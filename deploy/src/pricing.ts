import { formatUnits, getAddress, keccak256, toUtf8Bytes } from 'ethers';

export const FIRSTO_SOURCE = 'https://tapeout.firsto.ai/circuits';
export const MAX_QUOTE_AGE_MS = 5 * 60_000;
export const OFFICIAL_COLLECTIONS = {
  TapeOut: '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c',
  Behemoth: '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c',
} as const;
export const PRICE_SORTS = ['price_low', 'daily_capacity_price_low', 'recently_listed', 'token_id_low'] as const;
export type PriceSort = typeof PRICE_SORTS[number];
type ObjectValue = Record<string, unknown>;
const UINT256 = (1n << 256n) - 1n;
const requireValue: (condition: unknown, reason: string) => asserts condition = (condition, reason) => { if (!condition) throw new Error(reason); };
const obj = (value: unknown, name: string): ObjectValue => { requireValue(value && typeof value === 'object' && !Array.isArray(value), `${name} 数据缺失`); return value as ObjectValue; };
const uint = (value: unknown, name: string): string => { requireValue(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 78 && BigInt(value) <= UINT256, `${name} 必须是精确的非负整数字符串`); return value; };
const text = (value: unknown, name: string): string => { requireValue(typeof value === 'string' && value.length > 0 && value.length <= 256, `${name} 无效`); return value; };
const address = (value: unknown, name: string) => getAddress(text(value, name)).toLowerCase();
const optionalUint = (value: unknown, name: string) => value == null ? null : uint(value, name);
const time = (value: unknown, name: string): number => { const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; requireValue(Number.isSafeInteger(n) && n > 0, `${name} 时间缺失或无效`); return n; };
const optionalObj = (value: unknown, name: string) => value == null ? null : obj(value, name);
const ageIssue = (at: number, now: number) => at > now + 30_000 ? '来源时间超前，无法确认' : now - at > MAX_QUOTE_AGE_MS ? '来源超过 5 分钟，需重新获取' : null;

export interface MineAsk { id: string; seller: string; venue: string; kind: string; priceWei: string; buyerCostWei: string; expiresAt: number | null; legacyListingId: string | null; sourceFeeBps: number | null; sourceSchemaVersion: string | null }
export interface MineQuote {
  collection: string; tokenId: string; series: 'TapeOut' | 'Behemoth'; owner: string; status: string; taskId: string | null;
  verifiedWeight: string | null; unverifiedWeight: string | null; estimated24hAtomic: string | null;
  tokenSymbol: 'BEM'; tokenDecimals: 8; ask: MineAsk | null; bestBidSellerNetWei: string | null;
  listingReference: { priceWei: string; dailyCapacityPriceWei: string } | null;
  source: { url: string; viewId: string; sourceBlock: string; timestamps: Record<string, number>; observedAt: number; receivedAt: number };
  issues: string[]; detailChecked: boolean;
}
export interface MineQuotePage { rows: MineQuote[]; excluded: number; page: number; totalPages: number; total: number; viewId: string; sourceBlock: string; receivedAt: number }
export interface CapacityReference { dailyCapacityPriceWei: string; observedAt: number; sourceBlock: string; viewId: string; sourceUrl: string; receivedAt: number }
export interface QuotePlan {
  schemaVersion: 1; chainId: 56; createdAt: string; sourceDigest: string;
  target: { collection: string; tokenId: string; series: string; askId: string; askPriceWei: string; firstoBuyerCostWei: string };
  reference: CapacityReference;
  flexiblePurchase: { minVerifiedWeight: string; referencePriceWei: string; targetDailyYieldAtomic: string; extraBps: number; referenceObservedAt: number; referenceBlock: string; referenceDigest: string };
  funding: { targetRaiseWei: string; priceCapWei: string; totalShares: 100; pricePerShareWei: string; extraBps: number };
  eligibility: { collection: string; expectedTaskId: string; modelSource: 'reference-nft-onchain'; originalTargetFirst: true; miningStatus: 'verified'; minVerifiedWeight: string; unverifiedWeight: '0'; excludeOptimal: true };
  notes: string[];
}

