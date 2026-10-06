import { getAddress, ZeroAddress, id } from 'ethers';
import { ARTIFACT_DIGEST } from './chain-client.mjs';
import pinnedGenesis from '../public/data/frontend-manifest.json' with { type: 'json' };

export const GENESIS_ARTIFACT_DIGEST = pinnedGenesis.artifactDigest;
export const PRODUCT_STAGES = Object.freeze(['genesis', 'fresh-active', 'code-upgraded', 'role-migrating', 'role-wired']);

export class LiveDataError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'LiveDataError'; this.code = code; this.details = details; }
}
export function insist(ok, code, message) { if (!ok) throw new LiveDataError(code, message); }
export const hash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
export function liveAddress(value) {
  try { const a = getAddress(value); insist(a !== ZeroAddress, 'invalid_address', '合约地址不能为零。'); return a; }
  catch { throw new LiveDataError('invalid_address', '地址格式无效。'); }
}
const safeInteger = n => Number.isSafeInteger(n) && n >= 0;
export const PORTFOLIO_MANIFEST_KEYS = Object.freeze(['portfolioFactory', 'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation', 'portfolioFactoryImplementation']);
export const MANIFEST_KEYS = Object.freeze(['factory', 'shareMarket', 'lens', 'beacon', 'timelock']);

/** No permissive parsing or demo fallback. The same-origin file is an operator-reviewed public trust root. */
export function validateManifest(input, expectedDigest = ARTIFACT_DIGEST) {
  insist(input && input.schemaVersion === 1 && input.chainId === 56, 'manifest_schema', '不支持的部署清单或网络。');
  insist(hash(expectedDigest) && hash(input.artifactDigest) && input.artifactDigest.toLowerCase() === expectedDigest.toLowerCase(), 'artifact_mismatch', '部署清单与当前页面合约版本不一致。');
  insist(typeof input.sourceCommit === 'string' && /^[\da-f]{40}$/i.test(input.sourceCommit), 'manifest_schema', '部署清单缺少源码版本。');
  insist(Number.isFinite(Date.parse(input.verifiedAt)), 'manifest_schema', '部署清单缺少核验时间。');
  const d = input.deployment;
  insist(d && hash(d.txHash) && hash(d.blockHash) && safeInteger(d.blockNumber)
    && safeInteger(input.verifiedBlockNumber) && input.verifiedBlockNumber >= d.blockNumber, 'manifest_schema', '部署区块或核验区块无效。');
  const addresses = {}, codehash = {};
  for (const name of MANIFEST_KEYS) {
    addresses[name] = liveAddress(input[name]);
    insist(hash(input.codehash?.[name]), 'manifest_schema', `${name} 缺少运行代码摘要。`);
    codehash[name] = input.codehash[name].toLowerCase();
  }
  const hasPortfolio = input.kind === 'integrated-v2';
  insist(hasPortfolio || !PORTFOLIO_MANIFEST_KEYS.some(key => input[key] !== undefined), 'manifest_schema', '预算部署必须使用 integrated-v2 清单。');
  if (hasPortfolio) for (const name of PORTFOLIO_MANIFEST_KEYS) {
    addresses[name] = liveAddress(input[name]);
    insist(hash(input.codehash?.[name]), 'manifest_schema', `${name} 缺少运行代码摘要。`);
    codehash[name] = input.codehash[name].toLowerCase();
  }
  let freshAuthority;
  if (input.authority !== undefined || input.gasWallet !== undefined || input.freshAuthority !== undefined) {
    const proof=input.freshAuthority;
    insist(proof && typeof proof==='object' && hash(proof.codehash) && hash(proof.deploymentTxHash),
      'manifest_schema', '新部署管理员合约缺少代码或部署交易核验。');
    const authority=liveAddress(input.authority), gasWallet=liveAddress(input.gasWallet);
    const first=liveAddress(proof.administratorOne), second=liveAddress(proof.administratorTwo);
    insist(sameAddress(proof.address,authority) && sameAddress(proof.gasWallet,gasWallet)
      && new Set([authority,gasWallet,first,second].map(value=>value.toLowerCase())).size===4,
    'manifest_schema', '新部署管理员和 Gas 钱包地址不一致或重复。');
    freshAuthority=Object.freeze({address:authority,codehash:proof.codehash.toLowerCase(),
      deploymentTxHash:proof.deploymentTxHash.toLowerCase(),administratorOne:first,
      administratorTwo:second,gasWallet});
  }
  insist(new Set(Object.values(addresses)).size === MANIFEST_KEYS.length + (hasPortfolio ? PORTFOLIO_MANIFEST_KEYS.length : 0), 'manifest_schema', '部署合约地址不能重复。');
  return Object.freeze({ schemaVersion: 1, chainId: 56, ...(hasPortfolio ? { kind: 'integrated-v2' } : {}), ...addresses, deployment: Object.freeze({ ...d }),
    artifactDigest: input.artifactDigest.toLowerCase(), sourceCommit: input.sourceCommit, verifiedAt: input.verifiedAt,
    verifiedBlockNumber: input.verifiedBlockNumber, codehash: Object.freeze(codehash),
    ...(freshAuthority ? {authority:freshAuthority.address,gasWallet:freshAuthority.gasWallet,freshAuthority} : {}) });
}

