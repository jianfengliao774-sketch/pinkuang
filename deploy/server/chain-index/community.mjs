import { Interface } from 'ethers';

const binding = new Interface(['function isPool(address) view returns(bool)', 'function factory() view returns(address)']);
const states = ['Funding', 'Funded', 'Active', 'Listed', 'Closed', 'Refunding'];
const match = condition => { if (!condition) throw new Error('Community snapshot is incomplete or unsupported.'); };
const address = value => {
  match(/^0x[0-9a-f]{40}$/i.test(String(value)) && !/^0x0{40}$/i.test(String(value)));
  return String(value).toLowerCase();
};
const uint = value => {
  match(/^(0|[1-9]\d*)$/.test(String(value)));
  const result = BigInt(value); match(result < 2n ** 256n); return result;
};
const integer = value => {
  const result = Number(uint(value)); match(Number.isSafeInteger(result)); return result;
};

/** Verify immutable creation data and current state independently at one confirmed block. */
export async function verifyCommunityPool(pool, event, call, { factory, indexedThrough, indexedTimestamp }) {
  const args = event.args;
  match(address(event.address) === address(factory) && address(args.pool) === address(pool.address)
    && address(args.circuits) === address(pool.collection) && String(args.circuitId) === String(pool.circuitId)
    && integer(event.blockNumber) === integer(pool.createdBlock) && event.blockNumber <= indexedThrough
    && integer(event.timestamp) <= indexedTimestamp && /^0x[0-9a-f]{64}$/i.test(event.txHash));
  integer(event.logIndex);
  const [params, stateValue, unitValue, supplyValue, raisedValue, registered, ownerFactory, depositPaused] = await Promise.all([
    call('params'), call('state'), call('unitPriceWei'), call('totalSupply'), call('totalRaised'),
    call('isPool', [pool.address], factory), call('factory'), call('depositPaused'),
  ]);
  const target = uint(params.targetRaise), unit = uint(unitValue), supply = uint(supplyValue), raised = uint(raisedValue);
  const state = integer(stateValue), deadline = integer(params.fundingDeadline), purchaseDeadline = integer(params.purchaseDeadline);
  match(registered === true && address(ownerFactory) === address(factory) && typeof depositPaused === 'boolean'
    && state < states.length && address(params.circuits) === address(pool.collection)
    && target === uint(args.targetRaise) && target > 0n && target % 100n === 0n && unit === target / 100n
    && uint(params.priceCap) === uint(args.priceCap) && uint(params.priceCap) > 0n && uint(params.priceCap) <= target
    && supply <= 100n && raised === supply * unit && deadline > event.timestamp && purchaseDeadline > deadline);
  // Refunding retains its issued shares and totalRaised even after BNB has been withdrawn.
  // Only withdrawDeposit in Funding burns shares and reduces totalRaised by the same amount.
  match(state === 0 ? supply < 100n : state === 5 || supply === 100n);
  const actualCircuitId = uint(params.circuitId).toString();
  if ([0, 1, 5].includes(state)) match(actualCircuitId === uint(args.circuitId).toString());
  return { address: address(pool.address), createdBlock: integer(pool.createdBlock), createdAt: integer(event.timestamp),
    eventId: `${event.txHash.toLowerCase()}:${event.logIndex}`, collection: address(pool.collection),
    circuitId: uint(args.circuitId).toString(), actualCircuitId, targetRaiseWei: target.toString(),
    unitPriceWei: unit.toString(), totalShares: 100, subscribedShares: Number(supply), state: states[state],
    fundingDeadline: deadline, depositPaused, verified: true };
}

export async function communityPage(index, iface, options = {}) {
  if (index.communityReadInFlight) throw new Error('Community snapshot read already running.');
  index.communityReadInFlight = true;
  try { return await buildPage(index, iface, options); }
  finally { index.communityReadInFlight = false; }
}

async function buildPage(index, iface, { cursor = 0, limit = 5, atBlock, atHash, anchorBlock, anchorHash } = {}) {
  const deadline = Date.now() + 20_000;
  const bounded = async (action, capMs = 20_000) => {
    const remaining = Math.min(deadline - Date.now(), capMs);
    if (remaining <= 0) throw new Error('Community snapshot read deadline exceeded.');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Community snapshot read deadline exceeded.')), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  const source = index.status();
  match(source.complete && /^0x[0-9a-f]{64}$/.test(source.indexedBlockHash)
    && Number.isSafeInteger(source.indexedThrough) && source.indexedThrough >= 0
    && Number.isSafeInteger(source.indexedTimestamp) && source.indexedTimestamp >= 0
    && Number.isSafeInteger(cursor) && cursor >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 10);
  if (atBlock !== undefined || atHash !== undefined) match(atBlock === source.indexedThrough && atHash === source.indexedBlockHash);
  if (anchorBlock !== undefined || anchorHash !== undefined) match(Number.isSafeInteger(anchorBlock) && anchorBlock >= 0
    && anchorBlock <= source.indexedThrough && /^0x[0-9a-f]{64}$/.test(anchorHash)
    && index._header(anchorBlock)?.hash === anchorHash);
  const key = `${source.indexedThrough}:${source.indexedBlockHash}`;
  if (index.communityCache?.key !== key) index.communityCache = { key, pools: new Map() };
  // pools() excludes portfolio children. A malformed or unsupported standalone
  // pool must not stop announcements for every other verified pool.
  const cache = index.communityCache, page = index.pools({ cursor, limit }), items = [], invalidPools = [];
  for (const pool of page.items) {
    try {
      if (!cache.pools.has(pool.address)) {
        const rows = index.db.prepare(`SELECT l.block_number AS blockNumber,l.log_index AS logIndex,l.tx_hash AS txHash,
          l.address,l.args,h.timestamp FROM logs l JOIN headers h ON h.number=l.block_number
          WHERE l.kind='factory' AND l.name='PoolCreated' AND l.address=? AND json_extract(l.args,'$.pool')=?
          ORDER BY l.block_number,l.tx_index,l.log_index LIMIT 2`).all(source.factory, pool.address);
        match(rows.length === 1);
        const call = async (name, args = [], to = pool.address) => {
          const decoder = name === 'isPool' || name === 'factory' ? binding : iface;
          const response = await bounded(() => index.provider.call({ to,
            data: decoder.encodeFunctionData(name, args), blockTag: source.indexedThrough }), 4_000);
          return decoder.decodeFunctionResult(name, response)[0];
        };
        cache.pools.set(pool.address, await verifyCommunityPool(pool, { ...rows[0], args: JSON.parse(rows[0].args) }, call, source));
      }
      items.push(cache.pools.get(pool.address));
    } catch {
      invalidPools.push(pool.address);
    }
  }
  const canonical = await bounded(() => index.provider.getBlock(source.indexedThrough));
  const current = index.status();
  match(current.complete && current.indexedThrough === source.indexedThrough && current.indexedBlockHash === source.indexedBlockHash
    && canonical?.number === source.indexedThrough && canonical?.hash?.toLowerCase() === source.indexedBlockHash);
  return { schemaVersion: 1, items, invalidPools, nextCursor: page.nextCursor,
    anchorVerified: anchorBlock === undefined ? null : true };
}