export function formatExact(value: string | null | undefined, decimals = 18): string { return value == null ? '—' : formatUnits(uint(value, '金额'), decimals); }
export function quoteIssue(quote: MineQuote, now = Date.now()): string | null {
  if (quote.issues.length) return quote.issues[0];
  const stale = ageIssue(quote.source.observedAt, now); if (stale) return stale;
  if (!quote.ask) return '当前没有有效卖单，不推测成交价';
  if (quote.ask.expiresAt !== null && quote.ask.expiresAt <= now) return '卖单已过期';
  return null;
}
export function referenceIssue(reference: CapacityReference, now = Date.now()): string | null { return ageIssue(reference.observedAt, now); }

export function parseQuotePage(raw: unknown, receivedAt = Date.now()): MineQuotePage {
  const data = obj(raw, '报价列表');
  requireValue(Array.isArray(data.rows) && data.rows.length <= 50, '报价列表超出单页上限');
  requireValue(Number.isSafeInteger(data.page) && Number(data.page) >= 1 && Number.isSafeInteger(data.totalPages) && Number(data.totalPages) >= 0 && Number.isSafeInteger(data.total) && Number(data.total) >= 0, '报价分页无效');
  const freshness = obj(data.sourceFreshness, '来源更新时间');
  const sourceBlock = uint(data.sourceBlock, '源区块');
  const viewId = text(data.viewId, '快照标识');
  const rows: MineQuote[] = []; let excluded = 0;
  for (const rawRow of data.rows) {
    try {
      const row = obj(rawRow, '矿机'); const collection = address(row.collection, '矿机合约');
      const series = (Object.keys(OFFICIAL_COLLECTIONS) as (keyof typeof OFFICIAL_COLLECTIONS)[]).find(key => OFFICIAL_COLLECTIONS[key] === collection);
      requireValue(series && row.category === 'official_mining' && row.classification === 'official_mining', '非官方矿机');
      const tokenId = uint(row.tokenId, '矿机编号'); const mining = obj(row.mining, '挖矿数据');
      requireValue(mining.tokenSymbol === 'BEM' && mining.tokenDecimals === 8, '产能币种或小数位不符合 BEM / 8');
      const status = text(mining.status, '挖矿状态');
      const issues: string[] = []; const stamps: Record<string, number> = {};
      const needed = ['circuit_collections:', 'official_circuit_mining:', 'blockfeed:bsc-tapeout-markets-shadow-v1:circuit-orders'];
      const a = optionalObj(row.bestAsk, '卖单'); let ask: MineAsk | null = null;
      if (a) {
        requireValue(a.status === 'open', '卖单不是有效挂单');
        const execution = optionalObj(a.execution, '卖单执行来源');
        if (execution) {
          requireValue(execution.chainId === 56 && address(execution.collection, '卖单合约') === collection && uint(execution.tokenId, '卖单编号') === tokenId, '卖单链或资产身份不匹配');
          requireValue(uint(execution.priceWei, '执行报价') === uint(a.priceWei, '挂单价'), '执行报价不一致');
          requireValue(address(execution.maker, '执行卖家') === address(a.account, '挂牌卖家'), '卖单卖家身份不一致');
          if (execution.feeBps != null) requireValue(Number.isSafeInteger(execution.feeBps) && Number(execution.feeBps) >= 0 && Number(execution.feeBps) <= 10_000, '来源费率无效');
          const kind = text(execution.kind, '市场类型');
          if (kind === 'signed_ask') needed.push(`circuit_signed_ask_exchange:${address(execution.exchange, '挂单市场')}`);
          else if (kind === 'circuit_batch_ask') needed.push(`circuit_batch_ask_exchange:${address(execution.exchange, '挂单市场')}`);
        }
        const id = text(a.id, '挂单编号'); const priceWei = uint(a.priceWei, '挂单价'); const buyerCostWei = uint(a.buyerCostWei, '买方总额');
        requireValue(BigInt(buyerCostWei) >= BigInt(priceWei), '买方总额小于挂单价');
        const legacy = /^official:0x6feebbebc07bcb90bd1ac8b0cf9baa4f0ff2b46f:(\d+)$/i.exec(id);
        ask = { id, seller: address(a.account, '卖家'), venue: text(a.venue, '报价市场'), kind: execution ? text(execution.kind, '报价市场类型') : a.venue === 'official' ? 'official' : 'unknown', priceWei, buyerCostWei, expiresAt: a.expiresAt == null ? null : time(a.expiresAt, '挂单到期'), legacyListingId: a.venue === 'official' && legacy ? uint(legacy[1], '官方挂单编号') : null, sourceFeeBps: execution?.feeBps == null ? null : Number(execution.feeBps), sourceSchemaVersion: execution?.schemaVersion == null ? null : uint(execution.schemaVersion, '来源协议版本') };
        if (ask.venue !== 'official' && (!execution || ask.expiresAt === null)) issues.push('缺少 Firsto 挂单执行来源或到期时间');
      }
      for (const prefix of needed) {
        const matches = Object.entries(freshness).filter(([key]) => key === prefix || key.startsWith(prefix));
        if (!matches.length) { issues.push(`缺少报价来源更新时间：${prefix}`); continue; }
        for (const [key, value] of matches) { const at = time(value, '来源更新时间'); stamps[key] = at; if (at > receivedAt + 30_000) issues.push('来源时间超前，无法确认'); }
      }
      const observedAt = Object.values(stamps).length ? Math.min(...Object.values(stamps)) : 0;
      const bid = optionalObj(row.bestBid, '买单'); const reference = optionalObj(row.listingReference, '同类参考价');
      rows.push({ collection, tokenId, series, owner: address(row.owner, '当前持有人'), status, taskId: optionalUint(mining.taskId, '任务编号'), verifiedWeight: optionalUint(mining.verifiedWeight, '验证权重'), unverifiedWeight: optionalUint(mining.unverifiedWeight, '未验证权重'), estimated24hAtomic: optionalUint(mining.estimated24hAtomic, '日产能'), tokenSymbol: 'BEM', tokenDecimals: 8, ask, bestBidSellerNetWei: bid ? optionalUint(bid.sellerNetWei, '买单卖家实收') : null, listingReference: reference ? { priceWei: uint(reference.priceWei, '同类参考价'), dailyCapacityPriceWei: uint(reference.dailyCapacityPriceWei, '同类日产能价') } : null, source: { url: FIRSTO_SOURCE, viewId, sourceBlock, timestamps: stamps, observedAt, receivedAt }, issues, detailChecked: false });
    } catch { excluded++; }
  }
  return { rows, excluded, page: Number(data.page), totalPages: Number(data.totalPages), total: Number(data.total), viewId, sourceBlock, receivedAt };
}

