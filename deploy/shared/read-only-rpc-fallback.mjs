const TRANSIENT_HTTP = new Set([403, 408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(['TIMEOUT', 'NETWORK_ERROR', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']);

function fixedUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a fixed HTTP(S) RPC URL.`); }
  if (url.username || url.password || url.hash || !(url.protocol === 'https:'
    || url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)))
    throw new Error(`${label} must use HTTPS without credentials or fragments.`);
  return url.href;
}

/** The process's existing operator settings are the only backup source. */
export function readOnlyRpcFallbackUrl(primary, env = process.env) {
  const original = fixedUrl(primary, 'Primary RPC');
  for (const name of ['BEMINE_READ_FALLBACK_RPC_URL', 'CHAIN_INDEX_LOGS_RPC_URL']) {
    if (!env[name]) continue;
    const candidate = fixedUrl(env[name], name);
    if (candidate !== original) return candidate;
  }
  return null;
}

export function isRpcTransportFailure(error) {
  const status = error?.response?.statusCode ?? error?.info?.response?.statusCode
    ?? Number(String(error?.info?.responseStatus ?? '').match(/^\d{3}/)?.[0]);
  return TRANSIENT_HTTP.has(status) || TRANSIENT_CODES.has(error?.code)
    || TRANSIENT_CODES.has(error?.cause?.code)
    || error?.code === 'UNSUPPORTED_OPERATION' && error.operation === 'bodyJson';
}
