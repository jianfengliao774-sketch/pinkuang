import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface } from 'ethers';
import { confirmNativeUpgradeTransaction, nativeUpgradeBatch, nativeUpgradeDeployment, nativeUpgradeProgressKey,
  nativeUpgradeSalt, readNativeUpgradeStatus, reconcileNativeUpgradeDeployments, scheduleNativeUpgradeTransaction,
  validateNativeUpgradeCatalog, verifyNativeUpgradeBatchReceipt, verifyNativeUpgradeDeploymentRuntime } from '../lib/native-sale-upgrade.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = '0x' + 'ab'.repeat(32), blockHash = '0x' + 'bc'.repeat(32);
const libraryRuntime = '0x73' + '00'.repeat(20) + '6000';
function fixture(profile = 'full-test', enable = true) {
  const artifact = { abi: [], bytecode: '0x6000', deployedBytecode: libraryRuntime };
  return { schemaVersion: 1, kind: 'fresh-native-firsto-sale-upgrade-v1', chainId: 56, profile,
    genesisArtifactDigest: hash, candidateArtifactDigest: '0x' + 'cd'.repeat(32),
    minimumDelaySeconds: profile === 'formal' ? '172800' : '0',
    bindings: { factory: address(1), beacon: address(2), timelock: address(3), proposer: address(4) },
    expectedImplementations: { PoolVault: address(20) }, libraries: { SaleGovernance: address(21) },
    artifacts: { SaleSettlement: { ...artifact }, FirstoSale: { ...artifact }, PoolVault: { ...artifact, deployedBytecode: '0x6000' } },
    ...(enable ? { activation: { pool: address(22), proposalId: '1', priceWei: '40000000000000000', feeBps: '100', feeEpoch: '1' } } : {}) };
}
const deployed = { SaleSettlement: address(30), FirstoSale: address(31), PoolVault: address(32) };
const clock = new Interface(['function getMinDelay() view returns(uint256)', 'function PROPOSER_ROLE() view returns(bytes32)',
  'function hasRole(bytes32,address) view returns(bool)', 'function getTimestamp(bytes32) view returns(uint256)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)']);
const native = new Interface(['function enableNativeFirstoSale(uint256,uint256,uint16,uint256)', 'function nativeFirstoSaleVersion() view returns(uint8)']);
const beacon = new Interface(['function implementation() view returns(address)', 'function upgradeTo(address)']);
function receiptFor(catalog, batch, kind = 'schedule', delay = 0n) {
  const base = { status: '0x1', transactionHash: hash, blockHash, blockNumber: '0x123', logs: [] };
  const values = batch.targets.map((target, i) => clock.encodeEventLog(clock.getEvent(kind === 'schedule' ? 'CallScheduled' : 'CallExecuted'),
    kind === 'schedule' ? [batch.operationId, i, target, 0n, batch.payloads[i], batch.predecessor, delay]
      : [batch.operationId, i, target, 0n, batch.payloads[i]]));
  if (kind === 'schedule') values.push(clock.encodeEventLog(clock.getEvent('CallSalt'), [batch.operationId, batch.salt]));
  base.logs = values.map(value => ({ ...value, address: catalog.bindings.timelock,
    transactionHash: hash, blockHash, blockNumber: '0x123' }));
  return base;
}

test('native upgrade rejects old catalogs, other sites, unsafe terms and formal test activation', () => {
  const catalog = fixture(); assert.equal(validateNativeUpgradeCatalog(catalog, { profile: 'full-test' }), catalog);
  for (const alter of [c => { c.kind = 'fresh-sale-policy-upgrade-v1'; }, c => { c.chainId = 97; },
    c => { c.activation.priceWei = Number.MAX_SAFE_INTEGER + 1; }, c => { c.activation.feeBps = '201'; },
    c => { c.activation.proposalId = true; }, c => { c.minimumDelaySeconds = '1'; }]) {
    const changed = structuredClone(catalog); alter(changed); assert.throws(() => validateNativeUpgradeCatalog(changed));
  }
  assert.throws(() => validateNativeUpgradeCatalog(catalog, { profile: 'formal' }));
  assert.throws(() => validateNativeUpgradeCatalog(fixture('formal')));
  assert.equal(validateNativeUpgradeCatalog(fixture('formal', false)).profile, 'formal');
});

