import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress, toBeHex } from 'ethers';
import { TargetAvailabilityTracker, ownerAtCreation } from './target-availability.mjs';
import { OFFICIAL_TARGET_MARKET } from './target-listing-evidence.mjs';

const a = n => '0x' + n.toString(16).padStart(40, '0');
const h = n => '0x' + n.toString(16).padStart(64, '0');
const pool = a(1), otherPool = a(2), collection = a(3), seller = a(4), buyer = a(5);
const nft = new Interface(['function ownerOf(uint256) view returns(address)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const mode = new Interface(['function flexiblePurchase() view returns(bool enabled,uint256 referenceCircuitId,(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest) config)']);
const market = new Interface(['function listingFor(address,uint256) view returns(uint256 id,address seller,uint96 price,bool valid)']);
const config = [0n, 0n, 0n, 0n, 0n, 0n, h(0)];
const metadata = (address = pool, id = '11') => ({ address, createdBlock: 5, collection, circuitId: id });
const row = (address = pool, id = 11n, state = 0n) => ({ pool: address, state,
  params: { circuits: collection, circuitId: id, directSeller: ZeroAddress } });
const creation = (address = pool, id = '11') => ({ block_number: 5, tx_index: 2, log_index: 4,
  args: JSON.stringify({ pool: address, circuits: collection, circuitId: id }) });
const transfer = (from, to, { tokenId = 11n, txIndex = 3, logIndex = 6, blockHash = h(5) } = {}) => ({
  ...nft.encodeEventLog(nft.getEvent('Transfer'), [from, to, tokenId]), address: collection,
  blockNumber: 5, blockHash, transactionIndex: txIndex, index: logIndex, transactionHash: h(100 + logIndex), removed: false,
});

function fixture() {
  const calls = [], logs = [], events = [creation()], owners = new Map([['11:5', seller], ['11:10', seller]]),
    modes = new Map([[pool, false]]), headers = new Map([[5, h(5)], [10, h(10)]]);
  let fail = null, hang = null, clock = 1_000_000, official = [0n, ZeroAddress, 0n, false], firstoFailed = false;
  let asks = [];
  const source = { indexedThrough: 10, indexedBlockHash: h(10), indexedTimestamp: 1000 };
  const index = { _header: block => ({ hash: headers.get(block) }), db: { prepare: () => ({ iterate: () => events }) } };
  const provider = {
    getBlock: async block => { calls.push({ name: 'header', block }); return { number: block, hash: headers.get(block) }; },
    getLogs: async request => {
      calls.push({ name: 'transfers', request });
      if (fail === 'transfers') throw new Error('offline');
      return logs.filter(log => request.topics[3].some(topic => topic === log.topics[3]));
    },
    send: async (method, [request, block]) => {
      assert.equal(method, 'eth_call');
      const iface = request.to === collection ? nft : request.to === OFFICIAL_TARGET_MARKET ? market : mode, decoded = iface.parseTransaction(request);
      const key = decoded.name === 'ownerOf' ? `${decoded.args[0]}:${Number(BigInt(block))}` : request.to;
      calls.push({ name: decoded.name, key, block });
      if (fail === key || fail === decoded.name) throw new Error('offline');
      if (hang === key) return new Promise(() => {});
      return iface.encodeFunctionResult(decoded.name, decoded.name === 'ownerOf' ? [owners.get(key)]
        : decoded.name === 'listingFor' ? official : [modes.get(key), 11n, config]);
    },
  };
  return { index, provider, source, calls, logs, events, owners, modes, headers, now: () => clock,
    advance: n => { clock += n; source.indexedTimestamp = Math.floor(clock / 1000); },
    official: value => { official = value; }, asks: value => { asks = value; },
    failFirsto: value => { firstoFailed = value; },
    listingLoader: async (collection, tokenId) => {
      calls.push({ name: 'firsto', key: `${collection}:${tokenId}` });
      if (firstoFailed) throw new Error('Firsto offline');
      return { fetchedAt: new Date(clock).toISOString(), responseDate: new Date(clock).toUTCString(),
        detail: { asset: { collection, tokenId, owner: seller, category: 'official_mining', classification: 'official_mining' },
          orders: { signedAsks: asks, asksAndOnchainBids: [] } } };
    },
    fail: key => { fail = key; }, hang: key => { hang = key; },
    nextBlock: () => { source.indexedThrough++; source.indexedBlockHash = h(source.indexedThrough);
      headers.set(source.indexedThrough, source.indexedBlockHash); },
    tracker: options => new TargetAvailabilityTracker(index, provider, options) };
}

test('fixed Funding and Funded compare canonical creation ownership without changing chain state', async () => {
  for (const state of [0n, 1n]) {
    const f = fixture(), tracker = f.tracker(), current = row(pool, 11n, state);
    let result = (await tracker.capture([current], [metadata()], f.source)).get(pool);
    assert.equal(result.status, 'available'); assert.equal(result.originalOwner, seller);
    assert.equal(result.currentOwner, seller); assert.equal(result.chainState, state); assert.equal(current.state, state);
    assert.equal(result.creationOwnerProof, 'block_end_owner_and_ordered_transfers');
    f.nextBlock(); f.owners.set('11:11', buyer);
    result = (await tracker.capture([current], [metadata()], f.source)).get(pool);
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'target_owner_changed');
    assert.equal(result.observedBlock, 11); assert.equal(result.observedBlockHash, h(11));
    assert.equal(result.chainState, state); assert.equal(current.state, state);
  }
});

test('fixed Funding and Funded delist only after both venues confirm no ask; state and creation proof stay intact', async () => {
  for (const state of [0n, 1n]) {
    const f = fixture(), tracker = f.tracker({ listingLoader: f.listingLoader, now: f.now }), input = row(pool, 11n, state);
    const result = (await tracker.capture([input], [metadata()], f.source)).get(pool);
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'target_listing_unavailable');
    assert.equal(result.currentOwner, seller); assert.equal(result.originalOwner, seller);
    assert.deepEqual(result.listingEvidence, { official: 'absent', firsto: 'absent', observedAt: new Date(f.now()).toISOString(),
      validUntil: new Date(f.now()+60_000).toISOString() });
    assert.equal(result.chainState, state); assert.equal(input.state, state);
  }
});

