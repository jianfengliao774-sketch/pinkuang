import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { fetchMineDetail, FIRSTO_SOURCE, MAX_QUOTE_AGE_MS, OFFICIAL_COLLECTIONS } from '../../deploy/src/pricing.ts';
import { abi, CHAIN_ID, uint } from './chain-client.mjs';
import { QUOTE_BASE } from './quote-base.mjs';

const OFFICIAL_MARKET = getAddress('0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f');
const MARKET = new Interface(['function listingFor(address,uint256) view returns(uint256 id,address seller,uint96 price,bool valid)']);
const OFFICIAL_MARKET_SOURCE = `https://bscscan.com/address/${OFFICIAL_MARKET}`;
const NFT = new Interface(['function ownerOf(uint256) view returns(address)']);
const OFFICIAL = new Set(Object.values(OFFICIAL_COLLECTIONS).map(value => value.toLowerCase()));
const BEM_ATOMIC_PER_TOKEN = 100_000_000n;
const TOTAL_SHARES = 100n;
const unavailable = reason => Object.freeze({ available: false, reason });
const exactDecimal = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? uint(value) : null;
function blockTime(header, number) {
  if (!/^0x[\da-f]{64}$/i.test(header?.hash ?? '') ||
      !/^0x[\da-f]+$/i.test(header?.number ?? '') ||
      !/^0x[\da-f]+$/i.test(header?.timestamp ?? '') ||
      BigInt(header.number) !== number) return null;
  const millis = BigInt(header.timestamp) * 1000n;
  return millis > 0n && millis <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(millis) : null;
}

/** Display-only Firsto metadata; incomplete or conflicting weights stay unknown. */
export function parseMinerDisplayMetadata(mining) {
  const rawTask = exactDecimal(mining?.taskId);
  const task = rawTask !== null && rawTask < 2n ** 32n ? rawTask : null;
  const verified = exactDecimal(mining?.verifiedWeight);
  const unverified = exactDecimal(mining?.unverifiedWeight);
  const weight = exactDecimal(mining?.weight);
  const validWeights = verified !== null && unverified !== null && weight !== null
    && weight === verified + unverified && weight > 0n;
  const classification = validWeights && task !== null
    ? mining.status === 'verified' && task > 0n && verified > 0n && unverified === 0n ? 'verified'
      : mining.status === 'unverified' && task === 0n && verified === 0n && unverified > 0n ? 'unverified' : null
    : null;
  return Object.freeze({ taskId: task !== null ? task.toString() : null,
    miningClassification: classification, hashPower: classification ? weight.toString() : null });
}

/** Whole-miner equivalent per one BEM/day, using Firsto's integer floor convention. */
export function shareDailyCapacityPriceWei(pricePerUnitWei, estimated24hAtomic) {
  const price = uint(pricePerUnitWei), daily = uint(estimated24hAtomic);
  if (daily === 0n) throw new Error('Estimated daily BEM output is unavailable.');
  const numerator = price * TOTAL_SHARES * BEM_ATOMIC_PER_TOKEN;
  return numerator / daily;
}

/** Whole-miner price / this NFT's gross daily output; never a class average. */
export function minerDailyCapacityPriceWei(priceWei, estimated24hAtomic) {
  const price = uint(priceWei), daily = uint(estimated24hAtomic);
  if (daily === 0n) throw new Error('Estimated daily BEM output is unavailable.');
  return price * BEM_ATOMIC_PER_TOKEN / daily;
}

/** Display quote only. Bids, expired orders and another NFT's asks cannot supply its price. */
export function minerAskPriceWei(detail, now = Date.now()) {
  const asset = detail?.asset;
  if (!asset || exactDecimal(asset.tokenId) === null || !Number.isSafeInteger(now) || now <= 0) return null;
  const groups = [detail.orders?.signedAsks, detail.orders?.asksAndOnchainBids];
  let best = null;
  for (const [group, orders] of groups.entries()) {
    if (!Array.isArray(orders) || orders.length > 500) continue;
    for (const order of orders) {
      try {
        const price = exactDecimal(order.priceWei);
        const expiry = order.expiry ?? order.expiresAt;
        if (order.status !== 'open' || (order.side != null && order.side !== 'ask')
          || (order.side == null && group !== 0)
          || getAddress(order.collection) !== getAddress(asset.collection)
          || exactDecimal(order.tokenId) !== exactDecimal(asset.tokenId)
          || getAddress(order.maker) !== getAddress(asset.owner)
          || (order.chainId != null && BigInt(order.chainId) !== CHAIN_ID)
          || price === null || price === 0n
          || (expiry != null && (!/^(0|[1-9]\d*)$/.test(String(expiry))
            || BigInt(expiry) * 1000n <= BigInt(now)))) continue;
        if (best === null || price < best) best = price;
      } catch { /* An incomplete external order is not a display price. */ }
    }
  }
  return best;
}

