import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { fetchMineQuote, FIRSTO_SOURCE, MAX_QUOTE_AGE_MS, OFFICIAL_COLLECTIONS } from '../../deploy/src/pricing.ts';
import { abi, CHAIN_ID, uint } from './chain-client.mjs';

const NFT = new Interface(['function ownerOf(uint256) view returns(address)']);
const OFFICIAL = new Set(Object.values(OFFICIAL_COLLECTIONS).map(value => value.toLowerCase()));
const BEM_ATOMIC_PER_TOKEN = 100_000_000n;
const TOTAL_SHARES = 100n;
const QUOTE_BASE = '/pinkuang-deploy/firsto-api';
const unavailable = reason => Object.freeze({ available: false, reason });

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
    fetchMineQuote(collection, tokenId, { baseUrl: QUOTE_BASE }),
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
    if (!/^0x[\da-f]{64}$/i.test(block?.hash ?? '') || !/^0x[\da-f]+$/i.test(block?.number ?? '') ||
        (blockNumber !== undefined && BigInt(block.number) !== uint(blockNumber))) return unavailable('invalid_block');
    const tag = toQuantity(BigInt(block.number));
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

    // The source parser checks that the list and detail refer to the same NFT.
    // Unlike an acquisition quote, a miner already owned by a pool need not
    // still have a sell order on Firsto.
    const quote = await quoteLoader(collection, tokenId);
    if (!quote?.detailChecked || getAddress(quote.collection) !== collection ||
        uint(quote.tokenId).toString() !== tokenId || getAddress(quote.owner) !== pool ||
        quote.tokenSymbol !== 'BEM' || quote.tokenDecimals !== 8 || quote.status !== 'verified') {
      return unavailable('quote_identity');
    }
    const miningStamps = Object.entries(quote.source?.timestamps ?? {})
      .filter(([key]) => key.startsWith('official_circuit_mining:'))
      .map(([, timestamp]) => timestamp);
    const observedAt = quote.source?.observedAt;
    if (!miningStamps.length || miningStamps.some(timestamp => !Number.isSafeInteger(timestamp) ||
        timestamp > now + 30_000 || now - timestamp > MAX_QUOTE_AGE_MS)) {
      return unavailable('stale_quote');
    }
    if (!Number.isSafeInteger(observedAt) || observedAt > now + 30_000 ||
        now - observedAt > MAX_QUOTE_AGE_MS) return unavailable('stale_quote');
    const dailyAtomic = uint(quote.estimated24hAtomic);
    if (dailyAtomic === 0n) return unavailable('missing_output');
    const after = await request('eth_getBlockByNumber', [tag, false]);
    if (after?.hash !== block.hash || BigInt(await request('eth_chainId')) !== CHAIN_ID) {
      return unavailable('chain_changed');
    }
    return Object.freeze({ available: true, pool, collection, tokenId, sourceBlock: BigInt(block.number),
      observedAt, estimated24hAtomic: dailyAtomic, pricePerUnitWei: price,
      priceWeiPerDailyBem: shareDailyCapacityPriceWei(price, dailyAtomic),
      sourceUrl: FIRSTO_SOURCE,
      basis: 'gross_estimated_output' });
  } catch {
    // Display data is optional. Keep purchase eligibility, calldata and price
    // independent of an unavailable or malformed external estimate.
    return unavailable('unavailable');
  }
}
