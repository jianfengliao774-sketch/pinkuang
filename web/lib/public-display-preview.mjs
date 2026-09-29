import { insist, liveAddress } from './live-config.mjs';
import { fetchLiveJsonWithClock, validateIndexSource } from './live-data.mjs';

const UINT256_MAX = (1n << 256n) - 1n;
const SECTIONS = new Set(['pools', 'portfolios', 'stats', 'orders']);
const previewClocks = new WeakMap();
const decimal = (value, label) => {
  insist(typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value)
    && BigInt(value) <= UINT256_MAX, 'invalid_data', `${label} 必须是 uint256 精确整数。`);
  return value;
};
const blockNumber = (value, label) => {
  insist(Number.isSafeInteger(value) && value >= 0, 'invalid_data', `${label} 无效。`);
  return value;
};

function previewNow(source, localNow) {
  const proof = source && previewClocks.get(source);
  if (!proof) return localNow;
  const elapsed = localNow - proof.localReceivedAt;
  return elapsed >= 0 ? proof.serverNow + elapsed : NaN;
}

export function publicPreviewFresh(source, now = Date.now()) {
  const checkedAt = Date.parse(source?.checkedAt);
  const current = previewNow(source, now);
  return source?.readMode === 'verified_snapshot' && source.stale === true
    && source.transactionReady === false && Number.isFinite(checkedAt)
    && Number.isFinite(current) && checkedAt <= current + 30_000
    && current - checkedAt <= 30 * 60_000;
}

/** Use the response's elapsed server clock for the preview expiry timer too. */
export function publicPreviewRemaining(source, now = Date.now()) {
  return publicPreviewFresh(source, now)
    ? Math.max(0, Date.parse(source.checkedAt) + 30 * 60_000 - previewNow(source, now)) : 0;
}

/** A preview is useful only until this route's authoritative section is current. */
export function publicPreviewNeedsRefresh(resolution, routeKey, section) {
  return resolution?.key !== routeKey || resolution.sections?.[section] !== true;
}

const sanitizeSource = source => Object.freeze({
  chainId: source.chainId, factory: source.factory, market: source.market,
  indexedThrough: source.indexedThrough, indexedBlockHash: source.indexedBlockHash,
  indexedTimestamp: source.indexedTimestamp,
  registeredPoolCount: source.registeredPoolCount,
  standalonePoolCount: source.standalonePoolCount, portfolioCount: source.portfolioCount,
  checkedAt: source.checkedAt, readMode: 'verified_snapshot', stale: true,
  refreshing: source.refreshing, transactionReady: false,
});