test('native upgrade namespaces cannot reuse old progress, and formal batch upgrades only the beacon', () => {
  const catalog = fixture('formal', false), batch = nativeUpgradeBatch(catalog, deployed);
  assert.deepEqual(batch.targets, [catalog.bindings.beacon]); assert.deepEqual(batch.values, [0n]);
  assert.equal(beacon.decodeFunctionData('upgradeTo', batch.payloads[0])[0].toLowerCase(), deployed.PoolVault);
  assert.match(nativeUpgradeProgressKey(catalog, address(4)), /^bemine\.native-firsto\.v1:/);
  assert.notEqual(nativeUpgradeSalt(catalog), nativeUpgradeSalt({ ...catalog, candidateArtifactDigest: hash }));
  assert.equal(batch.salt, nativeUpgradeSalt(catalog));
});

test('test batch pins the exact existing proposal, price and Firsto fee epoch', () => {
  const catalog = fixture(), batch = nativeUpgradeBatch(catalog, deployed);
  assert.deepEqual(batch.targets, [catalog.bindings.beacon, catalog.activation.pool]);
  assert.deepEqual(batch.values, [0n, 0n]);
  assert.deepEqual([...native.decodeFunctionData('enableNativeFirstoSale', batch.payloads[1])], [1n, 40000000000000000n, 100n, 1n]);
  const changed = structuredClone(catalog); changed.activation.priceWei = '40000000000000001';
  assert.notEqual(nativeUpgradeBatch(changed, deployed).operationId, batch.operationId);
});

test('new libraries override qualified stale links and PoolVault keeps the current governance library', () => {
  const catalog = fixture(), placeholder = '00'.repeat(20);
  catalog.artifacts.FirstoSale.bytecode = '0x60' + placeholder + '00';
  catalog.artifacts.FirstoSale.linkReferences = { 'src/libraries/SaleSettlement.sol': { SaleSettlement: [{ start: 1, length: 20 }] } };
  catalog.libraries['src/libraries/SaleSettlement.sol:SaleSettlement'] = address(50);
  assert.throws(() => nativeUpgradeDeployment(catalog, 'FirstoSale'), /先确认/);
  assert.equal(nativeUpgradeDeployment(catalog, 'FirstoSale', deployed).slice(4, 44), deployed.SaleSettlement.slice(2));
  catalog.artifacts.PoolVault.bytecode = '0x60' + placeholder + placeholder + '00';
  catalog.artifacts.PoolVault.linkReferences = { 'src/libraries/FirstoSale.sol': { FirstoSale: [{ start: 1, length: 20 }] },
    'src/libraries/SaleGovernance.sol': { SaleGovernance: [{ start: 21, length: 20 }] } };
  const bytes = nativeUpgradeDeployment(catalog, 'PoolVault', deployed);
  assert.equal(bytes.slice(4, 44), deployed.FirstoSale.slice(2));
  assert.equal(bytes.slice(44, 84), catalog.libraries.SaleGovernance.slice(2));
  assert.equal(bytes.slice(-40), catalog.bindings.factory.slice(2));
});

test('both Solidity library self-address guards are patched, and wrong runtime cannot continue', async () => {
  const catalog = fixture();
  for (const name of ['SaleSettlement', 'FirstoSale']) {
    const exact = '0x73' + deployed[name].slice(2) + '6000';
    const methods = [];
    const provider = { async request({ method }) { methods.push(method); return exact; } };
    assert.equal((await verifyNativeUpgradeDeploymentRuntime(provider, catalog, name, deployed[name], deployed)).toLowerCase(), deployed[name]);
    assert.deepEqual(methods, ['eth_getCode']);
    await assert.rejects(verifyNativeUpgradeDeploymentRuntime({ request: async () => exact + '00' }, catalog, name, deployed[name], deployed), /编译不一致/);
  }
});

test('chain state uses the current approved implementation baseline and never accepts another upgrade', async () => {
  const catalog = fixture(), methods = [];
  let implementation = catalog.expectedImplementations.PoolVault;
  const provider = { async request({ method, params }) {
    methods.push(method); assert.equal(method, 'eth_call'); const data = params[0].data;
    if (data.startsWith(beacon.getFunction('implementation').selector)) return beacon.encodeFunctionResult('implementation', [implementation]);
    if (data.startsWith(native.getFunction('nativeFirstoSaleVersion').selector)) return native.encodeFunctionResult('nativeFirstoSaleVersion', [1]);
    const parsed = clock.parseTransaction({ data }); return clock.encodeFunctionResult(parsed.name,
      [{ getMinDelay: 0n, PROPOSER_ROLE: hash, hasRole: true, getTimestamp: implementation === deployed.PoolVault ? 1n : 0n }[parsed.name]]);
  } };
  assert.equal((await readNativeUpgradeStatus(provider, catalog)).activated, false);
  implementation = address(90); await assert.rejects(readNativeUpgradeStatus(provider, catalog), /其他升级/);
  implementation = deployed.PoolVault; const status = await readNativeUpgradeStatus(provider, catalog, deployed);
  assert.equal(status.activated, true); assert.equal(status.timestamp, 1n);
  assert.equal(methods.includes('eth_sendTransaction'), false);
});