const unchangedRootKeys = Object.freeze(['factory', 'shareMarket', 'lens', 'beacon', 'timelock',
  'portfolioFactory', 'portfolioMarket', 'portfolioBeacon']);
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const sameAddress = same;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** A served genesis file may be missing, but may never silently replace the build-pinned root. */
export function validatePinnedGenesis(input) {
  const manifest = validateManifest(input, GENESIS_ARTIFACT_DIGEST);
  insist(JSON.stringify(canonical(input)) === JSON.stringify(canonical(pinnedGenesis)), 'genesis_mismatch',
    '旧版部署清单与页面固定的链上记录不一致。');
  return manifest;
}

/** The product service verifies the chain; the browser also binds its result to both compiled ABIs. */
export function validateProductGraph(input, genesis = pinnedGenesis) {
  insist(input && input.status === 'verified' && input.chainId === 56 && PRODUCT_STAGES.includes(input.stage),
    'product_graph', '链上产品阶段未通过核验。');
  insist(hash(input.genesisArtifactDigest) && same(input.genesisArtifactDigest, genesis.artifactDigest),
    'product_graph', '旧版合约摘要与页面不一致。');
  const fresh = input.stage === 'fresh-active';
  const upgraded = input.stage !== 'genesis' && !fresh;
  const expectedDigest = upgraded || fresh ? ARTIFACT_DIGEST : genesis.artifactDigest;
  if (fresh) insist(same(genesis.artifactDigest, ARTIFACT_DIGEST),
    'product_graph', '新部署页面必须由同一份合约产物构建。');
  insist(hash(input.artifactDigest) && same(input.artifactDigest, expectedDigest)
    && (!upgraded || hash(input.upgradeArtifactDigest) && same(input.upgradeArtifactDigest, ARTIFACT_DIGEST))
    && (input.upgradeArtifactDigest == null || same(input.upgradeArtifactDigest, ARTIFACT_DIGEST)),
  'product_graph', '链上阶段与页面合约产物不一致。');
  insist(Number.isSafeInteger(input.verifiedBlockNumber) && input.verifiedBlockNumber >= genesis.verifiedBlockNumber
    && hash(input.verifiedBlockHash), 'product_graph', '链上核验区块无效。');
  insist(Number.isSafeInteger(input.stageActivationBlock)
    && input.stageActivationBlock >= genesis.deployment.blockNumber
    && input.stageActivationBlock <= input.verifiedBlockNumber && hash(input.stageActivationHash)
    && (upgraded || fresh || input.stageActivationBlock === genesis.deployment.blockNumber
      && same(input.stageActivationHash, genesis.deployment.blockHash)),
  'product_graph', '产品阶段生效区块未通过核验。');
  insist(!upgraded || hash(input.operationId) && input.creationPaused === true,
    'product_graph', '升级批次或建池暂停状态未核验。');
  if (fresh) insist(input.operationId == null && input.upgradeArtifactDigest == null
    && input.freshFactoryVerified === true
    && input.freshAuthority && liveAddress(input.freshAuthority.address)
    && hash(input.freshAuthority.codehash) && hash(input.freshAuthority.deploymentTxHash)
    && input.freshAuthority.activationBlock === input.stageActivationBlock
    && same(input.freshAuthority.activationHash, input.stageActivationHash),
  'product_graph', '新部署的工厂或管理员接线尚未完成链上核验。');
  insist(typeof input.operationalReady === 'boolean', 'product_graph', '运营接线状态未通过核验。');
  // Older genesis responses have no read mode. A verified historical response
  // must carry explicit display-only fields before the page may render it.
  const readMode = input.readMode ?? 'current';
  const stale = readMode === 'verified_snapshot';
  insist(stale
    ? input.stale === true && input.transactionReady === false && input.operationalReady === false
      && typeof input.refreshing === 'boolean' && safeInteger(input.snapshotAgeMs)
    : readMode === 'current' && (input.stale === undefined || input.stale === false)
      && (input.transactionReady === undefined || typeof input.transactionReady === 'boolean'),
  'product_graph', '历史产品阶段缺少仅供展示标记。');
  insist(same(input.factory, genesis.factory) && same(input.portfolioFactory, genesis.portfolioFactory),
    'product_graph', 'Factory 与旧版可信部署不一致。');
  const manifest = validateManifest(input.manifest, expectedDigest);
  if (fresh) {
    const pinned=validateManifest(genesis, expectedDigest).freshAuthority;
    insist(pinned && manifest.freshAuthority && input.freshAuthority
      && ['address','codehash','deploymentTxHash','administratorOne','administratorTwo','gasWallet']
        .every(key=>same(pinned[key],manifest.freshAuthority[key])
          && same(pinned[key],input.freshAuthority[key])),
    'product_graph', '管理员合约、签名钱包或 Gas 钱包与页面固定清单不一致。');
  }
  insist(manifest.verifiedBlockNumber === input.stageActivationBlock
    && manifest.deployment.blockNumber === genesis.deployment.blockNumber
    && same(manifest.deployment.blockHash, genesis.deployment.blockHash)
    && same(manifest.deployment.txHash, genesis.deployment.txHash), 'product_graph', '部署交易或核验区块不一致。');
  for (const key of unchangedRootKeys) {
    insist(same(manifest[key], genesis[key]) && same(manifest.codehash[key], genesis.codehash[key]),
      'product_graph', `${key} 与已发布的原始部署不一致。`);
  }
  if (!upgraded) for (const key of PORTFOLIO_MANIFEST_KEYS) {
    insist(same(manifest[key], genesis[key]) && same(manifest.codehash[key], genesis.codehash[key]),
      'product_graph', `${key} 与已发布的原始部署不一致。`);
  }
  return Object.freeze({ stage: input.stage, manifest, artifactDigest: expectedDigest,
    operationId: input.operationId ?? null, verifiedBlockNumber: input.verifiedBlockNumber,
    verifiedBlockHash: input.verifiedBlockHash.toLowerCase(), operationalReady: input.operationalReady,
    readMode, stale, userExitReady: fresh && !stale && input.userExitReady === true,
    ...(input.transactionReady === false ? { transactionReady: false } : {}),
    ...(stale ? { refreshing: input.refreshing, snapshotAgeMs: input.snapshotAgeMs } : {}),
    stageActivationBlock: input.stageActivationBlock, stageActivationHash: input.stageActivationHash.toLowerCase(),
    ...(fresh ? {freshAuthority:Object.freeze({...input.freshAuthority}),freshFactoryVerified:true} : {}) });
}

