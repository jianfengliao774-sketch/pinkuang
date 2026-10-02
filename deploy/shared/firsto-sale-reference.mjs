import { ZeroAddress, getAddress, keccak256, toUtf8Bytes, toQuantity } from 'ethers';
import { fetchMineDetail, parseCapacityReference, MAX_QUOTE_AGE_MS, OFFICIAL_COLLECTIONS } from '../src/pricing.ts';
const BEM = 100_000_000n;
const known = new Set(Object.values(OFFICIAL_COLLECTIONS).map(value => value.toLowerCase()));
const need = (condition, message) => { if (!condition) throw new Error(message); };
const uint = value => {
  if (typeof value === 'number') need(Number.isSafeInteger(value) && value >= 0, 'Invalid exact integer.');
  need(typeof value === 'bigint' && value >= 0n || typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value), 'Invalid exact integer.');
  return BigInt(value);
};
const cancelled = signal => { if (signal?.aborted) throw Object.assign(new Error('参考价读取已取消。'), { name: 'AbortError' }); };
const same = (a, b) => getAddress(a) === getAddress(b);

export async function fetchFirstoReferenceRaw({ fetcher, baseUrl, signal }) {
  const response = await fetcher(`${baseUrl}/v1/circuit-holders?page=1`, {
    method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json' },
  });
  need(response.ok, `Firsto 参考价暂不可用（HTTP ${response.status}）。`);
  need(!response.redirected && response.headers.get('content-type')?.includes('application/json'), 'Firsto 参考价响应无效。');
  const reader = response.body?.getReader(); need(reader, 'Firsto 参考价响应为空。');
  let size = 0; const parts = [];
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 2_000_000) { await reader.cancel(); throw new Error('Firsto 参考价响应过大。'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Read only the NFT identity and its official Firsto reference; never sign or broadcast. */
export async function readFirstoSaleReference({ provider, pool: poolInput, market: marketInput, params,
  signal, now = Date.now, fetcher = fetch, baseUrl = 'https://api-tapeout.firsto.ai',
  detailLoader, referenceLoader } = {}) {
  need(typeof provider?.request === 'function', '只读链上服务暂不可用。');
  const pool = getAddress(poolInput), market = getAddress(marketInput);
  need(pool !== ZeroAddress && market !== ZeroAddress, '矿池或市场地址无效。');
  cancelled(signal);
  need(params, '矿机身份暂不可用。');
  const identity = params;
  const collection = getAddress(identity.circuits), tokenId = uint(identity.circuitId).toString();
  need(known.has(collection.toLowerCase()), '仅支持官方 TapeOut / Behemoth 矿机。');
  const results = await Promise.allSettled([
    detailLoader ? detailLoader(collection, tokenId, { signal })
      : fetchMineDetail(collection, tokenId, { baseUrl, fetcher, signal, displayOnly: true }),
    referenceLoader ? referenceLoader({ signal }) : fetchFirstoReferenceRaw({ baseUrl, fetcher, signal }),
  ]);
  cancelled(signal);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const detail = results[0].value, raw = results[1].value, asset = detail?.asset, mining = asset?.mining;
  need(asset && same(asset.collection, collection) && uint(asset.tokenId).toString() === tokenId
    && same(asset.owner, pool) && asset.category === 'official_mining'
    && ['official_mining', 'unknown'].includes(asset.classification), 'Firsto 矿机身份或持有人已变化，请刷新项目。');
  need(mining?.status === 'verified' && mining.tokenSymbol === 'BEM' && mining.tokenDecimals === 8
    && uint(mining.verifiedWeight) > 0n && uint(mining.unverifiedWeight) === 0n
    && uint(mining.weight) === uint(mining.verifiedWeight), 'Firsto 未提供这台矿机的有效验证日产出。');
  const daily = uint(mining.estimated24hAtomic), miningBlock = uint(mining.sourceBlock);
  need(daily > 0n && miningBlock > 0n, 'Firsto 矿机日产出或来源区块暂不可用。');
  need(raw?.coverage?.holders === 'complete' && raw.coverage.market24h === 'complete', 'Firsto 市场参考价尚未完整更新。');
  const reference = parseCapacityReference(raw, now());
  const header = await provider.request({ method: 'eth_getBlockByNumber', params: [toQuantity(miningBlock), false] });
  cancelled(signal);
  need(header?.number && BigInt(header.number) === miningBlock && header.timestamp, 'Firsto 日产出来源时间暂不可用。');
  const miningAt = Number(BigInt(header.timestamp) * 1000n), current = now();
  need(Number.isSafeInteger(miningAt) && Number.isSafeInteger(current)
    && miningAt > 0 && miningAt <= current && current - miningAt < MAX_QUOTE_AGE_MS
    && reference.observedAt <= current && current - reference.observedAt < MAX_QUOTE_AGE_MS,
  'Firsto 报价超过有效期，请重新读取。');
  const observedAt = Math.floor(Math.min(miningAt, reference.observedAt) / 1000);
  const priceWei = (uint(reference.dailyCapacityPriceWei) * daily + BEM - 1n) / BEM;
  need(priceWei > 0n && priceWei < 1n << 128n, 'Firsto 整机参考价超出有效范围。');
  const evidence = { source: 'https://api-tapeout.firsto.ai', collection, tokenId, pool,
    estimated24hAtomic: daily.toString(), miningSourceBlock: miningBlock.toString(),
    referenceDailyCapacityPriceWei: reference.dailyCapacityPriceWei,
    referenceSourceBlock: reference.sourceBlock, referenceObservedAt: reference.observedAt,
    referenceViewId: reference.viewId, priceWei: priceWei.toString(), observedAt };
  return Object.freeze({ kind: 'setSaleReference', collection, tokenId, estimated24hAtomic: daily,
    referenceDailyCapacityPriceWei: uint(reference.dailyCapacityPriceWei),
    observedAt, validUntil: observedAt * 1000 + MAX_QUOTE_AGE_MS, evidence,
    args: Object.freeze({ market, pool, priceWei: priceWei.toString(), observedAt: String(observedAt),
      digest: keccak256(toUtf8Bytes(JSON.stringify(evidence))) }) });
}

