import { getAddress, ZeroAddress } from 'ethers';
import { fetchLiveJson } from './live-config.mjs';

const statuses = new Set(['disabled', 'idle', 'reading', 'queued', 'pending', 'confirmed',
  'source-unavailable', 'gas-paused', 'review-required']);
const need = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Public background status only; a visit never requests a wallet signature or a Gas task. */
export async function fetchSaleReferenceStatus(config, poolInput, { signal, fetcher = globalThis.fetch } = {}) {
  const pool = getAddress(poolInput), base = new URL(config.indexBaseUrl);
  need(pool !== ZeroAddress && base.origin === config.origin && !base.search && !base.hash,
    '参考价状态来源与当前站点不一致。');
  const reply = await fetchLiveJson(`${base.href.replace(/\/$/, '')}/v1/display/sale-reference/${pool}`,
    { maxBytes: 16_384, timeoutMs: 10_000,
      fetcher: (url, options) => fetcher(url, { ...options,
        signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal }) });
  need(reply?.schemaVersion === 1 && reply.chainId === 56
    && same(reply.factory, config.factory ?? config.manifest?.factory)
    && same(reply.market, config.shareMarket ?? config.manifest?.shareMarket)
    && typeof reply.enabled === 'boolean' && typeof reply.stale === 'boolean'
    && same(reply.item?.pool, pool) && statuses.has(reply.item.status), '参考价后台状态暂不可用。');
  if (reply.item.priceWei !== undefined) need(typeof reply.item.priceWei === 'string' && /^(0|[1-9]\d*)$/.test(reply.item.priceWei), '参考价金额无效。');
  if (reply.item.hash !== undefined) need(/^0x[\da-f]{64}$/i.test(reply.item.hash), '参考价交易记录无效。');
  return Object.freeze(reply);
}
