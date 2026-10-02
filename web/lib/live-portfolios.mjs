import { Interface, ZeroAddress, getAddress, keccak256, toQuantity } from 'ethers';
import { abi, uint } from './chain-client.mjs';
import { validateManifest, insist, PORTFOLIO_MANIFEST_KEYS, GENESIS_ARTIFACT_DIGEST } from './live-config.mjs';
import { fetchLiveJsonWithClock, requireRecentSnapshotState, validateIndexSource, displayIndexSource } from './live-data.mjs';
import { readDisplayCache, DISPLAY_CACHE_TIMEOUT_MS } from './display-cache-transport.mjs';
import { loadOperatorQuote, readOfficialMinerOnchain } from './operator-quotes.mjs';
import { decodeFirstoOrder, verifyFirstoSignedAsk } from '../../deploy/src/firsto-purchase.mjs';
import { exactPrice, shareQuantity } from './live-actions.mjs';
import { isRetryableReadError } from './read-retry.mjs';
import { saleReferenceState, DEFAULT_SALE_REVIEW_THRESHOLD_BPS, readSaleReviewThreshold,
  normalizeSaleReviewThresholdBps, effectiveSaleReviewThresholdBps, requiresSaleReview } from './sale-governance-gate.mjs';
import { freshUserExitReady } from './fresh-user-exits.mjs';
import { freshWalletActionReady } from './fresh-wallet-actions.mjs';

