import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface, Wallet, ZeroAddress, getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { createUiContext, sameUnsignedIntent } from '../lib/ui-context.mjs';
import { boundedReadPreview } from '../lib/bounded-read-preview.mjs';
import { operatorCreateInput } from '../lib/operator-create-input.mjs';
import { prepareAdminAction, sameAdminPurchasePreview } from '../lib/live-admin.mjs';
import { preparePortfolioAction } from '../lib/live-portfolios.mjs';
import { approvedOperatorCall, prepareAuthoritySignature, prepareAuthoritySubmission } from '../lib/authority-client.mjs';
import { portfolioFixture } from './portfolio-fixture.mjs';

// Execute the shipped component handlers, including their actual preparation and
// signing modules. Only React state and the external wallet/relay transports are
// adapted. No test can reach a network, simulate, or request an on-chain send.
const sources = Object.fromEntries(await Promise.all(['LiveOperator', 'LivePortfolios', 'LivePlatform']
  .map(async name => [name, (await readFile(new URL(`../components/${name}.jsx`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')])));
const between = (text, start, end) => {
  const from = text.indexOf(start), to = text.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `Actual handler boundary missing: ${start}`);
  return text.slice(from, to);
};
const evaluate = (code, environment, exports) => new Function(...Object.keys(environment),
  `${code}\nreturn {${exports.join(',')}};`)(...Object.values(environment));
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const signer = new Wallet('0x' + '11'.repeat(32)); // Public, offline test fixture only.
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const collection = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const nonceAbi = new Interface(['function nonces(address) view returns(uint256)']);
const registryAbi = new Interface(['function machinePool(address,uint256) view returns(address)']);
const platformCode = between(sources.LivePlatform, '  async function submitFreshAuthority(', '  async function sendFreshAuthority(')
  + between(sources.LivePlatform, '  async function sendPortfolio(', '  async function sendBudgetQueueStep(')
  + between(sources.LivePlatform, '  async function sendAdminAction(', '  async function recover(');
const operatorCode = between(sources.LiveOperator, '  const change = ', '  const finishFundingEdit = ')
  + between(sources.LiveOperator, '  async function prepare(', '  return <section');
const portfolioCode = between(sources.LivePortfolios, '  async function prepare(action,', '  const act=');
const operatorIdentityCode = between(sources.LiveOperator, '  if (identity.current?.key', '  useEffect(');
const portfolioIdentityCode = between(sources.LivePortfolios, '  if(context.current.identity', '  const enabled=');
const forbidden = name => () => assert.fail(`${name} must not precede or replace the prepared wallet request`);

function flow({ portfolio = false, nonceWait = null, occupied = false, walletWait = null } = {}) {
  const base = portfolioFixture();
  const config = { ...base.config, productFamily: 'fresh-v4', displayOnly: true, stage: 'fresh-active',
    authority: addr(21), freshAuthority: { address: addr(21), codehash: '0x' + 'aa'.repeat(32),
      administratorOne: signer.address, administratorTwo: addr(25) } };
  const events = [], commands = [], state = { busy: false, error: '', preview: null, feedback: null, progress: '',
    form: { circuits: collection, circuitId: '16736', targetRaise: '0.0044444444444445', priceCap: '0.004',
      fundingHours: '24', purchaseHours: '48' }, submissionHidden: false };
  const props = { config, account: signer.address, wallet: null, readProvider: null };
  const readProvider = { request: async ({ method, params }) => {
    assert.equal(method, 'eth_call', 'preview must not add runtime, status, simulation or wallet queries');
    assert.equal(params[1], 'latest'); assert.equal(params[0].from, undefined, 'not a simulation');
    if (params[0].to.toLowerCase() === config.factory.toLowerCase()) {
      const parsed = registryAbi.parseTransaction(params[0]);
      assert.equal(parsed.name, 'machinePool'); assert.equal(parsed.args[0], collection); assert.equal(parsed.args[1], 16736n);
      events.push('read:reservation'); return registryAbi.encodeFunctionResult('machinePool', [occupied ? addr(99) : ZeroAddress]);
    }
    assert.equal(params[0].to, config.authority); assert.equal(nonceAbi.parseTransaction(params[0]).args[0], signer.address);
    events.push('read:nonce'); if (nonceWait) await nonceWait.promise;
    return nonceAbi.encodeFunctionResult('nonces', [9n]);
  } };
  const wallet = { request: async ({ method, params }) => {
    events.push(`wallet:${method}`); assert.equal(method, 'eth_signTypedData_v4');
    assert.equal(params[0], signer.address); if (walletWait) await walletWait.promise;
    const payload = JSON.parse(params[1]), { EIP712Domain, ...types } = payload.types;
    return signer.signTypedData(payload.domain, types, payload.message);
  } };
  props.wallet = wallet; props.readProvider = readProvider;
  const context = { current: createUiContext() }, identity = { current: null }, previewRead = { current: null },
    submission = { current: null }, sequence = { current: 0 }, portfolioContext = { current: {} },
    walletEpoch = { current: 0 }, epoch = { current: 0 }, routeIdentity = { current: '#operator' },
    submissionLock = { current: null }, publishingProjectRef = { current: null };
  const setters = Object.fromEntries(['Form', 'Preview', 'Feedback', 'Busy', 'Error', 'Progress', 'AutoSelection',
    'Imported', 'SubmissionHidden', 'ReadFailed'].map(name => ['set' + name, value => {
    const key = name[0].toLowerCase() + name.slice(1); state[key] = typeof value === 'function' ? value(state[key]) : value;
  }]));
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  function platform() {
    return evaluate(platformCode, { ...props, client: { provider: props.readProvider }, busy: false,
      pending: null, isOperator: true, operatorServiceReady: true, submissionLock, walletEpoch, epoch, routeIdentity,
      publishingProjectRef, rewardSendingBlocked: () => false, setBusy: setters.setBusy, setError: setters.setError,
      setTransactionStage: () => {}, requireCurrentProductStage: forbidden('product graph preflight'),
      authorityActionStatus: forbidden('authority status'), createReadOnlyHttpProvider: forbidden('new read provider'),
      connectJournal: async () => { events.push('authenticate'); }, prepareAuthoritySubmission, approvedOperatorCall,
      publishedProjectIntent: (_config, transaction, { command }) => ({ transaction, command }),
      submitAuthorityAction: async (_config, _account, command) => { events.push('relay'); commands.push(command);
        return { status: 'pending', hash: '0x' + '23'.repeat(32) }; },
      setPublishingProject: value => { publishingProjectRef.current = value; }, setMessage: () => {},
      setOperatorRefresh: () => {}, setRefresh: () => {}, showTransactionProgress: () => {}, showTransactionResult: () => false,
      directMemberTransaction: () => null, sameUnsignedIntent, sameAdminPurchasePreview, same,
      prepareAdminAction: forbidden('confirm-time admin preview'), preparePortfolioAction: forbidden('confirm-time budget preview'),
      sendProductTransaction: forbidden('transaction send'), sendMemberWalletTransaction: forbidden('member send'),
      approvedPortfolioPurchase: forbidden('purchase'), boundedReadPreview, handleResult: forbidden('legacy result'),
      textError: error => error.message, L: zh => zh }, ['sendAdminAction', 'sendPortfolio']);
  }
  function render() {
    if (portfolio) {
      const viewIdentity = `${props.config.factory}:${props.account}`;
      const env = { ...props, provider: props.readProvider, context: portfolioContext, sequence, identity: viewIdentity,
        displayRead: { current: null }, expandedChildren: { current: new Set() },
        current: ticket => ticket === sequence.current, preview: state.preview, ...setters, selectedCurrent: null,
        actionFrozen: () => false, onConnect: forbidden('wallet connect'), preparePortfolioAction,
        prepareAuthoritySignature, approvedOperatorCall, brief: error => error.message,
        onSend: (result, input) => platform().sendPortfolio(result, input),
        recentMarketCredits: new Map(), recentMarketOrders: new Map(), marketCreditKey: 'credit', marketOrderKey: () => 'order',
        setOrderPool: () => {}, setOrders: () => {}, setMarketCredit: () => {}, loadMarketCredit: forbidden('post-confirm credit'),
        load: forbidden('post-confirm listing') };
      evaluate(portfolioIdentityCode, env, []);
      return evaluate(portfolioCode, env, ['prepare', 'submit']);
    }
    const key = `${props.config.factory}:${props.account}`;
    const env = { ...props, context, identity, previewRead, submission, key,
      deploymentKey: JSON.stringify([props.config.stage, props.config.artifactDigest, props.config.authority,
        props.config.portfolioFactory, props.config.operationId, props.config.stageActivationBlock,
        props.config.stageActivationHash, props.config.manifest]),
      form: state.form, preview: state.preview, mode: 'createPool', pool: '', listingId: '', imported: '',
      direct: true, creationPending: false, creationBlocked: false, autoSelection: null, ...setters,
      operatorCreateInput, prepareAdminAction, boundedReadPreview, prepareAuthoritySignature, approvedOperatorCall,
      errorText: error => error.message, recheckSelection: forbidden('confirm-time quote'),
      onSend: (preview, options) => platform().sendAdminAction(preview, options) };
    evaluate(operatorIdentityCode, env, []);
    return evaluate(operatorCode, env, ['prepare', 'send', 'cancelPreviewRead', 'change']);
  }
  const create = () => portfolio ? render().prepare({ kind: 'createPortfolio', budget: '0.005', absoluteCap: '0.003',
    unitCap: '0.0000001', fundingDeadline: String(Math.floor(Date.now() / 1000) + 86400),
    purchaseDeadline: String(Math.floor(Date.now() / 1000) + 3 * 86400) }, null) : render().prepare();
  const confirm = () => portfolio ? render().submit() : render().send();
  return { events, commands, state, props, context, sequence, walletEpoch, epoch, previewRead, create, confirm, render,
    cancel() { if (portfolio) setters.setPreview(null); else render().cancelPreviewRead(); },
    changeWallet(value = { request: wallet.request }) { props.wallet = value; walletEpoch.current++; render(); },
    changeAccount(value = addr(99)) { props.account = value; walletEpoch.current++; render(); } };
}

for (const portfolio of [false, true]) {
  const label = portfolio ? 'budget portfolio' : 'single-miner pool';
  test(`actual ${label} handlers read only during preview; confirmation opens the wallet before authentication and relay`, async () => {
    const f = flow({ portfolio }); await f.create();
    assert(f.state.preview, f.state.error); assert.equal(f.state.busy, false);
    assert.equal(f.events.filter(event => event === 'read:nonce').length, 1);
    assert.equal(f.events.filter(event => event === 'read:reservation').length, portfolio ? 0 : 2);
    assert(!f.events.some(event => event.startsWith('wallet:')));
    f.events.length = 0; f.props.readProvider.request = forbidden('confirmation read RPC');
    await f.confirm();
    assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4', 'authenticate', 'relay'], f.state.error);
    assert.equal(f.commands.length, 1); assert.equal(f.commands[0].nonce, '9');
    const contract = portfolio ? abi.BudgetPortfolioFactory : abi.PoolFactory;
    const parsed = contract.parseTransaction({ data: f.commands[0].args.data });
    assert.equal(parsed.name, portfolio ? 'createPortfolio' : 'createPool');
    if (!portfolio) assert.equal(parsed.args[0].targetRaise, 4444444444444500n, 'sign the exact reviewed wei amount');
  });
  for (const changed of ['account', 'wallet', 'cancel']) test(`actual ${label} confirmation never signs after ${changed}`, async () => {
    const f = flow({ portfolio }); await f.create(); assert(f.state.preview, f.state.error); f.events.length = 0;
    if (changed === 'account') f.changeAccount(); else if (changed === 'wallet') f.changeWallet(); else f.cancel();
    await f.confirm(); assert.deepEqual(f.events, []); assert.equal(f.commands.length, 0);
  });
}

test('actual single-miner input change invalidates the prepared authorization without signing the old values', async () => {
  const f = flow(); await f.create(); assert(f.state.preview, f.state.error); f.events.length = 0;
  f.render().change('targetRaise', '0.007'); await f.confirm();
  assert.equal(f.state.form.targetRaise, '0.007'); assert.deepEqual(f.events, []); assert.equal(f.commands.length, 0);
});

test('changing the exact reviewed transaction cannot substitute parameters in either actual confirmation handler', async () => {
  for (const portfolio of [false, true]) {
    const f = flow({ portfolio }); await f.create(); assert(f.state.preview, f.state.error); f.events.length = 0;
    const preview = portfolio ? f.state.preview.result : f.state.preview;
    const transaction = { ...preview.transaction, data: preview.transaction.data.slice(0, -64) + '00'.repeat(32) };
    if (portfolio) f.state.preview = { ...f.state.preview, result: { ...preview, transaction } };
    else f.state.preview = { ...preview, transaction };
    await f.confirm(); assert.deepEqual(f.events, []); assert.equal(f.commands.length, 0);
    assert.match(f.state.error, /与预览不同/);
  }
});

test('canceling actual preparation prevents a late nonce reply from publishing a preview or signing', async () => {
  const waiting = deferred(), f = flow({ nonceWait: waiting }), preparing = f.create();
  await turn(); assert(f.events.includes('read:nonce')); f.cancel(); waiting.resolve(); await preparing;
  assert.equal(f.state.preview, null); assert.equal(f.state.busy, false); assert.equal(f.commands.length, 0);
  assert(!f.events.some(event => event.startsWith('wallet:')));
});

test('an occupied target fails the actual preview before requesting a wallet signature or journal login', async () => {
  const f = flow({ occupied: true }); await f.create();
  assert.equal(f.state.preview, null); assert.match(f.state.error, /矿机|项目/);
  assert.deepEqual(f.events, ['read:reservation']); assert.equal(f.commands.length, 0);
});

test('a wallet change while its signature dialog is open cannot forward that signature to authentication or relay', async () => {
  const waiting = deferred(), f = flow({ walletWait: waiting }); await f.create(); assert(f.state.preview, f.state.error);
  f.events.length = 0; const signing = f.confirm(); await turn();
  assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4']); f.changeWallet(); waiting.resolve(); await signing;
  assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4']); assert.equal(f.commands.length, 0);
});

test('the actual handlers cannot sign using another reviewed Authority pin even if the visible pool addresses stay the same', async () => {
  for (const portfolio of [false, true]) {
    const f = flow({ portfolio }); await f.create(); assert(f.state.preview, f.state.error); f.events.length = 0;
    f.props.config = { ...f.props.config, freshAuthority: { ...f.props.config.freshAuthority, codehash: '0x' + 'bb'.repeat(32) } };
    await f.confirm(); assert.deepEqual(f.events, []); assert.equal(f.commands.length, 0);
    assert.match(f.state.error, /与预览不同/);
  }
});

test('concurrent actual confirmation clicks consume one authorization and cannot open a second wallet prompt or relay request', async () => {
  for (const portfolio of [false, true]) {
    const waiting = deferred(), f = flow({ portfolio, walletWait: waiting });
    await f.create(); assert(f.state.preview, f.state.error); f.events.length = 0;
    const first = f.confirm(); await turn(); await f.confirm();
    assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4']);
    waiting.resolve(); await first;
    assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4', 'authenticate', 'relay']);
    assert.equal(f.commands.length, 1);
  }
});
