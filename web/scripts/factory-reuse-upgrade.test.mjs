import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Interface } from 'ethers';
import { connectWallet, requireWallet } from '../lib/live-transactions.mjs';
import { walletConnectionError } from '../lib/wallet-discovery.mjs';
import { FACTORY_IMPLEMENTATION_SLOT, confirmFactoryReuseTransaction, factoryReuseBatch, factoryReuseDeployment,
  factoryReuseProgressKey, factoryReuseSalt, readFactoryReuseStatus, reconcileFactoryReuseDeployment,
  scheduleFactoryReuseTransaction, validateFactoryReuseCatalog, verifyFactoryReuseDeploymentRuntime } from '../lib/factory-reuse-upgrade.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = '0x' + 'ab'.repeat(32), blockHash = '0x' + 'bc'.repeat(32), role = '0x' + 'ef'.repeat(32);
const implementation = address(30);
const factory = new Interface(['function upgradeToAndCall(address,bytes)', 'function proxiableUUID() view returns(bytes32)',
  'function soldMachineReuseVersion() pure returns(uint8)', 'function owner() view returns(address)', 'function timelock() view returns(address)']);
const clock = new Interface(['function getMinDelay() view returns(uint256)', 'function PROPOSER_ROLE() view returns(bytes32)',
  'function hasRole(bytes32,address) view returns(bool)', 'function getTimestamp(bytes32) view returns(uint256)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)']);
const abi = factory.fragments.map(fragment => JSON.parse(fragment.format('json')));
function fixture(profile = 'full-test') {
  return { schemaVersion: 1, kind: 'fresh-sold-machine-reuse-upgrade-v1', chainId: 56, profile,
    genesisArtifactDigest: hash, candidateArtifactDigest: blockHash, minimumDelaySeconds: profile === 'formal' ? '172800' : '0',
    bindings: { factory: address(1), timelock: address(2), proposer: address(3) },
    expectedImplementations: { FreshPoolFactory: address(20) },
    artifacts: { FreshPoolFactory: { contractName: 'FreshPoolFactory', abi, bytecode: '0x6000',
      deployedBytecode: '0x60' + '00'.repeat(32) + '00', linkReferences: {}, deployedLinkReferences: {},
      immutableReferences: { '1': [{ start: 1, length: 32 }] } } } };
}
const runtime = replacement => '0x60' + replacement.slice(2).padStart(64, '0') + '00';
function implementationProvider({ code = runtime(implementation), uuid = FACTORY_IMPLEMENTATION_SLOT, version = 1n } = {}) {
  return { async request({ method, params }) {
    if (method === 'eth_getCode') return code;
    assert.equal(method, 'eth_call'); const parsed = factory.parseTransaction({ data: params[0].data });
    return factory.encodeFunctionResult(parsed.name, [parsed.name === 'proxiableUUID' ? uuid : version]);
  } };
}

test('factory catalog only allows one fresh Factory artifact and the right product profile', () => {
  const catalog = fixture(); assert.equal(validateFactoryReuseCatalog(catalog, { profile: 'full-test' }), catalog);
  for (const alter of [c => { c.kind = 'fresh-native-firsto-sale-upgrade-v1'; }, c => { c.chainId = 97; },
    c => { c.minimumDelaySeconds = '1'; }, c => { c.artifacts.PoolVault = c.artifacts.FreshPoolFactory; },
    c => { c.artifacts.FreshPoolFactory.contractName = 'PoolFactory'; },
    c => { c.artifacts.FreshPoolFactory.linkReferences = { 'library.sol': {} }; },
    c => { c.artifacts.FreshPoolFactory.deployedLinkReferences = { 'library.sol': {} }; },
    c => { c.artifacts.FreshPoolFactory.immutableReferences = {}; },
    c => { c.artifacts.FreshPoolFactory.immutableReferences['1'][0].length = 20; },
    c => { c.artifacts.FreshPoolFactory.abi.push({ type: 'constructor', inputs: [{ name: 'factory', type: 'address' }] }); },
    c => { c.artifacts.FreshPoolFactory.abi = []; }, c => { c.bindings.proposer = c.bindings.factory; },
    c => { c.salt = role; }]) {
    const changed = structuredClone(catalog); alter(changed); assert.throws(() => validateFactoryReuseCatalog(changed));
  }
  assert.throws(() => validateFactoryReuseCatalog(catalog, { profile: 'formal' }));
  assert.equal(validateFactoryReuseCatalog(fixture('formal')).profile, 'formal');
});