test('a valid official ask skips Firsto; an official outage plus a valid Firsto ask remains available', async () => {
  const f = fixture(), tracker = f.tracker({ listingLoader: f.listingLoader, now: f.now });
  f.official([7n, seller, 20n, true]); f.failFirsto(true);
  let result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'available'); assert.equal(result.reason, 'target_listing_available');
  assert.equal(f.calls.filter(call => call.name === 'firsto').length, 0);
  f.nextBlock(); f.owners.set('11:11', seller); f.fail('listingFor'); f.failFirsto(false);
  f.asks([{ status: 'open', maker: seller, collection, tokenId: '11', priceWei: '20', expiry: '2000' }]);
  result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'available'); assert.equal(result.listingEvidence.official, 'unknown');
  assert.equal(result.listingEvidence.firsto, 'available');
});

test('an absent official ask with failed Firsto stays unknown, and relisting restores the catalog status', async () => {
  const f = fixture(), tracker = f.tracker({ listingLoader: f.listingLoader, now: f.now }); f.failFirsto(true);
  let result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'target_listing_unverified');
  f.failFirsto(false); f.advance(30_000);
  result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'unavailable');
  f.nextBlock(); f.owners.set('11:11', seller); f.official([8n, seller, 20n, true]);
  result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'available', 'a previous absence is not a permanent cancellation');
});

