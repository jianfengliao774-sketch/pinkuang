import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, toQuantity } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { freshManifestDigest, loadFreshDisplayConfig } from '../lib/fresh-product-config.mjs';
import { authenticate, cancelPendingNonce, recoverPending, requireCurrentProductStage,
  retryLegacyEnvelope, sendProductTransaction, validateProductTransactionStage } from '../lib/live-transactions.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const keys = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock', 'portfolioFactory',
  'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation', 'portfolioFactoryImplementation'];
const authority = { address: address(30), administratorOne: address(31), administratorTwo: address(32),
  gasWallet: address(33), codehash: hash(99), deploymentTxHash: hash(98) };
const rawManifest = { schemaVersion: 1, kind: 'integrated-v2', chainId: 56,
  ...Object.fromEntries(keys.map((key, index) => [key, address(index + 10)])),
  codehash: Object.fromEntries(keys.map(key => [key, hash(50)])),
  authority: authority.address, gasWallet: authority.gasWallet, freshAuthority: authority,
  deployment: { txHash: hash(40), blockNumber: 90, blockHash: hash(41) },
  artifactDigest: ARTIFACT_DIGEST, sourceCommit: 'a'.repeat(40),
  verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBlockNumber: 100 };
const config = await loadFreshDisplayConfig({ basePath: '/bemine-v4', origin: 'https://example.test',
  pinnedManifest: rawManifest, manifestSha256: freshManifestDigest(rawManifest),
  fetcher: async () => assert.fail('Compiled display boot must stay local.') });
const account = address(1), pool = address(100), portfolio = address(200);
const blockedRpc = new Set(['eth_getCode', 'eth_getStorageAt', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_call', 'eth_estimateGas']);
const tx = ({ target = pool, contract = abi.PoolVault, kind = 'deposit', args = [2n], value = '20' } = {}) =>
  ({ chainId: '0x38', from: account, to: target, data: contract.encodeFunctionData(kind, args), value });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  json: async () => value });