test('Factory batch has exactly one proxy target, no initializer, and isolated progress identity', () => {
  const catalog = fixture(), deployed = { FreshPoolFactory: implementation }, batch = factoryReuseBatch(catalog, deployed);
  assert.deepEqual(batch.targets, [catalog.bindings.factory]); assert.deepEqual(batch.values, [0n]);
  assert.deepEqual([...factory.decodeFunctionData('upgradeToAndCall', batch.payloads[0])], [implementation, '0x']);
  assert.equal(factoryReuseDeployment(catalog), catalog.artifacts.FreshPoolFactory.bytecode);
  assert.match(factoryReuseProgressKey(catalog, catalog.bindings.proposer), /^bemine\.sold-machine-reuse\.v1:/);
  assert.notEqual(factoryReuseSalt(catalog), factoryReuseSalt({ ...catalog, candidateArtifactDigest: role }));
  for (const value of [...Object.values(catalog.bindings), catalog.expectedImplementations.FreshPoolFactory])
    assert.throws(() => factoryReuseBatch(catalog, { FreshPoolFactory: value }));
});

test('UUPS self immutable is exact, including all 32 bytes; wrong runtime, UUID and version are rejected', async () => {
  const catalog = fixture();
  assert.equal((await verifyFactoryReuseDeploymentRuntime(implementationProvider(), catalog, 'FreshPoolFactory', implementation)).toLowerCase(), implementation);
  for (const values of [{ code: runtime(address(31)) }, { code: runtime(implementation) + '00' },
    { uuid: hash }, { version: 0n }])
    await assert.rejects(verifyFactoryReuseDeploymentRuntime(implementationProvider(values), catalog, 'FreshPoolFactory', implementation));
});

test('status accepts only preserved baseline or completed exact Factory operation at one canonical block', async () => {
  const catalog = fixture(); let currentImpl = catalog.expectedImplementations.FreshPoolFactory, timestamp = 0n;
  let currentOwner = catalog.bindings.timelock, canonicalHash = blockHash; const tags = [];
  const provider = { async request({ method, params }) {
    if (method === 'eth_getBlockByNumber') return { number: '0x123', hash: params[0] === 'latest' ? blockHash : canonicalHash };
    if (method === 'eth_getStorageAt') { tags.push(params[2]); return '0x' + '00'.repeat(12) + currentImpl.slice(2); }
    if (method === 'eth_getCode') return runtime(implementation);
    assert.equal(method, 'eth_call'); const data = params[0].data;
    tags.push(params[1]);
    if (params[0].to === catalog.bindings.timelock) {
      const parsed = clock.parseTransaction({ data }); return clock.encodeFunctionResult(parsed.name,
        [{ getMinDelay: 0n, PROPOSER_ROLE: role, hasRole: true, getTimestamp: timestamp }[parsed.name]]);
    }
    const parsed = factory.parseTransaction({ data }); return factory.encodeFunctionResult(parsed.name,
      [{ owner: currentOwner, timelock: catalog.bindings.timelock, proxiableUUID: FACTORY_IMPLEMENTATION_SLOT, soldMachineReuseVersion: 1n }[parsed.name]]);
  } };
  assert.equal((await readFactoryReuseStatus(provider, catalog)).activated, false);
  assert.deepEqual([...new Set(tags)], ['0x123']);
  currentImpl = address(90); await assert.rejects(readFactoryReuseStatus(provider, catalog), /其他升级/);
  currentImpl = implementation; await assert.rejects(readFactoryReuseStatus(provider, catalog, { FreshPoolFactory: implementation }), /批次尚未启用/);
  timestamp = 1n; assert.equal((await readFactoryReuseStatus(provider, catalog, { FreshPoolFactory: implementation })).activated, true);
  currentOwner = address(99); await assert.rejects(readFactoryReuseStatus(provider, catalog, { FreshPoolFactory: implementation }), /权限/);
  currentOwner = catalog.bindings.timelock; canonicalHash = role;
  await assert.rejects(readFactoryReuseStatus(provider, catalog, { FreshPoolFactory: implementation }), /状态正在变化/);
});

