import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress, toQuantity } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { isSaleReferenceAdministrator, prepareFirstoSaleReference, confirmFirstoSaleReference,
  matchingReferenceStatus, waitForFirstoSaleReference } from '../lib/firsto-sale-reference.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const pool = address(1), market = address(2), adminOne = address(3), adminTwo = address(4), authority = address(5);
const collection = getAddress('0xb1024b89886b9a34aa4ff5f31c411d708b20a14c');
const now = 1790904988000, hash = `0x${'ab'.repeat(32)}`, foreign = `0x${'cd'.repeat(32)}`;
const config = { stage: 'fresh-active', authority, shareMarket: market,
  freshAuthority: { address: authority, administratorOne: adminOne, administratorTwo: adminTwo } };
const params = { circuits: collection, circuitId: 16736n, targetRaise: 44440000000000000n,
  priceCap: 40400000000000000n, directSeller: address(7), directPrice: 0n,
  fundingDeadline: 1790986405n, purchaseDeadline: 1791159205n };
const detail = () => ({ asset: { collection, tokenId: '16736', owner: pool, category: 'official_mining',
  classification: 'unknown', mining: { status: 'verified', weight: '1', verifiedWeight: '1', unverifiedWeight: '0',
    estimated24hAtomic: '432000', tokenSymbol: 'BEM', tokenDecimals: 8, sourceBlock: '125205383' } } });
const reference = () => ({ tokenSymbol: 'BEM', tokenDecimals: 8,
  asOf: '2026-10-02T01:35:39.892Z', sourceBlock: '125205441', viewId: 'hv4225-p190538',
  coverage: { holders: 'complete', market24h: 'complete' },
  marketStats: { dailyCapacityPriceWei: '7971375750399867057' } });
function fixture(changes = {}) {
  const calls = []; const provider = { async request(input) {
    calls.push(input); assert(['eth_call', 'eth_getBlockByNumber'].includes(input.method));
    if (input.method === 'eth_call') return abi.PoolVault.encodeFunctionResult('params', [params]);
    assert.deepEqual(input.params, ['0x7767b87', false]);
    return { number: toQuantity(125205383n), timestamp: toQuantity(BigInt((changes.miningAt ?? 1790904900000) / 1000)) };
  } };
  return { calls, input: { config, provider, account: adminOne, pool, params, now: () => now,
    detailLoader: async () => detail(), referenceLoader: async () => reference(), ...changes } };
}

test('single-admin and either formal administrator may prepare an exact reference; visitors cannot', async () => {
  assert.equal(isSaleReferenceAdministrator(config, adminOne), true);
  assert.equal(isSaleReferenceAdministrator(config, adminTwo), true);
  assert.equal(isSaleReferenceAdministrator({ ...config, freshAuthority: { ...config.freshAuthority, administratorTwo: adminOne } }, adminOne), true);
  assert.equal(isSaleReferenceAdministrator(config, address(99)), false);
  assert.equal(isSaleReferenceAdministrator({ ...config, authority: address(99) }, adminOne), false);
  const f = fixture({ account: address(99) });
  await assert.rejects(prepareFirstoSaleReference(f.input), /管理员/);
  assert.equal(f.calls.length, 0);
});