function fixture(options = {}) {
  const calls = [], state = { account, chain: '0x38', nonce: 7n, pendingNonce: 7n,
    price: 1_000_000_000n, balance: 10n ** 25n, authenticated: true, record: null, revision: 0,
    ...options };
  const envelope = (record, legacy = false) => ({ from: record.account, to: record.target,
    chainId: '0x38', nonce: toQuantity(BigInt(record.nonce)), data: record.data,
    value: toQuantity(BigInt(record.value)), gas: toQuantity(BigInt(record.gas)),
    ...(legacy ? { gasPrice: toQuantity(BigInt(record.gasPrice)), type: '0x0' }
      : { maxFeePerGas: toQuantity(BigInt(record.gasPrice)),
        maxPriorityFeePerGas: toQuantity(BigInt(record.gasPrice)), type: '0x2' }) });
  const provider = { request: async payload => {
    calls.push({ surface: 'wallet', ...payload });
    assert.equal(blockedRpc.has(payload.method), false, `Unexpected preflight RPC: ${payload.method}`);
    const { method, params } = payload;
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_accounts') return [state.account];
    if (method === 'eth_getTransactionCount') return toQuantity(params[1] === 'pending' ? state.pendingNonce : state.nonce);
    if (method === 'eth_gasPrice') return toQuantity(state.price);
    if (method === 'eth_getBalance') return toQuantity(state.balance);
    if (method === 'personal_sign') return `0x${'11'.repeat(65)}`;
    if (method === 'eth_sendTransaction') {
      assert(state.record, 'A durable armed intent must precede a wallet send.');
      if (state.rejectType2 && params[0].type === '0x2')
        throw new Error('Unsupported transaction type 0x2 (EIP-1559 envelope)');
      if (state.rejectWallet) throw Object.assign(new Error('User rejected'), { code: 4001 });
      if (state.sendTimeout) throw new Error('Wallet response lost');
      return hash(7);
    }
    assert.fail(`Unexpected wallet request: ${method}`);
  } };
  const fetcher = async (url, init = {}) => {
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ surface: 'journal', url, method, body });
    assert.equal(url.includes('product-graph'), false, 'Direct mode must not wait for a product graph.');
    assert.equal(init.credentials, 'same-origin');
    const path = url.replace('/bemine-v4/api/journal/', '');
    if (path === 'session' && method === 'GET') return state.authenticated
      ? response({ account: state.sessionAccount ?? account }) : response({ error: 'Login required' }, 401);
    if (path === 'challenge' && method === 'POST') {
      const nonce = 'A'.repeat(32);
      return response({ nonce, message: ['Pinkuang deployment journal login',
        `Origin: ${state.challengeOrigin ?? config.origin}`, 'Chain ID: 56', `Account: ${account.toLowerCase()}`,
        `Nonce: ${nonce}`, `Expires At: ${new Date(Date.now() + 300_000).toISOString()}`].join('\n') });
    }
    if (path === 'session' && method === 'POST') { state.authenticated = true; return response({ account }); }
    if (path === 'market' && method === 'GET') return response({ revision: state.revision, record: state.record,
      canRequestLegacyEnvelope: state.rejectType2 && state.record?.version === 2 && !state.record.hash && !state.legacyUsed,
      legacyEnvelopeIssued: state.legacyUsed === true });
    if (path === 'market/prepare-and-arm' && method === 'POST') {
      if (state.record || body.expectedRevision !== state.revision) return response({ error: 'Intent exists' }, 409);
      state.record = structuredClone(body.record); state.revision += 2;
      state.afterArm?.(state);
      if (state.armAckLost) throw new Error('Arm ACK lost');
      return response({ revision: state.revision, record: structuredClone(state.record),
        transaction: { ...envelope(state.record), ...state.permitChange } });
    }
    if (path === 'market/legacy-envelope' && method === 'POST') {
      if (!state.record || state.legacyUsed || body.expectedRevision !== state.revision)
        return response({ error: 'Legacy permission unavailable' }, 409);
      state.legacyUsed = true; state.revision++;
      return response({ legacyEnvelopeAuthorized: true, revision: state.revision,
        record: structuredClone(state.record), transaction: { ...envelope(state.record, true), ...state.legacyChange } });
    }
    if (path === 'market/cancel-intent' && method === 'POST') {
      if (!state.record || body.expectedRevision !== state.revision) return response({ error: 'Intent changed' }, 409);
      const transaction = { from: account, to: account, chainId: '0x38', nonce: toQuantity(BigInt(state.record.nonce)),
        data: '0x', value: '0x0', gas: '0x5208', type: '0x2',
        maxFeePerGas: toQuantity(state.price * 120n / 100n), maxPriorityFeePerGas: toQuantity(state.price * 120n / 100n),
        ...state.cancelChange };
      state.record = { ...state.record,
        cancellationRequests: [...(state.record.cancellationRequests ?? []), transaction] };
      state.revision++;
      return response({ revision: state.revision, record: structuredClone(state.record),
        legacyEnvelopeIssued: false, transaction });
    }
    if (path === 'market' && method === 'PUT') {
      assert.equal(body.expectedRevision, state.revision);
      state.record = structuredClone(body.record); state.revision++;
      if (state.hashAckLost) throw new Error('Hash ACK lost');
      return response({ revision: state.revision });
    }
    if (path === 'market' && method === 'DELETE') {
      assert(calls.some(item => item.method === 'eth_sendTransaction'), 'Receipt recovery must follow a send.');
      if (state.pendingResult) return response({ error: 'Receipt pending' }, 409);
      const r = state.record, result = { finalized: true, status: state.resolution ?? 'confirmed',
        action: r.action.kind, account, nonce: r.nonce, factory: r.factory, target: r.target,
        transactionHash: body.hash, receipt: { transactionHash: body.hash,
          to: state.resolution === 'cancelled' ? account : r.target,
          status: state.resolution === 'reverted' ? 0 : 1, blockNumber: 100, blockHash: hash(100) } };
      if (result.action === 'deposit' && result.status === 'confirmed') {
        const contract = r.targetType === 'portfolio' ? abi.BudgetPortfolioVault : abi.PoolVault;
        Object.assign(result, { poolAddress: r.target,
          shares: contract.decodeFunctionData('deposit', r.data)[0].toString(), amountWei: r.value });
      }
      if (state.badReceipt) { result.receipt.transactionHash = hash(8); return response({ result }); }
      state.saved = result; state.record = null; state.revision++;
      return response({ result, revision: state.revision });
    }
    if (path.startsWith('market/result?')) return response({ result: state.saved ?? null });
    assert.fail(`Unexpected journal request: ${method} ${url}`);
  };
  const send = (transaction = tx(), action = 'deposit') => sendProductTransaction({ provider, config,
    transaction, action, fetcher });
  return { provider, fetcher, state, calls, send };
}
const count = (f, method) => f.calls.filter(item => item.surface === 'wallet' && item.method === method).length;
const assertNoPreflight = f => {
  assert(!f.calls.some(item => blockedRpc.has(item.method)));
  assert(!f.calls.some(item => item.url?.includes('product-graph')));
};

