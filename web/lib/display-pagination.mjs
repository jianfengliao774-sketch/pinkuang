import { LiveDataError } from './live-config.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const identity = row => row?.orderId !== undefined ? `order:${String(row.orderId)}`
  : typeof row?.pool === 'string' ? `pool:${row.pool.toLowerCase()}` : null;

/** Only the materialized display API is read. Each loaded page stays on the
 * first page's source; a moving index is retried as a whole by the caller. */
export function appendDisplayPage(previous, next) {
  const a = previous?.source, b = next?.source;
  if (!Array.isArray(previous?.items) || !Array.isArray(next?.items)
    || !a || !b || a.chainId !== b.chainId || !same(a.factory, b.factory) || !same(a.market, b.market)
    || !Number.isSafeInteger(a.indexedThrough) || a.indexedThrough !== b.indexedThrough
    || a.indexedTimestamp !== b.indexedTimestamp
    || !same(a.indexedBlockHash, b.indexedBlockHash))
    throw new LiveDataError('source_changed', '展示快照已更新，请重新读取已加载页面。');
  const items = [...previous.items, ...next.items], keys = items.map(identity);
  if (keys.some(key => key === null) || new Set(keys).size !== keys.length)
    throw new LiveDataError('invalid_data', '展示分页包含重复或无效的项目。');
  if (previous.marketBnbOwed !== undefined && previous.marketBnbOwed !== next.marketBnbOwed)
    throw new LiveDataError('source_changed', '分页余额不属于同一展示快照。');
  return { ...previous, items, nextCursor: next.nextCursor, loadedPages: loadedDisplayPages(previous) + 1 };
}

export function loadedDisplayPages(page, loadedRows = 0) {
  return Number.isSafeInteger(page?.loadedPages) && page.loadedPages > 0 ? page.loadedPages
    : Math.max(1, Math.ceil((Number.isSafeInteger(loadedRows) && loadedRows > 0 ? loadedRows
      : Array.isArray(page?.items) ? page.items.length : 0) / 20));
}

export async function refreshDisplayPages(first, { read, options = {}, pageCount = 1, isCurrent = () => true } = {}) {
  let result = first;
  const cursors = new Set();
  for (let page = 1; page < pageCount && result.nextCursor != null; page++) {
    if (!isCurrent()) return result;
    const cursor = result.nextCursor;
    if (cursors.has(String(cursor))) throw new LiveDataError('invalid_cursor', '展示分页游标没有推进。');
    cursors.add(String(cursor));
    result = appendDisplayPage(result, await read({ ...options, cursor, source: first.source }));
  }
  return result;
}