test('deployment recovery rebuilds the exact receipt, blocks unknown outcomes, and makes no wallet submissions', async () => {
  const catalog = fixture(), methods = [], base = implementationProvider();
  const receipt = { status: '0x1', transactionHash: hash, blockHash, blockNumber: '0x123', from: catalog.bindings.proposer,
    to: null, contractAddress: implementation };
  const tx = { hash, from: catalog.bindings.proposer, to: null, input: '0x6000', value: '0x0', chainId: '0x38', blockHash, blockNumber: '0x123' };
  const provider = { async request(value) { methods.push(value.method);
    if (value.method === 'eth_getTransactionReceipt') return receipt;
    if (value.method === 'eth_getTransactionByHash') return tx;
    return base.request(value);
  } };
  const result = await reconcileFactoryReuseDeployment(provider, catalog, { FreshPoolFactory: { hash, status: 'confirmed', address: address(99) } }, catalog.bindings.proposer);
  assert.equal(result.deployed.FreshPoolFactory.toLowerCase(), implementation);
  assert.equal(methods.includes('eth_sendTransaction'), false);
  await assert.rejects(reconcileFactoryReuseDeployment(provider, catalog, { FreshPoolFactory: { status: 'unknown' } }, catalog.bindings.proposer), /不能重复发送/);
  tx.blockHash = role;
  await assert.rejects(reconcileFactoryReuseDeployment(provider, catalog, { FreshPoolFactory: { hash } }, catalog.bindings.proposer), /交易内容/);
});

function scheduleReceipt(catalog, batch, tx) {
  const values = [clock.encodeEventLog(clock.getEvent('CallScheduled'),
    [batch.operationId, 0, batch.targets[0], 0n, batch.payloads[0], batch.predecessor, 0n]),
    clock.encodeEventLog(clock.getEvent('CallSalt'), [batch.operationId, batch.salt])];
  return { status: '0x1', transactionHash: tx.hash, blockHash: tx.blockHash, blockNumber: tx.blockNumber,
    logs: values.map(value => ({ ...value, address: catalog.bindings.timelock,
      transactionHash: tx.hash, blockHash: tx.blockHash, blockNumber: tx.blockNumber })) };
}

