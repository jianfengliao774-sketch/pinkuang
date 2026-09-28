import { Interface, ZeroAddress, getAddress, keccak256, toQuantity } from 'ethers';
import { abi, uint } from './chain-client.mjs';
import { validateManifest, fetchLiveJson, PORTFOLIO_MANIFEST_KEYS } from './live-config.mjs';
import { validateIndexSource } from './live-data.mjs';
import { loadOperatorQuote, readOfficialMinerOnchain } from './operator-quotes.mjs';
import { decodeFirstoOrder, verifyFirstoSignedAsk } from '../../deploy/src/firsto-purchase.mjs';
import { exactPrice, shareQuantity } from './live-actions.mjs';
import { isRetryableReadError } from './read-retry.mjs';

const identity = new Interface(['function implementation() view returns(address)', 'function owner() view returns(address)']);
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);
const address = value => { const a = getAddress(value); requireValue(a !== ZeroAddress, '地址不能为零。'); return a; };
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
  const manifest = validateManifest(config.manifest);
  requireValue(manifest.kind === 'integrated-v2', '预算项目尚未完成部署验收。');
  requireValue(abi.BudgetPortfolioFactory && abi.BudgetPortfolioVault, '当前页面缺少预算项目合约版本。');
  const request = (method, params = []) => provider.request({ method, params });
  requireValue(BigInt(await request('eth_chainId')) === 56n, '请切换到 BSC 主网。');
  const block = await request('eth_getBlockByNumber', [blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber)), false]);
  requireValue(/^0x[\da-f]{64}$/i.test(block?.hash) && block.number && block.timestamp, '区块数据不可用。');
  requireValue(BigInt(block.number) >= BigInt(manifest.verifiedBlockNumber), '预算项目读取区块早于部署核验。');
  const tag = toQuantity(BigInt(block.number)), timestamp = BigInt(block.timestamp);
  requireValue(blockNumber === undefined || BigInt(block.number) === uint(blockNumber), '读取区块不一致。');
  const read = async (to, contract, method, args = []) => contract.decodeFunctionResult(method,
    await request('eth_call', [{ to, data: contract.encodeFunctionData(method, args) }, tag]));
  await Promise.all(PORTFOLIO_MANIFEST_KEYS.map(async key => {
    const code = await request('eth_getCode', [manifest[key], tag]);
    requireValue(code !== '0x' && keccak256(code) === manifest.codehash[key], '预算项目代码与核验清单不一致。');
  }));
  const pf = manifest.portfolioFactory, factoryAbi = abi.BudgetPortfolioFactory;
  const [legacy, market, beacon, operator, impl, owner, marketFactory, slot, marketSlot, coreMarketSlot, marketOwner, sellerFee, buyerFee] = await Promise.all([
    read(pf, factoryAbi, 'legacyFactory'), read(pf, factoryAbi, 'shareMarket'), read(pf, factoryAbi, 'beacon'),
    read(pf, factoryAbi, 'operator'), read(manifest.portfolioBeacon, identity, 'implementation'),
    read(manifest.portfolioBeacon, identity, 'owner'), read(manifest.portfolioMarket, abi.ShareMarket, 'factory'),
    request('eth_getStorageAt', [pf, SLOT, tag]),
    request('eth_getStorageAt', [manifest.portfolioMarket, SLOT, tag]),
    request('eth_getStorageAt', [manifest.shareMarket, SLOT, tag]),
    read(manifest.portfolioMarket, abi.ShareMarket, 'timelock'),
    read(manifest.portfolioMarket, abi.ShareMarket, 'feeBps'), read(manifest.portfolioMarket, abi.ShareMarket, 'buyerFeeBps'),
  ]);
  requireValue(same(legacy[0], manifest.factory) && same(market[0], manifest.portfolioMarket)
    && same(beacon[0], manifest.portfolioBeacon) && same(impl[0], manifest.portfolioImplementation)
    && same(owner[0], manifest.timelock) && same(marketFactory[0], pf)
    && /^0x0{24}[a-f\d]{40}$/i.test(slot) && same(`0x${slot.slice(-40)}`, manifest.portfolioFactoryImplementation),
  '预算工厂、市场或升级权限关联不一致。');
  requireValue(/^0x0{24}[a-f\d]{40}$/i.test(marketSlot) && marketSlot.toLowerCase() === coreMarketSlot.toLowerCase()
    && address(`0x${marketSlot.slice(-40)}`) && same(marketOwner[0], manifest.timelock)
    && sellerFee[0] === 100n && buyerFee[0] === 100n, '预算市场实现、权限或双边费率不一致。');
  const canonical = async () => {
    const final = await request('eth_getBlockByNumber', [tag, false]);
    requireValue(final?.hash?.toLowerCase() === block.hash.toLowerCase() && BigInt(await request('eth_chainId')) === 56n,
      '读取期间链上状态变化，请重新核对。');
  };
  return { manifest, provider, block, tag, timestamp, read, canonical, operator: address(operator[0]) };
}