test('actual Firsto 16736 market reference uses ceil only at wei and binds source evidence', async () => {
  const f = fixture(); const result = await prepareFirstoSaleReference(f.input);
  // 7971375750399867057 * 432000 / 1e8 = 34436343241727425.68624 wei.
  assert.equal(result.args.priceWei, '34436343241727426');
  assert.equal(result.args.observedAt, '1790904900', 'Publish source observation, never the browser retrieval time.');
  assert.equal(result.estimated24hAtomic, 432000n);
  assert.equal(result.args.market, market); assert.equal(result.args.pool, pool);
  assert.match(result.args.digest, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(f.calls.map(input => input.method), ['eth_getBlockByNumber'], 'Parent identity avoids another Pool getter.');
  const other = fixture({ pool: address(8), detailLoader: async () => ({ asset: { ...detail().asset, owner: address(8) } }) });
  assert.notEqual((await prepareFirstoSaleReference(other.input)).args.digest, result.args.digest);
});

test('missing parent params uses one business getter and both official quote reads overlap', async () => {
  const f = fixture({ params: undefined }); let started = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.input.detailLoader = async () => { started++; await gate; return detail(); };
  f.input.referenceLoader = async () => { started++; await gate; return reference(); };
  const task = prepareFirstoSaleReference(f.input);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(started, 2); release();
  await task;
  assert.deepEqual(f.calls.map(input => input.method), ['eth_call', 'eth_getBlockByNumber']);
});

test('wrong identity, stale sources, incomplete market and malformed units produce no signed action', async () => {
  const cases = [
    { detailLoader: async () => ({ asset: { ...detail().asset, owner: address(9) } }) },
    { detailLoader: async () => ({ asset: { ...detail().asset, tokenId: '16737' } }) },
    { detailLoader: async () => ({ asset: { ...detail().asset, mining: { ...detail().asset.mining, estimated24hAtomic: '0' } } }) },
    { referenceLoader: async () => ({ ...reference(), coverage: { holders: 'complete', market24h: 'partial' } }) },
    { referenceLoader: async () => ({ ...reference(), asOf: new Date(now - 300001).toISOString() }) },
    { referenceLoader: async () => ({ ...reference(), tokenDecimals: 18 }) },
    { miningAt: now - 301000 },
    { miningAt: now + 1000 },
    { referenceLoader: async () => { throw new Error('Firsto unavailable'); } },
  ];
  for (const changes of cases) await assert.rejects(prepareFirstoSaleReference(fixture(changes).input));
});

test('only the exact resulting business price, observation and digest confirms this update', async () => {
  const result = await prepareFirstoSaleReference(fixture().input), args = result.args;
  const views = new Interface(['function saleReference(address) view returns(uint128 marketPriceWei,uint64 observedAt,bytes32 sourceDigest)']);
  const provider = values => ({ async request(input) {
    assert.equal(input.method, 'eth_call'); assert.equal(input.params[0].to, market);
    assert.equal(views.parseTransaction(input.params[0]).args[0], pool);
    return views.encodeFunctionResult('saleReference', values);
  } });
  assert.equal(await confirmFirstoSaleReference(provider([args.priceWei, args.observedAt, args.digest]), args), true);
  await assert.rejects(confirmFirstoSaleReference(provider([args.priceWei, args.observedAt, foreign]), args), /本次/);
  await assert.rejects(confirmFirstoSaleReference(provider([1n, args.observedAt, args.digest]), args), /本次/);
});

test('receipt tracking ignores foreign hashes and wrong action kinds before this exact update confirms', async () => {
  let clock = 0, reads = 0; const seen = [];
  const statuses = [{ status: 'confirmed', hash: foreign, kind: 'setSaleReference' },
    { status: 'confirmed', hash, kind: 'claimFees' }, { status: 'pending', hash, kind: 'setSaleReference' },
    { status: 'confirmed', hash, kind: 'setSaleReference' }];
  const result = await waitForFirstoSaleReference({ config, account: adminOne, hash,
    now: () => clock, sleep: async ms => { clock += ms; },
    statusReader: async () => statuses[reads++], onStatus: status => seen.push(status.status) });
  assert.equal(result.hash, hash); assert.equal(reads, 4); assert.deepEqual(seen, ['pending', 'confirmed']);
  assert.equal(matchingReferenceStatus(statuses[0], hash), false);
});

test('failed, cancelled and timed-out trackers never manufacture success or resubmit', async () => {
  let clock = 0, reads = 0;
  await assert.rejects(waitForFirstoSaleReference({ config, account: adminOne, hash, now: () => clock,
    sleep: async ms => { clock += ms; }, timeoutMs: 9000,
    statusReader: async () => { reads++; return { status: 'confirmed', hash: foreign, kind: 'setSaleReference' }; } }), error => error.pending && error.hash === hash);
  assert.equal(reads, 3);
  await assert.rejects(waitForFirstoSaleReference({ config, account: adminOne, hash,
    statusReader: async () => ({ status: 'failed', hash, kind: 'setSaleReference' }) }), error => error.terminal && error.hash === hash);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(waitForFirstoSaleReference({ config, account: adminOne, hash, signal: abort.signal,
    statusReader: async () => assert.fail('Cancelled tracking must not read') }), { name: 'AbortError' });
});