/** Only callers displaying a fundraising miner ask pay for these reads. */
async function readOfficialAsk(request, collection, tokenId, tag, knownOwner) {
  const read = (to, iface, name, args) => Promise.resolve().then(() => request('eth_call', [{ to,
    data: iface.encodeFunctionData(name, args) }, tag])).then(value => iface.decodeFunctionResult(name, value));
  const [ownerResult, listingResult] = await Promise.allSettled([
    knownOwner === undefined ? read(collection, NFT, 'ownerOf', [tokenId]).then(value => value[0])
      : Promise.resolve(knownOwner),
    read(OFFICIAL_MARKET, MARKET, 'listingFor', [collection, tokenId]),
  ]);
  let owner = null;
  try { if (ownerResult.status === 'fulfilled' && getAddress(ownerResult.value) !== ZeroAddress)
    owner = getAddress(ownerResult.value); } catch { /* Keep the output estimate when an owner read fails. */ }
  if (!owner || listingResult.status !== 'fulfilled') return { owner, status: 'unavailable', price: null };
  try {
    const listing = listingResult.value;
    const ready = listing.valid === true && listing.id > 0n && listing.price > 0n
      && getAddress(listing.seller) === owner;
    return { owner, status: ready ? 'ready' : 'absent', price: ready ? listing.price : null };
  } catch { return { owner, status: 'unavailable', price: null }; }
}

function minerAskContext(detail, now, includeOfficialAsk, official) {
  let firsto = minerAskPriceWei(detail, now);
  if (includeOfficialAsk) {
    // The fallback seller must still own this NFT, even if Firsto has an older owner snapshot.
    try { if (!official?.owner || getAddress(detail.asset.owner) !== official.owner) firsto = null; }
    catch { firsto = null; }
  }
  const price = official?.price ?? firsto;
  const source = official?.price != null ? 'official' : firsto != null ? 'firsto' : null;
  const sourceUrl = source === 'official' ? OFFICIAL_MARKET_SOURCE : source === 'firsto' ? FIRSTO_SOURCE : null;
  return { includeOfficialAsk, officialAskStatus: includeOfficialAsk ? official.status : 'not_requested',
    minerAskPriceWei: price, minerAskSource: source, minerAskSourceUrl: sourceUrl,
    miningSourceUrl: FIRSTO_SOURCE, sourceUrl: sourceUrl ?? FIRSTO_SOURCE };
}

/** Listed pools use their approved sale price; fundraising uses the miner ask and mining uses acquisition cost. */
export function poolDailyCapacityPriceWei(pool, quote) {
  if (!quote?.available || typeof quote.estimated24hAtomic !== 'bigint'
    || quote.estimated24hAtomic <= 0n || pool?.kind === 'portfolio') return null;
  const price = pool?.status === 'Listed' ? pool.salePrice
    : ['Funding', 'Funded'].includes(pool?.status) ? quote.minerAskPriceWei : pool?.purchaseCost;
  return typeof price === 'bigint' && price > 0n
    ? minerDailyCapacityPriceWei(price, quote.estimated24hAtomic) : null;
}

/**
 * Display-only quote. The PoolVault's *current* params identify the purchased
 * NFT even after an alternative miner replaces the original target. A failed
 * external quote must never block or modify the separately verified order.
 */