export async function readPortfolio(context, pool, account = ZeroAddress, { includeChildren = true } = {}) {
  const { manifest, read, timestamp } = context, target = address(pool), owner = getAddress(account), contract = abi.BudgetPortfolioVault;
  requireValue((await read(manifest.portfolioFactory, abi.BudgetPortfolioFactory, 'isPool', [target]))[0] === true,
    '此预算项目未在工厂登记。');
  const names = ['OFFICIAL_FACTORY', 'legacyFactory', 'state', 'budgetWei', 'absoluteCapWei', 'unitCapWei', 'spentWei',
    'totalSupply', 'memberCount', 'childCount', 'activeChildCount', 'fundingDeadline', 'purchaseDeadline', 'fundingFailed',
    'refundPerShareWei', 'salePerShareWei', 'activeProposalId', 'shareTradingAllowed', 'nextRoundAt'];
  const memberNames = ['balanceOf', 'claimableBem', 'bnbOwed', 'refundSettled', 'saleDebt', 'lockedShares'];
  const values = await Promise.all([...names.map(name => read(target, contract, name)),
    ...memberNames.map(name => read(target, contract, name, [owner]))]);
  const row = Object.fromEntries([...names, ...memberNames].map((key, i) => [key, values[i][0]]));
  requireValue(same(row.OFFICIAL_FACTORY, manifest.portfolioFactory) && same(row.legacyFactory, manifest.factory)
    && row.state <= 5n && row.totalSupply <= 100n && row.balanceOf <= 100n && row.budgetWei > 0n
    && row.budgetWei % 100n === 0n && row.lockedShares <= row.balanceOf, '预算项目状态不一致。');
  Object.assign(row, { kind: 'portfolio', pool: target, account: owner, shares: row.balanceOf,
    unitPriceWei: row.budgetWei / 100n, availableShares: row.balanceOf - row.lockedShares, timestamp,
    blockNumber: BigInt(context.block.number), blockHash: context.block.hash, children: [], proposal: null });
  row.withdrawableBnb = portfolioBnbEntitlement(row);
  if (row.activeProposalId > 0n) {
    const [p, voted] = await Promise.all([read(target, contract, 'proposals', [row.activeProposalId]),
      read(target, contract, 'hasVoted', [row.activeProposalId, owner])]);
    const child = await read(target, contract, 'childInfo', [p.child]);
    row.proposal = { id: row.activeProposalId, child: address(p.child), price: p.price, referencePrice: p.referencePrice,
      referenceAt: p.referenceAt, endsAt: p.endsAt, memberCount: p.memberCount, yesMembers: p.yesMembers,
      yesShares: p.yesShares, executed: p.executed, hasVoted: voted[0], threshold: p.price < child.purchaseCost ? 60n : 51n };
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
        context.read(context.manifest.factory, abi.PoolFactory, 'isPool', [pool]), context.read(pool, abi.PoolVault, 'factory'),
        context.read(pool, abi.PoolVault, 'state'), context.read(pool, abi.PoolVault, 'expiresAt'), context.read(pool, abi.PoolVault, 'activatedAt'),
      ]);
      requireValue(registered[0] === true && same(factory[0], context.manifest.factory), '子矿池未在已核验工厂登记。');
      return { pool, collection: address(info.collection), tokenId: info.tokenId, costWei: info.purchaseCost,
        official: info.official, sold: info.sold, state: state[0], expiresAt: expired[0], activatedAt: activatedAt[0] };
    })());
    result.push(...await Promise.all(jobs));
  }
  return result;
}

