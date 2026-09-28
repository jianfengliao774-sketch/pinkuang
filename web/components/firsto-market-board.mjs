import { displayAmount } from '../lib/amount-display.mjs';
import { formatUnits } from 'ethers';
import {
  fetchQuotePage,
  parseCapacityReference,
  quoteIssue,
  referenceIssue,
  MAX_QUOTE_AGE_MS,
} from '../../deploy/src/pricing.ts';
import { QUOTE_BASE, QUOTE_SOURCE } from '../lib/operator-quotes.mjs';

const BEM_ATOMIC = 100_000_000n;
const MAX_RESPONSE_BYTES = 2_000_000;

export const FIRSTO_MARKET_SOURCE = QUOTE_SOURCE;
export const FIRSTO_MARKET_PROXY = QUOTE_BASE;

const positiveInteger = value => typeof value === 'string' && /^(?:[1-9]\d*)$/.test(value) && value.length <= 78;
const sameAddress = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();

/** The unit is BNB / (one BEM per day); display only, never a transaction amount. */
export function dailyCapacityPriceWei(priceWei, estimated24hAtomic) {
  if (!positiveInteger(priceWei) || !positiveInteger(estimated24hAtomic)) return null;
  const price = BigInt(priceWei), daily = BigInt(estimated24hAtomic);
  if (!daily) return null;
  return ((price * BEM_ATOMIC + daily - 1n) / daily).toString();
}

/** A failed quote must not leave its old price visible as if it were current. */
export function marketQuoteView(row, now = Date.now()) {
  let unavailable = quoteIssue(row, now);
  if (!unavailable && (row.status !== 'verified' || row.unverifiedWeight !== '0'
    || !positiveInteger(row.verifiedWeight))) unavailable = '不是正在挖矿的纯验证矿机';
  if (!unavailable && !sameAddress(row.owner, row.ask?.seller)) unavailable = '卖家与当前 NFT 持有人不一致';
  if (!unavailable && (!positiveInteger(row.ask?.priceWei) || !positiveInteger(row.ask?.buyerCostWei))) unavailable = '市场报价无效';
  const unitWei = unavailable ? null : dailyCapacityPriceWei(row.ask.priceWei, row.estimated24hAtomic);
  const buyerUnitWei = unavailable ? null : dailyCapacityPriceWei(row.ask.buyerCostWei, row.estimated24hAtomic);
  if (!unavailable && (unitWei === null || buyerUnitWei === null)) unavailable = '预计日产出不可用';
  return Object.freeze({
    key: `${row.collection}:${row.tokenId}`,
    series: row.series,
    tokenId: row.tokenId,
    collection: row.collection,
    taskId: row.taskId,
    venue: !row.ask ? '未挂单' : row.ask.venue === 'official' ? 'TapeOut 官网挂单' : 'Firsto 挂单',
    sourceBlock: row.source.sourceBlock,
    observedAt: row.source.observedAt,
    validUntil: unavailable ? null : Math.min(row.source.observedAt + MAX_QUOTE_AGE_MS + 1,
      row.ask.expiresAt ?? Number.MAX_SAFE_INTEGER),
    unavailable,
    sellerPriceWei: unavailable ? null : row.ask.priceWei,
    buyerCostWei: unavailable ? null : row.ask.buyerCostWei,
    estimated24hAtomic: unavailable ? null : row.estimated24hAtomic,
    dailyCapacityPriceWei: unavailable ? null : unitWei,
    buyerDailyCapacityPriceWei: unavailable ? null : buyerUnitWei,
  });
}

export function marketReferenceView(raw, now = Date.now()) {
  if (raw?.coverage?.holders !== 'complete' || raw?.coverage?.market24h !== 'complete')
    throw new Error('Firsto 市场覆盖未完成');
  const reference = parseCapacityReference(raw, now);
  const issue = referenceIssue(reference, now);
  if (issue) throw new Error(issue);
  return Object.freeze(reference);
}

export function formatMarketAmount(value, decimals = 18) {
  return value == null ? '暂不可用' : displayAmount(value, decimals);
}

async function fetchMarketReference({ fetcher, signal, baseUrl }) {
  const response = await fetcher(`${baseUrl}/v1/circuit-holders?page=1`, {
    method: 'GET', signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Firsto 市场参考价暂不可用（HTTP ${response.status}）`);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('市场参考价返回类型无效');
  const size = Number(response.headers.get('content-length') || 0);
  if (size > MAX_RESPONSE_BYTES) throw new Error('市场参考价响应过大');
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw new Error('市场参考价响应过大');
  return JSON.parse(body);
}

/** Only public quote reads through the existing fixed-origin server proxy. */
export async function readFirstoMarketBoard({ page = 1, viewId, fetcher = fetch,
  signal, baseUrl = FIRSTO_MARKET_PROXY, now = Date.now() } = {}) {
  const [listed, referenced] = await Promise.allSettled([
    fetchQuotePage({ sort: 'daily_capacity_price_low', page, pageSize: 30, viewId },
      { fetcher, signal, baseUrl }),
    fetchMarketReference({ fetcher, signal, baseUrl }),
  ]);
  if (listed.status === 'rejected') throw listed.reason;
  const quotePage = listed.value;
  if (viewId && quotePage.viewId !== viewId) throw new Error('市场分页快照已变化，请刷新报价');
  let reference = null, referenceError = null;
  try {
    if (referenced.status === 'rejected') throw referenced.reason;
    reference = marketReferenceView(referenced.value, now);
  } catch (error) { referenceError = error?.message || '市场参考价暂不可用'; }
  return Object.freeze({
    sourceBlock: quotePage.sourceBlock,
    viewId: quotePage.viewId,
    page: quotePage.page,
    totalPages: quotePage.totalPages,
    excluded: quotePage.excluded,
    rows: Object.freeze(quotePage.rows.map(row => marketQuoteView(row, now))),
    reference,
    referenceError,
  });
}
