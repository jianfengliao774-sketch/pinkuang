import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, ZeroAddress, toQuantity } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { prepareAdminAction, readOperatorStatus, OFFICIAL_COLLECTIONS } from '../lib/live-admin.mjs';
const address = value => getAddress(`0x${value.toString(16).padStart(40, '0')}`);
const account = address(1), factory = address(2), lens = address(3), pool = address(4);
const config = { status: 'ready', chainId: 56, factory, lens };
const base = { circuits: OFFICIAL_COLLECTIONS[0], circuitId: '7', targetRaiseWei: '11000', priceCapWei: '10000', fundingHours: '24', purchaseHours: '48' };
function fixture({ operator = account, creationPaused = false } = {}) {
  let timestamp = 1_800_000_000n, chain = '0x38', changeBlock = false;
  const sent = [], simulated = [];
  const provider = { request: async ({ method, params = [] }) => {
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_getBlockByNumber') return { hash: `0x${(changeBlock && params[0] !== 'latest' ? '2' : '1').repeat(64)}`, number: '0x64', timestamp: toQuantity(timestamp) };
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') {
      const parsed = abi.PoolFactory.parseTransaction(params[0]); let result;
      if (parsed.name === 'operator') result = operator;
      else if (parsed.name === 'creationPaused') result = creationPaused;
      else if (parsed.name === 'createPool') { simulated.push(parsed.args[0]); result = pool; }
      else throw new Error(`Unsupported fixture call ${parsed.name}`);
      return abi.PoolFactory.encodeFunctionResult(parsed.fragment, [result]);
    }
    sent.push(method); throw new Error(`Signing or unsupported RPC refused: ${method}`);
  } };
  return { provider, sent, simulated, advance: () => { timestamp += 120n; }, changeChain: () => { chain = '0x1'; }, reorg: () => { changeBlock = true; } };
}
const prepare = (f, fields = {}) => prepareAdminAction({ provider: f.provider, config, account, kind: 'createPool', params: base, ...fields });
test('operator panel checks current Factory authority and only prepares a zero-value create call', async () => {
  const f = fixture();
  const status = await readOperatorStatus({ provider: f.provider, config, account });
  assert.equal(status.isOperator, true); assert.equal(status.account, account);
  const result = await prepare(f); const parsed = abi.PoolFactory.parseTransaction(result.transaction);
  assert.equal(parsed.name, 'createPool'); assert.equal(parsed.args[0].circuitId, 7n);
  assert.equal(parsed.args[0].targetRaise, 11000n); assert.equal(parsed.args[0].priceCap, 10000n);
  assert.equal(parsed.args[0].directSeller, ZeroAddress); assert.equal(parsed.args[0].directPrice, 0n);
  assert.equal(result.unitPriceWei, 110n); assert.equal(result.predictedPool, pool);
  assert.equal(result.transaction.value, '0x0'); assert.equal(result.transaction.from, account);
  assert.deepEqual(f.sent, []);
});
test('relative deadlines freeze at preview and exact calldata is unchanged after login delay', async () => {
  const f = fixture(); const preview = await prepare(f);
  assert.equal(preview.request.params.fundingDeadline, 1_800_000_000n + 24n * 3600n);
  assert.equal(preview.request.params.purchaseDeadline, 1_800_000_000n + 72n * 3600n);
  f.advance();
  const checked = await prepareAdminAction({ provider: f.provider, config, account, ...preview.request });
  assert.deepEqual(checked.transaction, preview.transaction);
  assert(Object.isFrozen(preview.request)); assert(Object.isFrozen(preview.request.params));
});
test('non-operator and paused creation never produce a transaction or simulate a creation', async () => {
  for (const options of [{ operator: address(5) }, { creationPaused: true }]) {
    const f = fixture(options); await assert.rejects(prepare(f));
    assert.equal(f.simulated.length, 0); assert.deepEqual(f.sent, []);
  }
});
test('invalid pool configuration fails closed before creation simulation', async () => {
  for (const params of [
    { ...base, circuits: address(8) }, { ...base, circuitId: '-1' },
    { ...base, targetRaiseWei: '11001' }, { ...base, targetRaiseWei: '0' },
    { ...base, priceCapWei: '11001' }, { ...base, fundingHours: '0' },
    { ...base, purchaseHours: '0' }, { ...base, fundingHours: '0.5' },
    { ...base, fundingDeadline: '1', purchaseDeadline: '2' },
  ]) {
    const f = fixture(); await assert.rejects(prepare(f, { params }));
    assert.equal(f.simulated.length, 0); assert.deepEqual(f.sent, []);
  }
});
test('wrong chain and reorg invalidate operator reads and creation preview', async () => {
  const f = fixture(); f.changeChain(); await assert.rejects(prepare(f), /BSC/);
  const other = fixture(); other.reorg(); await assert.rejects(prepare(other), /状态已变化/);
});
