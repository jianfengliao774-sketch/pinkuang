import { getAddress, ZeroAddress, toQuantity } from 'ethers';
import { abi, uint } from './chain-client.mjs';
import { hash, insist, liveAddress, validateManifest } from './live-config.mjs';
import { displayIndexSource, fetchLiveJsonWithClock, requireRecentSnapshotState, validateIndexSource } from './live-data.mjs';
import { saleReferenceState, readSaleReviewThreshold, effectiveSaleReviewThresholdBps, requiresSaleReview } from './sale-governance-gate.mjs';
import { createDisplayReadCache, displayConfigIdentity, displayProviderIdentity } from './display-read-cache.mjs';

const same = (a, b) => getAddress(a) === getAddress(b);
const message = error => error?.shortMessage || error?.message || '申请读取失败，请重试。';
const check = (ok, text) => insist(ok, 'review_requests', text);
const candidateLimit = kind => kind === 'pool' ? 100n : 16n;
const displayReads = createDisplayReadCache();
const abortCheck = signal => { if (signal?.aborted) throw Object.assign(new Error('申请读取已取消。'), { name: 'AbortError' }); };
const thresholdReader = read => {
  const values = new Map();
  return project => {
    const key = project.toLowerCase();
    if (!values.has(key)) values.set(key, readSaleReviewThreshold(read, project));
    return values.get(key);
  };
};

// Bound actual RPC requests, not just projects. One slow project must not open
// hundreds of concurrent view calls when its voting round has many candidates.
function readQueue(provider, signal) {
  let active = 0;
  const waiting = [], running = new Set();
  const request = input => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('申请读取已取消。'), { name: 'AbortError' })); return; }
    waiting.push({ input, resolve, reject }); pump();
  });
  const cancel = () => { for (const job of waiting.splice(0)) job.reject(Object.assign(new Error('申请读取已取消。'), { name: 'AbortError' })); };
  signal?.addEventListener('abort', cancel, { once: true });
  function pump() {
    while (!signal?.aborted && active < 4 && waiting.length) {
      const job = waiting.shift(); active++;
      const task = Promise.resolve().then(() => { abortCheck(signal); return provider.request(job.input); })
        .then(job.resolve, job.reject).finally(() => { active--; running.delete(task); pump(); });
      running.add(task);
    }
  }
  return { request, async drain() { try { while (running.size) await Promise.allSettled([...running]); }
    finally { signal?.removeEventListener('abort', cancel); } } };
}

function settings(config, provider) {
  check(config?.stage === 'fresh-active', '出售申请仅属于当前正式部署。');
  check(typeof provider?.request === 'function', '只读链上服务暂不可用。');
  const manifest = validateManifest(config.manifest), base = new URL(config.indexBaseUrl);
  check(base.origin === config.origin && !base.search && !base.hash, '申请索引来源与正式站点不一致。');
  return { manifest, base: base.href.replace(/\/$/, '') };
}

async function indexRead(base, path, manifest, options) {
  abortCheck(options.signal);
  const result = await fetchLiveJsonWithClock(`${base}${path}`, options);
  abortCheck(options.signal);
  const { body, serverNow, localReceivedAt } = result;
  const source = validateIndexSource(body.source, manifest, { now: options.now(),
    ...(serverNow === null ? {} : { timeProof: { serverNow, localReceivedAt } }) });
  return { source: options.displayOnly === true ? displayIndexSource(source) : source, data: body.data };
}