/** A section has its own proof and age. Never copy account or action fields. */
export function parsePublicDisplaySection(reply, manifest, section, { now = Date.now(), cursor = 0,
  limit = 50, activeOrders = true, lookupAddress = null, timeProof } = {}) {
  insist(SECTIONS.has(section), 'invalid_config', '未知公共展示分区。');
  insist(reply?.source?.readMode === 'verified_snapshot' && reply.source.stale === true
    && reply.source.transactionReady === false && typeof reply.source.refreshing === 'boolean',
  'index_stale', '公共展示快照必须明确标记为历史只读资料。');
  const source = validateIndexSource(reply.source, manifest, { now, maxAgeMs: 30 * 60_000, timeProof });
  insist(liveAddress(source.portfolioFactory) === liveAddress(manifest.portfolioFactory)
    && liveAddress(source.portfolioMarket) === liveAddress(manifest.portfolioMarket),
  'index_identity', '预算索引与正式版部署清单不一致。');
  const block = reply.block;
  insist(block && blockNumber(block.number, '展示区块') === source.indexedThrough
    && typeof block.hash === 'string' && block.hash.toLowerCase() === source.indexedBlockHash
    && blockNumber(block.timestamp, '展示区块时间') === source.indexedTimestamp,
  'source_changed', '公共展示快照与来源区块不一致。');
  const standaloneCount = BigInt(decimal(source.standalonePoolCount, '独立矿池数'));
  const portfolioCount = BigInt(decimal(source.portfolioCount, '预算项目数'));
  const registeredCount = BigInt(decimal(source.registeredPoolCount, '矿池登记总数'));
  const childCount = BigInt(decimal(source.childPoolCount, '子矿池数'));
  const reservedCount = BigInt(decimal(source.reservedChildPoolCount, '预留子矿池数'));
  insist(standaloneCount + childCount + reservedCount === registeredCount,
    'index_coverage', '来源登记数不一致。');
  const common = { section, source: sanitizeSource(source) };
  if (section === 'stats') {
    const data = reply.data;
    insist(data?.scope === 'confirmed_indexed_history', 'invalid_data', '缺少已核验历史统计。');
    const stats = {
      registeredPoolCount: decimal(data.registeredPoolCount, '登记矿池数'),
      everParticipantAddressCount: decimal(data.everParticipantAddressCount, '历史参与地址数'),
      topLevelProjectCount: decimal(data.topLevelProjectCount, '顶层项目数'),
      portfolioCount: decimal(data.portfolioCount, '预算项目数'),
    };
    insist(stats.registeredPoolCount === registeredCount.toString()
      && stats.portfolioCount === portfolioCount.toString()
      && decimal(data.standalonePoolCount, '独立矿池统计') === standaloneCount.toString()
      && BigInt(stats.topLevelProjectCount) === standaloneCount + portfolioCount,
    'index_coverage', '公共展示统计与来源计数不一致。');
    return Object.freeze({ ...common, stats: Object.freeze(stats) });
  }
  const data = reply.data;
  const exactPool = lookupAddress !== null;
  insist(!exactPool || section === 'pools', 'invalid_config', '仅矿池分区支持精确地址快照。');
  insist(exactPool || source[`${section}Available`] === true,
    'index_incomplete', '该公共展示分区未保存完整目录。');
  if (section === 'orders') insist(data?.ordersAvailable === true,
    'index_incomplete', '历史挂单分区不可用。');
  insist(Array.isArray(data?.items) && data.items.length <= (exactPool ? 1 : limit)
    && limit > 0 && limit <= 50,
    'invalid_data', '公共展示页缺少有界目录。');
  let items;
  if (section === 'pools') {
    items = data.items.map(row => ({ address: liveAddress(row.address),
      collection: liveAddress(row.collection), circuitId: decimal(row.circuitId, '矿机编号'),
      createdBlock: blockNumber(row.createdBlock, '矿池登记区块') }));
  } else if (section === 'portfolios') {
    items = data.items.map(row => {
      insist(row.kind === 'portfolio' && liveAddress(row.factory) === liveAddress(manifest.portfolioFactory),
        'index_identity', '预算项目登记身份不一致。');
      return { address: liveAddress(row.address), createdBlock: blockNumber(row.createdBlock, '预算登记区块'),
        budgetWei: decimal(row.budgetWei, '初始预算'),
        absoluteCapWei: decimal(row.absoluteCapWei, '初始总上限'),
        unitCapWei: decimal(row.unitCapWei, '初始单台上限') };
    });
  } else {
    items = data.items.map(row => {
      insist(row?.executable === false && row.openAtSourceBlock === activeOrders,
        'invalid_data', '历史挂单候选不得标记为可成交或非活动。');
      const orderId = decimal(row.orderId, '挂单编号');
      insist(BigInt(orderId) > 0n, 'invalid_data', '挂单编号无效。');
      const remaining = decimal(row.remaining, '历史剩余份额');
      const expiresAt = row.expiresAt === null ? null : decimal(row.expiresAt, '挂单到期时间');
      insist(!activeOrders || BigInt(remaining) > 0n && expiresAt !== null
        && BigInt(expiresAt) > BigInt(source.indexedTimestamp),
      'invalid_data', '挂单候选状态与核验区块不一致。');
      return { orderId, pool: liveAddress(row.pool), seller: liveAddress(row.seller),
        pricePerUnitWei: decimal(row.pricePerUnitWei, '历史每份价格'), remaining,
        listedBlock: blockNumber(row.listedBlock, '挂单登记区块') };
    });
  }
  insist(items.every(row => (row.createdBlock ?? row.listedBlock) <= source.indexedThrough),
    'invalid_data', '登记区块超出来源。');
  const identities = items.map(row => section === 'orders' ? row.orderId : row.address.toLowerCase());
  insist(new Set(identities).size === identities.length, 'invalid_data', '公共展示页包含重复身份。');
  if (section === 'orders') {
    insist(items.every((row, index) => index === 0 || BigInt(items[index - 1].orderId) > BigInt(row.orderId)),
      'invalid_data', '历史挂单排序无效。');
    insist(data.nextCursor === null || items.length === limit
      && decimal(data.nextCursor, '挂单游标') === items.at(-1)?.orderId,
    'invalid_data', '历史挂单游标无效。');
  } else {
    const total = section === 'pools' ? standaloneCount : portfolioCount;
    if (exactPool) {
      const target = liveAddress(lookupAddress);
      insist(liveAddress(data.lookupAddress) === target && data.nextCursor === null
        && items.every(row => row.address === target),
      'index_coverage', '矿池精确快照与查询地址不一致。');
    } else insist(total <= 500n && Number.isSafeInteger(cursor) && cursor >= 0
        && (data.nextCursor === null ? BigInt(cursor + items.length) === total
          : items.length === limit && data.nextCursor === cursor + limit
            && BigInt(data.nextCursor) < total),
      'index_coverage', '公共展示目录页与已核验数量不一致。');
  }
  return Object.freeze({ ...common, items: Object.freeze(items), nextCursor: data.nextCursor });
}

