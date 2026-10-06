import { sha256, toUtf8Bytes } from 'ethers';
import { ARTIFACT_DIGEST } from './chain-client.mjs';
import compiledManifest from '../public/data/frontend-manifest.json' with { type: 'json' };
import { fetchLiveJson, hash, insist, liveAddress, validateManifest, validateProductGraph } from './live-config.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** Digest the reviewed JSON values, independent of whitespace and property order. */
export const freshManifestDigest = value => sha256(toUtf8Bytes(JSON.stringify(canonical(value))));

/** The fresh deployment is its own trust root, never the earlier BEMine Factory. */
export function validateFreshManifest(input, expectedSha256) {
  insist(hash(expectedSha256) && freshManifestDigest(input) === expectedSha256.toLowerCase(),
    'fresh_manifest_mismatch', '正式版部署清单与当前页面固定的版本不一致。');
  const manifest = validateManifest(input, ARTIFACT_DIGEST);
  insist(manifest.kind === 'integrated-v2' && manifest.freshAuthority
    && manifest.freshAuthority.address === liveAddress(input.authority)
    && manifest.freshAuthority.gasWallet === liveAddress(input.gasWallet),
  'fresh_manifest', '正式版必须提供全新部署与管理员合约的核验清单。');
  return manifest;
}

/** Validate the API against this release's fresh genesis, including every address and code hash. */
export function validateFreshProductGraph(input, pinnedManifest) {
  insist(pinnedManifest?.freshAuthority && input?.stage === 'fresh-active',
    'fresh_product_graph', '正式版新合约阶段尚未通过核验。');
  const graph = validateProductGraph(input, pinnedManifest);
  insist(graph.freshFactoryVerified === true
    && same(input.factory, pinnedManifest.factory)
    && same(input.portfolioFactory, pinnedManifest.portfolioFactory)
    && (!graph.stale || graph.snapshotAgeMs < 30 * 60 * 1000),
  'fresh_product_graph', '正式版新合约或只读快照尚未通过核验。');
  return graph;
}

/**
 * Public browsing only needs this build's reviewed addresses. No RPC, current
 * product graph, polling, or current authorization proof is part of this boot.
 * Production builds replace compiledManifest with the reviewed v4 trust root.
 */
export async function loadFreshDisplayConfig({ fetcher = globalThis.fetch,
  basePath = '', origin = globalThis.location?.origin,
  manifestSha256 = process.env.NEXT_PUBLIC_V4_MANIFEST_SHA256,
  pinnedManifest: suppliedManifest, rpcUrl, allowedRpcOrigins = [] } = {}) {
  insist(typeof origin === 'string' && /^https?:\/\//.test(origin) && new URL(origin).origin === origin,
    'invalid_config', '缺少可信网站来源。');
  insist(/^\/bemine-v[45]\/?$/.test(basePath),
    'invalid_config', '正式版必须使用独立的版本路径。');
  insist(hash(manifestSha256), 'fresh_manifest_mismatch', '正式版构建缺少固定的清单摘要。');
  const base = basePath.replace(/\/$/, '');
  const version = base.slice(-1);
  const manifestUrl = `${origin}${base}/data/frontend-manifest.v${version}.json`;
  const rpc = new URL(rpcUrl ?? `${base}/api/rpc`, origin);
  insist(!rpc.username && !rpc.password && !rpc.hash, 'invalid_config', '只读 RPC 配置无效。');
  insist(rpc.origin === origin || rpc.protocol === 'https:' && allowedRpcOrigins.includes(rpc.origin),
    'rpc_not_allowed', 'RPC 来源未获配置授权。');

  let pinnedManifest, manifestSource = 'build';
  if (suppliedManifest !== undefined) {
    // An explicitly supplied build root must not silently fall back elsewhere.
    pinnedManifest = validateFreshManifest(suppliedManifest, manifestSha256);
  } else {
    try { pinnedManifest = validateFreshManifest(compiledManifest, manifestSha256); }
    catch {
      // Local development can still compile the earlier manifest. The only
      // fallback is this origin's v4 file, bound to the same build digest.
      const input = await fetchLiveJson(manifestUrl, { fetcher, allow404: true, maxBytes: 65536 });
      if (input === null) return Object.freeze({ status: 'unconfigured', displayOnly: true,
        transactionReady: false, operationalReady: false, userExitReady: false,
        reason: '正式版新合约尚未完成部署核验。', manifestUrl });
      pinnedManifest = validateFreshManifest(input, manifestSha256);
      manifestSource = 'same-origin';
    }
  }
  return Object.freeze({ status: 'ready', productFamily: 'fresh-v4', stage: 'fresh-active',
    pinnedManifest, manifest: pinnedManifest, artifactDigest: pinnedManifest.artifactDigest,
    displayOnly: true, readMode: 'display', manifestSource,
    transactionReady: false, operationalReady: false, userExitReady: false,
    freshFactoryVerified: false, freshAuthority: pinnedManifest.freshAuthority,
    origin, basePath: base, manifestUrl,
    productGraphUrl: `${origin}${base}/api/journal/product-graph`,
    indexBaseUrl: `${origin}${base}/api/chain-index`, journalBase: `${base}/api/journal`, rpcUrl: rpc.href });
}