async function context(config, provider, source, signal) {
  abortCheck(signal);
  const { manifest, base } = settings(config, provider), queue = readQueue(provider, signal);
  const request = (method, params = []) => queue.request({ method, params });
  try {
    if (config.displayOnly === true) {
      const blockNumber = source ? BigInt(source.indexedThrough) : null;
      const timestamp = source ? BigInt(source.indexedTimestamp) : BigInt(Math.floor(Date.now() / 1000));
      const tag = source ? toQuantity(blockNumber) : 'latest';
      const read = async (to, contract, name, args = []) => contract.decodeFunctionResult(name,
        await request('eth_call', [{ to, data: contract.encodeFunctionData(name, args) }, tag]));
      const references = new Map(), reference = pool => {
        const key = pool.toLowerCase();
        if (!references.has(key)) references.set(key, read(manifest.shareMarket, abi.ShareMarket, 'saleReference', [pool])
          .then(value => saleReferenceState(value, timestamp))
          .catch(error => ({ available: false, priceWei: null, observedAt: null, reason: message(error) })));
        return references.get(key);
      };
      return { config, manifest, base, queue, request, read, reference, source, saleReviewThreshold: thresholdReader(read),
        current: !source || source.stale !== true, displayOnly: true,
        block: source ? { hash: source.indexedBlockHash } : null, blockNumber, timestamp, async canonical() {} };
    }
    if (source) await requireRecentSnapshotState({ request: queue.request }, source);
    const [chain, block] = await Promise.all([
      request('eth_chainId'), request('eth_getBlockByNumber', [source ? toQuantity(source.indexedThrough) : 'latest', false]),
    ]);
    check(BigInt(chain) === 56n, '请切换至 BSC 主网。');
    check(block?.number && block?.timestamp && hash(block.hash), '申请快照区块暂不可用。');
    const blockNumber = BigInt(block.number), timestamp = BigInt(block.timestamp), tag = toQuantity(blockNumber);
    if (source) check(blockNumber === BigInt(source.indexedThrough)
      && block.hash.toLowerCase() === source.indexedBlockHash && timestamp === BigInt(source.indexedTimestamp),
    '申请索引与链上区块不一致，请刷新。');
    check(blockNumber >= BigInt(manifest.verifiedBlockNumber), 'RPC 尚未同步到当前正式部署。');
    const read = async (to, contract, name, args = []) => contract.decodeFunctionResult(name,
      await request('eth_call', [{ to, data: contract.encodeFunctionData(name, args) }, tag]));
    const [market, factory] = await Promise.all([
      read(manifest.factory, abi.PoolFactory, 'shareMarket'), read(manifest.shareMarket, abi.ShareMarket, 'factory'),
    ]);
    check(same(market[0], manifest.shareMarket) && same(factory[0], manifest.factory), '审核市场与当前正式工厂不一致。');
    const references = new Map();
    const reference = pool => {
      const key = pool.toLowerCase();
      if (!references.has(key)) references.set(key, read(manifest.shareMarket, abi.ShareMarket, 'saleReference', [pool])
        .then(value => saleReferenceState(value, timestamp))
        .catch(error => ({ available: false, priceWei: null, observedAt: null, reason: message(error) })));
      return references.get(key);
    };
    const current = !source || source.stale !== true && source.readMode !== 'verified_snapshot';
    return { config, manifest, base, queue, request, read, reference, source, current, block, blockNumber, timestamp,
      saleReviewThreshold: thresholdReader(read),
      async canonical() {
        await queue.drain();
        const [again, finalChain] = await Promise.all([request('eth_getBlockByNumber', [tag, false]), request('eth_chainId')]);
        check(BigInt(finalChain) === 56n && again?.hash?.toLowerCase() === block.hash.toLowerCase(),
          '读取期间链上区块发生变化，请刷新申请。');
      } };
  } catch (error) { await queue.drain(); throw error; }
}

function reviewState({ state, openerExecuted, executed, endsAt, timestamp, reference, review, priceWei, saleReviewThresholdBps }) {
  const discounted = reference.available ? priceWei < reference.priceWei : null;
  const reviewRequired = reference.available ? requiresSaleReview(priceWei, reference.priceWei, saleReviewThresholdBps) : null;
  const open = state === 2n && !openerExecuted && !executed && timestamp < endsAt;
  let status;
  if (openerExecuted || executed || state === 3n || state === 4n) status = 'executed';
  else if (!open) status = 'expired';
  else if (!reference.available) status = 'reference-missing';
  else if (reviewRequired === false) status = 'no-review';
  else if (review?.status === 2n) status = 'rejected';
  else if (review?.status === 1n && review.priceWei === priceWei) status = 'approved';
  else if (!review || review.status === 1n && review.priceWei !== priceWei) status = 'review-unavailable';
  else status = 'pending';
  return { status, discounted, reviewRequired, saleReviewThresholdBps, canReview: open && reviewRequired === true
    && (status === 'pending' || status === 'approved') };
}