test('identical fixed targets share listing reads, cache Firsto for 30s, and flexible targets add none', async () => {
  const f = fixture(), tracker = f.tracker({ listingLoader: f.listingLoader, now: f.now });
  f.events.push(creation(otherPool)); f.modes.set(otherPool, false);
  const rows = [row(), row(otherPool)], directory = [metadata(), metadata(otherPool)];
  await tracker.capture(rows, directory, f.source); await tracker.capture(rows, directory, f.source);
  assert.equal(f.calls.filter(call => call.name === 'listingFor').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'firsto').length, 1);
  f.advance(29_000); await tracker.capture(rows, directory, f.source);
  assert.equal(f.calls.filter(call => call.name === 'firsto').length, 1);
  f.advance(1000); await tracker.capture(rows, directory, f.source);
  assert.equal(f.calls.filter(call => call.name === 'firsto').length, 2);
  const flex = fixture(); flex.modes.set(pool, true);
  const result = (await flex.tracker({ listingLoader: flex.listingLoader, now: flex.now }).capture([row()], [metadata()], flex.source)).get(pool);
  assert.equal(result.status, 'not_applicable');
  assert.equal(flex.calls.filter(call => ['listingFor', 'firsto'].includes(call.name)).length, 0);
});

test('old indexed block cannot prove no listing; short-lived Firsto asks are refreshed at expiry', async () => {
  const f = fixture(), tracker = f.tracker({ listingLoader: f.listingLoader, now: f.now }); f.source.indexedTimestamp = 879;
  let result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'unknown');
  assert.equal(f.calls.filter(call => ['listingFor', 'firsto'].includes(call.name)).length, 0);
  f.source.indexedTimestamp = 1000;
  f.asks([{ status: 'open', maker: seller, collection, tokenId: '11', priceWei: '20', expiry: '1001' }]);
  result = (await tracker.capture([row()], [metadata()], f.source)).get(pool); assert.equal(result.status, 'available');
  f.advance(1000); result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'unavailable'); assert.equal(f.calls.filter(call => call.name === 'firsto').length, 2);
});

test('near-expiry delivery cannot gain 30 more seconds of absence proof from the compact cache', async () => {
  const f=fixture();let reads=0;
  const loader=async (...args)=>{
    reads++;const result=await f.listingLoader(...args);
    result.fetchedAt=new Date(f.now()-59_000).toISOString();return result;
  };
  const tracker=f.tracker({listingLoader:loader,now:f.now});
  assert.equal((await tracker.capture([row()],[metadata()],f.source)).get(pool).status,'unavailable');
  f.advance(2000);f.failFirsto(true);
  assert.equal((await tracker.capture([row()],[metadata()],f.source)).get(pool).status,'unknown');
  assert.equal(reads,2,'original delivery freshness bounds the cached absence');
});

test('same-block sale after PoolCreated is reversed rather than mistaken for the original owner', async () => {
  const f = fixture(), tracker = f.tracker();
  f.logs.push(transfer(seller, buyer)); f.owners.set('11:5', buyer); f.owners.set('11:10', buyer);
  const result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.originalOwner, seller); assert.equal(result.currentOwner, buyer);
  assert.equal(result.status, 'unavailable');
  const sameBlock = { indexedThrough: 5, indexedBlockHash: h(5) }, second = f.tracker();
  f.calls.length = 0;
  assert.equal((await second.capture([row()], [metadata()], sameBlock)).get(pool).status, 'unavailable');
  assert.equal(f.calls.filter(call => call.name === 'ownerOf').length, 1,
    'original and current block-end owner reads merge when the block is identical');
});

test('same transaction transfers obey the global event position and multiple transfers reverse in order', () => {
  const next = a(6), logs = [transfer(buyer, next, { txIndex: 3, logIndex: 8 }),
    transfer(seller, buyer, { txIndex: 2, logIndex: 5 }),
    transfer(a(7), seller, { txIndex: 2, logIndex: 3 })];
  assert.equal(ownerAtCreation(next, logs, { txIndex: 2, logIndex: 4 },
    { collection, tokenId: '11', blockNumber: 5, blockHash: h(5) }), seller);
});