/** Bounded JSON fetch; redirects and credentials to other origins are never followed. */
export async function fetchLiveJson(url, { fetcher = globalThis.fetch, method = 'GET', body, maxBytes = 1048576, timeoutMs = 15000, allow404 = false } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { method, redirect: 'error', credentials: 'same-origin', cache: 'no-store',
      signal: abort.signal, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new LiveDataError('http_unavailable', `数据服务暂不可用（HTTP ${response.status}）。`, { status: response.status });
    insist(!response.redirected, 'http_redirect', '数据服务不能重定向。');
    const contentType = response.headers?.get('content-type') ?? '';
    insist(/\bapplication\/([\w.+-]*\+)?json\b/i.test(contentType), 'invalid_json', '数据服务未返回 JSON。');
    const size = Number(response.headers?.get('content-length') || 0);
    insist(!Number.isFinite(size) || size <= maxBytes, 'response_too_large', '数据响应超过大小限制。');
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), parts = []; let bytes = 0;
      try {
        while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
          insist(bytes <= maxBytes, 'response_too_large', '数据响应超过大小限制。'); parts.push(next.value); }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const all = new Uint8Array(bytes); let offset = 0;
      for (const part of parts) { all.set(part, offset); offset += part.byteLength; }
      text = new TextDecoder('utf-8', { fatal: true }).decode(all);
    } else {
      text = await response.text();
      insist(new TextEncoder().encode(text).byteLength <= maxBytes, 'response_too_large', '数据响应超过大小限制。');
    }
    try { return JSON.parse(text); } catch { throw new LiveDataError('invalid_json', '数据服务返回无效 JSON。'); }
  } catch (error) {
    if (error instanceof LiveDataError) throw error;
    throw new LiveDataError('network_unavailable', abort.signal.aborted ? '读取超时，请重试。' : '无法连接只读数据服务。');
  } finally { clearTimeout(timer); }
}

