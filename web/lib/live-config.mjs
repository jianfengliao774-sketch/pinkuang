import { getAddress, ZeroAddress } from 'ethers';
import { ARTIFACT_DIGEST } from './chain-client.mjs';

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
export const MANIFEST_KEYS = Object.freeze(['factory', 'shareMarket', 'lens', 'beacon', 'timelock']);

/** No permissive parsing or demo fallback. The same-origin file is an operator-reviewed public trust root. */
export function validateManifest(input) {
  insist(input && input.schemaVersion === 1 && input.chainId === 56, 'manifest_schema', '不支持的部署清单或网络。');
  insist(hash(input.artifactDigest) && input.artifactDigest.toLowerCase() === ARTIFACT_DIGEST.toLowerCase(), 'artifact_mismatch', '部署清单与当前页面合约版本不一致。');
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
  insist(new Set(Object.values(addresses)).size === MANIFEST_KEYS.length, 'manifest_schema', '部署合约地址不能重复。');
  return Object.freeze({ schemaVersion: 1, chainId: 56, ...addresses, deployment: Object.freeze({ ...d }),
    artifactDigest: input.artifactDigest.toLowerCase(), sourceCommit: input.sourceCommit, verifiedAt: input.verifiedAt,
    verifiedBlockNumber: input.verifiedBlockNumber, codehash: Object.freeze(codehash) });
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
  const input = await fetchLiveJson(manifestUrl, { fetcher, allow404: true, maxBytes: 65536 });
  if (input === null) return Object.freeze({ status: 'unconfigured', reason: '尚未配置已核验的正式合约。', manifestUrl });
  const manifest = validateManifest(input);
  const rpc = new URL(rpcUrl ?? `${base}/api/rpc`, origin);
  insist(!rpc.username && !rpc.password && !rpc.hash, 'invalid_config', '只读 RPC 配置无效。');
  insist(rpc.origin === origin || (rpc.protocol === 'https:' && allowedRpcOrigins.includes(rpc.origin)), 'rpc_not_allowed', 'RPC 来源未获配置授权。');
  return Object.freeze({ status: 'ready', manifest, origin, basePath: base, manifestUrl,
    indexBaseUrl: `${origin}${base}/api/chain-index`, journalBase: `${base}/api/journal`, rpcUrl: rpc.href });
}

const READ_RPC = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getStorageAt']);
/** Only used for reads. A wallet provider may instead be injected by the UI. */
export function createReadOnlyHttpProvider(config, { fetcher = globalThis.fetch } = {}) {
  insist(config?.status === 'ready', 'unconfigured', '尚未配置正式合约。');
  let id = 0;
  return Object.freeze({ async request({ method, params = [] }) {
    insist(READ_RPC.has(method), 'rpc_method_denied', '只读连接不支持该操作。');
    const requestId = ++id;
    const response = await fetchLiveJson(config.rpcUrl, { fetcher, method: 'POST', body: { jsonrpc: '2.0', id: requestId, method, params } });
    insist(response?.jsonrpc === '2.0' && response.id === requestId && !response.error && Object.hasOwn(response, 'result'), 'rpc_error', '只读 RPC 返回错误或不匹配的响应。');
    return response.result;
  } });
}

export const createReadProvider = createReadOnlyHttpProvider;