test('flexible reference ownership, active pools and portfolio children never become unavailable', async () => {
  const f = fixture(), tracker = f.tracker(); f.modes.set(pool, true); f.owners.set('11:10', buyer);
  let result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'not_applicable'); assert.equal(result.purchaseMode, 'flexible');
  assert.equal(result.reason, 'flexible_reference');
  assert.equal(f.calls.filter(call => ['ownerOf', 'transfers'].includes(call.name)).length, 0);
  f.calls.length = 0;
  result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'not_applicable'); assert.equal(f.calls.length, 0, 'the immutable mode is cached');
  result = (await tracker.capture([row(pool, 11n, 2n)], [metadata()], f.source)).get(pool);
  assert.equal(result.reason, 'pool_not_funding'); assert.equal(f.calls.length, 0);
  result = (await tracker.capture([row(otherPool)], [metadata()], f.source)).get(otherPool);
  assert.equal(result.reason, 'portfolio_child'); assert.equal(f.calls.length, 0);
});

test('target already acquired by its own pool is not an external sale', async () => {
  const f = fixture(); f.owners.set('11:10', pool);
  const result = (await f.tracker().capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'not_applicable'); assert.equal(result.reason, 'target_owned_by_pool');
});

test('persisted mode and baseline avoid historical RPC and aggregate Transfer queries for new targets', async () => {
  const f = fixture(), tracker = f.tracker();
  f.events.push(creation(otherPool, '12')); f.modes.set(otherPool, false);
  f.owners.set('12:5', seller); f.owners.set('12:10', buyer);
  const inputs = [row(), row(otherPool, 12n)], directory = [metadata(), metadata(otherPool, '12')];
  const result = await tracker.capture(inputs, directory, f.source);
  assert.equal(result.get(otherPool).status, 'unavailable');
  assert.equal(f.calls.filter(call => call.name === 'transfers').length, 1);
  assert.deepEqual(f.calls.find(call => call.name === 'transfers').request.topics[3], [toBeHex(11, 32), toBeHex(12, 32)]);
  assert.equal(f.calls.filter(call => call.name === 'header').length, 1);
  const reopened = f.tracker(); reopened.restore(JSON.parse(JSON.stringify(tracker.persisted())));
  f.calls.length = 0; f.fail('transfers');
  const after = await reopened.capture(inputs, directory, f.source);
  assert.equal(after.get(otherPool).status, 'unavailable');
  assert.deepEqual(f.calls.map(call => call.name), ['ownerOf', 'ownerOf']);
  assert(f.calls.every(call => call.block === '0xa'), 'only current owner RPC remains');
});

test('missing creation event, history outage, malformed transfer and current owner outage remain unknown', async () => {
  for (const setup of [
    f => { f.events.length = 0; },
    f => f.fail('11:5'),
    f => f.fail('transfers'),
    f => f.fail('flexiblePurchase'),
    f => f.fail('11:10'),
    f => { f.logs.push(transfer(a(7), buyer)); f.owners.set('11:5', seller); },
    f => { f.logs.push(transfer(seller, buyer, { blockHash: h(99) })); f.owners.set('11:5', buyer); },
    f => { f.logs.push(transfer(seller, buyer), transfer(seller, buyer)); f.owners.set('11:5', buyer); },
  ]) {
    const f = fixture(); f.owners.set('11:10', buyer); setup(f);
    const result = (await f.tracker().capture([row()], [metadata()], f.source)).get(pool);
    assert.equal(result.status, 'unknown', result.reason); assert.equal(result.chainState, 0n);
  }
});

test('a reorg invalidates the cached creation owner and cannot manufacture an unavailable result', async () => {
  const f = fixture(), tracker = f.tracker(); await tracker.capture([row()], [metadata()], f.source);
  f.source.indexedBlockHash = h(100); f.headers.set(10, h(100));
  f.headers.set(5, h(55)); f.owners.set('11:5', buyer); f.owners.set('11:10', buyer);
  let result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'available'); assert.equal(result.originalOwner, buyer); assert.equal(result.creationBlockHash, h(55));
  f.headers.set(5, h(555)); f.fail('11:5');
  result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'unknown'); assert.equal(result.originalOwner, null);
});

