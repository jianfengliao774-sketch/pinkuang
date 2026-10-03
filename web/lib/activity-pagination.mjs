import { summarizeOverviewActivity } from './activity-summary.mjs';

export function activityPaginationEnabled(route) {
  return ['overview', 'records', 'rewards', 'detail'].includes(route);
}

/** Merge overview subscription logs before paging so one operation is one row.
 * Public records and exports continue to retain every original log.
 */
export function activityPage(rows, { route, page = 0, pageSize = 5, totalCount, overviewTotalCount, hasMore = false } = {}) {
  const records = route === 'overview' ? summarizeOverviewActivity(rows) : rows;
  const paginated = activityPaginationEnabled(route);
  const suppliedCount = route === 'overview' ? overviewTotalCount : totalCount;
  // A partially loaded list cannot prove how many pages the server holds.
  const count = Number.isSafeInteger(suppliedCount) && suppliedCount >= 0 ? suppliedCount
    : hasMore ? null : records.length;
  const totalPages = count === null ? null : Math.max(1, Math.ceil(count / pageSize));
  const requestedPage = Math.max(0, Number.isSafeInteger(page) ? page : 0);
  const lastPage = totalPages === null && hasMore ? Math.max(requestedPage, Math.ceil(records.length / pageSize) - 1)
    : Math.max(0, (totalPages ?? Math.ceil(records.length / pageSize)) - 1);
  const pageIndex = Math.min(requestedPage, lastPage);
  const start = pageIndex * pageSize;
  return {
    paginated,
    pageIndex,
    totalCount: count,
    totalPages,
    loadedCount: records.length,
    hasLoadedNextPage: records.length > start + pageSize,
    visibleRows: paginated ? records.slice(start, start + pageSize) : records,
  };
}

const knownCount = value => Number.isSafeInteger(value) && value >= 0;
const changedHistory = () => Object.assign(new Error('记录来源已变化，请刷新并从第一页重新读取。'), { code: 'source_reorg' });

/** A descending cursor only adds rows below the first page. Newer head events
 * are absent from that list, so their totals cannot replace its first-page
 * metadata. Keep every raw log for detail views and CSV exports. */
export function appendActivityPage(snapshot, part) {
  for (const key of ['totalCount', 'overviewTotalCount']) {
    if (knownCount(snapshot[key]) && knownCount(part[key]) && part[key] < snapshot[key]) throw changedHistory();
  }
  const anchor = snapshot.source, later = part.source;
  if (knownCount(anchor?.indexedThrough) && knownCount(later?.indexedThrough)) {
    if (later.indexedThrough < anchor.indexedThrough || later.indexedThrough === anchor.indexedThrough
      && typeof anchor.indexedBlockHash === 'string' && typeof later.indexedBlockHash === 'string'
      && later.indexedBlockHash.toLowerCase() !== anchor.indexedBlockHash.toLowerCase()) throw changedHistory();
  }
  return { ...snapshot, ...part, source: anchor ?? later,
    items: [...snapshot.items, ...part.items],
    totalCount: knownCount(snapshot.totalCount) ? snapshot.totalCount : part.totalCount ?? null,
    overviewTotalCount: knownCount(snapshot.overviewTotalCount) ? snapshot.overviewTotalCount : part.overviewTotalCount ?? null,
  };
}

/** Fetch only the cursor chunks needed by an explicit page jump. */
export async function loadActivityPage(snapshot, { route, page, pageSize = 5, readPage, isCurrent = () => true } = {}) {
  let next = { ...snapshot, items: [...snapshot.items] };
  const visited = new Set();
  while (isCurrent()) {
    const view = activityPage(next.items, { route, page, pageSize, ...next, hasMore: !!next.nextCursor });
    const needed = Math.min((view.pageIndex + 1) * pageSize, view.totalCount ?? Number.MAX_SAFE_INTEGER);
    if (view.loadedCount >= needed || !next.nextCursor) return { ...next, pageIndex: view.pageIndex };
    if (visited.has(next.nextCursor)) throw new Error('记录分页游标未前进，请刷新重试。');
    visited.add(next.nextCursor);
    const part = await readPage({ cursor: next.nextCursor, limit: 50, source: next.source });
    if (!isCurrent()) return null;
    next = appendActivityPage(next, part);
  }
  return null;
}
