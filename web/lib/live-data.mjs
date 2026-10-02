import { Interface, ZeroAddress, getAddress, keccak256, toQuantity } from 'ethers';
import { abi, uint, readPoolSnapshot, decodePoolRow, hasPosition, assetKey } from './chain-client.mjs';
import { insist, hash, liveAddress, validateManifest, fetchLiveJson, createReadOnlyHttpProvider, MANIFEST_KEYS, GENESIS_ARTIFACT_DIGEST } from './live-config.mjs';
import { isRetryableReadError, settleReadRound } from './read-retry.mjs';
import { readSaleReference, readSaleReview, saleExecutionGate, saleReferenceState,
  DEFAULT_SALE_REVIEW_THRESHOLD_BPS, readSaleReviewThreshold, requiresSaleReview } from './sale-governance-gate.mjs';
import { readMiningOverviewStats } from './mining-overview.mjs';
import { readDisplayCache, DISPLAY_CACHE_TIMEOUT_MS } from './display-cache-transport.mjs';

const bindings = new Interface(['function owner() view returns(address)', 'function factory() view returns(address)',
  'function timelock() view returns(address)', 'function lens() view returns(address)', 'function shareMarket() view returns(address)',
  'function beacon() view returns(address)', 'function VERSION() view returns(uint256)']);
const governanceViews = new Interface([
  'function saleReference(address pool) view returns(uint128 marketPriceWei,uint64 observedAt,bytes32 sourceDigest)',
  'function saleReview(address pool,uint256 proposalId) view returns(uint8 status,uint128 priceWei)',
]);
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
// A page assembled across an index sync must not become actionable merely
// because its later read used the live endpoint for the same canonical block.
const conservativeSource = (source, earlier) => earlier?.readMode === 'verified_snapshot'
  || source.readMode === 'verified_snapshot'
  ? withSourceClock(Object.freeze({ ...(earlier?.readMode === 'verified_snapshot' ? earlier : source),
    readMode: 'verified_snapshot', stale: true, transactionReady: false,
    refreshing: earlier?.refreshing === true || source.refreshing === true }),
    sourceClocks.get(earlier?.readMode === 'verified_snapshot' ? earlier : source))
  : source;
const sourceClocks = new WeakMap();
const withSourceClock = (source, proof) => {
  if (proof) sourceClocks.set(source, proof);
  return source;
};
/** Display provenance cannot authorize a transaction, even for a current index. */
export const displayIndexSource = source => withSourceClock(Object.freeze({ ...source, displayOnly: true,
  transactionReady: false }), sourceClocks.get(source));
/** HTTP Date is from the same-origin index response. Its rounded seconds and
 * Age header provide an elapsed server clock when the user's clock is wrong. */
export async function fetchLiveJsonWithClock(url, { fetcher = globalThis.fetch, now = Date.now, ...options } = {}) {
  let serverNow = null, localReceivedAt = null;
  const body = await fetchLiveJson(url, { ...options, fetcher: async (...args) => {
    const response = await fetcher(...args);
    localReceivedAt = now();
    const rawDate = response?.headers?.get?.('date');
    const parsed = typeof rawDate === 'string' ? Date.parse(rawDate) : NaN;
    const age = response?.headers?.get?.('age') ?? null;
    if (Number.isFinite(parsed) && parsed >= 0
      && (age === null || /^(0|[1-9]\d{0,3})$/.test(age))) {
      const candidate = parsed + (age === null ? 0 : Number(age) * 1000);
      if (Number.isSafeInteger(candidate)) serverNow = candidate;
    }
    return response;
  } });
  return { body, serverNow, localReceivedAt };
}
function proofNow(proof, localNow) {
  if (!proof) return localNow;
  const elapsed = localNow - proof.localReceivedAt;
  insist(Number.isFinite(elapsed) && elapsed >= 0, 'index_stale', '本机时钟在读取期间变化，请重新读取。');
  return proof.serverNow + elapsed;
}
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const sessionStorageSafe = () => { try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; } };

async function verifyInParallel(checks) {
  let next = 0, failed = false, failure;
  const workers = Array.from({ length: Math.min(4, checks.length) }, async () => {
    while (!failed && next < checks.length) {
      const check = checks[next++];
      try { await check(); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  });
  // A rejected read must not leave RPC work running into the next page attempt.
  await Promise.all(workers);
  if (failed) throw failure;
}

/** Preserve index order and drain all started RPC reads before failing a page. */
async function mapReadBounded(items, concurrency, read) {
  const values = new Array(items.length), failures = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failures.length && next < items.length) {
      const index = next++;
      try { values[index] = await read(items[index], index); }
      catch (error) { failures.push(error); }
    }
  }));
  const failure = failures.find(error => !isRetryableReadError(error)) ?? failures[0];
  if (failure) throw failure;
  return values;
}

export function validateIndexSource(input, manifest, { now = Date.now(), maxAgeMs, timeProof } = {}) {
  insist(input && input.chainId === 56 && sameAddress(input.factory, manifest.factory)
    && sameAddress(input.market, manifest.shareMarket), 'index_identity', '索引合约身份与部署清单不一致。');
  const displaySnapshot = input.readMode === 'verified_snapshot';
  insist(displaySnapshot ? input.stale === true && input.transactionReady === false && typeof input.refreshing === 'boolean'
    : input.stale !== true && (input.transactionReady !== false || input.displayOnly === true),
  'index_stale', '历史展示快照缺少明确的过期或交易限制标记。');
  insist(input.complete === true && input.unknownReason === null, 'index_incomplete', '索引尚未完整核验，请稍后刷新。');
  for (const key of ['startBlock', 'confirmations', 'indexedThrough', 'indexedTimestamp', 'observedSafeHead']) safeInt(input[key], key);
  insist(input.startBlock <= manifest.deployment.blockNumber && input.indexedThrough >= manifest.verifiedBlockNumber
    && input.indexedThrough === input.observedSafeHead && input.confirmations >= 1 && hash(input.indexedBlockHash), 'index_coverage', '索引覆盖或安全区块无效。');
  const checkedAt = Date.parse(input.checkedAt);
  const allowedAge = Math.min(maxAgeMs ?? (displaySnapshot ? 30 * 60 * 1000 : 120000), displaySnapshot ? 30 * 60 * 1000 : 120000);
  const proof = timeProof ?? sourceClocks.get(input);
  const current = proofNow(proof, now);
  if (proof) insist(current + 30_000 >= input.indexedTimestamp * 1000
    && current - input.indexedTimestamp * 1000 <= allowedAge + 90_000,
  'index_stale', '索引来源区块已落后于服务器时间。');
  insist(Number.isFinite(checkedAt) && checkedAt <= current + 30000 && current - checkedAt <= allowedAge, 'index_stale', '索引核验已过期，请刷新。');
  return withSourceClock(Object.freeze({ ...input, factory: getAddress(input.factory), market: getAddress(input.market), indexedBlockHash: input.indexedBlockHash.toLowerCase() }), proof);
}