/** /bemine-v4/ uses a separate static manifest and the v4-only API namespace. */
export async function loadFreshLiveConfig({ fetcher = globalThis.fetch,
  basePath = '', origin = globalThis.location?.origin,
  manifestSha256 = process.env.NEXT_PUBLIC_V4_MANIFEST_SHA256,
  rpcUrl, allowedRpcOrigins = [] } = {}) {
  insist(typeof origin === 'string' && /^https?:\/\//.test(origin) && new URL(origin).origin === origin,
    'invalid_config', '缺少可信网站来源。');
  insist(/^\/bemine-v[45]\/?$/.test(basePath),
    'invalid_config', '正式版必须使用独立的版本路径。');
  const base = basePath.replace(/\/$/, '');
  const version = base.slice(-1);
  const manifestUrl = `${origin}${base}/data/frontend-manifest.v${version}.json`;
  const productGraphUrl = `${origin}${base}/api/journal/product-graph`;
  insist(hash(manifestSha256), 'fresh_manifest_mismatch', '正式版构建缺少固定的清单摘要。');
  const [manifestRead, graphRead] = await Promise.allSettled([
    fetchLiveJson(manifestUrl, { fetcher, allow404: true, maxBytes: 65536 }),
    fetchLiveJson(productGraphUrl, { fetcher, maxBytes: 65536 }),
  ]);
  if (manifestRead.status === 'rejected') throw manifestRead.reason;
  if (manifestRead.value === null) return Object.freeze({ status: 'unconfigured',
    reason: '正式版新合约尚未完成部署核验。', manifestUrl });
  const pinnedManifest = validateFreshManifest(manifestRead.value, manifestSha256);
  if (graphRead.status === 'rejected') throw graphRead.reason;
  const graph = validateFreshProductGraph(graphRead.value, pinnedManifest);
  const rpc = new URL(rpcUrl ?? `${base}/api/rpc`, origin);
  insist(!rpc.username && !rpc.password && !rpc.hash, 'invalid_config', '只读 RPC 配置无效。');
  insist(rpc.origin === origin || rpc.protocol === 'https:' && allowedRpcOrigins.includes(rpc.origin),
    'rpc_not_allowed', 'RPC 来源未获配置授权。');
  return Object.freeze({ status: 'ready', productFamily: 'fresh-v4', pinnedManifest,
    manifest: graph.manifest, stage: graph.stage, artifactDigest: graph.artifactDigest,
    operationId: graph.operationId, productGraphUrl, verifiedBlockHash: graph.verifiedBlockHash,
    operationalReady: graph.operationalReady, readMode: graph.readMode, stale: graph.stale, userExitReady: graph.userExitReady,
    ...(graph.transactionReady === false ? { transactionReady: false } : {}),
    ...(graph.stale ? { refreshing: graph.refreshing, snapshotAgeMs: graph.snapshotAgeMs } : {}),
    stageActivationBlock: graph.stageActivationBlock, stageActivationHash: graph.stageActivationHash,
    freshAuthority: graph.freshAuthority, freshFactoryVerified: true,
    origin, basePath: base, manifestUrl,
    indexBaseUrl: `${origin}${base}/api/chain-index`, journalBase: `${base}/api/journal`, rpcUrl: rpc.href });
}
