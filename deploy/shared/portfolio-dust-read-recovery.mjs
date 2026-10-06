const readMethods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getTransactionCount',
  'eth_getCode', 'eth_getStorageAt', 'eth_call']);
const transportCodes = new Set(['SERVER_ERROR', 'NETWORK_ERROR', 'TIMEOUT']);
const transientProxyMessages = new Set(['Read-only data service is unavailable.',
  'Read-only data service timed out.', 'Read-only data service is busy.',
  'Read-only archive retry timed out.', 'Read-only archive retry is busy.']);
const hash = /^0x[\da-f]{64}$/i;
const preserved = '部署和升级排程的确认记录已保留。当前链状态暂未读取完成，请核对进度；无需重复部署。';

function isRpcError(value) {
  return value && typeof value === 'object' && (typeof value.code === 'number'
    || typeof value.code === 'string' && /^-?\d+$/.test(value.code));
}
function responseBody(response) {
  // FetchResponse.bodyJson throws for an empty or non-JSON HTTP error page.
  try { return response.bodyJson; } catch {
    // Truncated JSON is an invalid envelope, not an opaque HTTP error page.
    try { if (/^[\s]*[\[{]/.test(response.bodyText)) return null; } catch { /* No readable body. */ }
    return undefined;
  }
}
function mayRetry(error) {
  if (!transportCodes.has(error?.code) || error?.event === 'changed'
    || isRpcError(error?.error) || isRpcError(error?.info?.error)) return false;
  const response = error?.response;
  if (response) {
    if (![502, 503, 504].includes(response.statusCode)) return false;
    const body = responseBody(response);
    // A structured RPC refusal, identity failure or invalid envelope must reach
    // the verifier unchanged. Only these fixed proxy transport errors qualify.
    if (body !== undefined) {
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof body.error !== 'string'
        || !transientProxyMessages.has(body.error)) return false;
    }
    return true;
  }
  // A message containing "502" is not proof of a HTTP response.
  return error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT';
}
function retryWait(error, fallback, now) {
  const raw = error?.response?.headers?.['retry-after'];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  let ms;
  if (/^\d+$/.test(value)) ms = Number(value) * 1000;
  else {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) ms = Math.max(0, timestamp - now);
  }
  return Number.isFinite(ms) && ms >= 0 && ms <= 2500 ? ms : null;
}
function sameParams(params, fingerprint) {
  try { return JSON.stringify(params) === fingerprint; } catch { return false; }
}

/** Wrap only an independent read provider; never an injected wallet. Configure
 * its FetchRequest to 18 seconds, maxAttempts: 1 and retryFunc: async () => false.
 * Wrap the pacing queue with this helper, so both attempts enter that queue.
 */
export function retryPortfolioDustRead(send, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, retryDelayMs = 1000, maxElapsedForRetryMs = 2000 } = {}) {
  if (typeof send !== 'function' || typeof sleep !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 2500
    || !Number.isSafeInteger(maxElapsedForRetryMs) || maxElapsedForRetryMs < 0 || maxElapsedForRetryMs > 2000)
    throw new TypeError('A bounded independent read retry is required.');
  return async (method, params) => {
    if (!readMethods.has(method) || !Array.isArray(params))
      throw new TypeError('Only the pinned portfolio read methods are allowed.');
    const fingerprint = JSON.stringify(params), started = now();
    if (!Number.isFinite(started)) throw new TypeError('A valid read clock is required.');
    try { return await send(method, params); }
    catch (error) {
      const current = now(), elapsed = current - started;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > maxElapsedForRetryMs
        || !mayRetry(error)) throw error;
      const wait = retryWait(error, retryDelayMs, current);
      if (wait === null || !sameParams(params, fingerprint)) throw error;
      await sleep(wait);
      if (!sameParams(params, fingerprint)) throw error;
      // Exactly one additional attempt, with the original method and params.
      // Preserve its result or error; do not restart validation or any wallet flow.
      return send(method, params);
    }
  };
}

/** Fixed messages never expose the provider URL, raw body or calldata. Ordinary
 * local validation errors return null so their reviewed messages remain intact.
 */
export function portfolioDustReadErrorMessage(error) {
  if (transportCodes.has(error?.code))
    return '链上读取暂时未完成。原交易记录已保留，请稍后只读核对进度；不会重复发送。';
  if (error?.code === 'CALL_EXCEPTION' || error?.code === 'UNKNOWN_ERROR'
    && readMethods.has(error?.payload?.method ?? error?.info?.payload?.method))
    return '链上只读核验未通过。原交易记录已保留，请核对进度；不会重复发送。';
  return null;
}

/** Display stored history only. This result is never a verification or a send
 * gate; even a supplied fresh proof cannot turn it into a current-state claim.
 */
export function confirmedScheduleStatus(row, _freshProof) {
  const schedule = row?.transactions?.schedule;
  if (schedule?.status !== 'confirmed') return '';
  if (!Number.isSafeInteger(schedule.verifiedReadyAt) || schedule.verifiedReadyAt <= 1
    || !Number.isSafeInteger(schedule.blockNumber) || schedule.blockNumber < 1
    || !Number.isSafeInteger(schedule.verifiedBlockNumber) || schedule.verifiedBlockNumber < schedule.blockNumber
    || !hash.test(schedule.verifiedBlockHash ?? '')) return preserved;
  const date = new Date(schedule.verifiedReadyAt * 1000);
  if (!Number.isFinite(date.getTime())) return preserved;
  const time = date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return `历史核验记录：最早启用时间 ${time}（北京时间，核验区块 #${schedule.verifiedBlockNumber}）。当前链状态暂未读取完成，请核对进度；无需重复部署。`;
}