const identity = new Interface(['function implementation() view returns(address)', 'function owner() view returns(address)']);
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);
const address = value => { const a = getAddress(value); requireValue(a !== ZeroAddress, '地址不能为零。'); return a; };
/** These gates open a preview; contract execution decides on-chain eligibility. */
export function portfolioConfigActionReady(config,action,targetType='portfolio') {
  if (config?.displayOnly === true) return config.status === 'ready' && config.kind === 'integrated-v2'
    && ['genesis','fresh-active','code-upgraded','role-migrating','role-wired'].includes(config.stage);
  const v4Ready = config?.productFamily !== 'fresh-v4'
    || config.operationalReady === true && config.stale !== true && config.transactionReady !== false
    || freshUserExitReady(config,targetType,action) || freshWalletActionReady(config,targetType,action);
  return !!config && v4Ready;
}
export function portfolioCreateActionReady({ config, operatorVerified, operator, currentOperatorRead,
  wallet, account }) {
  const currentOperator = currentOperatorRead === true && typeof operator === 'string'
    && typeof account === 'string' && same(operator, account);
  return portfolioConfigActionReady(config) && !!wallet && !!account
    && (operatorVerified === true || currentOperator);
}
export function portfolioPageActionReady({ config, freshRead, listingSource, initialPool }) {
  return portfolioConfigActionReady(config) && freshRead === true
    && (!!initialPool || !!listingSource && (listingSource.displayOnly === true || listingSource.stale !== true
      && listingSource.readMode !== 'verified_snapshot'));
}
export function portfolioSelectedActionReady({ config, selectedProofCurrent, action, targetType }) {
  return portfolioConfigActionReady(config,action,targetType) && selectedProofCurrent === true;
}
export function portfolioOrderActionReady({ config, selectedProofCurrent, source, orderPool, selectedPool, action }) {
  return portfolioSelectedActionReady({ config, selectedProofCurrent, action, targetType:'portfolioMarket' })
    && !!source && (source.displayOnly === true || source.stale !== true && source.readMode !== 'verified_snapshot')
    && typeof orderPool === 'string' && typeof selectedPool === 'string'
    && same(orderPool, selectedPool);
}
/** Genesis permits one candidate per round and any positive-share holder to propose it. */
export function genesisPortfolioProposalGate(row) {
  if (row?.state !== 2n) return { allowed: false, reason: '项目当前不在运行状态，不能发起出售。' };
  if (row.shares === 0n) return { allowed: false, reason: '持有至少 1 份项目份额才能发起出售。' };
  if (row.proposal && (row.proposal.executed || row.timestamp < row.proposal.endsAt))
    return { allowed: false, reason: '本轮已有进行中的出售提案，请等待结算或投票结束。' };
  if (row.timestamp < row.nextRoundAt)
    return { allowed: false, reason: '下一轮出售提案尚未开放。' };
  return { allowed: true, reason: null };
}
function childSaleExecutionGate({ candidate, openerExecuted, state, timestamp, stage }) {
  const passed = candidate.yesShares >= candidate.threshold
    && candidate.yesMembers * 2n > candidate.memberCount;
  const open = state === 2n && !openerExecuted && !candidate.executed && timestamp < candidate.endsAt;
  if (stage === 'genesis') return { passed, discounted: candidate.threshold === 60n,
    reviewRequired: false, reviewApproved: null, canExecute: open && passed, executionBlockReason: null };
  const { saleReference: reference, saleReview: review } = candidate;
  const saleReviewThresholdBps = normalizeSaleReviewThresholdBps(candidate.saleReviewThresholdBps);
  const discounted = reference?.available ? candidate.price < reference.priceWei : null;
  const reviewRequired = reference?.available ? requiresSaleReview(candidate.price, reference.priceWei, saleReviewThresholdBps) : null;
  const reviewApproved = review?.available === true && review.status === 1n;
  let executionBlockReason = null;
  if (!reference?.available) executionBlockReason = reference?.reason || 'Firsto 市场参考价不可用，暂不能挂牌。';
  else if (reviewRequired && !review?.available) executionBlockReason = review?.reason || '平台审核状态不可用，暂不能挂牌。';
  else if (reviewRequired && review.status === 2n) executionBlockReason = '平台已驳回这项子矿机出售提案。';
  else if (reviewRequired && !reviewApproved) executionBlockReason = '低于 Firsto 市场参考价的审核门槛，尚待平台审核通过。';
  return { passed, discounted, reviewRequired, reviewApproved, saleReviewThresholdBps,
    canExecute: open && passed && executionBlockReason === null, executionBlockReason };
}
// Leave capacity for other page sections on the 24-active-request read proxy.
const PORTFOLIO_PAGE_READ_LIMIT = 12;
function boundedPortfolioReads(read) {
  let active = 0;
  const waiting = [], pending = new Set();
  const limited = (...args) => {
    const task = (async () => {
      if (active < PORTFOLIO_PAGE_READ_LIMIT) active++;
      else await new Promise(resolve => waiting.push(resolve));
      try { return await read(...args); }
      finally {
        const next = waiting.shift();
        if (next) next(); // Transfer the occupied slot to the next read.
        else active--;
      }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  return { read: limited, drain: () => Promise.allSettled([...pending]) };
}
export const PORTFOLIO_ACTIONS = new Set(['deposit', 'withdrawDeposit', 'finalizeFundingFailure', 'claimFailedFunding',
  'finalizeAcquisition', 'collectChildBem', 'claimBem', 'withdrawBnb', 'transfer', 'proposeChildSale', 'voteChildSale',
  'executeChildSale', 'settleChildSale', 'expireChildSale', 'buyOfficial', 'buyFirsto']);

/** Settled historical credit survives share transfers; unpaid accrual is counted exactly once. */
export function portfolioBnbEntitlement(row) {
  const accrued = row.shares * row.salePerShareWei;
  requireValue(accrued >= row.saleDebt, '预算项目卖款账本不一致。');
  const refund = !row.refundSettled && row.state !== 0n && row.state !== 1n ? row.shares * row.refundPerShareWei : 0n;
  return row.bnbOwed + refund + accrued - row.saleDebt;
}

export async function readPortfolioContext(config, provider, blockNumber) {
  requireValue(['genesis','fresh-active','code-upgraded','role-migrating','role-wired'].includes(config?.stage),
    '预算项目缺少已核验的产品阶段。');
  const manifest = validateManifest(config.manifest, config.stage === 'genesis' ? GENESIS_ARTIFACT_DIGEST : undefined);
  requireValue(manifest.kind === 'integrated-v2', '预算项目尚未完成部署验收。');
  requireValue(abi.BudgetPortfolioFactory && abi.BudgetPortfolioVault, '当前页面缺少预算项目合约版本。');
  const request = (method, params = []) => provider.request({ method, params });
  requireValue(BigInt(await request('eth_chainId')) === 56n, '请切换到 BSC 主网。');
  const block = await request('eth_getBlockByNumber', [blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber)), false]);
  requireValue(/^0x[\da-f]{64}$/i.test(block?.hash) && block.number && block.timestamp, '区块数据不可用。');
  requireValue(BigInt(block.number) >= BigInt(manifest.verifiedBlockNumber), '预算项目读取区块早于部署核验。');
  const tag = toQuantity(BigInt(block.number)), timestamp = BigInt(block.timestamp);
  insist(blockNumber === undefined || BigInt(block.number) === uint(blockNumber),
    'source_reorg', '读取区块不一致。');
  const read = async (to, contract, method, args = []) => contract.decodeFunctionResult(method,
    await request('eth_call', [{ to, data: contract.encodeFunctionData(method, args) }, tag]));
  await Promise.all(PORTFOLIO_MANIFEST_KEYS.map(async key => {
    const code = await request('eth_getCode', [manifest[key], tag]);
    requireValue(code !== '0x' && keccak256(code) === manifest.codehash[key], '预算项目代码与核验清单不一致。');
  }));
  const pf = manifest.portfolioFactory, factoryAbi = abi.BudgetPortfolioFactory;
  const [legacy, market, beacon, operator, impl, owner, marketFactory, legacyMarket, slot, marketSlot, coreMarketSlot, marketOwner, sellerFee, buyerFee] = await Promise.all([
    read(pf, factoryAbi, 'legacyFactory'), read(pf, factoryAbi, 'shareMarket'), read(pf, factoryAbi, 'beacon'),
    read(pf, factoryAbi, 'operator'), read(manifest.portfolioBeacon, identity, 'implementation'),
    read(manifest.portfolioBeacon, identity, 'owner'), read(manifest.portfolioMarket, abi.ShareMarket, 'factory'),
    read(manifest.factory, abi.PoolFactory, 'shareMarket'),
    request('eth_getStorageAt', [pf, SLOT, tag]),
    request('eth_getStorageAt', [manifest.portfolioMarket, SLOT, tag]),
    request('eth_getStorageAt', [manifest.shareMarket, SLOT, tag]),
    read(manifest.portfolioMarket, abi.ShareMarket, 'timelock'),
    read(manifest.portfolioMarket, abi.ShareMarket, 'feeBps'), read(manifest.portfolioMarket, abi.ShareMarket, 'buyerFeeBps'),
  ]);
  requireValue(same(legacy[0], manifest.factory) && same(market[0], manifest.portfolioMarket)
    && same(beacon[0], manifest.portfolioBeacon) && same(impl[0], manifest.portfolioImplementation)
    && same(owner[0], manifest.timelock) && same(marketFactory[0], pf)
    && same(legacyMarket[0], manifest.shareMarket)
    && /^0x0{24}[a-f\d]{40}$/i.test(slot) && same(`0x${slot.slice(-40)}`, manifest.portfolioFactoryImplementation),
  '预算工厂、市场或升级权限关联不一致。');
  requireValue(/^0x0{24}[a-f\d]{40}$/i.test(marketSlot) && marketSlot.toLowerCase() === coreMarketSlot.toLowerCase()
    && address(`0x${marketSlot.slice(-40)}`) && same(marketOwner[0], manifest.timelock)
    && sellerFee[0] === 100n && buyerFee[0] === 100n, '预算市场实现、权限或双边费率不一致。');
  const canonical = async () => {
    const final = await request('eth_getBlockByNumber', [tag, false]);
    insist(BigInt(await request('eth_chainId')) === 56n,
      'wrong_chain', '读取期间网络已变化，请切回 BSC 主网。');
    insist(final?.hash?.toLowerCase() === block.hash.toLowerCase(),
      'source_reorg', '读取期间链上状态变化，请重新核对。');
  };
  return { manifest, stage: config.stage, provider, block, tag, timestamp, read, canonical, operator: address(operator[0]) };
}

// All ordinary portfolio fields share a provider's 12-request budget, including
// directory and detail reads started by different mounted page sections.
const displayReadBudgets = new WeakMap();
const displayContexts = new WeakMap();
export function readPortfolioDisplayContext(config, provider, blockNumber, source) {
  if (config?.productFamily !== 'fresh-v4') return readPortfolioContext(config, provider, blockNumber);
  const manifest = validateManifest(config.manifest, config.stage === 'genesis' ? GENESIS_ARTIFACT_DIGEST : undefined);
  requireValue(manifest.kind === 'integrated-v2' && provider?.request && source,
    '预算项目缺少展示来源。');
  requireValue(same(source.portfolioFactory, manifest.portfolioFactory)
    && same(source.portfolioMarket, manifest.portfolioMarket)
    && BigInt(source.indexedThrough) === uint(blockNumber), '预算项目展示来源不一致。');
  let entries = displayContexts.get(provider);
  if (!entries) { entries = new Map(); displayContexts.set(provider, entries); }
  const key = JSON.stringify([config.stage, config.manifest, String(blockNumber), source.indexedBlockHash]);
  if (entries.has(key)) return entries.get(key);
  let budget = displayReadBudgets.get(provider);
  if (!budget) {
    budget = boundedPortfolioReads(input => provider.request(input));
    displayReadBudgets.set(provider, budget);
  }
  const tag = toQuantity(uint(blockNumber)), timestamp = BigInt(source.indexedTimestamp);
  const read = async (to, contract, method, args = []) => contract.decodeFunctionResult(method,
    await budget.read({ method: 'eth_call', params: [{ to, data: contract.encodeFunctionData(method, args) }, tag] }));
  // There is deliberately no canonical() or authorization proof on this context.
  const context = { manifest, stage: config.stage, provider, tag, timestamp, read,
    block: { number: tag, hash: source.indexedBlockHash, timestamp: toQuantity(timestamp) },
    operator: null, source: displayIndexSource(source), displayOnly: true };
  entries.set(key, context);
  if (entries.size > 4) entries.delete(entries.keys().next().value);
  return context;
}

/** Read only values needed to encode or describe an explicit transaction. */
export function readPortfolioBusinessContext(config, provider, { now = Date.now } = {}) {
  const manifest = validateManifest(config.manifest, config.stage === 'genesis' ? GENESIS_ARTIFACT_DIGEST : undefined);
  requireValue(manifest.kind === 'integrated-v2' && provider?.request, '预算项目配置或读取服务不可用。');
  let budget = displayReadBudgets.get(provider);
  if (!budget) {
    budget = boundedPortfolioReads(input => provider.request(input));
    displayReadBudgets.set(provider, budget);
  }
  const read = async (to, contract, method, args = []) => contract.decodeFunctionResult(method,
    await budget.read({ method: 'eth_call', params: [{ to: address(to), data: contract.encodeFunctionData(method, args) }, 'latest'] }));
  return { manifest, stage: config.stage, provider, tag: 'latest', read,
    timestamp: BigInt(Math.floor(now() / 1000)), block: { number: null, hash: null },
    operator: null, displayOnly: true };
}

/** Complete business model for a shared server cache, without browser proof reads. */
export async function readPortfolioCurrent(config, provider, pool, account = ZeroAddress, { includeChildren = true } = {}) {
  const context = readPortfolioBusinessContext(config, provider), group = boundedPortfolioReads(context.read);
  try { return await readPortfolio({ ...context, read: group.read }, pool, account, { includeChildren }); }
  finally { await group.drain(); }
}

const displayIntegers = ['state', 'budgetWei', 'absoluteCapWei', 'unitCapWei', 'spentWei', 'totalSupply', 'memberCount',
  'childCount', 'activeChildCount', 'fundingDeadline', 'purchaseDeadline', 'refundPerShareWei', 'salePerShareWei',
  'activeProposalId', 'nextProposalId', 'nextRoundAt', 'balanceOf', 'claimableBem', 'bnbOwed', 'saleDebt', 'lockedShares',
  'shares', 'unitPriceWei', 'availableShares', 'timestamp', 'withdrawableBnb'];
function decodeDisplayItem(item, config, source, account) {
  requireValue(item?.kind === 'portfolio' && same(item.account, account) && same(item.OFFICIAL_FACTORY, config.manifest.portfolioFactory)
    && same(item.legacyFactory, config.manifest.factory) && Array.isArray(item.children) && Array.isArray(item.proposals)
    && displayIntegers.every(name => typeof item[name] === 'bigint' && item[name] >= 0n)
    && ['fundingFailed', 'refundSettled', 'shareTradingAllowed'].every(name => typeof item[name] === 'boolean')
    && (item.blockNumber === null || typeof item.blockNumber === 'bigint' && item.blockNumber >= 0n)
    && item.state <= 5n && item.shares <= 100n && item.totalSupply <= 100n && item.availableShares <= item.shares
    && item.budgetWei > 0n && item.budgetWei % 100n === 0n, '服务器预算项目展示数据无效或账户不一致。');
  return { ...item, pool: address(item.pool), displayOnly: true, displaySource: source };
}
async function serverPortfolioDisplay(config, path, query, { fetcher = globalThis.fetch, now = Date.now } = {}) {
  if (config?.displayOnly !== true) return null;
  const manifest = validateManifest(config.manifest, config.stage === 'genesis' ? GENESIS_ARTIFACT_DIGEST : undefined);
  const base = new URL(config.indexBaseUrl);
  requireValue(base.origin === config.origin && !base.search && !base.hash, '索引服务来源不一致。');
  const url = new URL(`${base.href.replace(/\/$/, '')}/v1/display/portfolios${path}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  let response;
  try {
    const read = () => fetchLiveJsonWithClock(url.href, { fetcher, now,
      timeoutMs: DISPLAY_CACHE_TIMEOUT_MS });
    response = await (readDisplayCache(read));
  }
  catch (error) {
    if (config.testProfile === true || config.displayOnly === true) throw error;
    if (isRetryableReadError(error) || error?.code === 'network_unavailable' || [404,503].includes(error?.details?.status)) return null;
    throw error;
  }
  const { body, serverNow, localReceivedAt } = response, input = body?.source;
  requireValue(input?.cacheOrigin === 'server' && input.displayOnly === true && input.transactionReady === false
    && ['display','verified_snapshot','current'].includes(input.readMode), '服务器预算项目快照来源无效。');
  const parsed = validateIndexSource({ ...input, ...(input.readMode === 'display'
    ? { cacheReadMode: 'display', readMode: input.stale === true ? 'verified_snapshot' : 'current' } : {}) }, manifest,
    { now: now(), ...(serverNow === null ? {} : { timeProof: { serverNow, localReceivedAt } }) });
  requireValue(same(parsed.portfolioFactory, manifest.portfolioFactory) && same(parsed.portfolioMarket, manifest.portfolioMarket),
    '服务器预算项目快照合约来源不一致。');
  const source = displayIndexSource(parsed);
  const data = JSON.parse(JSON.stringify(body.data), (_key, value) => value && typeof value === 'object'
    && Object.keys(value).length === 1 && typeof value.$bemineBigInt === 'string'
    && /^(0|[1-9]\d*)$/.test(value.$bemineBigInt) ? uint(value.$bemineBigInt) : value);
  return { source, data };
}

async function portfolioDisplaySource(config, { fetcher = globalThis.fetch, now = Date.now } = {}) {
  const manifest = validateManifest(config.manifest, config.stage === 'genesis' ? GENESIS_ARTIFACT_DIGEST : undefined);
  const base = new URL(config.indexBaseUrl);
  requireValue(base.origin === config.origin && !base.search && !base.hash, '索引服务来源不一致。');
  const { body: reply, serverNow, localReceivedAt } = await fetchLiveJsonWithClock(`${base.href.replace(/\/$/, '')}/health`, { fetcher, now });
  const source = validateIndexSource(reply?.source?.complete === true ? reply.source : reply?.displaySource, manifest, { now: now(),
    ...(serverNow === null ? {} : { timeProof: { serverNow, localReceivedAt } }) });
  requireValue(same(source.portfolioFactory, manifest.portfolioFactory)
    && same(source.portfolioMarket, manifest.portfolioMarket), '预算项目索引身份不一致。');
  return displayIndexSource(source);
}

/** Current business fields only; the result can open, never authorize, a preview. */
export async function readPortfolioDisplayRow(config, provider, pool, account = ZeroAddress, options = {}) {
  const cached = await serverPortfolioDisplay(config, `/${address(pool)}`,
    { account: getAddress(account), children: options.includeChildren !== false }, options);
  if (cached) {
    const item = decodeDisplayItem(cached.data?.item, config, cached.source, getAddress(account));
    requireValue(same(item.pool, pool), '服务器预算项目与请求不一致。');
    return { item, source: cached.source, operator: null };
  }
  if (config?.productFamily !== 'fresh-v4') {
    const context = await readPortfolioContext(config, provider);
    const item = await readPortfolio(context, pool, account); await context.canonical();
    return { item, operator: context.operator };
  }
  const source = await portfolioDisplaySource(config, options);
  const context = await readPortfolioDisplayContext(config, provider, BigInt(source.indexedThrough), source);
  const group = boundedPortfolioReads(context.read);
  try {
    const item = await readPortfolio({ ...context, read: group.read }, pool, account, { includeChildren: options.includeChildren !== false });
    return { item, source, operator: null };
  } finally { await group.drain(); }
}

export async function readPortfolioDisplayChildren(config, provider, row, offset = 0n) {
  if (config?.productFamily !== 'fresh-v4') {
    const context = await readPortfolioContext(config, provider, row.blockNumber);
    insist(context.block.hash.toLowerCase() === row.blockHash.toLowerCase(), 'source_reorg', '项目区块已变化，请重新展开项目。');
    const children = await readPortfolioChildren(context, row.pool, row.childCount, offset); await context.canonical();
    return children;
  }
  requireValue(row.displayOnly === true && row.displaySource, '项目缺少展示来源。');
  const context = row.blockNumber === null ? readPortfolioBusinessContext(config, provider)
    : await readPortfolioDisplayContext(config, provider, row.blockNumber, row.displaySource);
  const group = boundedPortfolioReads(context.read);
  try { return await readPortfolioChildren({ ...context, read: group.read }, row.pool, row.childCount, offset); }
  finally { await group.drain(); }
}

export async function readPortfolio(context, pool, account = ZeroAddress, { includeChildren = true } = {}) {
  const { manifest, read, timestamp } = context, target = address(pool), owner = getAddress(account), contract = abi.BudgetPortfolioVault;
  if (!context.displayOnly) requireValue((await read(manifest.portfolioFactory, abi.BudgetPortfolioFactory, 'isPool', [target]))[0] === true,
    '此预算项目未在工厂登记。');
  const names = ['OFFICIAL_FACTORY', 'legacyFactory', 'state', 'budgetWei', 'absoluteCapWei', 'unitCapWei', 'spentWei',
    'totalSupply', 'memberCount', 'childCount', 'activeChildCount', 'fundingDeadline', 'purchaseDeadline', 'fundingFailed',
    'refundPerShareWei', 'salePerShareWei', 'activeProposalId', 'nextProposalId', 'shareTradingAllowed', 'nextRoundAt'];
  const memberNames = ['balanceOf', 'claimableBem', 'bnbOwed', 'refundSettled', 'saleDebt', 'lockedShares'];
  const values = await Promise.all([...names.map(name => read(target, contract, name)),
    ...memberNames.map(name => read(target, contract, name, [owner])),
    context.stage === 'genesis' ? DEFAULT_SALE_REVIEW_THRESHOLD_BPS : readSaleReviewThreshold(read, target)]);
  const row = Object.fromEntries([...names, ...memberNames].map((key, i) => [key, values[i][0]]));
  row.saleReviewThresholdBps = values[names.length + memberNames.length];
  if (context.displayOnly) Object.assign(row, { displayOnly: true, displaySource: context.source });
  requireValue(same(row.OFFICIAL_FACTORY, manifest.portfolioFactory) && same(row.legacyFactory, manifest.factory)
    && row.state <= 5n && row.totalSupply <= 100n && row.balanceOf <= 100n && row.budgetWei > 0n
    && row.budgetWei % 100n === 0n && row.lockedShares <= row.balanceOf, '预算项目状态不一致。');
  Object.assign(row, { kind: 'portfolio', pool: target, account: owner, shares: row.balanceOf,
    unitPriceWei: row.budgetWei / 100n, availableShares: row.balanceOf - row.lockedShares, timestamp,
    blockNumber: context.block.number === null ? null : BigInt(context.block.number), blockHash: context.block.hash, children: [], proposal: null, proposals: [] });
  row.withdrawableBnb = portfolioBnbEntitlement(row);
  const childThresholds = new Map();
  const childThreshold = child => {
    const key = child.toLowerCase();
    if (!childThresholds.has(key)) childThresholds.set(key, readSaleReviewThreshold(read, child));
    return childThresholds.get(key);
  };
  if (row.activeProposalId > 0n) {
    requireValue(row.nextProposalId > row.activeProposalId && row.nextProposalId - row.activeProposalId <= 16n,
      '预算项目出售候选数量超出可核验范围。');
    const entries = await Promise.all(Array.from({ length: Number(row.nextProposalId - row.activeProposalId) }, (_, offset) => {
      const id = row.activeProposalId + BigInt(offset);
      return Promise.all([read(target, contract, 'proposals', [id]), read(target, contract, 'hasVoted', [id, owner])])
        .then(async ([p, voted]) => {
          const cost = context.stage === 'genesis'
            ? (await read(target, contract, 'childInfo', [p.child]))[2] : null;
          requireValue(cost === null || cost > 0n, '创世子矿机购机成本未通过链上核验。');
          let saleReference = null, saleReview = null, saleReviewThresholdBps = row.saleReviewThresholdBps;
          if (context.stage !== 'genesis') {
            const [referenceResult, reviewResult, childThresholdResult] = await Promise.allSettled([
              read(manifest.shareMarket, abi.ShareMarket, 'saleReference', [p.child]),
              read(target, contract, 'childSaleReview', [id]),
              childThreshold(p.child),
            ]);
            saleReviewThresholdBps = effectiveSaleReviewThresholdBps(row.saleReviewThresholdBps,
              childThresholdResult.status === 'fulfilled' ? childThresholdResult.value : DEFAULT_SALE_REVIEW_THRESHOLD_BPS);
            saleReference = referenceResult.status === 'fulfilled'
              ? saleReferenceState(referenceResult.value, timestamp)
              : Object.freeze({ available: false, reason: 'Firsto 市场参考价暂不可读取。' });
            const reviewStatus = reviewResult.status === 'fulfilled' ? reviewResult.value[0] : null;
            saleReview = reviewStatus !== null && reviewStatus <= 2n
              ? Object.freeze({ available: true, status: reviewStatus })
              : Object.freeze({ available: false, status: null, reason: '平台审核状态暂不可读取。' });
          }
          return { id, child: address(p.child), price: p.price, referencePrice: p.referencePrice,
            referenceAt: p.referenceAt, endsAt: p.endsAt, memberCount: p.memberCount, yesMembers: p.yesMembers,
            yesShares: p.yesShares, executed: p.executed, hasVoted: voted[0],
            threshold: cost !== null && p.price < cost ? 60n : 51n, saleReference, saleReview,
            saleReviewThresholdBps };
        });
    }));
    row.proposals = entries.filter(candidate => candidate.endsAt === entries[0].endsAt)
      .map(candidate => Object.freeze({ ...candidate, ...childSaleExecutionGate({ candidate,
        openerExecuted: entries[0].executed, state: row.state, timestamp, stage: context.stage }) }));
    row.proposal = row.proposals[0];
  }
  // Display at most 100 children per page; the adapter accepts a cursor for further batches below.
  if (includeChildren) row.children = await readPortfolioChildren(context, target, row.childCount);
  return Object.freeze(row);
}

export async function readPortfolioChildren(context, portfolio, count, offset = 0n) {
  const result = [], end = count < offset + 100n ? count : offset + 100n;
  for (let start = offset; start < end; start += 4n) {
    const jobs = [];
    for (let i = start; i < end && i < start + 4n; i++) jobs.push((async () => {
      const pool = address((await context.read(portfolio, abi.BudgetPortfolioVault, 'childAt', [i]))[0]);
      const info = await context.read(portfolio, abi.BudgetPortfolioVault, 'childInfo', [pool]);
      const [registered, factory, state, expired, activatedAt] = await Promise.all([
        context.displayOnly ? true : context.read(context.manifest.factory, abi.PoolFactory, 'isPool', [pool]).then(value => value[0]),
        context.displayOnly ? context.manifest.factory : context.read(pool, abi.PoolVault, 'factory').then(value => value[0]),
        context.read(pool, abi.PoolVault, 'state'), context.read(pool, abi.PoolVault, 'expiresAt'), context.read(pool, abi.PoolVault, 'activatedAt'),
      ]);
      requireValue(registered === true && same(factory, context.manifest.factory), '子矿池未在已核验工厂登记。');
      return { pool, collection: address(info.collection), tokenId: info.tokenId, costWei: info.purchaseCost,
        official: info.official, sold: info.sold, state: state[0], expiresAt: expired[0], activatedAt: activatedAt[0] };
    })());
    result.push(...await Promise.all(jobs));
  }
  return result;
}

export async function readPortfolioPage(config, provider, { account, cursor = 0, mine = false,
  fetcher = globalThis.fetch, now = Date.now } = {}) {
  requireValue(Number.isSafeInteger(cursor) && cursor >= 0, '项目分页游标无效。');
  const owner = getAddress(account || ZeroAddress);
  const cached = await serverPortfolioDisplay(config, '', { account: owner, cursor, limit: 20, ...(mine ? { mine: true } : {}) }, { fetcher, now });
  if (cached) {
    requireValue(Array.isArray(cached.data?.items) && cached.data.items.length <= 20
      && (cached.data.nextCursor === null || Number.isSafeInteger(cached.data.nextCursor) && cached.data.nextCursor > cursor),
    '服务器预算项目分页无效。');
    const items = cached.data.items.map(item => decodeDisplayItem(item, config, cached.source, owner));
    requireValue(new Set(items.map(item => item.pool)).size === items.length, '服务器预算项目分页重复。');
    return { items, nextCursor: cached.data.nextCursor, source: cached.source, operator: null };
  }
  const manifest = validateManifest(config.manifest, config.stage === 'genesis' ? GENESIS_ARTIFACT_DIGEST : undefined), base = new URL(config.indexBaseUrl);
  requireValue(base.origin === config.origin && !base.search && !base.hash, '索引服务来源不一致。');
  const path = mine ? `/v1/accounts/${address(account)}/portfolios` : '/v1/portfolios';
  let result;
  try { result = await fetchLiveJsonWithClock(`${base.href.replace(/\/$/, '')}${path}?cursor=${cursor}&limit=20`, { fetcher, now }); }
  catch (error) {
    if (mine || !isRetryableReadError(error)) throw error;
    result = await fetchLiveJsonWithClock(`${base.href.replace(/\/$/, '')}/v1/snapshot/portfolios?cursor=${cursor}&limit=20`, { fetcher, now });
    requireValue(result.body?.source?.readMode === 'verified_snapshot', '预算项目快照来源无效。');
  }
  const { body: reply, serverNow, localReceivedAt } = result;
  const parsedSource = validateIndexSource(reply.source, manifest, { now: now(),
    ...(reply.source?.readMode === 'verified_snapshot' ? { maxAgeMs: 30 * 60 * 1000 } : {}),
    ...(serverNow === null ? {} : { timeProof: { serverNow, localReceivedAt } }) });
  const source = config.productFamily === 'fresh-v4' ? displayIndexSource(parsedSource) : parsedSource;
  requireValue(same(source.portfolioFactory, manifest.portfolioFactory) && same(source.portfolioMarket, manifest.portfolioMarket)
    && Array.isArray(reply.data?.items) && reply.data.items.length <= 20, '预算项目索引身份或分页无效。');
  const nextCursor = reply.data.nextCursor;
  requireValue(nextCursor === null || Number.isSafeInteger(nextCursor) && nextCursor > cursor, '索引返回重复游标。');
  if (config.productFamily !== 'fresh-v4') await requireRecentSnapshotState(provider, source);
  const context = await readPortfolioDisplayContext(config, provider, BigInt(source.indexedThrough), source);
  insist(context.block.hash.toLowerCase() === source.indexedBlockHash
    && context.timestamp === BigInt(source.indexedTimestamp), 'source_reorg', '预算项目索引区块已变化。');
  if (!context.displayOnly && source.readMode === 'verified_snapshot') {
    const count = (await context.read(manifest.portfolioFactory, abi.BudgetPortfolioFactory, 'portfolioCount'))[0];
    requireValue(typeof source.portfolioCount === 'string' && count === BigInt(source.portfolioCount), '预算项目快照数量与链上不一致。');
  }
  const items = [], seen = new Set();
  for (const entry of reply.data.items) {
    const pool = address(entry.address);
    requireValue(entry.kind === 'portfolio' && same(entry.factory, manifest.portfolioFactory)
      && !seen.has(pool), '预算项目索引包含重复或外部地址。');
    seen.add(pool);
  }
  const limited = boundedPortfolioReads(context.read), pageContext = { ...context, read: limited.read };
  try {
    for (let offset = 0; offset < reply.data.items.length; offset += 4) {
      const batch = await Promise.allSettled(reply.data.items.slice(offset, offset + 4)
        .map(entry => readPortfolio(pageContext, entry.address, account || ZeroAddress, { includeChildren: false })));
      const failed = batch.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      items.push(...batch.map(result => result.value));
    }
  } finally { await limited.drain(); }
  if (!context.displayOnly) await context.canonical();
  return { items, nextCursor, source, operator: context.operator };
}

export async function readPortfolioOrders(config, provider, pool, { cursor,
  fetcher = globalThis.fetch, now = Date.now } = {}) {
  const manifest = validateManifest(config.manifest, config.stage === 'genesis' ? GENESIS_ARTIFACT_DIGEST : undefined), target = address(pool), base = new URL(config.indexBaseUrl);
  requireValue(base.origin === config.origin && !base.search && !base.hash, '订单索引服务来源不一致。');
  const query = new URLSearchParams({ pool: target, limit: '20' });
  if (cursor !== undefined && cursor !== null) query.set('cursor', uint(String(cursor)).toString());
  const { body: reply, serverNow, localReceivedAt } = await fetchLiveJsonWithClock(
    `${base.href.replace(/\/$/, '')}/v1/portfolio-orders?${query}`, { fetcher, now });
  const parsedSource = validateIndexSource(reply.source, manifest, { now: now(),
    ...(serverNow === null ? {} : { timeProof: { serverNow, localReceivedAt } }) });
  const source = config.productFamily === 'fresh-v4' ? displayIndexSource(parsedSource) : parsedSource;
  requireValue(same(source.portfolioFactory, manifest.portfolioFactory) && same(source.portfolioMarket, manifest.portfolioMarket)
    && Array.isArray(reply.data?.items) && reply.data.items.length <= 20, '预算订单索引身份无效。');
  const ctx = await readPortfolioDisplayContext(config, provider, BigInt(source.indexedThrough), source);
  insist(ctx.block.hash.toLowerCase() === source.indexedBlockHash, 'source_reorg', '预算订单索引区块已变化。');
  if (!ctx.displayOnly) await readPortfolio(ctx, target, ZeroAddress, { includeChildren: false });
  const items = []; let last = cursor ? uint(String(cursor)) : null;
  for (const entry of reply.data.items) {
    const id = uint(entry.orderId);
    requireValue(id > 0n && (last === null || id < last), '订单游标或排序无效。'); last = id;
    const [raw, expiry] = await Promise.all([ctx.read(manifest.portfolioMarket, abi.ShareMarket, 'orders', [id]),
      ctx.read(manifest.portfolioMarket, abi.ShareMarket, 'orderExpiresAt', [id])]);
    const order = raw[0];
    requireValue(same(order.pool, target) && same(entry.pool, target) && same(order.seller, entry.seller)
      && order.remaining === uint(entry.remaining) && order.pricePerUnit === uint(entry.pricePerUnitWei), '预算订单与链上数据不一致。');
    items.push({ id, pool: target, seller: address(order.seller), remaining: order.remaining,
      pricePerUnitWei: order.pricePerUnit, active: order.active, expiresAt: expiry[0], expired: expiry[0] <= ctx.timestamp });
  }
  requireValue(reply.data.nextCursor === null || items.length > 0 && String(reply.data.nextCursor) === last.toString(), '订单分页游标无效。');
  if (!ctx.displayOnly) await ctx.canonical(); return { items, nextCursor: reply.data.nextCursor, source };
}

export async function preparePortfolioAction({ config, provider, account, pool, action }) {
  if (config?.displayOnly === true) return preparePortfolioDirectAction({ config, provider, account, pool, action });
  const context = await readPortfolioContext(config, provider), owner = address(account), { manifest, read } = context;
  const operatorAllowed = async () => {
    if (same(owner, context.operator)) return true;
    if (config?.stage !== 'fresh-active' || !config.authority || !same(context.operator, config.authority)) return false;
    const [first, second, core, budget] = await Promise.all([
      read(config.authority, abi.PlatformAuthority, 'administratorOne'),
      read(config.authority, abi.PlatformAuthority, 'administratorTwo'),
      read(config.authority, abi.PlatformAuthority, 'coreFactory'),
      read(config.authority, abi.PlatformAuthority, 'budgetFactory'),
    ]);
    return (same(owner, first[0]) || same(owner, second[0]))
      && same(core[0], manifest.factory) && same(budget[0], manifest.portfolioFactory);
  };
  let target = pool && address(pool), contract = abi.BudgetPortfolioVault, method = action.kind, args = [], value = 0n, row = null, procurement = null;
  let targetType = 'portfolio', marketTrade = null;
  if (['marketList', 'marketFill', 'marketCancel', 'marketExpire', 'marketWithdraw'].includes(method)) {
    const methodMap = { marketList: 'list', marketFill: 'fill', marketCancel: 'cancel', marketExpire: 'expire', marketWithdraw: 'withdrawBnb' };
    method = methodMap[method]; targetType = 'portfolioMarket'; target = manifest.portfolioMarket; contract = abi.ShareMarket;
    if (method === 'list' || method === 'fill') {
      const [sellerFee, buyerFee] = await Promise.all([read(target, contract, 'feeBps'), read(target, contract, 'buyerFeeBps')]);
      requireValue(sellerFee[0] === 100n && buyerFee[0] === 100n, '预算市场尚未通过双边 1% 手续费核验。');
    }
    if (method === 'list') {
      row = await readPortfolio(context, address(pool), owner, { includeChildren: false });
      const shares = shareQuantity(action.quantity), price = exactPrice(action.price);
      requireValue(row.shareTradingAllowed && shares <= row.availableShares, '项目份额正在冻结或可售数量不足。');
      args = [row.pool, shares, price];
      marketTrade = { baseWei: uint(price * shares), buyerFeeWei: price * shares / 100n, sellerFeeWei: price * shares / 100n };
    } else if (method !== 'withdrawBnb') {
      const id = uint(action.orderId); requireValue(id > 0n, '订单编号无效。');
      const [o, expiry] = await Promise.all([read(target, contract, 'orders', [id]), read(target, contract, 'orderExpiresAt', [id])]);
      const order = o[0];
      requireValue(order.active && order.remaining > 0n && same(order.pool, pool), '订单已结束或属于其他预算项目。');
      row = await readPortfolio(context, order.pool, owner, { includeChildren: false });
      if (method === 'fill') {
        const shares = shareQuantity(action.quantity);
        requireValue(row.shareTradingAllowed && expiry[0] > context.timestamp && shares <= order.remaining && !same(order.seller, owner), '订单暂不能成交。');
        if (action.expectedSeller) requireValue(same(order.seller, action.expectedSeller), '卖方已改变。');
        if (action.expectedPricePerUnitWei !== undefined) requireValue(order.pricePerUnit === uint(action.expectedPricePerUnitWei), '每份价格已改变。');
        const base = uint(order.pricePerUnit * shares), fee = base / 100n;
        value = uint(base + fee); args = [id, shares];
        marketTrade = { baseWei: base, buyerFeeWei: fee, sellerFeeWei: fee, seller: order.seller, pricePerUnitWei: order.pricePerUnit };
      } else {
        requireValue(method === 'cancel' ? same(order.seller, owner) : expiry[0] <= context.timestamp, '只有卖方可撤单；到期后任何人可解锁。');
        args = [id];
      }
    }
  } else if (method === 'createPortfolio') {
    targetType = 'portfolioFactory';
    requireValue(await operatorAllowed(), '仅链上登记的预算项目管理员可创建项目。');
    target = manifest.portfolioFactory; contract = abi.BudgetPortfolioFactory;
    const budget = exactPrice(action.budget), absoluteCap = exactPrice(action.absoluteCap), unitCap = exactPrice(action.unitCap);
    const funding = uint(action.fundingDeadline, 64), purchase = uint(action.purchaseDeadline, 64);
    requireValue(budget % 100n === 0n && absoluteCap <= budget && funding > context.timestamp && purchase > funding,
      '请核对预算、价格上限和募集/购机截止时间。');
    args = [budget, absoluteCap, unitCap, funding, purchase];
  } else {
    requireValue(method === 'autoPurchase' || PORTFOLIO_ACTIONS.has(method), '不支持的预算项目操作。');
    row = await readPortfolio(context, target, owner, { includeChildren: false });
    if (action.expectedPool) requireValue(same(target, action.expectedPool), '预算项目已改变。');
    if (method === 'claimBem') requireValue(row.lockedShares === 0n,
      '份额挂单仍在锁定；请先撤单或等待成交、到期解锁后再领取 BEM。');
    if (method === 'autoPurchase') {
      requireValue(await operatorAllowed() && row.state === 1n, '预算项目未募满或当前钱包不是运营钱包。');
      const child = address(action.child);
      requireValue((await read(manifest.factory, abi.PoolFactory, 'isPool', [child]))[0], '子矿池未登记。');
      const [paramsResult, childState, supply, childFactory] = await Promise.all([
        read(child, abi.PoolVault, 'params'), read(child, abi.PoolVault, 'state'), read(child, abi.PoolVault, 'totalSupply'), read(child, abi.PoolVault, 'factory'),
      ]);
      const params = paramsResult[0];
      requireValue(same(childFactory[0], manifest.factory) && childState[0] === 0n && supply[0] === 0n, '只能采购已创建但无人认购的子矿池。');
      const official = await readOfficialMinerOnchain(provider, params.circuits, params.circuitId, { config, blockTag: context.tag });
      requireValue(official.blockHash === context.block.hash && same(official.registry.pool, child), '矿机唯一性登记或区块不一致。');
      const weighted = row.unitCapWei * uint(official.verifiedWeight);
      const projectCap = weighted < row.absoluteCapWei ? weighted : row.absoluteCapWei;
      requireValue(params.priceCap <= projectCap && params.targetRaise <= row.budgetWei - row.spentWei, '子矿池价格上限或募集额超出预算限制。');
      if (official.official && uint(official.official.priceWei) <= params.priceCap) {
        method = 'buyOfficial'; args = [child, uint(official.official.id)];
        procurement = { route: 'official', child, priceWei: uint(official.official.priceWei), capWei: params.priceCap };
      } else {
        let order;
        if (action.frozenOrder) order = await verifyFirstoSignedAsk(provider, decodeFirstoOrder(action.frozenOrder), { blockTag: context.tag });
        else {
          const checked = await loadOperatorQuote({ collection: params.circuits, tokenId: params.circuitId.toString(), config, provider,
            blockTag: context.tag, mode: 'createPool', officialPriceCapWei: params.priceCap.toString() });
          requireValue(checked.chain.blockHash === context.block.hash && checked.chain.firsto, checked.chain.firstoError || '无可执行的 Firsto 报价。');
          order = checked.chain.firsto;
        }
        requireValue(same(order.ask.collection, params.circuits) && uint(order.ask.tokenId) === params.circuitId
          && uint(order.grossWei) <= params.priceCap, 'Firsto 报价不属于目标矿机或超过购机上限。');
        method = 'buyFirsto'; args = [child, order.encodedOrder];
        procurement = { route: 'firsto', child, priceWei: uint(order.grossWei), capWei: params.priceCap, frozenOrder: order.encodedOrder };
      }
      if (action.expectedPurchaseWei !== undefined) requireValue(procurement.priceWei === uint(action.expectedPurchaseWei), '采购报价已变化，请重新预览。');
    } else if (method === 'deposit') { const shares = shareQuantity(action.quantity); args = [shares]; value = row.unitPriceWei * shares; }
    else if (method === 'transfer') args = [address(action.recipient), shareQuantity(action.quantity)];
    else if (method === 'collectChildBem') args = [address(action.child)];
    else if (method === 'proposeChildSale') {
      const child = address(action.child);
      if (context.stage === 'genesis') {
        const gate = genesisPortfolioProposalGate(row);
        requireValue(gate.allowed, gate.reason);
        const [info, childState, activatedAt] = await Promise.all([
          read(target, abi.BudgetPortfolioVault, 'childInfo', [child]),
          read(child, abi.PoolVault, 'state'), read(child, abi.PoolVault, 'activatedAt'),
        ]);
        requireValue(info.collection !== ZeroAddress && !info.sold && childState[0] === 2n
          && context.timestamp >= activatedAt[0] + 7n * 86400n,
        '该子矿机尚未满足创世版出售条件。');
      }
      args = [child, exactPrice(action.price), exactPrice(action.reference), uint(action.referenceAt, 64)];
    }
    else if (method === 'voteChildSale' || method === 'executeChildSale') {
      const candidate = row.proposals.find(item => item.id === uint(action.proposalId));
      requireValue(candidate && !row.proposal?.executed && !candidate.executed, '子矿机提案已改变。');
      if (method === 'executeChildSale') requireValue(row.timestamp < candidate.endsAt
        && candidate.yesShares >= candidate.threshold
        && candidate.yesMembers * 2n > candidate.memberCount,
      '子矿机出售尚未达到该版本链上表决门槛。');
      if (method === 'executeChildSale') requireValue(candidate.canExecute,
        candidate.executionBlockReason || '子矿机出售当前不可执行，请重新预览。');
      args = method === 'voteChildSale' ? [candidate.id, action.support] : [candidate.id];
      if (method === 'voteChildSale') requireValue(typeof action.support === 'boolean', '投票选项无效。');
    } else if (method === 'buyOfficial') args = [address(action.child), uint(action.listingId)];
    else if (method === 'buyFirsto') args = [address(action.child), action.encodedOrder];
  }
  const transaction = { chainId: '0x38', from: owner, to: target, data: contract.encodeFunctionData(method, args), value: toQuantity(value) };
  await context.canonical();
  return { transaction, action: { kind: method, targetType }, row,
    blockNumber: BigInt(context.block.number), args, procurement, marketTrade,
    payoutWei: targetType === 'portfolio' && method === 'withdrawBnb' ? row.withdrawableBnb
      : targetType === 'portfolio' && method === 'claimBem' ? row.claimableBem : null };
}

/** Exact calldata, without browser deployment, role or canonical-block rechecks. */
async function preparePortfolioDirectAction({ config, provider, account, pool, action }) {
  const context = readPortfolioBusinessContext(config, provider), { manifest, read } = context, owner = address(account);
  requireValue(action && typeof action.kind === 'string', '预算项目操作无效。');
  let method = action.kind, target = pool && address(pool), contract = abi.BudgetPortfolioVault;
  let targetType = 'portfolio', args = [], value = 0n, row = target ? { pool: target, account: owner, displayOnly: true } : null;
  let procurement = null, marketTrade = null, payoutWei = null;
  if (method === 'createPortfolio') {
    targetType = 'portfolioFactory'; target = manifest.portfolioFactory; contract = abi.BudgetPortfolioFactory;
    const budget = exactPrice(action.budget), absoluteCap = exactPrice(action.absoluteCap), unitCap = exactPrice(action.unitCap);
    const funding = uint(action.fundingDeadline, 64), purchase = uint(action.purchaseDeadline, 64);
    requireValue(budget % 100n === 0n && absoluteCap <= budget && funding > context.timestamp && purchase > funding,
      '请核对预算、价格上限和募集/购机截止时间。');
    args = [budget, absoluteCap, unitCap, funding, purchase];
  } else if (['marketList', 'marketFill', 'marketCancel', 'marketExpire', 'marketWithdraw'].includes(method)) {
    method = { marketList: 'list', marketFill: 'fill', marketCancel: 'cancel', marketExpire: 'expire', marketWithdraw: 'withdrawBnb' }[method];
    targetType = 'portfolioMarket'; target = manifest.portfolioMarket; contract = abi.ShareMarket;
    if (method === 'list') {
      const shares = shareQuantity(action.quantity), price = exactPrice(action.price), base = uint(price * shares);
      args = [address(pool), shares, price]; marketTrade = { baseWei: base, buyerFeeWei: base / 100n, sellerFeeWei: base / 100n };
    } else if (method !== 'withdrawBnb') {
      const id = uint(action.orderId); requireValue(id > 0n, '订单编号无效。'); args = [id];
      if (method === 'fill') {
        const shares = shareQuantity(action.quantity);
        const [orders, buyerFee, sellerFee] = await Promise.all([
          read(target, contract, 'orders', [id]), read(target, contract, 'buyerFeeBps'), read(target, contract, 'feeBps'),
        ]);
        const order = orders[0], unitPrice = uint(order.pricePerUnit);
        requireValue(same(order.pool, pool), '订单不属于当前预算项目。');
        if (action.expectedSeller !== undefined) requireValue(same(order.seller, action.expectedSeller), '卖方已改变。');
        if (action.expectedPricePerUnitWei !== undefined) requireValue(unitPrice === uint(action.expectedPricePerUnitWei), '每份价格已改变。');
        requireValue(unitPrice > 0n && uint(buyerFee[0], 16) <= 10000n && uint(sellerFee[0], 16) <= 10000n,
          '挂单金额或手续费无效。');
        const base = uint(unitPrice * shares), fee = uint(base * buyerFee[0] / 10000n);
        value = uint(base + fee); args = [id, shares];
        marketTrade = { baseWei: base, buyerFeeWei: fee, sellerFeeWei: base * sellerFee[0] / 10000n,
          seller: address(order.seller), pricePerUnitWei: order.pricePerUnit };
      }
    }
  } else {
    requireValue(method === 'autoPurchase' || PORTFOLIO_ACTIONS.has(method), '不支持的预算项目操作。');
    requireValue(target, '预算项目地址无效。');
    if (method === 'deposit') {
      const shares = shareQuantity(action.quantity), budget = (await read(target, contract, 'budgetWei'))[0];
      requireValue(budget > 0n && budget % 100n === 0n, '预算金额无法换算为等额份额。');
      args = [shares]; value = uint(budget / 100n * shares);
    } else if (method === 'transfer') args = [address(action.recipient), shareQuantity(action.quantity)];
    else if (method === 'collectChildBem') args = [address(action.child)];
    else if (method === 'proposeChildSale') args = [address(action.child), exactPrice(action.price), exactPrice(action.reference), uint(action.referenceAt, 64)];
    else if (method === 'voteChildSale' || method === 'executeChildSale') {
      const id = uint(action.proposalId); requireValue(id > 0n, '提案编号无效。');
      if (method === 'voteChildSale') requireValue(typeof action.support === 'boolean', '投票选项无效。');
      args = method === 'voteChildSale' ? [id, action.support] : [id];
    } else if (method === 'buyOfficial') args = [address(action.child), uint(action.listingId)];
    else if (method === 'buyFirsto') args = [address(action.child), action.encodedOrder];
    else if (method === 'claimBem') payoutWei = (await read(target, contract, 'claimableBem', [owner]))[0];
    else if (method === 'withdrawBnb') {
      const names = ['state', 'refundPerShareWei', 'salePerShareWei'];
      const members = ['balanceOf', 'bnbOwed', 'refundSettled', 'saleDebt'];
      const result = await Promise.all([...names.map(name => read(target, contract, name)), ...members.map(name => read(target, contract, name, [owner]))]);
      Object.assign(row, Object.fromEntries([...names, ...members].map((name, index) => [name, result[index][0]])));
      row.shares = row.balanceOf; payoutWei = portfolioBnbEntitlement(row);
    } else if (method === 'autoPurchase') {
      const child = address(action.child), params = (await read(child, abi.PoolVault, 'params'))[0];
      const checked = await loadOperatorQuote({ collection: params.circuits, tokenId: params.circuitId.toString(), config,
        provider, mode: 'createPool', officialPriceCapWei: params.priceCap.toString() });
      if (checked.chain.official && uint(checked.chain.official.priceWei) <= params.priceCap) {
        method = 'buyOfficial'; args = [child, uint(checked.chain.official.id)];
        procurement = { route: 'official', child, priceWei: uint(checked.chain.official.priceWei), capWei: params.priceCap };
      } else {
        const order = action.frozenOrder ? decodeFirstoOrder(action.frozenOrder) : checked.chain.firsto;
        requireValue(order && same(order.ask.collection, params.circuits) && uint(order.ask.tokenId) === params.circuitId,
          'Firsto 报价不属于目标矿机。');
        const price = uint(order.grossWei ?? checked.chain.firsto?.grossWei);
        requireValue(price <= params.priceCap, 'Firsto 报价超过购机上限。');
        method = 'buyFirsto'; args = [child, order.encodedOrder ?? action.frozenOrder];
        procurement = { route: 'firsto', child, priceWei: price, capWei: params.priceCap, frozenOrder: args[1] };
      }
    }
  }
  const transaction = { chainId: '0x38', from: owner, to: target, data: contract.encodeFunctionData(method, args), value: toQuantity(value) };
  return { transaction, action: { kind: method, targetType }, row, blockNumber: null, args,
    procurement, marketTrade, payoutWei, displayOnly: true };
}