test('Factory schedule recovery accepts the fixed wallet wrapper only for this exact single target operation', async () => {
  const previous = JSON.parse(await readFile(new URL('./fixtures/sale-upgrade-wrapped-schedule.json', import.meta.url), 'utf8'));
  const runtimeProof = JSON.parse(await readFile(new URL('../../deploy/fixtures/fresh-activation-envelope.json', import.meta.url), 'utf8')).runtimeProof;
  const catalog = fixture(); catalog.bindings.timelock = '0x9021E33Db265CE4253E7f9e79741BB94f119C4A0';
  const batch = factoryReuseBatch(catalog, { FreshPoolFactory: implementation }), transaction = scheduleFactoryReuseTransaction(catalog, batch, 0n);
  const manager = new Interface(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
  const old = manager.decodeFunctionData('redeemDelegations', previous.tx.input);
  const inner = catalog.bindings.timelock.toLowerCase() + '00'.repeat(32) + transaction.data.slice(2);
  const tx = { ...previous.tx, input: manager.encodeFunctionData('redeemDelegations', [[...old[0]], [...old[1]], [inner]]) };
  const receipt = { ...previous.receipt, ...scheduleReceipt(catalog, batch, tx) };
  const provider = { async request({ method }) { return method === 'eth_getTransactionReceipt' ? receipt : tx; } };
  const expected = { from: tx.from, ...transaction, batchProof: { kind: 'schedule', batch, delay: 0n } };
  assert.equal((await confirmFactoryReuseTransaction(provider, { hash: tx.hash }, expected, { runtimeProof })).transactionHash, tx.hash);
  receipt.logs[0].data += '00';
  await assert.rejects(confirmFactoryReuseTransaction(provider, { hash: tx.hash }, expected, { runtimeProof }));
});

test('Factory console isolates its catalog, three transaction journal, and user selected wallet', async () => {
  const ui = await readFile(new URL('../components/FactoryReuseUpgradePanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /const order = \['FreshPoolFactory'\]/);
  assert.match(ui, /factory-reuse-upgrade\.\$\{profile\}\.json/);
  assert.match(ui, /factoryReuseProgressKey\(catalog, account\)/);
  assert.match(ui, /connectWallet\(connected, \{ reselectAccount: !!account \}\)/);
  assert.match(ui, /setAccount\(currentOwner\)/);
  assert.doesNotMatch(ui, /connected\.account/);
  assert.match(ui, /共 3 笔钱包交易/);
  assert.match(ui, /networkEpoch\.current === epoch/);
  assert.match(ui, /journal\.current === currentJournal/);
  assert.doesNotMatch(ui, /displayAmount|catalog\.activation|enableNativeFirstoSale/);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function connectionProvider({ owner = address(3), permissionError, approval } = {}) {
  const provider = new EventEmitter(), calls = [], state = { owner, chain: '0x38' };
  provider.request = async request => {
    calls.push(request);
    if (request.method === 'eth_requestAccounts') {
      if (permissionError) throw permissionError;
      if (approval) await approval.promise;
      return [state.owner];
    }
    if (request.method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
    if (request.method === 'eth_accounts') return [state.owner];
    if (request.method === 'eth_chainId') return state.chain;
    assert.fail(`Factory connection must not sign or send: ${request.method}`);
  };
  return { provider, calls, state };
}
async function actualConnectHandler({ entries = [], selectedWalletId = '', account = '', injected } = {}) {
  const source = await readFile(new URL('../components/FactoryReuseUpgradePanel.jsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  async function connect()'), source.indexOf('  function recoverHash('));
  const state = { account, error: '', notice: '', connecting: false, chainStatus: null }, context = {
    connectionLock: { current: false }, lock: { current: false }, life: { current: {} }, provider: { current: null },
    networkEpoch: { current: 0 }, discovery: { current: { refresh() {}, getWallets: () => entries } },
    window: { ethereum: injected }, account, selectedWalletId, connectWallet, requireWallet, walletConnectionError,
  };
  for (const name of ['Account', 'Error', 'Notice', 'Connecting', 'ChainStatus', 'SelectedWalletId'])
    context['set' + name] = value => { state[name[0].toLowerCase() + name.slice(1)] = value; };
  const connect = new Function(...Object.keys(context), body + '\nreturn connect;')(...Object.values(context));
  return { connect, state, context };
}

test('actual Factory connect caller adopts the shared helper address string and visibly enables its account', async () => {
  const wallet = connectionProvider(), entries = [{ id: 'metamask', brandId: 'metamask', provider: wallet.provider }];
  const ui = await actualConnectHandler({ entries }); await ui.connect();
  assert.equal(ui.state.account, address(3)); assert.equal(typeof ui.state.account, 'string');
  assert.equal(ui.state.notice, '钱包已连接。'); assert.equal(ui.state.error, ''); assert.equal(ui.state.connecting, false);
  assert.equal(ui.context.provider.current, wallet.provider);
  assert.deepEqual(wallet.calls.map(row => row.method), ['eth_requestAccounts', 'eth_chainId', 'eth_chainId', 'eth_accounts', 'eth_chainId', 'eth_accounts']);
});

test('actual Factory connect refreshes late injected wallets and uses the explicitly selected concrete wallet', async () => {
  const entries = [], ui = await actualConnectHandler({ entries, selectedWalletId: 'okx' });
  await ui.connect(); assert.match(ui.state.error, /尚未检测到钱包/);
  const meta = connectionProvider(), okx = connectionProvider({ owner: address(40) });
  entries.push({ id: 'metamask', brandId: 'metamask', provider: meta.provider }, { id: 'okx', brandId: 'okx', provider: okx.provider });
  await ui.connect(); assert.equal(ui.state.account, address(40)); assert.equal(ui.state.error, '');
  assert.equal(ui.context.provider.current, okx.provider); assert.equal(meta.calls.length, 0);
});

test('actual Factory connect lock prevents duplicate prompts and stale provider results cannot replace a new wallet', async () => {
  const approval = deferred(), wallet = connectionProvider({ approval }), entry = { id: 'metamask', provider: wallet.provider };
  const ui = await actualConnectHandler({ entries: [entry] });
  const pending = ui.connect(); await tick(); assert.equal(ui.state.connecting, true);
  await ui.connect(); assert.equal(wallet.calls.filter(row => row.method === 'eth_requestAccounts').length, 1);
  ui.context.provider.current = connectionProvider().provider;
  approval.resolve(); await pending; assert.equal(ui.state.account, ''); assert.equal(ui.state.connecting, false);
});

test('actual Factory rejection and pending wallet requests show useful errors without retry or transaction calls', async () => {
  for (const [code, message] of [[4001, /取消了钱包授权/], [-32002, /等待确认/], [4100, /尚未授权/]]) {
    const wallet = connectionProvider({ permissionError: { code } });
    const ui = await actualConnectHandler({ entries: [{ id: 'metamask', provider: wallet.provider }] });
    await ui.connect(); assert.match(ui.state.error, message); assert.equal(ui.state.notice, '');
    assert.equal(ui.state.account, ''); assert.equal(ui.state.connecting, false);
    assert.deepEqual(wallet.calls.map(row => row.method), ['eth_requestAccounts']);
  }
});

test('an account event during the final connect read cannot overwrite the new account with an older helper result', async () => {
  const finalRead = deferred(), entered = deferred(), wallet = connectionProvider();
  const request = wallet.provider.request; let accountReads = 0;
  wallet.provider.request = async input => {
    if (input.method === 'eth_accounts' && ++accountReads === 2) { entered.resolve(); return finalRead.promise; }
    return request(input);
  };
  const ui = await actualConnectHandler({ entries: [{ id: 'metamask', provider: wallet.provider }] });
  const pending = ui.connect(); await entered.promise;
  wallet.state.owner = address(40); ui.context.networkEpoch.current++; ui.state.account = address(40);
  finalRead.resolve([address(3)]); await pending;
  assert.equal(ui.state.account, address(40)); assert.match(ui.state.error, /账户或网络已变化/);
  assert.equal(ui.state.connecting, false); assert.equal(ui.context.connectionLock.current, false);
  assert(wallet.calls.every(row => ['eth_requestAccounts', 'eth_accounts', 'eth_chainId'].includes(row.method)));
});

async function actualWalletEffect(wallet) {
  const source = await readFile(new URL('../components/FactoryReuseUpgradePanel.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('    const connected = wallets.find('), end = source.indexOf('  }, [wallets, selectedWalletId]);', start);
  assert(start >= 0 && end > start);
  const state = { account: '', notice: '', chainStatus: null }, context = { wallets: [{ id: 'test', provider: wallet }], selectedWalletId: 'test',
    provider: { current: null }, networkEpoch: { current: 0 } };
  for (const name of ['Account', 'Notice', 'ChainStatus']) context['set' + name] = value => { state[name[0].toLowerCase() + name.slice(1)] = value; };
  const stop = new Function(...Object.keys(context), source.slice(start, end))(...Object.values(context));
  return { state, context, stop };
}

test('actual Factory provider effect silently restores authorized accounts and follows wallet/network changes', async () => {
  const wallet = connectionProvider(), ui = await actualWalletEffect(wallet.provider);
  try {
    await tick(); assert.equal(ui.state.account, address(3));
    wallet.state.owner = address(40); wallet.provider.emit('accountsChanged', [address(40)]);
    assert.equal(ui.state.account, ''); await tick(); assert.equal(ui.state.account, address(40));
    wallet.state.chain = '0x1'; wallet.provider.emit('chainChanged', '0x1'); await tick(); assert.equal(ui.state.account, '');
    wallet.state.chain = '0x38'; wallet.provider.emit('chainChanged', '0x38'); await tick(); assert.equal(ui.state.account, address(40));
    assert(wallet.calls.every(row => ['eth_accounts', 'eth_chainId'].includes(row.method)));
  } finally { ui.stop(); }
  assert.equal(wallet.provider.listenerCount('accountsChanged'), 0);
});

test('a late empty authorization probe cannot erase an explicitly connected Factory account', async () => {
  const pending = deferred(), wallet = new EventEmitter();
  wallet.request = ({ method }) => method === 'eth_accounts' ? pending.promise : Promise.resolve('0x38');
  const ui = await actualWalletEffect(wallet);
  try {
    ui.context.networkEpoch.current++; ui.state.account = address(3);
    pending.resolve([]); await tick(); assert.equal(ui.state.account, address(3));
  } finally { ui.stop(); }
});