function row(context, kind, project, pool, id, p, opener, state, reference, review, identity, saleReviewThresholdBps) {
  const { timestamp, blockNumber } = context;
  const members = kind === 'pool' ? p.snapshotMemberCount : p.memberCount;
  const yesCount = kind === 'pool' ? p.yesCount : p.yesMembers;
  check(p.price > 0n && p.price < (1n << 128n) && members > 0n && members <= 100n
    && yesCount <= members && p.yesShares <= 100n, '提案价格或投票数据不一致。');
  if (kind === 'pool') check(p.snapshotTotalShares === 100n && p.snapshotTs + 86400n === p.endsAt,
    '单机提案的快照格式不受支持。');
  const gate = reviewState({ state, openerExecuted: opener.executed, executed: p.executed,
    endsAt: p.endsAt, timestamp, reference, review, priceWei: p.price, saleReviewThresholdBps });
  return { key: `${kind}:${project.toLowerCase()}:${id}`, kind, project, pool, proposalId: id,
    priceWei: p.price, referencePriceWei: reference.priceWei ?? null,
    referenceObservedAt: reference.observedAt ?? null, referenceAvailable: reference.available,
    referenceReason: reference.reason ?? null, recordedReferencePriceWei: kind === 'pool' ? p.refPrice : p.referencePrice,
    recordedReferenceAt: kind === 'pool' ? p.refAt : p.referenceAt,
    proposer: kind === 'pool' ? liveAddress(p.proposer) : null,
    proposerUnavailable: kind === 'portfolio' ? '此预算提案未记录申请人，尚未找到可核实的直接发起交易。' : null,
    collection: identity.collection, tokenId: identity.tokenId, endsAt: p.endsAt,
    yesShares: p.yesShares, yesCount, requiredYesShares: 51n, requiredYesCount: members / 2n + 1n,
    passed: p.yesShares > 50n && yesCount * 2n > members, reviewStatus: review?.status ?? null,
    reviewPriceWei: review?.priceWei ?? null, ...gate,
    canReview: gate.canReview && (context.displayOnly === true || context.current && context.config.stale !== true
      && context.config.operationalReady !== false),
    current: context.current, blockNumber, blockHash: context.block?.hash ?? null, timestamp,
    ...(context.displayOnly === true ? { displayOnly: true } : {}) };
}