export function parseCapacityReference(raw: unknown, receivedAt = Date.now()): CapacityReference {
  const data = obj(raw, '日产能参考'); const market = obj(data.marketStats, '日产能市场统计');
  requireValue(data.tokenSymbol === 'BEM' && data.tokenDecimals === 8, '参考产能币种不是 BEM / 8');
  const dailyCapacityPriceWei = uint(market.dailyCapacityPriceWei, '日产能参考价');
  requireValue(BigInt(dailyCapacityPriceWei) > 0n, '日产能参考价暂不可用');
  return { dailyCapacityPriceWei, observedAt: time(data.asOf, '参考价时间'), sourceBlock: uint(data.sourceBlock, '参考源区块'), viewId: text(data.viewId, '参考快照'), sourceUrl: FIRSTO_SOURCE, receivedAt };
}

export function verifyQuoteDetail(quote: MineQuote, raw: unknown): MineQuote {
  const data = obj(raw, '矿机详情'); const asset = obj(data.asset, '矿机详情资产');
  requireValue(address(asset.collection, '详情合约') === quote.collection && uint(asset.tokenId, '详情编号') === quote.tokenId && asset.category === 'official_mining' && asset.classification === 'official_mining', '详情与报价资产身份不一致');
  requireValue(address(asset.owner, '详情持有人') === quote.owner, '持有人已变化，请刷新报价');
  const mining = obj(asset.mining, '详情挖矿数据');
  for (const [key, value] of Object.entries({ taskId: quote.taskId, status: quote.status, verifiedWeight: quote.verifiedWeight, unverifiedWeight: quote.unverifiedWeight, estimated24hAtomic: quote.estimated24hAtomic, tokenSymbol: 'BEM', tokenDecimals: 8 })) requireValue(mining[key] === value, '矿机型号、状态或产能已变化，请刷新报价');
  if (quote.ask) {
    const orders = obj(data.orders, '详情挂单');
    const candidates = [orders.signedAsks, orders.asksAndOnchainBids].flatMap(value => { requireValue(Array.isArray(value) && value.length <= 500, '详情订单数量或格式无效'); return value; });
    const matched = candidates.some(value => { try { const order = obj(value, '订单'); const id = typeof order.askHash === 'string' ? order.askHash : `${text(order.venue, '市场')}:${address(order.exchange, '市场合约')}:${uint(order.orderKey, '订单编号')}`; return order.status === 'open' && (order.side == null || order.side === 'ask') && address(order.maker, '卖家') === quote.ask!.seller && uint(order.priceWei, '卖价') === quote.ask!.priceWei && uint(order.buyerCostWei, '总额') === quote.ask!.buyerCostWei && id.toLowerCase() === quote.ask!.id.toLowerCase(); } catch { return false; } });
    requireValue(matched, '列表报价与详情挂单不一致，请刷新后重试');
  }
  return { ...quote, detailChecked: true };
}