export async function readPortfolioPage(config, provider, { account, cursor = 0, mine = false, fetcher = globalThis.fetch } = {}) {
  requireValue(Number.isSafeInteger(cursor) && cursor >= 0, '项目分页游标无效。');
  const manifest = validateManifest(config.manifest), base = new URL(config.indexBaseUrl);
  requireValue(base.origin === config.origin && !base.search && !base.hash, '索引服务来源不一致。');
  const path = mine ? `/v1/accounts/${address(account)}/portfolios` : '/v1/portfolios';
  let reply;
  try { reply = await fetchLiveJson(`${base.href.replace(/\/$/, '')}${path}?cursor=${cursor}&limit=20`, { fetcher }); }
  catch (error) {
    if (mine || !isRetryableReadError(error)) throw error;
    reply = await fetchLiveJson(`${base.href.replace(/\/$/, '')}/v1/snapshot/portfolios?cursor=${cursor}&limit=20`, { fetcher });
    requireValue(reply?.source?.readMode === 'verified_snapshot', '预算项目快照来源无效。');
  }
  const source = validateIndexSource(reply.source, manifest,
    reply.source?.readMode === 'verified_snapshot' ? { maxAgeMs: 30 * 60 * 1000 } : undefined);
  requireValue(same(source.portfolioFactory, manifest.portfolioFactory) && same(source.portfolioMarket, manifest.portfolioMarket)
    && Array.isArray(reply.data?.items) && reply.data.items.length <= 20, '预算项目索引身份或分页无效。');
  const nextCursor = reply.data.nextCursor;
  requireValue(nextCursor === null || Number.isSafeInteger(nextCursor) && nextCursor > cursor, '索引返回重复游标。');
  const context = await readPortfolioContext(config, provider, BigInt(source.indexedThrough));
  requireValue(context.block.hash.toLowerCase() === source.indexedBlockHash
    && context.timestamp === BigInt(source.indexedTimestamp), '预算项目索引区块已变化。');
  if (source.readMode === 'verified_snapshot') {
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
  for (let offset = 0; offset < reply.data.items.length; offset += 4) {
    const batch = await Promise.allSettled(reply.data.items.slice(offset, offset + 4)
      .map(entry => readPortfolio(context, entry.address, account || ZeroAddress, { includeChildren: false })));
    const failed = batch.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    items.push(...batch.map(result => result.value));
  }
  await context.canonical();
  return { items, nextCursor, source, operator: context.operator };
}

export async function readPortfolioOrders(config, provider, pool, { cursor, fetcher = globalThis.fetch } = {}) {
  const manifest = validateManifest(config.manifest), target = address(pool), base = new URL(config.indexBaseUrl);
  requireValue(base.origin === config.origin && !base.search && !base.hash, '订单索引服务来源不一致。');
  const query = new URLSearchParams({ pool: target, limit: '20' });
  if (cursor !== undefined && cursor !== null) query.set('cursor', uint(String(cursor)).toString());
  const reply = await fetchLiveJson(`${base.href.replace(/\/$/, '')}/v1/portfolio-orders?${query}`, { fetcher });
  const source = validateIndexSource(reply.source, manifest);
  requireValue(same(source.portfolioFactory, manifest.portfolioFactory) && same(source.portfolioMarket, manifest.portfolioMarket)
    && Array.isArray(reply.data?.items) && reply.data.items.length <= 20, '预算订单索引身份无效。');
  const ctx = await readPortfolioContext(config, provider, BigInt(source.indexedThrough));
  requireValue(ctx.block.hash.toLowerCase() === source.indexedBlockHash, '预算订单索引区块已变化。');
  await readPortfolio(ctx, target, ZeroAddress, { includeChildren: false });
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
  await ctx.canonical(); return { items, nextCursor: reply.data.nextCursor };
}

export async function preparePortfolioAction({ config, provider, account, pool, action }) {
  const context = await readPortfolioContext(config, provider), owner = address(account), { manifest, read } = context;
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
    requireValue(same(owner, context.operator), '仅预算项目运营钱包可创建项目。');
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
    if (method === 'autoPurchase') {
      requireValue(same(owner, context.operator) && row.state === 1n, '预算项目未募满或当前钱包不是运营钱包。');
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
    else if (method === 'proposeChildSale') args = [address(action.child), exactPrice(action.price), exactPrice(action.reference), uint(action.referenceAt, 64)];
    else if (method === 'voteChildSale' || method === 'executeChildSale') {
      requireValue(uint(action.proposalId) === row.activeProposalId && row.activeProposalId > 0n, '子矿机提案已改变。');
      args = method === 'voteChildSale' ? [row.activeProposalId, action.support] : [row.activeProposalId];
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
