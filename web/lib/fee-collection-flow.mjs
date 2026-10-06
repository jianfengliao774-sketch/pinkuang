import { getAddress } from 'ethers';

const HASH = /^0x[0-9a-f]{64}$/i;
const stopped = () => new Error('归集已停止；已提交的交易请先核对状态。');

export function feeCollectionDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(stopped()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** One entry point, separate exact signatures. Never resend an unresolved batch. */
export async function collectFeeBatches({ plan, recipient, onAction, readStatus, onStatus = () => {},
  onProgress = () => {}, current = () => true, signal, wait = feeCollectionDelay, now = Date.now }) {
  const owner = getAddress(recipient), completed = [];
  const ensureCurrent = () => { if (signal?.aborted || !current()) throw stopped(); };
  let lastStarted = null;
  for (let index = 0; index < plan.batches.length; index++) {
    ensureCurrent();
    // Stay within both relay limits even when every receipt arrives immediately.
    if (lastStarted !== null) await wait(Math.max(0, 15_000 - (now() - lastStarted)), signal);
    ensureCurrent();
    const batch = plan.batches[index];
    if (!Array.isArray(batch.markets) || !Array.isArray(batch.pools)
      || batch.markets.length + batch.pools.length > 24) throw new Error('手续费来源分批无效。');
    onProgress({ completed: [...completed], index, total: plan.batches.length, phase: 'signing' });
    lastStarted = now();
    let result = await onAction('claimFees', { markets: batch.markets.map(getAddress),
      pools: batch.pools.map(getAddress), recipient: owner });
    ensureCurrent();
    if (!HASH.test(result?.hash ?? '') || result.kind !== 'claimFees')
      throw new Error('归集提交结果尚不明确；请核对代付交易状态后再继续。');
    const expectedHash = result.hash.toLowerCase(), started = now();
    onStatus(result);
    onProgress({ completed: [...completed], index, total: plan.batches.length, phase: 'confirming', hash: result.hash });
    while (result.status !== 'confirmed') {
      if (result.status === 'failed') throw new Error(`第 ${index + 1} 批归集失败；已完成 ${completed.length} 批。`);
      if (now() - started >= 120_000)
        throw new Error('归集交易仍待确认；请刷新状态核对，后续批次已暂停。');
      await wait(5_000, signal); ensureCurrent();
      result = await readStatus(); ensureCurrent(); onStatus(result);
      if (result.kind !== 'claimFees' || result.hash?.toLowerCase() !== expectedHash)
        throw new Error('代付状态已变化；请核对已提交的归集交易，后续批次已暂停。');
    }
    completed.push(result.hash);
    onProgress({ completed: [...completed], index, total: plan.batches.length, phase: 'confirmed', hash: result.hash });
  }
  return completed;
}
