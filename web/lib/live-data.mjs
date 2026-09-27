import { Interface, ZeroAddress, getAddress, keccak256, toQuantity } from 'ethers';
import { abi, uint, readPoolSnapshot, hasPosition, assetKey } from './chain-client.mjs';
import { insist, hash, liveAddress, validateManifest, fetchLiveJson, createReadOnlyHttpProvider, MANIFEST_KEYS } from './live-config.mjs';

const bindings = new Interface(['function owner() view returns(address)', 'function factory() view returns(address)',
  'function timelock() view returns(address)', 'function lens() view returns(address)', 'function shareMarket() view returns(address)',
  'function beacon() view returns(address)', 'function VERSION() view returns(uint256)']);
const STATES = ['Funding', 'Funded', 'Active', 'Listed', 'Closed', 'Refunding'];
const COLLECTIONS = { '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c': ['TapeOut', 'TAPEOUT'],
  '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c': ['Behemoth', 'BEHEMOTH'] };
const safeInt = (n, name) => { insist(Number.isSafeInteger(n) && n >= 0, 'invalid_data', `${name} 不是精确非负整数。`); return n; };
const exact = (n, name) => { insist(typeof n === 'string' && /^(0|[1-9]\d*)$/.test(n), 'invalid_data', `${name} 不是精确整数字符串。`); return uint(n); };
const sameAddress = (a, b) => liveAddress(a) === liveAddress(b);
const good = (s, bit) => (BigInt(s.validMask) & (1n << BigInt(bit))) !== 0n && (BigInt(s.errorMask) & (1n << BigInt(bit))) === 0n;
const sameSource = (a, b) => a.chainId === b.chainId && a.factory === b.factory && a.market === b.market
  && a.startBlock === b.startBlock && a.indexedThrough === b.indexedThrough && a.indexedBlockHash === b.indexedBlockHash
  && a.indexedTimestamp === b.indexedTimestamp;

export function validateIndexSource(input, manifest, { now = Date.now(), maxAgeMs = 120000 } = {}) {
  insist(input && input.chainId === 56 && sameAddress(input.factory, manifest.factory)
    && sameAddress(input.market, manifest.shareMarket), 'index_identity', '索引合约身份与部署清单不一致。');
  insist(input.complete === true && input.unknownReason === null, 'index_incomplete', '索引尚未完整核验，请稍后刷新。');
  for (const key of ['startBlock', 'confirmations', 'indexedThrough', 'indexedTimestamp', 'observedSafeHead']) safeInt(input[key], key);
  insist(input.startBlock <= manifest.deployment.blockNumber && input.indexedThrough >= manifest.verifiedBlockNumber
    && input.indexedThrough === input.observedSafeHead && input.confirmations >= 1 && hash(input.indexedBlockHash), 'index_coverage', '索引覆盖或安全区块无效。');
  const checkedAt = Date.parse(input.checkedAt);
  insist(Number.isFinite(checkedAt) && checkedAt <= now + 30000 && now - checkedAt <= maxAgeMs, 'index_stale', '索引核验已过期，请刷新。');
  return Object.freeze({ ...input, factory: getAddress(input.factory), market: getAddress(input.market), indexedBlockHash: input.indexedBlockHash.toLowerCase() });
}

/** Exact amounts stay bigint. Missing mining estimates and history are deliberately null. */
export function livePoolModel(row, snapshot) {
  const params = row.params;
  const collection = params ? getAddress(params.circuits) : null;
  const names = collection ? COLLECTIONS[collection.toLowerCase()] : null;
  return Object.freeze({ ...row, id: row.pool, poolAddress: row.pool, tokenId: params ? params.circuitId.toString() : null,
    assetKey: params ? assetKey(collection, params.circuitId) : null, collection,
    name: names?.[0] ?? null, series: names?.[1] ?? null, status: row.state === null ? null : STATES[Number(row.state)] ?? null,
    funded: row.totalSupply, members: row.memberCount, targetRaiseWei: params?.targetRaise ?? null,
    priceCapWei: params?.priceCap ?? null, daily: null, dailyBemAtomic: null, gates: null, participants: null,
    purchaseCostWei: row.purchaseCost, costWei: null, secondaryPurchaseCostWei: null, history: null,
    age: row.activatedAt && snapshot.timestamp >= row.activatedAt ? (snapshot.timestamp - row.activatedAt) / 86400n : null });
}