/** Fetches only the active page's section. Pool deep links use exact server lookup. */
export async function readPublicDisplaySection({ origin, manifest, section, address,
  fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  insist(typeof origin === 'string' && new URL(origin).origin === origin && SECTIONS.has(section),
    'invalid_config', '网站来源或公共展示分区无效。');
  const target = address ? liveAddress(address).toLowerCase() : null;
  insist(!target || section === 'pools' || section === 'portfolios', 'invalid_config', '该分区不支持地址查找。');
  if (target && section === 'pools') {
    const url = new URL(`${origin}/bemine-v4/api/chain-index/v1/snapshot/pools/${target}`);
    try {
      const { body: reply, serverNow, localReceivedAt } = await fetchLiveJsonWithClock(url.href,
        { fetcher, now, maxBytes: 1_000_000 });
      const proof = serverNow === null ? null : { serverNow, localReceivedAt };
      const preview = parsePublicDisplaySection(reply, manifest, section,
        { now: now(), lookupAddress: target, ...(proof ? { timeProof: proof } : {}) });
      if (proof) previewClocks.set(preview.source, proof);
      return preview;
    } catch (error) {
      // Allow the frontend and index proxy to roll out independently. A 200
      // reply with an invalid proof must fail closed instead of scanning pages.
      if (error?.code !== 'http_unavailable' || error.details?.status !== 404) throw error;
    }
  }
  let cursor = 0, firstSource = null, lastPreview = null;
  const seen = new Set();
  for (let page = 0; page < (target ? 2 : 1); page++) {
    const url = new URL(`${origin}/bemine-v4/api/chain-index/v1/snapshot/${section}`);
    if (section !== 'stats') url.searchParams.set('limit', '50');
    if (section === 'orders') url.searchParams.set('active', 'true');
    if (cursor) url.searchParams.set('cursor', String(cursor));
    const { body: reply, serverNow, localReceivedAt } = await fetchLiveJsonWithClock(url.href,
      { fetcher, now, maxBytes: 1_000_000 });
    const proof = serverNow === null ? null : { serverNow, localReceivedAt };
    const preview = parsePublicDisplaySection(reply, manifest, section,
      { now: now(), cursor, ...(proof ? { timeProof: proof } : {}) });
    if (proof) previewClocks.set(preview.source, proof);
    lastPreview = preview;
    if (firstSource) insist(preview.source.indexedThrough === firstSource.indexedThrough
      && preview.source.indexedBlockHash === firstSource.indexedBlockHash
      && preview.source.indexedTimestamp === firstSource.indexedTimestamp
      && preview.source.checkedAt === firstSource.checkedAt
      && preview.source.registeredPoolCount === firstSource.registeredPoolCount
      && preview.source.standalonePoolCount === firstSource.standalonePoolCount
      && preview.source.portfolioCount === firstSource.portfolioCount,
    'source_changed', '公共展示目录分页时来源发生变化。');
    else firstSource = preview.source;
    if (preview.items) for (const row of preview.items) {
      const identity = section === 'orders' ? row.orderId : row.address.toLowerCase();
      insist(!seen.has(identity), 'invalid_data', '公共展示目录分页身份重复。');
      seen.add(identity);
    }
    if (!target || preview.items?.some(row => row.address.toLowerCase() === target)
      || preview.nextCursor === null) return preview;
    cursor = preview.nextCursor;
  }
  // No historical preview is shown for an address beyond the small search window.
  return lastPreview;
}