async function projectRequests(ctx, kind, project, options, selectedId) {
  const { manifest, read, request } = ctx, isPool = kind === 'pool';
  const factory = isPool ? manifest.factory : manifest.portfolioFactory;
  check(factory, '当前部署不包含预算项目。');
  const contract = isPool ? abi.PoolVault : abi.BudgetPortfolioVault;
  const factoryAbi = isPool ? abi.PoolFactory : abi.BudgetPortfolioFactory;
  const [registered, binding, stateResult, active, next, code] = await Promise.all([
    ...(ctx.displayOnly ? [null, null] : [
    read(factory, factoryAbi, 'isPool', [project]), read(project, contract, 'OFFICIAL_FACTORY'),
    ]),
    read(project, contract, 'state'), read(project, contract, 'activeProposalId'), read(project, contract, 'nextProposalId'),
    ctx.displayOnly ? null : request('eth_getCode', [project, toQuantity(ctx.blockNumber)]),
  ]);
  if (!ctx.displayOnly) check(registered[0] === true && same(binding[0], factory) && code && code !== '0x', '申请项目未在当前正式工厂登记。');
  const state = stateResult[0], activeId = active[0], nextId = next[0];
  check(state <= 5n && nextId >= 1n && (activeId === 0n || activeId < nextId)
    && nextId - (activeId || nextId) <= candidateLimit(kind), '当前轮申请数量或状态无效。');
  if (!activeId) return [];
  if (selectedId !== undefined && (selectedId < activeId || selectedId >= nextId)) return [];
  const saleReviewThresholdBps = await ctx.saleReviewThreshold(project);
  let identity;
  if (isPool) {
    const [params, boundFactory, subscriber] = await Promise.all([
      read(project, contract, 'params'), ctx.displayOnly ? null : read(project, contract, 'factory'),
      ctx.displayOnly ? null : read(factory, factoryAbi, 'designatedSubscriber', [project]),
    ]);
    if (!ctx.displayOnly) check(same(boundFactory[0], factory) && subscriber[0] === ZeroAddress, '预算子矿机须从预算项目审核。');
    identity = { collection: liveAddress(params[0].circuits), tokenId: params[0].circuitId };
  } else if (!ctx.displayOnly) {
    const [legacy, factoryLegacy] = await Promise.all([
      read(project, contract, 'legacyFactory'), read(factory, factoryAbi, 'legacyFactory'),
    ]);
    check(same(legacy[0], manifest.factory) && same(factoryLegacy[0], manifest.factory), '预算项目与当前矿池工厂不一致。');
  }
  const get = async id => {
    const value = await read(project, contract, isPool ? 'getProposal' : 'proposals', [id]);
    return isPool ? value[0] : value;
  };
  const opener = await get(activeId), candidates = [];
  // Four candidates at a time also bounds queued RPC work and memory.
  const firstId = selectedId ?? activeId, endId = selectedId === undefined ? nextId : selectedId + 1n;
  for (let start = firstId; start < endId; start += 4n) {
    const ids = Array.from({ length: Number(endId - start < 4n ? endId - start : 4n) }, (_, n) => start + BigInt(n));
    const batch = await Promise.allSettled(ids.map(async id => {
      const p = id === activeId ? opener : await get(id);
      if (p.endsAt !== opener.endsAt || isPool && p.snapshotTs !== opener.snapshotTs) return null;
      const pool = isPool ? project : liveAddress(p.child);
      const [reference, reviewResult, childResult, childThreshold] = await Promise.all([
        ctx.reference(pool),
        (isPool ? read(manifest.shareMarket, abi.ShareMarket, 'saleReview', [project, id])
          : read(project, contract, 'childSaleReview', [id])).catch(() => null),
        isPool ? null : read(project, contract, 'childInfo', [pool]),
        isPool ? saleReviewThresholdBps : ctx.saleReviewThreshold(pool),
      ]);
      let review = null;
      if (reviewResult && reviewResult[0] <= 2n) review = { status: reviewResult[0], priceWei: isPool ? reviewResult[1] : p.price };
      const child = isPool ? identity : { collection: liveAddress(childResult.collection), tokenId: childResult.tokenId };
      return row(ctx, kind, project, pool, id, p, opener, state, reference, review, child,
        effectiveSaleReviewThresholdBps(saleReviewThresholdBps, childThreshold));
    }));
    const failed = batch.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    candidates.push(...batch.map(result => result.value).filter(Boolean));
  }
  if (!isPool && candidates.length && selectedId === undefined) await identifyPortfolioProposers(ctx, project, candidates, options);
  return candidates;
}