/** Index discovers history; all balances/orders/eligibility are independently re-read at its canonical source block. */
export function createLiveDataClient(config, { provider, fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  insist(config?.status === 'ready', 'unconfigured', '尚未配置已核验的正式合约。');
  const manifest = validateManifest(config.manifest);
  const rpc = provider ?? createReadOnlyHttpProvider(config, { fetcher });
  const request = (method, params = []) => rpc.request({ method, params });
  const indexBase = new URL(config.indexBaseUrl);
  insist(indexBase.origin === config.origin && !indexBase.search && !indexBase.hash, 'invalid_config', '索引必须来自本站配置。');
  const verified = new Map();

  async function blockHeader(blockNumber) {
    insist(BigInt(await request('eth_chainId')) === 56n, 'wrong_chain', '请切换至 BSC 主网。');
    const block = await request('eth_getBlockByNumber', [blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber)), false]);
    insist(block && hash(block.hash) && /^0x[\da-f]+$/i.test(block.number) && /^0x[\da-f]+$/i.test(block.timestamp), 'rpc_block', 'RPC 区块响应无效。');
    insist(blockNumber === undefined || BigInt(block.number) === uint(blockNumber), 'rpc_block', 'RPC 返回了错误的区块。');
    return { number: BigInt(block.number), timestamp: BigInt(block.timestamp), hash: block.hash.toLowerCase() };
  }
  async function call(to, iface, method, args, block) {
    const result = await request('eth_call', [{ to, data: iface.encodeFunctionData(method, args ?? []) }, toQuantity(block)]);
    return iface.decodeFunctionResult(method, result);
  }
  async function ensureCanonical(source) {
    const b = await blockHeader(BigInt(source.indexedThrough));
    insist(b.hash === source.indexedBlockHash && b.timestamp === BigInt(source.indexedTimestamp), 'source_reorg', '索引区块已变化，请重新读取全部页面。');
  }
  async function verifyDeployment({ blockNumber } = {}) {
    const b = await blockHeader(blockNumber);
    insist(b.number >= BigInt(manifest.verifiedBlockNumber), 'deployment_block', '所选区块早于部署核验。');
    const key = `${b.number}:${b.hash}`;
    if (!verified.has(key)) {
      const deployment = await blockHeader(BigInt(manifest.deployment.blockNumber));
      insist(deployment.hash === manifest.deployment.blockHash.toLowerCase(), 'deployment_reorg', '部署区块与清单不符。');
      for (const name of MANIFEST_KEYS) {
        const code = await request('eth_getCode', [manifest[name], toQuantity(b.number)]);
        insist(typeof code === 'string' && /^0x(?:[\da-f]{2})+$/i.test(code) && keccak256(code) === manifest.codehash[name], 'deployment_code', `${name} 运行代码与清单不一致。`);
      }
      const checks = [[manifest.factory, 'lens', manifest.lens], [manifest.factory, 'shareMarket', manifest.shareMarket],
        [manifest.factory, 'beacon', manifest.beacon], [manifest.factory, 'timelock', manifest.timelock],
        [manifest.lens, 'factory', manifest.factory], [manifest.shareMarket, 'factory', manifest.factory],
        [manifest.shareMarket, 'timelock', manifest.timelock], [manifest.beacon, 'owner', manifest.timelock]];
      for (const [to, method, expected] of checks) insist(sameAddress((await call(to, bindings, method, [], b.number))[0], expected), 'deployment_binding', '链上部署关系与清单不一致。');
      insist((await call(manifest.lens, bindings, 'VERSION', [], b.number))[0] === 1n, 'lens_version', '不支持的只读聚合版本。');
      if (verified.size >= 8) verified.delete(verified.keys().next().value);
      verified.set(key, true);
    }
    const after = await blockHeader(b.number);
    insist(after.hash === b.hash, 'source_reorg', '读取期间发生区块变化。');
    return Object.freeze({ chainId: 56n, factory: manifest.factory, lens: manifest.lens, blockNumber: b.number, blockHash: b.hash, timestamp: b.timestamp });
  }
  async function indexRead(path, query = {}, expected) {
    const url = new URL(`${indexBase.href.replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const response = await fetchLiveJson(url.href, { fetcher });
    const source = validateIndexSource(response?.source, manifest, { now: now() });
    if (expected) {
      const old = validateIndexSource(expected, manifest, { now: now() });
      insist(sameSource(source, old), 'source_changed', '索引已更新，分页必须从第一页重新读取。');
    }
    await verifyDeployment({ blockNumber: BigInt(source.indexedThrough) });
    await ensureCanonical(source);
    return { source, data: response.data };
  }
  async function sourceFor(expected) { return (await indexRead('/health', {}, expected)).source; }
  const pageLimit = value => { safeInt(value, 'limit'); insist(value >= 1 && value <= 20, 'page_limit', '每页读取 1–20 条。'); return value; };
  function page(data, limit) { insist(data && Array.isArray(data.items) && data.items.length <= limit
    && Object.hasOwn(data, 'nextCursor'), 'invalid_page', '索引分页响应无效。'); return data; }
  async function positionsAt(addresses, account, source) {
    const normalized = addresses.map(liveAddress);
    insist(new Set(normalized).size === normalized.length, 'duplicate_pool', '索引包含重复项目地址。');
    const snapshot = await readPoolSnapshot(rpc, { factory: manifest.factory, account: account ?? ZeroAddress,
      pools: normalized, blockNumber: BigInt(source.indexedThrough) });
    insist(sameAddress(snapshot.lens, manifest.lens) && snapshot.blockHash.toLowerCase() === source.indexedBlockHash
      && snapshot.timestamp === BigInt(source.indexedTimestamp), 'source_reorg', '聚合读取与索引区块不一致。');
    insist(snapshot.pools.length === normalized.length && snapshot.pools.every((r, i) => sameAddress(r.pool, normalized[i])), 'pool_response', '聚合项目列表与请求不一致。');
    return snapshot;
  }
  function numericCursor(data, cursor) {
    if (data.nextCursor !== null) {
      safeInt(data.nextCursor, 'nextCursor');
      insist(data.items.length > 0 && data.nextCursor === cursor + data.items.length, 'invalid_cursor', '索引分页游标没有正确推进。');
    }
  }
  async function readPools({ account, cursor = 0, limit = 20, source: expected } = {}) {
    safeInt(cursor, 'cursor'); pageLimit(limit);
    const { source, data } = await indexRead('/v1/pools', { cursor, limit }, expected);
    page(data, limit); numericCursor(data, cursor);
    for (const row of data.items) { liveAddress(row.address); liveAddress(row.collection); exact(row.circuitId, 'circuitId');
      safeInt(row.createdBlock, 'createdBlock'); insist(row.createdBlock <= source.indexedThrough, 'invalid_data', '项目创建区块超出索引范围。'); }
    const snapshot = await positionsAt(data.items.map(row => row.address), account, source);
    insist(snapshot.totalPools !== null && BigInt(cursor + data.items.length) <= snapshot.totalPools
      && (data.nextCursor === null ? BigInt(cursor + data.items.length) >= snapshot.totalPools : BigInt(data.nextCursor) < snapshot.totalPools), 'index_coverage', '项目分页与同块工厂总数不一致。');
    return Object.freeze({ source, items: snapshot.pools.map(row => livePoolModel(row, snapshot)), nextCursor: data.nextCursor, snapshot });
  }
  async function readPool({ pool, account, source: expected } = {}) {
    const source = await sourceFor(expected), snapshot = await positionsAt([liveAddress(pool)], account, source);
    insist(snapshot.pools[0]?.trusted, 'untrusted_pool', '该项目未通过官方工厂身份核验。');
    return Object.freeze({ source, item: livePoolModel(snapshot.pools[0], snapshot), snapshot });
  }
  async function readPositions({ account, cursor = 0, limit = 20, source: expected } = {}) {
    const owner = liveAddress(account); safeInt(cursor, 'cursor'); pageLimit(limit);
    const { source, data } = await indexRead(`/v1/accounts/${owner}/pools`, { cursor, limit }, expected);
    page(data, limit); numericCursor(data, cursor);
    const snapshot = await positionsAt(data.items, owner, source);
    const marketBnbOwed = (await call(manifest.shareMarket, abi.ShareMarket, 'bnbOwed', [owner], snapshot.blockNumber))[0];
    await ensureCanonical(source);
    return Object.freeze({ source, items: snapshot.pools.filter(hasPosition).map(row => livePoolModel(row, snapshot)),
      nextCursor: data.nextCursor, snapshot, marketBnbOwed });
  }
  async function readStats({ source: expected } = {}) {
    const { source, data } = await indexRead('/v1/stats', {}, expected);
    insist(data?.scope === 'confirmed_indexed_history', 'invalid_data', '平台统计口径无效。');
    const values = { scope: data.scope, estimatedDailyBemAtomic: null, currentlyActivePoolCount: null };
    for (const field of ['registeredPoolCount', 'everParticipantAddressCount', 'purchasedCostWei', 'shareMarketFilledGrossWei', 'harvestedToMembersBemAtomic']) values[field] = exact(data[field], field);
    const count = (await call(manifest.factory, abi.PoolFactory, 'poolCount', [], BigInt(source.indexedThrough)))[0];
    insist(count === values.registeredPoolCount, 'index_coverage', '项目统计与同块工厂登记数不一致。');
    await ensureCanonical(source);
    return Object.freeze({ source, data: Object.freeze(values) });
  }
  async function readOrders({ pool, seller, active, cursor, limit = 20, source: expected } = {}) {
    pageLimit(limit); if (pool) pool = liveAddress(pool); if (seller) seller = liveAddress(seller);
    insist(active === undefined || typeof active === 'boolean', 'invalid_query', '订单状态筛选无效。');
    if (cursor !== undefined) insist(/^[1-9]\d*$/.test(String(cursor)), 'invalid_cursor', '订单游标无效。');
    const { source, data } = await indexRead('/v1/orders', { pool, seller, active, cursor, limit }, expected); page(data, limit);
    const seen = new Set(); let last = cursor === undefined ? null : uint(String(cursor));
    const candidates = data.items.map(row => {
      const orderId = exact(row.orderId, 'orderId'); insist(orderId > 0n && !seen.has(row.orderId) && (last === null || orderId < last), 'invalid_order', '订单编号或排序无效。');
      seen.add(row.orderId); last = orderId;
      return { ...row, orderId, pool: liveAddress(row.pool), seller: liveAddress(row.seller), remaining: exact(row.remaining, 'remaining'),
        pricePerUnitWei: exact(row.pricePerUnitWei, 'pricePerUnitWei'), expiresAt: row.expiresAt === null ? 0n : exact(row.expiresAt, 'expiresAt') };
    });
    insist(data.nextCursor === null || (candidates.length > 0 && String(data.nextCursor) === candidates.at(-1).orderId.toString()), 'invalid_cursor', '订单游标无效。');
    const addresses = [...new Set(candidates.map(row => row.pool))], snapshot = await positionsAt(addresses, undefined, source);
    const rows = new Map(snapshot.pools.map(row => [getAddress(row.pool), row]));
    const items = [];
    for (const item of candidates) {
      const raw = (await call(manifest.shareMarket, abi.ShareMarket, 'orders', [item.orderId], snapshot.blockNumber))[0];
      const expiresAt = (await call(manifest.shareMarket, abi.ShareMarket, 'orderExpiresAt', [item.orderId], snapshot.blockNumber))[0];
      insist(rows.get(item.pool)?.trusted && sameAddress(raw.pool, item.pool) && sameAddress(raw.seller, item.seller)
        && raw.remaining === item.remaining && raw.pricePerUnit === item.pricePerUnitWei && expiresAt === item.expiresAt, 'order_mismatch', '订单索引与同块合约数据不一致。');
      insist((!pool || item.pool === pool) && (!seller || item.seller === seller), 'order_mismatch', '订单不符合请求筛选。');
      const open = raw.active && raw.remaining > 0n && expiresAt > snapshot.timestamp;
      insist(active === undefined || open === active, 'order_mismatch', '订单状态不符合索引筛选。');
      items.push(Object.freeze({ ...item, id: item.orderId.toString(), shares: raw.remaining, active: raw.active, expiresAt,
        openAtSourceBlock: open, shareTradingAllowed: rows.get(item.pool).shareTradingAllowed,
        executable: false, requiresLatestSimulation: true }));
    }
    await ensureCanonical(source);
    return Object.freeze({ source, items, nextCursor: data.nextCursor, snapshot });
  }
  async function readGovernance({ pool, account = ZeroAddress, source: expected } = {}) {
    pool = liveAddress(pool); account = getAddress(account); const source = await sourceFor(expected);
    const g = (await call(manifest.lens, abi.PoolLens, 'governance', [pool, account], BigInt(source.indexedThrough)))[0];
    insist(g.status.trustError === 0n && good(g.status, 0), 'untrusted_pool', '该治理项目未通过官方身份核验。');
    const result = { pool, account, status: { validMask: g.status.validMask, errorMask: g.status.errorMask, trustError: g.status.trustError } };
    const bits = { state: 1, activeProposalId: 2, proposal: 3, purchaseCost: 4, hasVoted: 5, snapshotShares: 6,
      listedProposalId: 7, expiresAt: 8, salePrice: 9, requiredYesCount: 10, requiredYesShares: 10, discounted: 10, passed: 10,
      canVote: 11, canCancelExpired: 12, canExecute: 13 };
    for (const [key, bit] of Object.entries(bits)) result[key] = good(g.status, bit) ? g[key] : null;
    await ensureCanonical(source); return Object.freeze({ source, data: Object.freeze(result) });
  }
  async function readActivity({ pool, account, cursor, limit = 20, source: expected } = {}) {
    pageLimit(limit); if (pool) pool = liveAddress(pool); if (account) account = liveAddress(account);
    if (cursor !== undefined) insist(/^\d+:\d+:\d+$/.test(cursor) && cursor.split(':').every(n => Number.isSafeInteger(Number(n))), 'invalid_cursor', '流水游标无效。');
    const { source, data } = await indexRead('/v1/activity', { pool, account, cursor, limit }, expected); page(data, limit);
    let previous = cursor?.split(':').map(Number); const seen = new Set();
    const items = data.items.map(row => {
      const tuple = [safeInt(row.blockNumber, 'blockNumber'), safeInt(row.transactionIndex, 'transactionIndex'), safeInt(row.logIndex, 'logIndex')];
      const key = tuple.join(':');
      insist(!seen.has(key) && (!previous || tuple[0] < previous[0] || (tuple[0] === previous[0] && (tuple[1] < previous[1] || (tuple[1] === previous[1] && tuple[2] < previous[2])))), 'invalid_activity', '流水排序或分页重复。');
      previous = tuple; seen.add(key);
      insist(hash(row.blockHash) && hash(row.transactionHash) && row.blockNumber <= source.indexedThrough
        && typeof row.event === 'string' && row.fields && typeof row.fields === 'object' && !Array.isArray(row.fields), 'invalid_activity', '流水身份或事件字段无效。');
      liveAddress(row.contract); if (row.pool !== null) liveAddress(row.pool);
      safeInt(row.timestamp, 'timestamp'); insist(row.timestamp <= source.indexedTimestamp, 'invalid_activity', '流水时间超出索引范围。');
      insist(!pool || (row.pool && sameAddress(row.pool, pool)), 'invalid_activity', '流水不属于请求的矿池。');
      return Object.freeze({ ...row });
    });
    insist(data.nextCursor === null || (items.length > 0 && data.nextCursor === previous.join(':')), 'invalid_cursor', '流水下一页游标无效。');
    return Object.freeze({ source, items, nextCursor: data.nextCursor });
  }
  async function readYield({ pool, account, days = 30, source: expected } = {}) {
    pool = liveAddress(pool); if (account) account = liveAddress(account); safeInt(days, 'days'); insist(days >= 1 && days <= 90, 'invalid_query', '收益窗口为1–90天。');
    const { source, data } = await indexRead('/v1/yield', { pool, account, days }, expected);
    insist(data?.scope === 'pool' && sameAddress(data.pool, pool) && (account ? sameAddress(data.account, account) : data.account === null)
      && data.token === 'BEM' && data.tokenDecimals === 8 && data.timezone === 'Asia/Shanghai' && Array.isArray(data.buckets)
      && data.buckets.length === days && data.accountUnclaimedDailyAccrual === null, 'invalid_yield', '收益数据口径无效。');
    const lastDay = new Date((source.indexedTimestamp + 8 * 3600) * 1000).toISOString().slice(0, 10);
    const lastMidnight = Date.parse(`${lastDay}T00:00:00Z`);
    const buckets = data.buckets.map((row, i) => {
      const expectedDate = new Date(lastMidnight - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
      insist(row.date === expectedDate, 'invalid_yield', '收益日期与索引区块窗口不一致。');
      insist(account || row.accountClaimedAtomic === null, 'invalid_yield', '未指定钱包的收益不能包含个人领取额。');
      return { date: row.date, poolHarvestNetAtomic: exact(row.poolHarvestNetAtomic, 'poolHarvestNetAtomic'),
        accountClaimedAtomic: account ? exact(row.accountClaimedAtomic, 'accountClaimedAtomic') : null }; });
    return Object.freeze({ source, data: Object.freeze({ ...data, buckets, accountUnclaimedDailyAccrual: null }) });
  }
  return Object.freeze({ manifest, provider: rpc, verifyDeployment, readPools, readPool, readPositions, readStats, readOrders, readGovernance, readActivity, readYield });
}
