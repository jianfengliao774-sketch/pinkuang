import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { fetchMineDetail, FIRSTO_SOURCE, MAX_QUOTE_AGE_MS, OFFICIAL_COLLECTIONS } from '../../deploy/src/pricing.ts';
import { abi, CHAIN_ID, uint } from './chain-client.mjs';

const NFT = new Interface(['function ownerOf(uint256) view returns(address)']);
const OFFICIAL = new Set(Object.values(OFFICIAL_COLLECTIONS).map(value => value.toLowerCase()));
const BEM_ATOMIC_PER_TOKEN = 100_000_000n;
const TOTAL_SHARES = 100n;
const QUOTE_BASE = '/pinkuang-deploy/firsto-api';
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
    const block = await request('eth_getBlockByNumber', [requestedTag, false]);
    const pinnedNumber = /^0x[\da-f]+$/i.test(block?.number ?? '') ? BigInt(block.number) : null;
    const pinnedAt = pinnedNumber === null ? null : blockTime(block, pinnedNumber);
    if (pinnedAt === null || (blockNumber !== undefined && pinnedNumber !== uint(blockNumber)) ||
        pinnedAt > now + 30_000 || now - pinnedAt > MAX_QUOTE_AGE_MS) return unavailable('invalid_block');
    const tag = toQuantity(pinnedNumber);
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
    if (getAddress(owner) !== pool) return unavailable('miner_not_in_pool');

    // The exact Firsto detail endpoint covers pool-owned NFTs even when they
    // have no active sell order or are absent from three pages of text search.
    const detail = await quoteLoader(collection, tokenId);
    const asset = detail?.asset, mining = asset?.mining;
    if (!asset || !mining || getAddress(asset.collection) !== collection ||
        exactDecimal(asset.tokenId)?.toString() !== tokenId || getAddress(asset.owner) !== pool ||
        asset.category !== 'official_mining' || asset.classification !== 'official_mining' ||
        mining.tokenSymbol !== 'BEM' || mining.tokenDecimals !== 8 || mining.status !== 'verified') {
      return unavailable('quote_identity');
    }
    const dailyAtomic = exactDecimal(mining.estimated24hAtomic);
    if (dailyAtomic === null || dailyAtomic === 0n) return unavailable('missing_output');
    const miningSourceBlock = exactDecimal(mining.sourceBlock);
    if (miningSourceBlock === null || miningSourceBlock > pinnedNumber) return unavailable('stale_quote');
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
    return Object.freeze({ available: true, pool, collection, tokenId, sourceBlock: pinnedNumber,
      miningSourceBlock, observedAt, validUntil: observedAt + MAX_QUOTE_AGE_MS,
      estimated24hAtomic: dailyAtomic, pricePerUnitWei: price,
      priceWeiPerDailyBem: shareDailyCapacityPriceWei(price, dailyAtomic),
      sourceUrl: FIRSTO_SOURCE,
      basis: 'gross_estimated_output' });
  } catch {
    // Display data is optional. Keep purchase eligibility, calldata and price
    // independent of an unavailable or malformed external estimate.
    return unavailable('unavailable');
  }
}