test('historical block hash mismatch invalidates both mode and ownership', async () => {
  const f = fixture(); f.provider.getBlock = async () => ({ hash: h(99) });
  const tracker = f.tracker(), result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'creation_block_unverified');
  assert.equal(result.purchaseMode, null); assert.equal(result.originalOwner, null); assert.equal(tracker.persisted().entries.length, 0);
});

test('a timed out owner call stays unknown and overlapping refreshes do not duplicate its underlying RPC', async () => {
  const f = fixture(), tracker = f.tracker({ timeoutMs: 15 });
  await tracker.capture([row()], [metadata()], f.source); f.nextBlock(); f.hang('11:11'); f.calls.length = 0;
  for (let i = 0; i < 2; i++) {
    const result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
    assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'current_owner_unverified');
  }
  assert.equal(f.calls.filter(call => call.name === 'ownerOf').length, 1);
});

test('successful current ownership is read once per exact block hash and refreshed at a new tip or same-height reorg', async () => {
  const f = fixture(), tracker = f.tracker(); await tracker.capture([row()], [metadata()], f.source);
  assert.equal(f.calls.filter(call => call.name === 'ownerOf' && call.block === '0xa').length, 1);
  await tracker.capture([row()], [metadata()], f.source);
  assert.equal(f.calls.filter(call => call.name === 'ownerOf' && call.block === '0xa').length, 1,
    'a repeat display pass at the same canonical tip adds no successful current owner call');
  f.nextBlock(); f.owners.set('11:11', buyer);
  let result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'unavailable');
  assert.equal(f.calls.filter(call => call.name === 'ownerOf' && call.block === '0xb').length, 1);
  f.source.indexedBlockHash = h(111); f.headers.set(11, h(111)); f.owners.set('11:11', seller);
  result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'available', 'a same-height replacement block does not reuse the former fork owner');
  assert.equal(f.calls.filter(call => call.name === 'ownerOf' && call.block === '0xb').length, 2);
  assert.equal(tracker.ownerObservations.size, 1, 'observations from the previous tip are discarded');
});

test('an unknown owner observation is retried on the next pass at the same block', async () => {
  const f = fixture(), tracker = f.tracker(); f.fail('11:10');
  let result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'unknown'); assert.equal(tracker.ownerObservations.size, 0);
  f.fail(null); f.owners.set('11:10', buyer);
  result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'unavailable');
  assert.equal(f.calls.filter(call => call.name === 'ownerOf' && call.block === '0xa').length, 2);
  await tracker.capture([row()], [metadata()], f.source);
  assert.equal(f.calls.filter(call => call.name === 'ownerOf' && call.block === '0xa').length, 2);
});

test('only initial creation mode and owner use historical transport; current ownership remains on ordinary send', async () => {
  const f = fixture(), historical = [], ordinary = [], send = f.provider.send;
  f.provider.sendHistorical = (method, params) => { historical.push(params); return send(method, params); };
  f.provider.send = (method, params) => { ordinary.push(params); return send(method, params); };
  const tracker = f.tracker();
  const result = (await tracker.capture([row()], [metadata()], f.source)).get(pool);
  assert.equal(result.status, 'available'); assert.equal(historical.length, 2);
  assert(historical.every(params => params[1] === '0x5'));
  assert.deepEqual(historical.map(params => params[0].to), [pool, collection]);
  assert.equal(ordinary.length, 1); assert.equal(ordinary[0][0].to, collection); assert.equal(ordinary[0][1], '0xa');
  await tracker.capture([row()], [metadata()], f.source);
  assert.equal(historical.length, 2); assert.equal(ordinary.length, 1, 'same-tip successful current observation is reused');
});
