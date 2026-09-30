const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call']);
export const READ_PREVIEW_TIMEOUT_MS = 20000;
const problem = (code, message) => Object.assign(new Error(message), { code });

/** A deadline for discardable reads only. Never wrap wallet authorization, signing or broadcasting. */
export async function boundedReadPreview(task, { provider, isCurrent = () => true, signal,
  timeoutMs = READ_PREVIEW_TIMEOUT_MS, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  if (!provider?.request) throw new Error('只读服务尚未就绪，请刷新后重试。');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid read deadline');
  const controller = new AbortController();
  let active = true, timer, rejectStop;
  const cancelled = () => problem('read_cancelled', '已取消核对，请重新预览。');
  const check = () => { if (!active || signal?.aborted || !isCurrent()) throw cancelled(); };
  const stop = error => { if (active) { active = false; controller.abort(); rejectStop(error); } };
  const abort = () => stop(cancelled());
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  const reader = Object.freeze({ async request(input) {
    check();
    if (!READ_METHODS.has(input?.method)) throw problem('read_method_forbidden', '只读核对不能请求钱包授权或发送交易。');
    const result = await provider.request(input);
    check(); // A late transport result must not continue the preview or initiate its next RPC.
    return result;
  } });
  signal?.addEventListener('abort', abort, { once: true });
  timer = schedule(() => stop(problem('read_timeout', '链上核对暂未完成，请稍后重新预览。尚未请求钱包签名。')), timeoutMs);
  if (signal?.aborted) abort();
  const work = Promise.resolve().then(() => { check(); return task({ provider: reader, check, signal: controller.signal }); })
    .then(result => { check(); return result; });
  try { return await Promise.race([work, stopped]); }
  finally { active = false; unschedule(timer); controller.abort(); signal?.removeEventListener('abort', abort); }
}