test('direct stage loading returns no fabricated proof and never requests a current graph', async () => {
  const before = structuredClone(config);
  assert.equal(await requireCurrentProductStage(config, async () => assert.fail('No graph required')), undefined);
  assert.deepEqual(config, before);
  assert.equal(config.readMode, 'display');
  for (const flag of ['transactionReady', 'operationalReady', 'userExitReady', 'freshFactoryVerified'])
    assert.equal(config[flag], false);
});

test('fixed-manifest actions accept false runtime flags while preserving exact calldata and value rules', () => {
  assert.equal(validateProductTransactionStage(config, tx(), 'deposit').value, 20n);
  const create = tx({ target: config.manifest.portfolioFactory, contract: abi.BudgetPortfolioFactory,
    kind: 'createPortfolio', args: [100n, 100n, 1n, 1000n, 2000n], value: '0' });
  // ABI-local selector validation is performed without a runtime role attestation.
  assert.equal(validateProductTransactionStage(config, create,
    { kind: 'createPortfolio', targetType: 'portfolioFactory' }).action.kind, 'createPortfolio');
  for (const changed of [{ value: 20 }, { value: '-1' }, { chainId: '0x1' },
    { data: `${tx().data}00` }, { from: address(0) }])
    assert.throws(() => validateProductTransactionStage(config, { ...tx(), ...changed }, 'deposit'));
  assert.throws(() => validateProductTransactionStage(config, tx({ kind: 'claim', args: [], value: '1' }), 'claim'), /不能附带/);
  assert.throws(() => validateProductTransactionStage(config, tx(), 'claim'), /操作名称/);
  assert.throws(() => validateProductTransactionStage({ ...config, factory: address(999) }, tx(), 'deposit'), /地址不一致/);
});

test('direct deposit reaches one wallet send with one identity round and no chain attestation reads', async () => {
  const f = fixture();
  const result = await f.send();
  assert.equal(result.status, 'confirmed');
  assert.equal(result.shares, '2');
  assertNoPreflight(f);
  assert.equal(count(f, 'eth_chainId'), 1);
  assert.equal(count(f, 'eth_accounts'), 1);
  assert.equal(count(f, 'eth_getTransactionCount'), 2);
  assert.equal(count(f, 'eth_gasPrice'), 1);
  assert.equal(count(f, 'eth_getBalance'), 1);
  assert.equal(count(f, 'eth_sendTransaction'), 1);
  const arm = f.calls.findIndex(item => item.url?.endsWith('/prepare-and-arm'));
  const wallet = f.calls.findIndex(item => item.method === 'eth_chainId');
  const send = f.calls.findIndex(item => item.method === 'eth_sendTransaction');
  const receipt = f.calls.findIndex(item => item.method === 'DELETE');
  assert(arm < wallet && wallet < send && send < receipt);
  assert.equal(config.transactionReady, false, 'A send must not mutate display config into a current proof.');
});

test('direct portfolio deposit works from the unflattened display boot config', async () => {
  const f = fixture();
  const result = await f.send(tx({ target: portfolio, contract: abi.BudgetPortfolioVault }),
    { kind: 'deposit', targetType: 'portfolio' });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.targetType, 'portfolio');
  assert.equal(result.factory, config.manifest.portfolioFactory);
  assertNoPreflight(f);
});

test('one identity round immediately before sending still stops a changed account or chain', async () => {
  for (const afterArm of [state => { state.account = address(9); }, state => { state.chain = '0x1'; }]) {
    const f = fixture({ afterArm });
    const result = await f.send();
    assert.equal(result.status, 'pending');
    assert(f.state.record);
    assert.equal(count(f, 'eth_chainId'), 1);
    assert.equal(count(f, 'eth_accounts'), 1);
    assert.equal(count(f, 'eth_sendTransaction'), 0);
  }
});

test('direct mode still requires matching authentication, exact permit and durable one-use arm ACK', async () => {
  const missing = fixture({ authenticated: false });
  await assert.rejects(missing.send(), /Login required/);
  assert.equal(count(missing, 'eth_sendTransaction'), 0);
  for (const permitChange of [{ to: address(9) }, { value: '0x100' }, { gas: '0x1' }]) {
    const f = fixture({ permitChange });
    const result = await f.send();
    assert.equal(result.status, 'pending');
    assert(f.state.record);
    assert.equal(count(f, 'eth_sendTransaction'), 0);
  }
  const lost = fixture({ armAckLost: true });
  await assert.rejects(lost.send(), /Arm ACK lost/);
  assert(lost.state.record);
  assert.equal(count(lost, 'eth_sendTransaction'), 0);
  await assert.rejects(lost.send(), /待核对/);
});