test('receipt recovery verifies the saved deployment hash and retains unknown wallet outcomes', async () => {
  const catalog = fixture(), methods = [], step = { hash, status: 'submitted' };
  const provider = { async request({ method }) { methods.push(method);
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: hash, blockHash,
      blockNumber: '0x123', from: catalog.bindings.proposer, to: null, contractAddress: deployed.SaleSettlement };
    if (method === 'eth_getTransactionByHash') return { hash, from: catalog.bindings.proposer, to: null,
      input: '0x6000', value: '0x0', chainId: '0x38', blockHash, blockNumber: '0x123' };
    return '0x73' + deployed.SaleSettlement.slice(2) + '6000';
  } };
  const result = await reconcileNativeUpgradeDeployments(provider, catalog, { SaleSettlement: step }, catalog.bindings.proposer);
  assert.equal(result.deployed.SaleSettlement.toLowerCase(), deployed.SaleSettlement);
  assert.equal(methods.includes('eth_sendTransaction'), false);
  await assert.rejects(reconcileNativeUpgradeDeployments(provider, catalog,
    { SaleSettlement: { status: 'unknown', hash: null } }, catalog.bindings.proposer), /不能重复发送/);
});

test('both one-call formal and two-call test batch events require complete exact receipt evidence', () => {
  for (const catalog of [fixture('formal', false), fixture()]) for (const kind of ['schedule', 'execute']) {
    const batch = nativeUpgradeBatch(catalog, deployed), receipt = receiptFor(catalog, batch, kind);
    assert.equal(verifyNativeUpgradeBatchReceipt(receipt, catalog.bindings.timelock, { kind, batch, delay: 0n }), batch.operationId);
    for (const alter of [r => { r.logs.pop(); }, r => { r.logs.push(r.logs[0]); },
      r => { r.logs[0].address = address(80); }, r => { r.logs[0].removed = true; },
      r => { r.logs[0].transactionHash = blockHash; }, r => { r.logs[0].data += '00'; }]) {
      const changed = structuredClone(receipt); alter(changed);
      assert.throws(() => verifyNativeUpgradeBatchReceipt(changed, catalog.bindings.timelock, { kind, batch, delay: 0n }));
    }
  }
});

test('native receipt recovery accepts the fixed MetaMask wrapper only for the exact native batch', async () => {
  const previous = JSON.parse(await readFile(new URL('./fixtures/sale-upgrade-wrapped-schedule.json', import.meta.url), 'utf8'));
  const runtimeProof = JSON.parse(await readFile(new URL('../../deploy/fixtures/fresh-activation-envelope.json', import.meta.url), 'utf8')).runtimeProof;
  const catalog = fixture(); catalog.bindings.timelock = '0x9021E33Db265CE4253E7f9e79741BB94f119C4A0';
  const batch = nativeUpgradeBatch(catalog, deployed), transaction = scheduleNativeUpgradeTransaction(catalog, batch, 0n);
  const manager = new Interface(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
  const old = manager.decodeFunctionData('redeemDelegations', previous.tx.input);
  const inner = catalog.bindings.timelock.toLowerCase() + '00'.repeat(32) + transaction.data.slice(2);
  const tx = { ...previous.tx, input: manager.encodeFunctionData('redeemDelegations', [[...old[0]], [...old[1]], [inner]]) };
  const receipt = { ...previous.receipt, ...receiptFor(catalog, batch), transactionHash: tx.hash,
    blockNumber: tx.blockNumber, blockHash: tx.blockHash };
  receipt.logs = receipt.logs.map(log => ({ ...log, transactionHash: tx.hash, blockNumber: tx.blockNumber, blockHash: tx.blockHash }));
  const provider = { async request({ method }) { return method === 'eth_getTransactionReceipt' ? receipt : tx; } };
  const expected = { from: tx.from, ...transaction, batchProof: { kind: 'schedule', batch, delay: 0n } };
  const result = await confirmNativeUpgradeTransaction(provider, { hash: tx.hash }, expected, { runtimeProof });
  assert.equal(result.transactionHash, tx.hash);
  tx.input = previous.tx.input;
  await assert.rejects(confirmNativeUpgradeTransaction(provider, { hash: tx.hash }, expected, { runtimeProof }));
});