// Budget proposals have no proposer field on-chain. Attribute only a direct,
// canonical proposeChildSale transaction; a relayed contract sender is unknown.
async function identifyPortfolioProposers(ctx, project, candidates, options) {
  const wanted = new Map(candidates.map(item => [item.proposalId.toString(), item]));
  let cursor;
  try {
    for (let page = 0; page < 4 && wanted.size; page++) {
      const query = new URLSearchParams({ pool: project, limit: '50', ...(cursor ? { cursor } : {}) });
      const { source, data } = await indexRead(ctx.base, `/v1/activity?${query}`, ctx.manifest, options);
      check(Array.isArray(data?.items) && data.items.length <= 50, '预算申请历史分页无效。');
      for (const event of data.items) {
        if (event.event !== 'ChildSaleProposed' || !wanted.has(String(event.fields?.proposalId))) continue;
        const item = wanted.get(String(event.fields.proposalId));
        check(same(event.pool, project) && same(event.contract, project) && event.source === 'portfolio'
          && Number.isSafeInteger(event.blockNumber) && event.blockNumber <= source.indexedThrough
          && Number.isSafeInteger(event.logIndex) && event.logIndex >= 0
          && BigInt(event.blockNumber) <= ctx.blockNumber && hash(event.blockHash) && hash(event.transactionHash)
          && same(event.fields.child, item.pool) && uint(event.fields.price) === item.priceWei
          && uint(event.fields.endsAt) === item.endsAt, '预算申请事件身份无效。');
        const [tx, block, receipt] = await Promise.all([
          ctx.request('eth_getTransactionByHash', [event.transactionHash]),
          ctx.displayOnly ? null : ctx.request('eth_getBlockByNumber', [toQuantity(event.blockNumber), false]),
          ctx.displayOnly ? null : ctx.request('eth_getTransactionReceipt', [event.transactionHash]),
        ]);
        if (ctx.displayOnly) {
          if (!tx?.to || !same(tx.to, project)) continue;
          const parsed = abi.BudgetPortfolioVault.parseTransaction({ data: tx.input ?? tx.data });
          if (parsed?.name !== 'proposeChildSale' || !same(parsed.args[0], item.pool)
            || parsed.args[1] !== item.priceWei || parsed.args[2] !== item.recordedReferencePriceWei
            || parsed.args[3] !== item.recordedReferenceAt) continue;
          item.proposer = liveAddress(tx.from); item.proposerUnavailable = null;
          item.transactionHash = event.transactionHash; wanted.delete(item.proposalId.toString()); continue;
        }
        if (!tx || !tx.to || !same(tx.to, project) || tx.hash?.toLowerCase() !== event.transactionHash.toLowerCase()
          || tx.blockHash?.toLowerCase() !== event.blockHash.toLowerCase()
          || block?.hash?.toLowerCase() !== event.blockHash.toLowerCase()
          || BigInt(tx.blockNumber) !== BigInt(event.blockNumber)
          || !receipt || BigInt(receipt.status) !== 1n
          || receipt.transactionHash?.toLowerCase() !== event.transactionHash.toLowerCase()
          || receipt.blockHash?.toLowerCase() !== event.blockHash.toLowerCase()) continue;
        const log = receipt.logs?.find(value => same(value.address, project)
          && BigInt(value.logIndex) === BigInt(event.logIndex));
        if (!log) continue;
        const emitted = abi.BudgetPortfolioVault.parseLog(log);
        if (emitted?.name !== 'ChildSaleProposed' || emitted.args.proposalId !== item.proposalId
          || !same(emitted.args.child, item.pool) || emitted.args.price !== item.priceWei
          || emitted.args.endsAt !== item.endsAt) continue;
        const parsed = abi.BudgetPortfolioVault.parseTransaction({ data: tx.input ?? tx.data });
        if (parsed?.name !== 'proposeChildSale' || !same(parsed.args[0], item.pool)
          || parsed.args[1] !== item.priceWei || parsed.args[2] !== item.recordedReferencePriceWei
          || parsed.args[3] !== item.recordedReferenceAt) continue;
        item.proposer = liveAddress(tx.from); item.proposerUnavailable = null;
        item.transactionHash = event.transactionHash; wanted.delete(item.proposalId.toString());
      }
      if (data.nextCursor === null) break;
      check(typeof data.nextCursor === 'string' && /^\d+:\d+:\d+$/.test(data.nextCursor)
        && data.nextCursor !== cursor, '预算申请历史游标无效。');
      cursor = data.nextCursor;
    }
  } catch { /* Attribution is optional; an unknown proposer must never be invented. */ }
}

/** Read one directory page; every displayed application comes from pinned views.
 * Errors remain separate from empty projects and other pages keep working. */
export function readSaleReviewRequests(input = {}) {
  const { config, provider, account = '', scope = 'pool', cursor = 0, limit = 10,
    fetcher = globalThis.fetch, signal, force = false, refreshToken = 0, cacheMs = 120_000, now = Date.now } = input;
  if (config?.displayOnly !== true || !provider?.request) return readSaleReviewRequestsUncached(input);
  const key = JSON.stringify([displayConfigIdentity(config), (account || '').toLowerCase(), scope, cursor, limit, displayProviderIdentity(fetcher)]);
  return displayReads(provider, key, sharedSignal => readSaleReviewRequestsUncached({ ...input, signal: sharedSignal }),
    { signal, force, refreshToken, cacheMs, now, shouldCache: value => !value.errors?.length });
}

