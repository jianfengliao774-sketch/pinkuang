import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { fetchMineDetail, FIRSTO_SOURCE, MAX_QUOTE_AGE_MS, OFFICIAL_COLLECTIONS } from '../../deploy/src/pricing.ts';
import { abi, CHAIN_ID, uint } from './chain-client.mjs';
import { QUOTE_BASE } from './quote-base.mjs';

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

/** Official PoD H is the active pool weight: verified H=(b*+bonus)*P,
 * unverified H=b*P. The exact Firsto detail exposes this as weight. Never
 * reinterpret missing verification data as an unverified miner.
 * Official UI: https://tapeout.net/pod/assets/main-C1q9aWV9.js
 */
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

/** Buyer price per one whole BEM of estimated daily output, rounded up by at most one wei. */
export function shareDailyCapacityPriceWei(pricePerUnitWei, estimated24hAtomic) {
  const price = uint(pricePerUnitWei), daily = uint(estimated24hAtomic);
  if (daily === 0n) throw new Error('Estimated daily BEM output is unavailable.');
  const numerator = price * TOTAL_SHARES * BEM_ATOMIC_PER_TOKEN;
  return (numerator + daily - 1n) / daily;
}

/**
 * Display-only quote. The PoolVault's *current* params identify the purchased
 * NFT even after an alternative miner replaces the original target. A failed
 * external quote must never block or modify the separately verified order.
 */
export async function readShareDailyCapacityPrice(provider, {
  factory: factoryInput, pool: poolInput, pricePerUnitWei,
  allowUnownedTarget = false,
  blockNumber, now = Date.now(), quoteLoader = (collection, tokenId) =>
    fetchMineDetail(collection, tokenId, { baseUrl: QUOTE_BASE }),
} = {}) {
  try {
    if (!provider?.request || !Number.isSafeInteger(now) || now <= 0 || typeof quoteLoader !== 'function') {
      return unavailable('invalid_input');
    }
    const factory = getAddress(factoryInput), pool = getAddress(poolInput);
    if (factory === ZeroAddress || pool === ZeroAddress) return unavailable('invalid_input');
    const price = uint(pricePerUnitWei);
    const request = (method, params = []) => provider.request({ method, params });
    if (BigInt(await request('eth_chainId')) !== CHAIN_ID) return unavailable('wrong_chain');
    const requestedTag = blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber));
    let block = await request('eth_getBlockByNumber', [requestedTag, false]);
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
    const owner = await call(collection, NFT, 'ownerOf', [tokenId]);
    if (getAddress(owner) !== pool && !allowUnownedTarget) return unavailable('miner_not_in_pool');

    // The exact Firsto detail endpoint covers pool-owned NFTs even when they
    // have no active sell order or are absent from three pages of text search.
    const detail = await quoteLoader(collection, tokenId);
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
    const after = await request('eth_getBlockByNumber', [tag, false]);
    const sourceAfter = sourceTag === tag ? after : await request('eth_getBlockByNumber', [sourceTag, false]);
    if (after?.hash !== block.hash || blockTime(after, pinnedNumber) !== pinnedAt ||
        sourceAfter?.hash !== sourceHeader.hash || blockTime(sourceAfter, miningSourceBlock) !== observedAt ||
        BigInt(await request('eth_chainId')) !== CHAIN_ID) {
      return unavailable('chain_changed');
    }
    const metadata = parseMinerDisplayMetadata(mining);
    const context = { pool, collection, tokenId, sourceBlock: pinnedNumber,
      miningSourceBlock, observedAt, validUntil: observedAt + MAX_QUOTE_AGE_MS };
    if (mining.status !== 'verified' || dailyAtomic === null || dailyAtomic === 0n) {
      const missing = unavailable(mining.status !== 'verified' ? 'unverified_output' : 'missing_output');
      return metadata.miningClassification ? Object.freeze({ ...missing, ...context, ...metadata,
        metadataAvailable: true }) : missing;
    }
    return Object.freeze({ available: true, ...context, ...metadata, metadataAvailable: true,
      estimated24hAtomic: dailyAtomic, pricePerUnitWei: price,
      priceWeiPerDailyBem: shareDailyCapacityPriceWei(price, dailyAtomic),
      marketReferencePriceWei: (() => {
        const value = exactDecimal(asset.listingReference?.dailyCapacityPriceWei);
        return value !== null && value > 0n ? value : null;
      })(),
      sourceUrl: FIRSTO_SOURCE,
      basis: 'gross_estimated_output' });
  } catch {
    // Display data is optional. Keep purchase eligibility, calldata and price
    // independent of an unavailable or malformed external estimate.
    return unavailable('unavailable');
  }
}