type FetchOptions = { signal?: AbortSignal; baseUrl?: string; fetcher?: typeof fetch };
function apiBase(options: FetchOptions) { return options.baseUrl ?? `${import.meta.env?.BASE_URL ?? '/'}firsto-api`; }
async function readApi(path: string, options: FetchOptions): Promise<unknown> {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 15_000);
  const forward = () => abort.abort(); options.signal?.addEventListener('abort', forward, { once: true });
  if (options.signal?.aborted) abort.abort();
  try {
    const response = await (options.fetcher ?? fetch)(`${apiBase(options)}${path}`, { method: 'GET', signal: abort.signal, cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } });
    requireValue(response.ok, `Firsto 报价来源暂不可用（HTTP ${response.status}），不使用估算或旧报价`);
    requireValue(response.headers.get('content-type')?.includes('application/json'), '报价代理未返回 JSON，请检查同源 API 代理');
    const reader = response.body?.getReader(); requireValue(reader, '报价响应为空');
    const parts: Uint8Array[] = []; let size = 0;
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error('报价响应超过读取上限'); } parts.push(item.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', forward); }
}

export async function fetchQuotePage(input: { query?: string; sort?: PriceSort; page?: number; series?: 'TapeOut' | 'Behemoth'; pageSize?: 30 | 50; viewId?: string } = {}, options: FetchOptions = {}): Promise<MineQuotePage> {
  const query = (input.query ?? '').trim(); const page = input.page ?? 1; const sort = input.sort ?? 'price_low';
  requireValue(query.length <= 128 && !/[\x00-\x1f\x7f]/.test(query), '搜索内容过长或无效');
  requireValue(Number.isSafeInteger(page) && page >= 1 && page <= 10_000 && PRICE_SORTS.includes(sort), '分页或排序无效');
  const params = new URLSearchParams({ category: 'official_mining', sort, page: String(page), pageSize: String(input.pageSize ?? 30) });
  if (query) params.set('query', query); if (input.series) params.set('processorName', input.series); if (input.viewId) params.set('viewId', input.viewId);
  return parseQuotePage(await readApi(`/v1/circuits?${params}`, options));
}
export async function fetchCapacityReference(options: FetchOptions = {}): Promise<CapacityReference> { return parseCapacityReference(await readApi('/v1/circuit-holders?page=1', options)); }
export async function fetchMineQuote(collectionValue: string, tokenValue: string, options: FetchOptions = {}): Promise<MineQuote> {
  const collection = address(collectionValue, '矿机合约'); const tokenId = uint(tokenValue.trim(), '矿机编号');
  const series = (Object.keys(OFFICIAL_COLLECTIONS) as (keyof typeof OFFICIAL_COLLECTIONS)[]).find(key => OFFICIAL_COLLECTIONS[key] === collection);
  requireValue(series, '只接受官方 TapeOut / Behemoth 合约地址，不按同名认定');
  let found: MineQuote | undefined; let viewId: string | undefined;
  for (let page = 1; page <= 3; page++) {
    const result = await fetchQuotePage({ query: tokenId, series, page, pageSize: 50, viewId }, options);
    if (viewId) requireValue(viewId === result.viewId, '来源快照已变化，请重试'); else viewId = result.viewId;
    found = result.rows.find(row => row.collection === collection && row.tokenId === tokenId);
    if (found || page >= result.totalPages) break;
  }
  requireValue(found, '受限查询未找到完全匹配的官方矿机，不能推测其报价');
  const detail = await readApi(`/v1/circuit/${collection}/${tokenId}`, options);
  return verifyQuoteDetail(found, detail);
}