export async function readShareDailyCapacityPrice(provider, {
  factory: factoryInput, pool: poolInput, pricePerUnitWei,
  allowUnownedTarget = false, includeOfficialAsk = false,
  displayOnly = false, params: displayParams,
  blockNumber, now = Date.now(), quoteLoader = (collection, tokenId) =>
    fetchMineDetail(collection, tokenId, { baseUrl: QUOTE_BASE, displayOnly: true }),
} = {}) {
  try {
    if (!provider?.request || !Number.isSafeInteger(now) || now <= 0 || typeof quoteLoader !== 'function'
      || typeof includeOfficialAsk !== 'boolean' || typeof allowUnownedTarget !== 'boolean') {
      return unavailable('invalid_input');
    }
    const factory = getAddress(factoryInput), pool = getAddress(poolInput);
    if (factory === ZeroAddress || pool === ZeroAddress) return unavailable('invalid_input');
    const price = uint(pricePerUnitWei);
    const request = (method, params = []) => provider.request({ method, params });
    if (displayOnly) {
      // Daily output reuses the loaded identity. Official asks are opt-in for fundraising views.
      const params = displayParams ?? abi.PoolVault.decodeFunctionResult('params',
        await request('eth_call', [{ to: pool, data: abi.PoolVault.encodeFunctionData('params') }, 'latest']))[0];
      const collection = getAddress(params.circuits), tokenId = uint(params.circuitId).toString();
      if (includeOfficialAsk && !OFFICIAL.has(collection.toLowerCase())) return unavailable('unsupported_miner');
      const detail = await quoteLoader(collection, tokenId);
      const mining = detail?.asset?.mining;
      if (includeOfficialAsk && (!detail?.asset || getAddress(detail.asset.collection) !== collection
        || exactDecimal(detail.asset.tokenId)?.toString() !== tokenId
        || detail.asset.category !== 'official_mining' || detail.asset.classification !== 'official_mining'
        || mining?.tokenSymbol !== 'BEM' || mining?.tokenDecimals !== 8)) return unavailable('quote_identity');
      const dailyAtomic = exactDecimal(mining?.estimated24hAtomic);
      const metadata = parseMinerDisplayMetadata(mining);
      const context = { pool, collection, tokenId, sourceBlock: null,
        miningSourceBlock: exactDecimal(mining?.sourceBlock), observedAt: now,
        validUntil: now + MAX_QUOTE_AGE_MS, displayOnly: true, allowUnownedTarget, ...metadata };
      if (mining?.status !== 'verified' || dailyAtomic === null || dailyAtomic === 0n)
        return Object.freeze({ ...unavailable('missing_output'), ...context, metadataAvailable: true });
      // No ask request can help a missing/invalid daily estimate; keep those RPCs opt-in and last.
      const official = includeOfficialAsk ? await readOfficialAsk(request, collection, tokenId, 'latest') : null;
      return Object.freeze({ available: true, ...context, metadataAvailable: true,
        estimated24hAtomic: dailyAtomic, pricePerUnitWei: price,
        priceWeiPerDailyBem: shareDailyCapacityPriceWei(price, dailyAtomic),
        ...minerAskContext(detail, now, includeOfficialAsk, official),
        marketReferencePriceWei: exactDecimal(detail.asset?.listingReference?.dailyCapacityPriceWei),
        basis: 'gross_estimated_output' });
    }
    const requestedTag = blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber));
    const [initialChainId, initialBlock] = await Promise.all([
      request('eth_chainId'), request('eth_getBlockByNumber', [requestedTag, false]),
    ]);
    if (BigInt(initialChainId) !== CHAIN_ID) return unavailable('wrong_chain');
    let block = initialBlock;
    let pinnedNumber = /^0x[\da-f]+$/i.test(block?.number ?? '') ? BigInt(block.number) : null;
    let pinnedAt = pinnedNumber === null ? null : blockTime(block, pinnedNumber);
    if (pinnedAt === null || (blockNumber !== undefined && pinnedNumber !== uint(blockNumber)) ||
        pinnedAt > now + 30_000 || now - pinnedAt > MAX_QUOTE_AGE_MS) return unavailable('invalid_block');
    let tag = toQuantity(pinnedNumber);
    const call = async (address, iface, name, args = []) => {
      const result = await request('eth_call', [{ to: address, data: iface.encodeFunctionData(name, args) }, tag]);
      return iface.decodeFunctionResult(name, result)[0];
    };
    const [registered, backlink, params] = await Promise.all([
      call(factory, abi.PoolFactory, 'isPool', [pool]),
      call(pool, abi.PoolVault, 'factory'),
      call(pool, abi.PoolVault, 'params'),
    ]);
    if (!registered || getAddress(backlink) !== factory) return unavailable('untrusted_pool');
    const collection = getAddress(params.circuits), tokenId = uint(params.circuitId).toString();
    if (!OFFICIAL.has(collection.toLowerCase())) return unavailable('unsupported_miner');
    // Both reads use the same identity checked above. Keep the ownership and
    // Firsto identity comparisons below before exposing any display price.
    const [owner, detail] = await Promise.all([
      call(collection, NFT, 'ownerOf', [tokenId]), quoteLoader(collection, tokenId),
    ]);
    if (getAddress(owner) !== pool && !allowUnownedTarget) return unavailable('miner_not_in_pool');

    // The exact Firsto detail endpoint covers pool-owned NFTs even when they
    // have no active sell order or are absent from three pages of text search.
    const asset = detail?.asset, mining = asset?.mining;
    if (!asset || !mining || getAddress(asset.collection) !== collection ||
        exactDecimal(asset.tokenId)?.toString() !== tokenId || getAddress(asset.owner) !== getAddress(owner) ||
        asset.category !== 'official_mining' || asset.classification !== 'official_mining' ||
        mining.tokenSymbol !== 'BEM' || mining.tokenDecimals !== 8 || !['verified', 'unverified'].includes(mining.status)) {
      return unavailable('quote_identity');
    }
    const dailyAtomic = exactDecimal(mining.estimated24hAtomic);
    const miningSourceBlock = exactDecimal(mining.sourceBlock);
    if (miningSourceBlock === null) return unavailable('stale_quote');
    // The external request can finish after the initially pinned block. For a
    // live read only, pin again and recheck every identity at the newer block.
    // Explicit historical reads never advance beyond the requested snapshot.
    if (miningSourceBlock > pinnedNumber) {
      if (blockNumber !== undefined) return unavailable('stale_quote');
      block = await request('eth_getBlockByNumber', ['latest', false]);
      pinnedNumber = /^0x[\da-f]+$/i.test(block?.number ?? '') ? BigInt(block.number) : null;
      pinnedAt = pinnedNumber === null ? null : blockTime(block, pinnedNumber);
      if (pinnedAt === null || pinnedNumber < miningSourceBlock || pinnedAt > now + 30_000 ||
          now - pinnedAt > MAX_QUOTE_AGE_MS) return unavailable('stale_quote');
      tag = toQuantity(pinnedNumber);
      const [registeredNow, backlinkNow, paramsNow, ownerNow] = await Promise.all([
        call(factory, abi.PoolFactory, 'isPool', [pool]), call(pool, abi.PoolVault, 'factory'),
        call(pool, abi.PoolVault, 'params'), call(collection, NFT, 'ownerOf', [tokenId]),
      ]);
      if (!registeredNow || getAddress(backlinkNow) !== factory) return unavailable('untrusted_pool');
      if (getAddress(paramsNow.circuits) !== collection || uint(paramsNow.circuitId).toString() !== tokenId ||
          getAddress(ownerNow) !== getAddress(owner)) return unavailable('quote_identity');
    }
    const sourceTag = toQuantity(miningSourceBlock);
    const sourceHeader = sourceTag === tag ? block : await request('eth_getBlockByNumber', [sourceTag, false]);
    const observedAt = blockTime(sourceHeader, miningSourceBlock);
    if (observedAt === null || observedAt > pinnedAt || observedAt > now + 30_000 ||
        now - observedAt > MAX_QUOTE_AGE_MS) return unavailable('stale_quote');
    const official = includeOfficialAsk && mining.status === 'verified' && dailyAtomic > 0n
      ? await readOfficialAsk(request, collection, tokenId, tag, owner) : null;
    const afterPromise = request('eth_getBlockByNumber', [tag, false]);
    const [after, sourceAfter, finalChainId] = await Promise.all([
      afterPromise,
      sourceTag === tag ? afterPromise : request('eth_getBlockByNumber', [sourceTag, false]),
      request('eth_chainId'),
    ]);
    if (after?.hash !== block.hash || blockTime(after, pinnedNumber) !== pinnedAt ||
        sourceAfter?.hash !== sourceHeader.hash || blockTime(sourceAfter, miningSourceBlock) !== observedAt ||
        BigInt(finalChainId) !== CHAIN_ID) {
      return unavailable('chain_changed');
    }
    const metadata = parseMinerDisplayMetadata(mining);
    const context = { pool, collection, tokenId, sourceBlock: pinnedNumber,
      miningSourceBlock, observedAt, validUntil: observedAt + MAX_QUOTE_AGE_MS, allowUnownedTarget };
    if (mining.status !== 'verified' || dailyAtomic === null || dailyAtomic === 0n) {
      const missing = unavailable(mining.status !== 'verified' ? 'unverified_output' : 'missing_output');
      return metadata.miningClassification ? Object.freeze({ ...missing, ...context, ...metadata,
        metadataAvailable: true }) : missing;
    }
    return Object.freeze({ available: true, ...context, ...metadata, metadataAvailable: true,
      estimated24hAtomic: dailyAtomic, pricePerUnitWei: price,
      priceWeiPerDailyBem: shareDailyCapacityPriceWei(price, dailyAtomic),
      ...minerAskContext(detail, now, includeOfficialAsk, official),
      marketReferencePriceWei: (() => {
        const value = exactDecimal(asset.listingReference?.dailyCapacityPriceWei);
        return value !== null && value > 0n ? value : null;
      })(),
      basis: 'gross_estimated_output' });
  } catch {
    // Display data is optional. Keep purchase eligibility, calldata and price
    // independent of an unavailable or malformed external estimate.
    return unavailable('unavailable');
  }
}