test('wallet rejection and ambiguous hash persistence retain the intent and never automatically resend', async () => {
  for (const options of [{ rejectWallet: true }, { sendTimeout: true }, { hashAckLost: true }, { pendingResult: true }]) {
    const f = fixture(options);
    const result = await f.send();
    assert.equal(result.status, 'pending');
    assert(f.state.record);
    assert.equal(count(f, 'eth_sendTransaction'), 1);
    await assert.rejects(f.send(), /待核对/);
    assert.equal(count(f, 'eth_sendTransaction'), 1);
    assertNoPreflight(f);
  }
});

test('result receipts remain necessary after broadcasting; malformed receipt is not success', async () => {
  const f = fixture({ badReceipt: true });
  const result = await f.send();
  assert.equal(result.status, 'pending');
  assert.equal(result.poolAddress, undefined);
  assert.equal(count(f, 'eth_sendTransaction'), 1);
  assertNoPreflight(f);
});

test('read-only recovery of a stored result does not touch the wallet in direct mode', async () => {
  const f = fixture();
  assert.equal((await f.send()).status, 'confirmed');
  const before = f.calls.length;
  const recovered = await recoverPending({ provider: f.provider, config, account, hash: hash(7), fetcher: f.fetcher });
  assert.equal(recovered.status, 'confirmed');
  assert(!f.calls.slice(before).some(item => item.surface === 'wallet'));
});

test('direct login uses the existing session immediately or exactly one signing identity round', async () => {
  const existing = fixture();
  assert.equal((await authenticate({ provider: existing.provider, config, account, fetcher: existing.fetcher })).account, account);
  assert.equal(count(existing, 'eth_chainId'), 0);
  assert.equal(count(existing, 'eth_accounts'), 0);
  assert.equal(count(existing, 'personal_sign'), 0);
  const login = fixture({ authenticated: false });
  await authenticate({ provider: login.provider, config, account, fetcher: login.fetcher });
  assert.equal(count(login, 'eth_chainId'), 1);
  assert.equal(count(login, 'eth_accounts'), 1);
  assert.equal(count(login, 'personal_sign'), 1);
  assert.equal(count(login, 'eth_sendTransaction'), 0);
  const foreign = fixture({ authenticated: false, challengeOrigin: 'https://foreign.test' });
  await assert.rejects(authenticate({ provider: foreign.provider, config, account, fetcher: foreign.fetcher }), /不匹配/);
  assert.equal(count(foreign, 'personal_sign'), 0);
});

test('an explicit legacy envelope retry retains the original intent without graph or repeated nonce rounds', async () => {
  const f = fixture({ rejectType2: true });
  assert.equal((await f.send()).legacyEnvelopeRejected, true);
  const before = f.calls.length;
  const result = await retryLegacyEnvelope({ provider: f.provider, config, account, fetcher: f.fetcher });
  assert.equal(result.status, 'confirmed');
  const next = f.calls.slice(before);
  assert.equal(next.filter(item => item.method === 'eth_getTransactionCount').length, 2);
  assert.equal(next.filter(item => item.method === 'eth_accounts').length, 1);
  assert.equal(next.filter(item => item.method === 'eth_chainId').length, 1);
  assert.equal(next.filter(item => item.method === 'eth_sendTransaction').length, 1);
  const sends = f.calls.filter(item => item.method === 'eth_sendTransaction');
  assert.equal(sends[0].params[0].nonce, sends[1].params[0].nonce);
  assert.equal(sends[0].params[0].data, sends[1].params[0].data);
  assert.equal(sends[1].params[0].type, '0x0');
  assertNoPreflight(f);
});

test('explicit nonce cancellation sends one own-wallet zero-value transaction without code/storage checks', async () => {
  const f = fixture({ pendingNonce: 8n, resolution: 'cancelled', record: {
    version: 2, chainId: 56, account, factory: config.manifest.factory, target: pool, targetType: 'pool',
    nonce: 7, action: { kind: 'deposit' }, data: tx().data, value: '20', submittedAt: new Date().toISOString(), hash: hash(6),
  } });
  const result = await cancelPendingNonce({ provider: f.provider, config, account, fetcher: f.fetcher });
  assert.equal(result.status, 'cancelled');
  assert.equal(count(f, 'eth_chainId'), 1);
  assert.equal(count(f, 'eth_accounts'), 1);
  assert.equal(count(f, 'eth_getTransactionCount'), 2);
  assert.equal(count(f, 'eth_sendTransaction'), 1);
  const sent = f.calls.find(item => item.method === 'eth_sendTransaction').params[0];
  assert.equal(sent.to, account);
  assert.equal(sent.value, '0x0');
  assert.equal(sent.data, '0x');
  assert.equal(sent.nonce, '0x7');
  assertNoPreflight(f);
});