async function readSaleReviewRequestsUncached({ config, provider, scope = 'pool', cursor = 0, limit = 10,
  fetcher = globalThis.fetch, now = Date.now, signal }) {
  check(scope === 'pool' || scope === 'portfolio', '申请类型无效。');
  check(Number.isSafeInteger(cursor) && cursor >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 20,
    '申请分页无效。');
  const { manifest, base } = settings(config, provider), options = { fetcher, now, signal, displayOnly: config.displayOnly === true };
  const { source, data } = await indexRead(base, `/v1/${scope === 'pool' ? 'pools' : 'portfolios'}?cursor=${cursor}&limit=${limit}`,
    manifest, options);
  if (scope === 'portfolio') check(manifest.portfolioFactory && same(source.portfolioFactory, manifest.portfolioFactory)
    && same(source.portfolioMarket, manifest.portfolioMarket), '预算申请索引属于其他部署。');
  check(Array.isArray(data?.items) && data.items.length <= limit
    && (data.nextCursor === null || Number.isSafeInteger(data.nextCursor)
      && data.nextCursor === cursor + data.items.length && data.items.length > 0), '申请目录分页无效。');
  const projects = data.items.map(entry => {
    if (scope === 'portfolio') check(entry.kind === 'portfolio' && same(entry.factory, manifest.portfolioFactory), '预算目录身份无效。');
    return liveAddress(entry.address);
  });
  check(new Set(projects).size === projects.length, '申请目录有重复项目。');
  const ctx = await context(config, provider, source, signal), items = [], errors = [];
  try {
    let total;
    if (scope === 'portfolio') {
      total = ctx.displayOnly ? source.portfolioCount === undefined ? null : uint(source.portfolioCount)
        : (await ctx.read(manifest.portfolioFactory, abi.BudgetPortfolioFactory, 'portfolioCount'))[0];
      if (source.portfolioCount !== undefined) check(total === uint(source.portfolioCount), '预算申请目录数量不一致。');
    } else {
      const registered = uint(data.registeredPoolCount), children = uint(data.childPoolCount);
      const reserved = uint(data.reservedChildPoolCount);
      total = uint(data.standalonePoolCount);
      const count = ctx.displayOnly ? registered : (await ctx.read(manifest.factory, abi.PoolFactory, 'poolCount'))[0];
      check(count === registered && total + children + reserved === registered, '申请目录与链上矿池数量不一致。');
    }
    const offset = BigInt(cursor), count = BigInt(projects.length), size = BigInt(limit);
    if (total !== null) check(offset <= total && count === (total - offset < size ? total - offset : size)
      && (data.nextCursor === null ? offset + count === total : BigInt(data.nextCursor) < total),
    '申请目录未覆盖当前页全部项目，请刷新。');
    for (let offset = 0; offset < projects.length; offset += 4) {
      abortCheck(signal);
      const batch = await Promise.allSettled(projects.slice(offset, offset + 4)
        .map(project => projectRequests(ctx, scope, project, options)));
      batch.forEach((result, index) => {
        if (result.status === 'fulfilled') items.push(...result.value);
        else errors.push({ project: projects[offset + index], message: message(result.reason) });
      });
    }
    abortCheck(signal);
    await ctx.canonical();
    return { items, nextCursor: data.nextCursor, source, errors, projectsRead: projects.length,
      scope, cursor, complete: errors.length === 0 };
  } finally { await ctx.queue.drain(); }
}

/** Re-read just the selected project at the latest head before signing. No
 * simulation, balance scan, other-page refresh or whole-directory reload. */
export async function refreshSaleReviewRequest({ config, provider, item, fetcher = globalThis.fetch, now = Date.now }) {
  check(item && ['pool', 'portfolio'].includes(item.kind), '请先选择一条出售申请。');
  const project = liveAddress(item.project), id = uint(item.proposalId);
  if (config?.displayOnly === true) {
    settings(config, provider);
    check(id > 0n && uint(item.priceWei) > 0n && item.key === `${item.kind}:${project.toLowerCase()}:${id}`, '申请编号或金额无效。');
    liveAddress(item.pool);
    return Object.freeze({ ...item, displayOnly: true });
  }
  const ctx = await context(config, provider);
  try {
    const items = await projectRequests(ctx, item.kind, project, { fetcher, now }, id);
    const latest = items.find(candidate => candidate.proposalId === id);
    check(latest && latest.key === item.key && same(latest.pool, item.pool) && latest.priceWei === uint(item.priceWei),
      '该申请或价格已变化，请刷新后重新选择。');
    await ctx.canonical();
    return latest;
  } finally { await ctx.queue.drain(); }
}