export function createQuotePlan(quote: MineQuote, reference: CapacityReference, extraBps = 1000, minVerifiedWeight = quote.verifiedWeight ?? '0', now = Date.now()): QuotePlan {
  requireValue(!quoteIssue(quote, now), quoteIssue(quote, now) ?? '报价无效');
  requireValue(quote.detailChecked, '请先通过合约地址与编号核对矿机详情');
  requireValue(!referenceIssue(reference, now), referenceIssue(reference, now) ?? '参考价无效');
  requireValue(quote.status === 'verified' && quote.unverifiedWeight === '0' && quote.verifiedWeight && BigInt(quote.verifiedWeight) > 0n, '只支持纯验证池、非最优、无未验证权重的官方矿机');
  const expectedTaskId = uint(quote.taskId, '任务型号'); requireValue(BigInt(expectedTaskId) < (1n << 32n), '任务型号超出链上 uint32 范围');
  const minimum = uint(minVerifiedWeight, '最低验证权重'); requireValue(BigInt(minimum) > 0n && BigInt(minimum) <= BigInt(quote.verifiedWeight) && BigInt(minimum) < (1n << 128n), '最低验证权重必须为正且不高于目标矿机');
  requireValue(quote.estimated24hAtomic && BigInt(quote.estimated24hAtomic) > 0n, '目标矿机缺少有效日产能');
  requireValue(Number.isInteger(extraBps) && extraBps >= 0 && extraBps <= 10000, '额外预算需在 0%–100% 之间，最多两位小数');
  const referencePriceWei = (BigInt(reference.dailyCapacityPriceWei) * BigInt(quote.estimated24hAtomic) + 99_999_999n) / 100_000_000n;
  const targetRaiseWei = ((referencePriceWei * BigInt(10_000 + extraBps) + 999_999n) / 1_000_000n) * 100n;
  requireValue(targetRaiseWei > 0n && targetRaiseWei <= UINT256, '筹款目标超出合约金额范围');
  const sourceDigest = keccak256(toUtf8Bytes(JSON.stringify({ quote, reference })));
  return { schemaVersion: 1, chainId: 56, createdAt: new Date(now).toISOString(), sourceDigest, target: { collection: quote.collection, tokenId: quote.tokenId, series: quote.series, askId: quote.ask!.id, askPriceWei: quote.ask!.priceWei, firstoBuyerCostWei: quote.ask!.buyerCostWei }, reference, flexiblePurchase: { minVerifiedWeight: minimum, referencePriceWei: referencePriceWei.toString(), targetDailyYieldAtomic: quote.estimated24hAtomic, extraBps, referenceObservedAt: Math.floor(reference.observedAt / 1000), referenceBlock: reference.sourceBlock, referenceDigest: sourceDigest }, funding: { targetRaiseWei: targetRaiseWei.toString(), priceCapWei: targetRaiseWei.toString(), totalShares: 100, pricePerShareWei: (targetRaiseWei / 100n).toString(), extraBps }, eligibility: { collection: quote.collection, expectedTaskId, modelSource: 'reference-nft-onchain', originalTargetFirst: true, miningStatus: 'verified', minVerifiedWeight: minimum, unverifiedWeight: '0', excludeOptimal: true }, notes: ['金额采用 Firsto 日产能参考价乘以目标日产能，再加额外预算；不是直接照抄挂单价。', '参考价为官方两系列纯验证池非最优矿机中，最低五个不同卖家有效挂单的日产能价中位数。', '任务型号在建池时由参考 NFT 的链上挖矿数据锁定；本计划的 expectedTaskId 是来源报价，提交建池前必须与链上值核对。替代品必须同官方合约、同任务型号，且原目标无符合条件的官网挂单。', '实际购买必须重新检查链上挂单、所有权、挖矿条件和最高总价。Firsto signed/batch 挂单不在现有 PoolVault.buyFromMarket 支持范围。', '自动替换矿机必须启用支持 flexiblePurchase 的新池；本计划只保存公开配置，不签名、不购买、不接收资产。', '额外预算未实际用于购机的部分，按购机时的份额比例计入可领取余额，由持有人领取；筹款总额向上取整为100份，每份为整数wei。'] };
}