/** Historical display snapshots are not an archive-node promise. Keep old-state
 * eth_call off ordinary RPC nodes; the separate public preview remains usable. */
export async function requireRecentSnapshotState(provider, source) {
  if (source?.readMode !== 'verified_snapshot') return;
  const [chainId, head] = await Promise.all([
    provider.request({ method: 'eth_chainId', params: [] }),
    provider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }),
  ]);
  insist(BigInt(chainId) === 56n, 'wrong_chain', '请切换至 BSC 主网。');
  insist(head && /^0x[\da-f]+$/i.test(head.number) && /^0x[\da-f]+$/i.test(head.timestamp)
    && hash(head.hash), 'rpc_block', 'RPC 最新区块响应无效。');
  const blockLag = BigInt(head.number) - BigInt(source.indexedThrough);
  const timeLag = BigInt(head.timestamp) - BigInt(source.indexedTimestamp);
  insist(blockLag >= 0n && timeLag >= 0n, 'source_changed', 'RPC 尚未追上已核验快照区块。');
  insist(blockLag <= 128n && timeLag <= 90n, 'index_stale',
    '历史区块超过普通 RPC 的安全状态读取窗口；仅显示服务器快照，请稍后刷新。');
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

/** Index discovers history; fresh display reads obtain only needed business fields. */
export function createLiveDataClient(config, { provider, fetcher = globalThis.fetch, now = () => Date.now(),
  verificationStorage = sessionStorageSafe() } = {}) {
  insist(config?.status === 'ready', 'unconfigured', '尚未配置已核验的正式合约。');
  const manifest = validateManifest(config.manifest, config.stage === 'genesis' ? GENESIS_ARTIFACT_DIGEST : undefined);
  const rpc = provider ?? createReadOnlyHttpProvider(config, { fetcher });
  // Browsing reads use the same-origin index's source and business fields.
  // Transaction preparation has its own latest-chain checks in live-actions.
  const displayReads = config.productFamily === 'fresh-v4';
  const markDisplaySource = source => displayReads ? displayIndexSource(source) : source;
  const request = (method, params = []) => rpc.request({ method, params });
  const indexBase = new URL(config.indexBaseUrl);
  insist(indexBase.origin === config.origin && !indexBase.search && !indexBase.hash, 'invalid_config', '索引必须来自本站配置。');
  const verified = new Map(), verifying = new Map();
  const proofKey = `bemine:deployment-verified:v2:${manifest.artifactDigest}:${manifest.factory.toLowerCase()}:${config.stage}:${manifest.verifiedBlockNumber}`;
  const readSessionProof = () => {
    try {
      const proof = JSON.parse(verificationStorage?.getItem(proofKey) ?? 'null');
      return proof && typeof proof.block === 'string' && /^(0|[1-9]\d*)$/.test(proof.block)
        && hash(proof.hash) && Number.isSafeInteger(proof.at) ? proof : null;
    } catch { return null; }
  };
  let sessionProof = readSessionProof();
  const sessionProofCurrent = header => sessionProof && sessionProof.at <= now()
    && now() - sessionProof.at < VERIFICATION_TTL_MS
    && BigInt(sessionProof.block) >= BigInt(manifest.verifiedBlockNumber)
    && BigInt(sessionProof.block) <= header.number
    && (BigInt(sessionProof.block) !== header.number || sessionProof.hash.toLowerCase() === header.hash);
  const saveSessionProof = header => {
    sessionProof = { block: header.number.toString(), hash: header.hash, at: now() };
    try { verificationStorage?.setItem(proofKey, JSON.stringify(sessionProof)); } catch { /* Browsing still works without storage. */ }
  };
  // PoolFactory only writes this slot during pool creation. A later source may
  // reuse the result after rechecking the original proof block's canonical hash.
  const subscriberCache = new Map();
  // The original integrated deployment predates designatedSubscriber even
  // though its manifest already includes a portfolio factory.
  const hasReservationReader = manifest.kind === 'integrated-v2'
    && (config.stage === 'fresh-active' || config.stage !== 'genesis'
      && manifest.artifactDigest !== GENESIS_ARTIFACT_DIGEST);

  async function blockHeader(blockNumber) {
    const tag = blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber));
    const { chainId, block } = await settleReadRound({
      chainId: () => request('eth_chainId'),
      block: () => request('eth_getBlockByNumber', [tag, false]),
    });
    insist(BigInt(chainId) === 56n, 'wrong_chain', '请切换至 BSC 主网。');
    insist(block && hash(block.hash) && /^0x[\da-f]+$/i.test(block.number) && /^0x[\da-f]+$/i.test(block.timestamp), 'rpc_block', 'RPC 区块响应无效。');
    insist(blockNumber === undefined || BigInt(block.number) === uint(blockNumber), 'rpc_block', 'RPC 返回了错误的区块。');
    return { number: BigInt(block.number), timestamp: BigInt(block.timestamp), hash: block.hash.toLowerCase() };
  }
  async function call(to, iface, method, args, block) {
    const result = await request('eth_call', [{ to, data: iface.encodeFunctionData(method, args ?? []) }, block === 'latest' ? block : toQuantity(block)]);
    return iface.decodeFunctionResult(method, result);
  }
  async function ensureCanonical(source) {
    if (displayReads) return; // A display result is never a transaction proof.
    const b = await blockHeader(BigInt(source.indexedThrough));
    insist(b.hash === source.indexedBlockHash && b.timestamp === BigInt(source.indexedTimestamp), 'source_reorg', '索引区块已变化，请重新读取全部页面。');
  }
  async function verifyDeploymentAtHeader(b, { displayRead = false } = {}) {
    insist(b.number >= BigInt(manifest.verifiedBlockNumber), 'deployment_block', '所选区块早于部署核验。');
    if (displayRead && sessionProofCurrent(b)) {
      const proofBlock = BigInt(sessionProof.block);
      const proofHeader = proofBlock === b.number ? b : await blockHeader(proofBlock);
      if (proofHeader.hash === sessionProof.hash.toLowerCase()) {
        const after = await blockHeader(b.number);
        insist(after.hash === b.hash, 'source_reorg', '读取期间发生区块变化。');
        return Object.freeze({ chainId: 56n, factory: manifest.factory, lens: manifest.lens,
          blockNumber: b.number, blockHash: b.hash, timestamp: b.timestamp });
      }
      // A newer source can be canonical while the earlier verification block was reorganized.
      sessionProof = null;
      try { verificationStorage?.removeItem(proofKey); } catch { /* Verification below remains authoritative. */ }
    }
    const key = `${b.number}:${b.hash}`;
    let pending = verifying.get(key);
    if (!pending) {
      pending = (async () => {
        if (!verified.has(key)) {
          const deployment = await blockHeader(BigInt(manifest.deployment.blockNumber));
          insist(deployment.hash === manifest.deployment.blockHash.toLowerCase(), 'deployment_reorg', '部署区块与清单不符。');
          const checks = MANIFEST_KEYS.map(name => async () => {
            const code = await request('eth_getCode', [manifest[name], toQuantity(b.number)]);
            insist(typeof code === 'string' && /^0x(?:[\da-f]{2})+$/i.test(code) && keccak256(code) === manifest.codehash[name], 'deployment_code', `${name} 运行代码与清单不一致。`);
          });
          const relationships = [[manifest.factory, 'lens', manifest.lens], [manifest.factory, 'shareMarket', manifest.shareMarket],
            [manifest.factory, 'beacon', manifest.beacon], [manifest.factory, 'timelock', manifest.timelock],
            [manifest.lens, 'factory', manifest.factory], [manifest.shareMarket, 'factory', manifest.factory],
            [manifest.shareMarket, 'timelock', manifest.timelock], [manifest.beacon, 'owner', manifest.timelock]];
          for (const [to, method, expected] of relationships) checks.push(async () => {
            insist(sameAddress((await call(to, bindings, method, [], b.number))[0], expected), 'deployment_binding', '链上部署关系与清单不一致。');
          });
          checks.push(async () => insist((await call(manifest.lens, bindings, 'VERSION', [], b.number))[0] === 1n, 'lens_version', '不支持的只读聚合版本。'));
          await verifyInParallel(checks);
        }
        const after = await blockHeader(b.number);
        insist(after.hash === b.hash, 'source_reorg', '读取期间发生区块变化。');
        // Cache only a fully drained verification whose final canonical check passed.
        if (!verified.has(key)) {
          if (verified.size >= 8) verified.delete(verified.keys().next().value);
          verified.set(key, true);
        }
      })();
      verifying.set(key, pending);
    }
    try { await pending; }
    catch (error) { verified.delete(key); throw error; }
    finally { if (verifying.get(key) === pending) verifying.delete(key); }
    if (displayRead) saveSessionProof(b);
    return Object.freeze({ chainId: 56n, factory: manifest.factory, lens: manifest.lens, blockNumber: b.number, blockHash: b.hash, timestamp: b.timestamp });
  }
  async function verifyDeployment({ blockNumber } = {}) {
    return verifyDeploymentAtHeader(await blockHeader(blockNumber));
  }
  async function indexRead(path, query = {}, expected) {
    const url = new URL(`${indexBase.href.replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const { body: response, serverNow, localReceivedAt } = await fetchLiveJsonWithClock(url.href, { fetcher, now });
    const displaySource = path === '/health' && response?.source?.complete !== true
      ? response?.displaySource : null;
    let source = validateIndexSource(displaySource ?? response?.source, manifest, { now: now(),
      ...(serverNow === null ? {} : { timeProof: { serverNow, localReceivedAt } }) });
    if (expected) {
      const old = validateIndexSource(expected, manifest, { now: now() });
      insist(sameSource(source, old), 'source_changed', '索引已更新，分页必须从第一页重新读取。');
      source = conservativeSource(source, old);
    }
    if (displayReads) return { source: markDisplaySource(source), data: response.data };
    await requireRecentSnapshotState(rpc, source);
    const header = await blockHeader(BigInt(source.indexedThrough));
    insist(header.hash === source.indexedBlockHash && header.timestamp === BigInt(source.indexedTimestamp),
      'source_reorg', '索引区块已变化，请重新读取全部页面。');
    await verifyDeploymentAtHeader(header, { displayRead: true });
    return { source, data: response.data };
  }
  async function savedSnapshotRead(path, query = {}) {
    const url = new URL(`${indexBase.href.replace(/\/$/, '')}/v1/snapshot${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const { body: response, serverNow, localReceivedAt } = await fetchLiveJsonWithClock(url.href, { fetcher, now });
    insist(response?.source?.readMode === 'verified_snapshot', 'index_identity', '服务端快照来源无效。');
    const source = validateIndexSource(response.source, manifest, { now: now(), maxAgeMs: 30 * 60 * 1000,
      ...(serverNow === null ? {} : { timeProof: { serverNow, localReceivedAt } }) });
    if (displayReads) return { source: markDisplaySource(source), data: response.data };
    await requireRecentSnapshotState(rpc, source);
    const header = await blockHeader(BigInt(source.indexedThrough));
    insist(header.hash === source.indexedBlockHash && header.timestamp === BigInt(source.indexedTimestamp),
      'source_reorg', '索引区块已变化，请重新读取全部页面。');
    await verifyDeploymentAtHeader(header, { displayRead: true });
    return { source, data: response.data };
  }
  async function serverDisplayRead(path, query = {}) {
    const url=new URL(`${indexBase.href.replace(/\/$/,'')}/v1/display${path}`);
    for(const [name,value] of Object.entries(query)) if(name!=='source' && value!==undefined && value!==null) url.searchParams.set(name,String(value));
    const read=()=>fetchLiveJsonWithClock(url.href,{fetcher,now,
      timeoutMs:DISPLAY_CACHE_TIMEOUT_MS});
    const {body,serverNow,localReceivedAt}=await (readDisplayCache(read));
    insist(body?.source?.cacheOrigin==='server' && body.source.readMode==='verified_snapshot',
      'index_identity','服务器展示快照身份无效。');
    const source=validateIndexSource(body.source,manifest,{now:now(),
      ...(serverNow===null?{}:{timeProof:{serverNow,localReceivedAt}})});
    if(query.source) insist(sameSource(source,query.source),'source_changed','服务器快照已更新，请从第一页重新读取。');
    const data=JSON.parse(JSON.stringify(body.data),(_name,value)=>value && typeof value==='object'
      && Object.keys(value).length===1 && typeof value.$bemineBigInt==='string'
      && /^(0|[1-9]\d*)$/.test(value.$bemineBigInt)?BigInt(value.$bemineBigInt):value);
    return {source,data};
  }
  async function cachedDisplay(read, fallback) {
    if(config.productFamily!=='fresh-v4') return fallback();
    try {return await read();} catch(error) {
      // A display cache outage must not fan out into per-row chain queries.
      // The page retains its previous snapshot while this cache recovers.
      if(config.testProfile===true || config.displayOnly===true) throw error;
      if(!isRetryableReadError(error) && !(error?.code==='http_unavailable' && [404,503].includes(error.details?.status))) throw error;
      return fallback();
    }
  }
  function displayRows(data,source) {
    const snapshot={timestamp:BigInt(source.indexedTimestamp)};
    return data.map(row=>{
      insist(row?.trusted===true && typeof row.pool==='string' && typeof row.unitPriceWei==='bigint'
        && (row.params===null || typeof row.params?.targetRaise==='bigint'), 'invalid_data','服务器项目快照不完整。');
      liveAddress(row.pool);
      return livePoolModel(row,snapshot);
    });
  }
  const readDisplayPool=options=>cachedDisplay(async()=>{
    const {source,data}=await serverDisplayRead(`/pools/${liveAddress(options.pool)}`,{account:options.account});
    const [item]=displayRows([data.item],source);
    insist(sameAddress(item.pool,options.pool),'pool_response','服务器项目与请求不一致。');
    return {source,item,snapshot:null};
  },()=>readPool(options));
  const readDisplayPools=(options={})=>cachedDisplay(async()=>{
    const {source,data}=await serverDisplayRead('/pools',options);page(data,options.limit ?? 20);
    return {source,items:displayRows(data.items,source),nextCursor:data.nextCursor,snapshot:null};
  },()=>readPools(options));
  const readDisplayPositions=options=>cachedDisplay(async()=>{
    const {account,...query}=options;
    const {source,data}=await serverDisplayRead(`/positions/${liveAddress(account)}`,query);page(data,options.limit ?? 20);
    insist(typeof data.marketBnbOwed==='bigint','invalid_data','服务器余额数据无效。');
    return {source,items:displayRows(data.items,source),nextCursor:data.nextCursor,marketBnbOwed:data.marketBnbOwed,snapshot:null};
  },()=>readPositions(options));
  const readDisplayOrders=(options={})=>cachedDisplay(async()=>{
    const {source,data}=await serverDisplayRead('/orders',options);page(data,options.limit ?? 20);
    for(const row of data.items) insist(typeof row.orderId==='bigint' && typeof row.pricePerUnitWei==='bigint'
      && typeof row.remaining==='bigint' && row.executable===false,'invalid_data','服务器订单数据无效。');
    return {source,items:data.items,nextCursor:data.nextCursor,snapshot:null};
  },()=>readOrders(options));
  const readDisplayStats=(options={})=>cachedDisplay(async()=>{
    const {source,data}=await serverDisplayRead('/stats');
    insist(data?.scope==='confirmed_indexed_history','invalid_data','服务器统计口径无效。');
    const values={...data,...readMiningOverviewStats(data)};
    for(const field of ['registeredPoolCount','everParticipantAddressCount','purchasedCostWei','shareMarketFilledGrossWei',
      'harvestedToMembersBemAtomic','topLevelProjectCount','standalonePoolCount','portfolioCount','childPoolCount','reservedChildPoolCount'])
      if(values[field]!==undefined) values[field]=exact(values[field],field);
    return {source,data:values};
  },()=>readStats(options));
  async function sourceFor(expected) { return (await indexRead('/health', {}, expected)).source; }
  const pageLimit = value => { safeInt(value, 'limit'); insist(value >= 1 && value <= 20, 'page_limit', '每页读取 1–20 条。'); return value; };
  async function childReservations(rows, source) {
    if (!hasReservationReader)
      return { subscribers: rows.map(() => ZeroAddress), commit: () => {} };
    const blockNumber = BigInt(source.indexedThrough);
    const subscribers = new Array(rows.length);
    const keys = rows.map(row => `${manifest.factory.toLowerCase()}:${row.pool.toLowerCase()}`);
    const proofBlocks = new Map();
    keys.forEach(key => {
      const saved = subscriberCache.get(key);
      if (saved && saved.block !== blockNumber && saved.block < blockNumber)
        proofBlocks.set(`${saved.block}:${saved.hash}`, saved.block);
    });
    const canonicalProofs = new Map();
    await verifyInParallel([...proofBlocks].map(([proof, number]) => async () => {
      canonicalProofs.set(proof, (await blockHeader(number)).hash === proof.split(':')[1]);
    }));
    const fresh = [];
    await verifyInParallel(rows.map((row, index) => async () => {
      const saved = subscriberCache.get(keys[index]);
      if (saved && (saved.block === blockNumber && saved.hash === source.indexedBlockHash
        || saved.block < blockNumber && canonicalProofs.get(`${saved.block}:${saved.hash}`) === true)) {
        subscribers[index] = saved.subscriber;
      } else {
        if (saved) subscriberCache.delete(keys[index]);
        subscribers[index] = getAddress((await call(manifest.factory, abi.PoolFactory,
          'designatedSubscriber', [row.pool], blockNumber))[0]);
        fresh.push({ key: keys[index], subscriber: subscribers[index] });
      }
    }));
    return { subscribers, commit: () => {
      for (const entry of fresh) {
        if (subscriberCache.size >= 1000) subscriberCache.delete(subscriberCache.keys().next().value);
        subscriberCache.set(entry.key, { subscriber: entry.subscriber, block: blockNumber,
          hash: source.indexedBlockHash });
      }
    } };
  }
  // The indexer checks every budget vault's childCount against ChildPurchased
  // history before marking a source complete. Repeating that global scan on
  // each browser page would exceed RPC quotas as the portfolio fleet grows.
  // Here we check the indexed partition and each visible row at one block.
  function indexedReservedCount(data) {
    insist(!hasReservationReader || (data.reservedChildPoolCount !== undefined
      && data.reservedChildPoolAddresses !== undefined && data.childPoolCount !== undefined
      && data.standalonePoolCount !== undefined && data.reservedChildPoolAddressesComplete === true),
    'index_coverage', '预算子池索引分类缺失或不完整。');
    const count = data.reservedChildPoolCount === undefined ? 0n : exact(data.reservedChildPoolCount, 'reservedChildPoolCount');
    const addresses = data.reservedChildPoolAddresses ?? [];
    insist(count <= 500n && Array.isArray(addresses) && addresses.length === Number(count),
      'index_coverage', '预算预留子池列表不完整。');
    const pools = addresses.map(liveAddress);
    insist(new Set(pools).size === pools.length, 'index_coverage', '预算预留子池地址重复。');
    insist(hasReservationReader || count === 0n, 'index_coverage', '旧版合约不支持预算预留子池分类。');
    return { count, pools };
  }
  // The event index can temporarily be unavailable while the Factory and Lens
  // remain readable. Use only a confirmed, manifest-verified chain snapshot;
  // never turn an index identity/integrity error into an apparently empty page.
  async function directSource() {
    const tip = await blockHeader();
    const confirmations = 12n;
    insist(tip.number >= BigInt(manifest.verifiedBlockNumber) + confirmations, 'deployment_block', '合约部署尚未获得足够确认。');
    const verified = await verifyDeployment({ blockNumber: tip.number - confirmations });
    const b = await blockHeader(verified.blockNumber);
    insist(b.hash === verified.blockHash, 'source_reorg', '链上区块已变化，请刷新。');
    return Object.freeze({ chainId: 56, factory: manifest.factory, market: manifest.shareMarket,
      startBlock: manifest.deployment.blockNumber, confirmations: Number(confirmations),
      indexedThrough: Number(b.number), indexedBlockHash: b.hash, indexedTimestamp: Number(b.timestamp),
      observedSafeHead: Number(b.number), complete: true, unknownReason: null,
      checkedAt: new Date(now()).toISOString(), readMode: 'direct_chain' });
  }
  async function directPage({ account = ZeroAddress, cursor = 0, limit = 20, holdings = false, pinnedSource } = {}) {
    if (displayReads) return directDisplayPage({ account, cursor, limit, holdings });
    const source = pinnedSource
      ? validateIndexSource(pinnedSource, manifest, { now: now() }) : await directSource();
    if (pinnedSource) {
      insist(source.readMode === 'direct_chain' && source.confirmations >= 12,
        'source_changed', '直读分页来源无效，请从第一页重新读取。');
      await verifyDeployment({ blockNumber: BigInt(source.indexedThrough) });
      await ensureCanonical(source);
    }
    const owner = getAddress(account);
    const block = BigInt(source.indexedThrough);
    const first = await readPoolSnapshot(rpc, { factory: manifest.factory, lens: manifest.lens, account: owner,
      offset: BigInt(cursor), limit: 20n, blockNumber: block });
    insist(sameAddress(first.lens, manifest.lens) && first.blockHash.toLowerCase() === source.indexedBlockHash
      && first.timestamp === BigInt(source.indexedTimestamp) && first.totalPools !== null,
    'source_reorg', '链上项目读取与已核验区块不一致。');
    const total = first.totalPools;
    insist(total <= 500n, 'direct_scan_limit', '项目数量超出直读上限，请等待索引恢复。');
    insist(BigInt(cursor) <= total, 'pool_response', '链上项目分页无效。');
    const rows = [], reservationProofs = [];
    let offset = BigInt(cursor), part = first;
    // Factory registration includes budget children. Continue scanning past
    // reserved children so an empty page cannot hide later public projects.
    while (offset < total && (holdings || rows.length < limit)) {
      insist(sameAddress(part.lens, manifest.lens) && part.blockHash.toLowerCase() === source.indexedBlockHash
        && part.timestamp === BigInt(source.indexedTimestamp) && part.totalPools === total
        && part.pools.length === Number(total - offset < 20n ? total - offset : 20n),
      'source_reorg', '链上项目扫描不完整。');
      const reservations = await childReservations(part.pools, source);
      reservationProofs.push(reservations);
      for (let index = 0; index < part.pools.length; index++) {
        offset++;
        if (reservations.subscribers[index] === ZeroAddress && (!holdings || hasPosition(part.pools[index]))) rows.push(part.pools[index]);
        if (!holdings && rows.length === limit) break;
      }
      if (offset < total && (holdings || rows.length < limit)) {
        part = await readPoolSnapshot(rpc, { factory: manifest.factory, lens: manifest.lens,
          account: owner, offset, limit: 20n, blockNumber: block });
      }
    }
    await ensureCanonical(source);
    reservationProofs.forEach(proof => proof.commit());
    const items = rows.map(row => livePoolModel(row, first));
    insist(!holdings || items.length <= limit, 'direct_scan_limit', '持仓超过直读分页上限，请等待索引恢复。');
    const nextCursor = holdings || offset === total ? null : Number(offset);
    return Object.freeze({ source, items, nextCursor, snapshot: first });
  }
  async function directDisplayPage({ account = ZeroAddress, cursor = 0, limit = 20, holdings = false } = {}) {
    const owner = getAddress(account), rows = [];
    let offset = BigInt(cursor), first, last;
    do {
      const raw = (await call(manifest.lens, abi.PoolLens, 'poolPage', [offset, 20n, owner], 'latest'))[0];
      insist(raw.registryCountValid && raw.totalPools <= 500n && offset <= raw.totalPools
        && raw.nextCursor >= offset && raw.nextCursor <= raw.totalPools && raw.pools.length <= 20,
      'pool_response', '项目目录的业务分页字段无效。');
      const snapshot = Object.freeze({ chainId: 56n, factory: manifest.factory, lens: manifest.lens, account: owner,
        blockNumber: raw.blockNumber, blockHash: null, timestamp: raw.timestamp, totalPools: raw.totalPools,
        nextCursor: raw.nextCursor, pools: raw.pools.map(row => decodePoolRow(row, manifest.factory)), displayOnly: true });
      first ??= snapshot; last = snapshot;
      // Subscriber is a business classification, read once without code/slot/header proofs.
      const subscribers = hasReservationReader ? await mapReadBounded(snapshot.pools, 8,
        row => call(manifest.factory, abi.PoolFactory, 'designatedSubscriber', [row.pool], 'latest').then(result => getAddress(result[0])))
        : snapshot.pools.map(() => ZeroAddress);
      for (let index = 0; index < snapshot.pools.length; index++) {
        offset++;
        if (subscribers[index] === ZeroAddress && (!holdings || hasPosition(snapshot.pools[index]))) rows.push(snapshot.pools[index]);
        if (!holdings && rows.length === limit) break;
      }
      if (snapshot.pools.length === 0) break;
    } while (offset < last.totalPools && (holdings || rows.length < limit));
    const source = Object.freeze({ chainId: 56, factory: manifest.factory, market: manifest.shareMarket,
      ...(manifest.kind === 'integrated-v2' ? { portfolioFactory: manifest.portfolioFactory, portfolioMarket: manifest.portfolioMarket } : {}),
      startBlock: manifest.deployment.blockNumber, confirmations: null,
      indexedThrough: Number(last.blockNumber), indexedBlockHash: null, indexedTimestamp: Number(last.timestamp),
      observedSafeHead: null, complete: true, unknownReason: null, checkedAt: new Date(now()).toISOString(),
      readMode: 'display_direct', displayOnly: true, transactionReady: false, stale: false });
    insist(!holdings || rows.length <= limit, 'direct_scan_limit', '持仓超过直读分页上限，请等待索引恢复。');
    return Object.freeze({ source, items: rows.map(row => livePoolModel(row, first)),
      nextCursor: holdings || offset >= last.totalPools ? null : Number(offset), snapshot: first });
  }
  const canReadDirect = (error, expected, cursor) => !expected && cursor === 0 && isRetryableReadError(error);
  function page(data, limit) { insist(data && Array.isArray(data.items) && data.items.length <= limit
    && Object.hasOwn(data, 'nextCursor'), 'invalid_page', '索引分页响应无效。'); return data; }
  async function positionsAt(addresses, account, source) {
    const normalized = addresses.map(liveAddress);
    insist(new Set(normalized).size === normalized.length, 'duplicate_pool', '索引包含重复项目地址。');
    if (displayReads) {
      const owner = getAddress(account ?? ZeroAddress), blockNumber = BigInt(source.indexedThrough);
      const rows = (await call(manifest.lens, abi.PoolLens, 'positions', [normalized, owner], blockNumber))[0];
      insist(rows.blockNumber === blockNumber && rows.timestamp === BigInt(source.indexedTimestamp)
        && rows.pools.length === normalized.length
        && rows.pools.every((row, index) => sameAddress(row.pool, normalized[index])),
      'pool_response', '聚合业务字段与页面来源或请求不一致。');
      return Object.freeze({ chainId: 56n, factory: manifest.factory, lens: manifest.lens,
        account: owner, blockNumber, blockHash: source.indexedBlockHash, timestamp: rows.timestamp,
        totalPools: rows.registryCountValid ? rows.totalPools : null, nextCursor: rows.nextCursor,
        pools: rows.pools.map(row => decodePoolRow(row, manifest.factory)), displayOnly: true });
    }
    const snapshot = await readPoolSnapshot(rpc, { factory: manifest.factory, lens: manifest.lens, account: account ?? ZeroAddress,
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
    if (expected?.readMode === 'direct_chain' || displayReads && expected?.readMode === 'display_direct')
      return directPage({ account, cursor, limit, pinnedSource: expected });
    let indexed;
    try { indexed = await indexRead('/v1/pools', { cursor, limit }, expected); }
    catch (error) {
      if (!canReadDirect(error, expected, cursor)) throw error;
      try { indexed = await savedSnapshotRead('/pools', { cursor, limit }); }
      catch (snapshotError) {
        if (!isRetryableReadError(snapshotError)
          && !(snapshotError?.code === 'http_unavailable' && snapshotError.details?.status === 404)) throw snapshotError;
        return directPage({ account, cursor, limit });
      }
    }
    const { source, data } = indexed;
    page(data, limit); numericCursor(data, cursor);
    for (const row of data.items) { liveAddress(row.address); liveAddress(row.collection); exact(row.circuitId, 'circuitId');
      safeInt(row.createdBlock, 'createdBlock'); insist(row.createdBlock <= source.indexedThrough, 'invalid_data', '项目创建区块超出索引范围。'); }
    const reserved = indexedReservedCount(data);
    const snapshot = await positionsAt(data.items.map(row => row.address), account, source);
    if (displayReads) {
      const standalone = data.standalonePoolCount === undefined
        ? exact(data.registeredPoolCount, 'registeredPoolCount') : exact(data.standalonePoolCount, 'standalonePoolCount');
      insist(!data.items.some(row => reserved.pools.includes(getAddress(row.address)))
        && BigInt(cursor + data.items.length) <= standalone
        && (data.nextCursor === null ? BigInt(cursor + data.items.length) >= standalone : BigInt(data.nextCursor) < standalone),
      'index_coverage', '项目目录分页与返回数量不一致。');
      return Object.freeze({ source, items: snapshot.pools.map(row => livePoolModel(row, snapshot)),
        nextCursor: data.nextCursor, snapshot });
    }
    const reservations = await childReservations(snapshot.pools, source);
    if (reservations.subscribers.some(value => value !== ZeroAddress)) {
      if (!expected && cursor === 0) return directPage({ account, cursor, limit });
      insist(false, 'index_coverage', '索引将预算子池列为公开认购项目。');
    }
    const registered = data.registeredPoolCount === undefined ? snapshot.totalPools : exact(data.registeredPoolCount, 'registeredPoolCount');
    const child = data.childPoolCount === undefined ? 0n : exact(data.childPoolCount, 'childPoolCount');
    const standalone = data.standalonePoolCount === undefined ? registered : exact(data.standalonePoolCount, 'standalonePoolCount');
    insist(snapshot.totalPools !== null && registered === snapshot.totalPools
      && standalone + child + reserved.count === registered
      && !data.items.some(row => reserved.pools.includes(getAddress(row.address)))
      && BigInt(cursor + data.items.length) <= standalone
      && (data.nextCursor === null ? BigInt(cursor + data.items.length) >= standalone : BigInt(data.nextCursor) < standalone),
    'index_coverage', '项目分页与同块工厂总数不一致。');
    await ensureCanonical(source);
    reservations.commit();
    return Object.freeze({ source, items: snapshot.pools.map(row => livePoolModel(row, snapshot)), nextCursor: data.nextCursor, snapshot });
  }
  async function readPool({ pool, account, source: expected } = {}) {
    let source;
    try { source = await sourceFor(expected); }
    catch (error) {
      if (displayReads) throw error;
      if (!canReadDirect(error, expected, 0)) throw error;
      source = await directSource();
    }
    const snapshot = await positionsAt([liveAddress(pool)], account, source);
    insist(snapshot.pools[0]?.trusted, 'untrusted_pool', '该项目未通过官方工厂身份核验。');
    return Object.freeze({ source, item: livePoolModel(snapshot.pools[0], snapshot), snapshot });
  }
  async function readPositions({ account, cursor = 0, limit = 20, source: expected } = {}) {
    const owner = liveAddress(account); safeInt(cursor, 'cursor'); pageLimit(limit);
    let indexed;
    try { indexed = await indexRead(`/v1/accounts/${owner}/pools`, { cursor, limit }, expected); }
    catch (error) {
      if (displayReads) throw error;
      if (!canReadDirect(error, expected, cursor)) throw error;
      const result = await directPage({ account: owner, cursor, limit, holdings: true });
      const marketBnbOwed = (await call(manifest.shareMarket, abi.ShareMarket, 'bnbOwed', [owner], BigInt(result.source.indexedThrough)))[0];
      await ensureCanonical(result.source);
      return Object.freeze({ ...result, marketBnbOwed });
    }
    const { source, data } = indexed;
    page(data, limit); numericCursor(data, cursor);
    const snapshot = await positionsAt(data.items, owner, source);
    const marketBnbOwed = (await call(manifest.shareMarket, abi.ShareMarket, 'bnbOwed', [owner], snapshot.blockNumber))[0];
    await ensureCanonical(source);
    return Object.freeze({ source, items: snapshot.pools.filter(hasPosition).map(row => livePoolModel(row, snapshot)),
      nextCursor: data.nextCursor, snapshot, marketBnbOwed });
  }
  async function readStats({ source: expected } = {}) {
    let indexed;
    try { indexed = await indexRead('/v1/stats', {}, expected); }
    catch (error) {
      if (!canReadDirect(error, expected, 0)) throw error;
      indexed = await savedSnapshotRead('/stats');
    }
    const { source, data } = indexed;
    insist(data?.scope === 'confirmed_indexed_history', 'invalid_data', '平台统计口径无效。');
    const values = { scope: data.scope, ...readMiningOverviewStats(data) };
    for (const field of ['registeredPoolCount', 'everParticipantAddressCount', 'purchasedCostWei', 'shareMarketFilledGrossWei', 'harvestedToMembersBemAtomic']) values[field] = exact(data[field], field);
    for (const field of ['topLevelProjectCount', 'standalonePoolCount', 'portfolioCount', 'childPoolCount', 'reservedChildPoolCount'])
      if (data[field] !== undefined) values[field] = exact(data[field], field);
    if (values.topLevelProjectCount !== undefined) insist(values.topLevelProjectCount === values.standalonePoolCount + values.portfolioCount
      && values.registeredPoolCount === values.standalonePoolCount + values.childPoolCount + (values.reservedChildPoolCount ?? 0n),
    'index_coverage', '父子项目统计不一致。');
    const reserved = indexedReservedCount(data);
    if (displayReads) {
      insist((values.reservedChildPoolCount ?? 0n) === reserved.count,
        'index_coverage', '项目统计的预留分类不一致。');
      return Object.freeze({ source, data: Object.freeze(values) });
    }
    const count = (await call(manifest.factory, abi.PoolFactory, 'poolCount', [], BigInt(source.indexedThrough)))[0];
    insist(count === values.registeredPoolCount && (values.reservedChildPoolCount ?? 0n) === reserved.count,
      'index_coverage', '项目统计与同块工厂登记数不一致。');
    await ensureCanonical(source);
    return Object.freeze({ source, data: Object.freeze(values) });
  }
  async function readOrders({ pool, seller, active, cursor, limit = 20, source: expected } = {}) {
    pageLimit(limit); if (pool) pool = liveAddress(pool); if (seller) seller = liveAddress(seller);
    insist(active === undefined || typeof active === 'boolean', 'invalid_query', '订单状态筛选无效。');
    if (cursor !== undefined) insist(/^[1-9]\d*$/.test(String(cursor)), 'invalid_cursor', '订单游标无效。');
    let indexed;
    try { indexed = await indexRead('/v1/orders', { pool, seller, active, cursor, limit }, expected); }
    catch (error) {
      if (!isRetryableReadError(error)) throw error;
      try {
        indexed = await savedSnapshotRead('/orders', { pool, seller, active, cursor, limit });
        if (expected) {
          const old = validateIndexSource(expected, manifest, { now: now() });
          insist(sameSource(indexed.source, old), 'source_changed', '索引已更新，分页必须从第一页重新读取。');
          indexed = { ...indexed, source: conservativeSource(indexed.source, old) };
        }
      } catch (snapshotError) {
        if (displayReads) throw snapshotError;
        if (!canReadDirect(error, expected, cursor === undefined ? 0 : 1)
          || !isRetryableReadError(snapshotError)
            && !(snapshotError?.code === 'http_unavailable' && snapshotError.details?.status === 404)) throw snapshotError;
      }
      if (!indexed) {
      const source = await directSource();
      const nextId = (await call(manifest.shareMarket, abi.ShareMarket, 'nextOrderId', [], BigInt(source.indexedThrough)))[0];
      insist(nextId <= 501n, 'direct_scan_limit', '订单数量超出直读上限，请等待索引恢复。');
      const candidates = [];
      for (let id = nextId - 1n; id > 0n; id--) {
        const raw = (await call(manifest.shareMarket, abi.ShareMarket, 'orders', [id], BigInt(source.indexedThrough)))[0];
        const expiresAt = (await call(manifest.shareMarket, abi.ShareMarket, 'orderExpiresAt', [id], BigInt(source.indexedThrough)))[0];
        if (raw.seller === ZeroAddress || raw.pool === ZeroAddress) continue;
        const open = raw.active && raw.remaining > 0n && expiresAt > BigInt(source.indexedTimestamp);
        if ((pool && !sameAddress(raw.pool, pool)) || (seller && !sameAddress(raw.seller, seller))
          || (active !== undefined && open !== active)) continue;
        candidates.push({ id: id.toString(), orderId: id, pool: getAddress(raw.pool), seller: getAddress(raw.seller),
          remaining: raw.remaining, shares: raw.remaining, pricePerUnitWei: raw.pricePerUnit,
          expiresAt, active: raw.active, openAtSourceBlock: open, executable: false, requiresLatestSimulation: true });
      }
      insist(candidates.length <= limit, 'direct_scan_limit', '订单超过直读分页上限，请等待索引恢复。');
      const snapshot = await positionsAt([...new Set(candidates.map(row => row.pool))], undefined, source);
      const pools = new Map(snapshot.pools.map(row => [getAddress(row.pool), row]));
      const items = candidates.map(row => {
        const verified = pools.get(row.pool);
        insist(verified?.trusted, 'untrusted_pool', '订单项目未通过官方工厂核验。');
        return Object.freeze({ ...row, shareTradingAllowed: verified.shareTradingAllowed });
      });
      await ensureCanonical(source);
      return Object.freeze({ source, items, nextCursor: null, snapshot });
      }
    }
    const { source, data } = indexed; page(data, limit);
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
    const items = await mapReadBounded(candidates, 8, async item => {
      const { order, expiry } = await settleReadRound({
        order: () => call(manifest.shareMarket, abi.ShareMarket, 'orders', [item.orderId], snapshot.blockNumber),
        expiry: () => call(manifest.shareMarket, abi.ShareMarket, 'orderExpiresAt', [item.orderId], snapshot.blockNumber),
      });
      const raw = order[0], expiresAt = expiry[0];
      insist(rows.get(item.pool)?.trusted && sameAddress(raw.pool, item.pool) && sameAddress(raw.seller, item.seller)
        && raw.remaining === item.remaining && raw.pricePerUnit === item.pricePerUnitWei && expiresAt === item.expiresAt, 'order_mismatch', '订单索引与同块合约数据不一致。');
      insist((!pool || item.pool === pool) && (!seller || item.seller === seller), 'order_mismatch', '订单不符合请求筛选。');
      const open = raw.active && raw.remaining > 0n && expiresAt > snapshot.timestamp;
      insist(active === undefined || open === active, 'order_mismatch', '订单状态不符合索引筛选。');
      return Object.freeze({ ...item, id: item.orderId.toString(), shares: raw.remaining, active: raw.active, expiresAt,
        openAtSourceBlock: open, shareTradingAllowed: rows.get(item.pool).shareTradingAllowed,
        executable: false, requiresLatestSimulation: true });
    });
    await ensureCanonical(source);
    return Object.freeze({ source, items, nextCursor: data.nextCursor, snapshot });
  }
  async function readGovernance({ pool, account = ZeroAddress, source: expected } = {}) {
    pool = liveAddress(pool); account = getAddress(account); const source = await sourceFor(expected);
    const block = displayReads ? 'latest' : BigInt(source.indexedThrough);
    const timestamp = displayReads ? BigInt(Math.floor(now() / 1000)) : BigInt(source.indexedTimestamp);
    const g = (await call(manifest.lens, abi.PoolLens, 'governance', [pool, account], block))[0];
    insist(g.status.trustError === 0n && good(g.status, 0), 'untrusted_pool', '该治理项目未通过官方身份核验。');
    const result = { pool, account, status: { validMask: g.status.validMask, errorMask: g.status.errorMask, trustError: g.status.trustError } };
    const bits = { state: 1, activeProposalId: 2, proposal: 3, purchaseCost: 4, hasVoted: 5, snapshotShares: 6,
      listedProposalId: 7, expiresAt: 8, salePrice: 9, canVote: 11, canCancelExpired: 12 };
    for (const [key, bit] of Object.entries(bits)) result[key] = good(g.status, bit) ? g[key] : null;
    // The immutable Lens derives both its discount flag and execution eligibility
    // from the old purchase-cost rule. Never expose those fields from the Lens.
    Object.assign(result, { requiredYesCount: null, requiredYesShares: null, discounted: null,
      passed: null, canExecute: null, reviewRequired: null, reviewApproved: null,
      saleReference: null, saleReview: null, saleReviewThresholdBps: DEFAULT_SALE_REVIEW_THRESHOLD_BPS });
    if (result.activeProposalId > 0n && result.proposal !== null) {
      const p = result.proposal;
      insist(p.snapshotTotalShares === 100n && p.snapshotMemberCount > 0n && p.snapshotMemberCount <= 100n
        && p.yesCount <= p.snapshotMemberCount && p.yesShares <= p.snapshotTotalShares,
      'governance_mismatch', '治理投票快照无效。');
      const requiredYesCount = p.snapshotMemberCount / 2n + 1n;
      // The still-active genesis Vault has a 60-share discount threshold. Once
      // the Timelock batch executes, the new Vault always uses dual majority.
      const oldDiscount = config.stage === 'genesis' && result.purchaseCost !== null
        && p.price < result.purchaseCost;
      const requiredYesShares = oldDiscount ? 60n : p.snapshotTotalShares / 2n + 1n;
      const expectedPassed = p.snapshotTs + 86400n === p.endsAt && p.price > 0n
        && p.yesCount >= requiredYesCount && p.yesShares >= requiredYesShares;
      const passed = (await call(pool, abi.PoolVault, 'proposalPassed', [result.activeProposalId], block))[0];
      insist(passed === expectedPassed, 'governance_mismatch', '链上提案门槛与双过半规则不一致。');
      result.requiredYesCount = requiredYesCount;
      result.requiredYesShares = requiredYesShares;
      result.passed = passed;
      if (config.stage === 'genesis') {
        result.discounted = oldDiscount;
        result.canExecute = passed && result.state === 2n && !p.executed
          && timestamp < p.endsAt;
        // Genesis ShareMarket has no review interface; do not display a review proof.
        await ensureCanonical(source);
        return Object.freeze({ source, data: Object.freeze(result) });
      }
      const threshold = readSaleReviewThreshold((to, contract, method, args) => call(to, contract, method, args, block), pool);
      try {
        [result.saleReference, result.saleReviewThresholdBps] = await Promise.all([displayReads
          ? call(manifest.shareMarket, governanceViews, 'saleReference', [pool], block).then(value => saleReferenceState(value, timestamp))
          : readSaleReference(request, manifest.shareMarket, pool, block, timestamp), threshold]);
      } catch (error) { result.saleReference = Object.freeze({ available: false,
        reason: error?.shortMessage || error?.message || 'Firsto 市场参考价暂不可读取。' });
        result.saleReviewThresholdBps = await threshold; }
      if (result.saleReference.available && requiresSaleReview(p.price, result.saleReference.priceWei, result.saleReviewThresholdBps)) {
        try {
          if (displayReads) {
            const [status, priceWei] = await call(manifest.shareMarket, governanceViews, 'saleReview', [pool, result.activeProposalId], block);
            insist(status <= 2n, 'governance_mismatch', 'Firsto 出售审核状态无效。');
            result.saleReview = Object.freeze({ status, priceWei });
          } else result.saleReview = await readSaleReview(request, manifest.shareMarket, pool,
            result.activeProposalId, block);
        }
        catch { /* Missing review capability or RPC failure leaves execution blocked. */ }
      }
      const gate = saleExecutionGate({ proposal: p, passed, state: result.state,
        timestamp, reference: result.saleReference, review: result.saleReview,
        saleReviewThresholdBps: result.saleReviewThresholdBps });
      Object.assign(result, gate);
    }
    await ensureCanonical(source); return Object.freeze({ source, data: Object.freeze(result) });
  }
  async function readActivity({ pool, account, cursor, limit = 20, source: expected } = {}) {
    safeInt(limit, 'limit'); insist(limit >= 1 && limit <= 50, 'page_limit', '每次读取 1–50 条记录。');
    if (pool) pool = liveAddress(pool); if (account) account = liveAddress(account);
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
    const totalCount = data.totalCount == null ? null : safeInt(data.totalCount, 'totalCount');
    const overviewTotalCount = data.overviewTotalCount == null ? null : safeInt(data.overviewTotalCount, 'overviewTotalCount');
    insist((totalCount === null || totalCount >= items.length) && (overviewTotalCount === null
      || totalCount !== null && overviewTotalCount <= totalCount), 'invalid_activity', '记录总数无效。');
    return Object.freeze({ source, items, nextCursor: data.nextCursor, totalCount, overviewTotalCount });
  }
  async function readYield({ pool, account, days = 30, scope = 'pool', source: expected } = {}) {
    pool = liveAddress(pool); if (account) account = liveAddress(account); safeInt(days, 'days'); insist(days >= 1 && days <= 90, 'invalid_query', '收益窗口为1–90天。');
    // Callers choose the accounting scope. A parent receipt must never be
    // accepted as a child harvest (or combined with it) just because both are BEM.
    insist(scope === 'pool' || scope === 'portfolio', 'invalid_query', '收益统计范围无效。');
    const { source, data } = await indexRead('/v1/yield', { pool, account, days }, expected);
    if (scope === 'portfolio') insist(manifest.kind === 'integrated-v2'
      && sameAddress(source.portfolioFactory, manifest.portfolioFactory)
      && sameAddress(source.portfolioMarket, manifest.portfolioMarket), 'index_identity', '预算历史记录来源不一致。');
    insist(data?.scope === scope && sameAddress(data.pool, pool) && (account ? sameAddress(data.account, account) : data.account === null)
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
  return Object.freeze({ manifest, provider: rpc, verifyDeployment, readDisplayPool, readDisplayPools, readDisplayPositions, readDisplayOrders, readDisplayStats, readPools, readPool, readPositions, readStats, readOrders, readGovernance, readActivity, readYield });
}