export async function loadLiveConfig({ fetcher = globalThis.fetch, basePath = '', origin = globalThis.location?.origin,
  rpcUrl, allowedRpcOrigins = [] } = {}) {
  insist(typeof origin === 'string' && /^https?:\/\//.test(origin) && new URL(origin).origin === origin, 'invalid_config', '缺少可信网站来源。');
  insist(typeof basePath === 'string' && /^(?:\/[A-Za-z0-9_-]+)*\/?$/.test(basePath), 'invalid_config', '网站路径无效。');
  const base = basePath.replace(/\/$/, '');
  const manifestUrl = `${origin}${base}/data/frontend-manifest.json`;
  const productGraphUrl = `${origin}${base}/api/journal/product-graph`;
  // Both same-origin documents are independent network fetches. Validate the
  // pinned genesis first, then bind the product graph to that exact genesis.
  const [manifestRead, graphRead] = await Promise.allSettled([
    fetchLiveJson(manifestUrl, { fetcher, allow404: true, maxBytes: 65536 }),
    fetchLiveJson(productGraphUrl, { fetcher, maxBytes: 65536 }),
  ]);
  if (manifestRead.status === 'rejected') throw manifestRead.reason;
  const input = manifestRead.value;
  if (input === null) return Object.freeze({ status: 'unconfigured', reason: '尚未配置已核验的正式合约。', manifestUrl });
  const genesis = validatePinnedGenesis(input);
  if (graphRead.status === 'rejected') throw graphRead.reason;
  const graph = validateProductGraph(graphRead.value, genesis);
  const rpc = new URL(rpcUrl ?? `${base}/api/rpc`, origin);
  insist(!rpc.username && !rpc.password && !rpc.hash, 'invalid_config', '只读 RPC 配置无效。');
  insist(rpc.origin === origin || (rpc.protocol === 'https:' && allowedRpcOrigins.includes(rpc.origin)), 'rpc_not_allowed', 'RPC 来源未获配置授权。');
  return Object.freeze({ status: 'ready', manifest: graph.manifest, stage: graph.stage,
    artifactDigest: graph.artifactDigest, operationId: graph.operationId,
    productGraphUrl, verifiedBlockHash: graph.verifiedBlockHash, operationalReady: graph.operationalReady,
    readMode: graph.readMode, stale: graph.stale, userExitReady: graph.userExitReady,
    ...(graph.transactionReady === false ? { transactionReady: false } : {}),
    ...(graph.stale ? { refreshing: graph.refreshing, snapshotAgeMs: graph.snapshotAgeMs } : {}),
    stageActivationBlock: graph.stageActivationBlock, stageActivationHash: graph.stageActivationHash,
    ...(graph.freshAuthority ? {freshAuthority:graph.freshAuthority,freshFactoryVerified:true} : {}),
    origin, basePath: base, manifestUrl,
    indexBaseUrl: `${origin}${base}/api/chain-index`, journalBase: `${base}/api/journal`, rpcUrl: rpc.href });
}

const READ_RPC = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getStorageAt',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs']);
const FEE_HISTORY_TOPIC = id('FeesClaimed(address,uint256,uint256)');
/** Only used for reads. A wallet provider may instead be injected by the UI. */
export function createReadOnlyHttpProvider(config, { fetcher = globalThis.fetch } = {}) {
  insist(config?.status === 'ready', 'unconfigured', '尚未配置正式合约。');
  let id = 0;
  return Object.freeze({ async request({ method, params = [] }) {
    insist(READ_RPC.has(method), 'rpc_method_denied', '只读连接不支持该操作。');
    if (method === 'eth_getLogs') {
      const filter = params[0], q = value => typeof value === 'string' && /^0x(?:0|[1-9a-f][\da-f]*)$/i.test(value);
      insist(config.stage === 'fresh-active' && config.manifest?.freshAuthority
        && params.length === 1 && filter && !Array.isArray(filter)
        && Object.keys(filter).length === 4 && Object.keys(filter).every(key => ['address','topics','fromBlock','toBlock'].includes(key))
        && typeof filter.address === 'string' && filter.address.toLowerCase() === config.manifest.authority?.toLowerCase()
        && Array.isArray(filter.topics) && filter.topics.length === 1 && filter.topics[0] === FEE_HISTORY_TOPIC
        && q(filter.fromBlock) && q(filter.toBlock)
        && BigInt(filter.toBlock) >= BigInt(filter.fromBlock) && BigInt(filter.toBlock) - BigInt(filter.fromBlock) < 5000n,
      'rpc_method_denied', '只读连接不支持该领取记录范围。');
    }
    const requestId = ++id;
    const response = await fetchLiveJson(config.rpcUrl, { fetcher, method: 'POST', body: { jsonrpc: '2.0', id: requestId, method, params } });
    insist(response?.jsonrpc === '2.0' && response.id === requestId && !response.error && Object.hasOwn(response, 'result'), 'rpc_error', '只读 RPC 返回错误或不匹配的响应。');
    return response.result;
  } });
}

export const createReadProvider = createReadOnlyHttpProvider;
