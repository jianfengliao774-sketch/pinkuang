import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { prepareAdminAction, readOperatorStatus } from '../lib/live-admin.mjs';
import { loadOperatorQuote, operatorQuoteDraft, readMachineRegistry } from '../lib/operator-quotes.mjs';
import { operatorFirstoFixture } from './operator-firsto-fixture.mjs';

const quote = f => loadOperatorQuote({ collection: f.data.quote.collection, tokenId: '7', config: f.config,
  provider: f.provider, fetcher: f.api.fetcher });
const createParams = f => ({ circuits: f.data.quote.collection, circuitId: '7', targetRaiseWei: '10000000000000000',
  priceCapWei: '6000000000000000', fundingHours: '24', purchaseHours: '48' });

test('new registry plus signed Firsto order produces a fixed draft with fee-inclusive cap and exact 100-share rounding', async () => {
  const f = await operatorFirstoFixture(), checked = await quote(f), draft = operatorQuoteDraft(checked);
  assert.equal(checked.chain.registry.supported, true); assert.equal(checked.chain.registry.pool, ZeroAddress);
  assert.equal(checked.chain.firsto.feeWei, '50000000000000');
  assert.equal(draft.params.priceCapWei, '5050000000000001');
  assert.equal(draft.params.targetRaiseWei, '5555000000000100');
  const flex = operatorQuoteDraft(checked, { mode: 'createFlexiblePoolChecked' });
  const cap = (3000000000000000001n * 123456789n + 99999999n) / 100000000n;
  assert.equal(flex.params.priceCapWei, cap.toString(), 'capacity cap formula is unchanged');
  assert(f.calls.every(call => !/send|sign|wallet_/.test(call.method)));
});

test('old deployment, incomplete migration and batch ask never enable Firsto procurement', async () => {
  for (const options of [{ old: true }, { ready: false }]) {
    const f = await operatorFirstoFixture(options), checked = await quote(f);
    assert.equal(checked.chain.firsto, null);
    assert.throws(() => operatorQuoteDraft(checked), /登记/);
    const status = await readOperatorStatus({ provider: f.provider, config: f.config, account: f.account });
    assert.equal(status.machineRegistry.ready, false);
  }
  const f = await operatorFirstoFixture();
  f.data.row.bestAsk.execution.kind = 'circuit_batch_ask';
  f.data.page.sourceFreshness[`circuit_batch_ask_exchange:${f.source.execution.exchange.toLowerCase()}`] = Date.now();
  const checked = await quote(f);
  assert.equal(checked.chain.firsto, null); assert.match(checked.chain.firstoError, /批量/);
});

test('duplicate target displays the existing pool and blocks both fixed and flexible creation before simulation', async () => {
  const f = await operatorFirstoFixture(); f.state.registryPool = f.pool;
  const checked = await quote(f);
  for (const mode of ['createPool', 'createFlexiblePoolChecked'])
    assert.throws(() => operatorQuoteDraft(checked, { mode }), error => error.message.includes(f.pool));
  await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
    kind: 'createPool', params: createParams(f) }), error => error.message.includes(f.pool));
  assert.equal(f.simulations.length, 0);
});

test('registry transport failure cannot be mistaken for an old compatible deployment', async () => {
  const failure = Object.assign(new Error('RPC timeout'), { code: -32005 });
  await assert.rejects(readMachineRegistry({ request: async () => { throw failure; } }, { factory: (await operatorFirstoFixture()).config.factory }), error => error === failure);
});

test('missing or unfinished registry rejects every new creation path, even with an official quote or manual parameters', async () => {
  for (const options of [{ old: true }, { ready: false }]) {
    const f = await operatorFirstoFixture(options), checked = await quote(f);
    const official = { ...checked, chain: { ...checked.chain, official: { id: '45', priceWei: '5000000000000001' } } };
    for (const kind of ['createPool', 'createFlexiblePoolChecked']) {
      assert.throws(() => operatorQuoteDraft(official, { mode: kind }), /登记/);
      await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account,
        kind, params: createParams(f), flexible: {} }), /登记/);
    }
    assert.equal(f.simulations.length, 0);
  }
});

test('pool automatically discovers original Firsto order; preview freezes bytes and reconfirmation never fetches a replacement', async t => {
  const f = await operatorFirstoFixture(); f.state.registryPool = f.pool;
  t.mock.method(globalThis, 'fetch', f.api.fetcher);
  const preview = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account, kind: 'buyFromFirsto', pool: f.pool });
  const parsed = abi.PoolVault.parseTransaction(preview.transaction);
  assert.equal(parsed.name, 'buyFromFirsto'); assert.equal(parsed.args[0], 0n);
  assert.equal(preview.transaction.value, '0x0'); assert.equal(preview.transaction.to, f.pool);
  assert.equal(preview.firsto.grossWei, '5050000000000001');
  assert.equal(preview.request.firstoOrder, parsed.args[1]); assert(Object.isFrozen(preview.request));
  const requests = f.api.requests.length;
  f.data.page.rows = []; // A newer API response must not silently change the already-reviewed order.
  const confirmed = await prepareAdminAction({ provider: f.provider, config: f.config, account: f.account, ...preview.request });
  assert.deepEqual(confirmed.transaction, preview.transaction); assert.equal(f.api.requests.length, requests);
  f.state.cancelled = true;
  await assert.rejects(prepareAdminAction({ provider: f.provider, config: f.config, account: f.account, ...preview.request }), /撤销/);
  assert.equal(f.api.requests.length, requests); assert.equal(f.simulations.length, 2);
});

test('fee-inclusive cap, target identity and pool registration are checked before Firsto simulation', async t => {
  const f = await operatorFirstoFixture(); f.state.registryPool = f.pool;
  t.mock.method(globalThis, 'fetch', f.api.fetcher);
  const input = { provider: f.provider, config: f.config, account: f.account, kind: 'buyFromFirsto', pool: f.pool };
  f.rows[0].params.priceCap = 5000000000000001n; // Seller price fits, source fee does not.
  await assert.rejects(prepareAdminAction(input), /总价超过/);
  f.rows[0].params.priceCap = 10000000000000000n;
  const preview = await prepareAdminAction(input);
  f.rows[0].params.circuitId = 8n;
  await assert.rejects(prepareAdminAction({ ...input, ...preview.request }), /不是矿池原目标/);
  f.rows[0].params.circuitId = 7n; f.state.registryPool = ZeroAddress;
  await assert.rejects(prepareAdminAction({ ...input, ...preview.request }), /登记不属于/);
  assert.equal(f.simulations.length, 1);
});
