import { Interface, ZeroAddress, getAddress } from 'ethers';
import { abi } from './chain-client.mjs';

// This is business eligibility only. It never authorizes an administrator,
// changes the verified product graph, or changes a pool's contract state.
export const targetOwnerViews = new Interface([
  'function targetOwnerVersion() pure returns(uint8)',
  'function targetOwner() view returns(address originalOwner,bool configured,uint256 nonce)',
]);
export const targetOwnerGuardEnabled = config => config?.targetOwnerGuardVersion === 1
  || config?.targetOwnerUpgrade?.version === 1;
const pendingState = row => row?.kind !== 'portfolio' && [0n, 1n, 0, 1, '0', '1'].includes(row?.state);
export const targetOwnerFundingText = status => status === 'not_configured'
  ? ['历史矿机归属需管理员确认，暂不能继续募集', 'An administrator must confirm the historical miner owner before subscriptions can continue']
  : ['矿机归属暂无法读取，请稍后刷新；暂不能继续募集或购机', 'Miner ownership is temporarily unavailable. Refresh shortly; subscriptions and procurement are paused'];
const unknown = pool => Object.freeze({ pool, status: 'unknown', checkedAt: Date.now() });

function deadline(read, timeoutMs) {
  let timer;
  return Promise.race([read, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Ownership read timed out.')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

/** Four small getters run together, with one bounded deadline and no retries. */
export async function readTargetOwnerFundingStatus({ provider, pool, blockTag = 'latest', timeoutMs = 4000 }) {
  const target = getAddress(pool);
  const call = async (contract, method) => contract.decodeFunctionResult(method,
    await provider.request({ method: 'eth_call', params: [{ to: target,
      data: contract.encodeFunctionData(method) }, blockTag] }));
  try {
    const [state, flexible, version, owner] = await deadline(Promise.all([
      call(abi.PoolVault, 'state'), call(abi.PoolVault, 'flexiblePurchase'),
      call(targetOwnerViews, 'targetOwnerVersion'), call(targetOwnerViews, 'targetOwner'),
    ]), Math.min(8000, Math.max(1, timeoutMs)));
    const chainState = state[0], enabled = flexible[0];
    if (version[0] !== 1n || chainState < 0n || chainState > 5n || typeof enabled !== 'boolean') return unknown(target);
    const originalOwner = getAddress(owner[0]), configured = owner[1], nonce = owner[2];
    if (typeof configured !== 'boolean' || typeof nonce !== 'bigint'
      || configured && (originalOwner === ZeroAddress || originalOwner === target)) return unknown(target);
    return Object.freeze({ pool: target, status: ![0n, 1n].includes(chainState) || enabled
      ? 'not_applicable' : configured ? 'configured' : 'not_configured',
    purchaseMode: enabled ? 'flexible' : 'fixed', chainState: chainState.toString(),
    originalOwner, configured, nonce, version: 1, checkedAt: Date.now() });
  } catch { return unknown(target); }
}

/** Missing/stale status never permits a Funding action; exit actions do not use this guard. */
export function targetOwnerFundingBlocked(row, config, now = Date.now()) {
  if (!targetOwnerGuardEnabled(config) || !pendingState(row)) return false;
  const read = row.targetOwnerFunding;
  return !read || read.pool?.toLowerCase() !== row.pool?.toLowerCase()
    || !Number.isFinite(read.checkedAt) || read.checkedAt > now || now - read.checkedAt > 60_000
    || !['configured', 'not_applicable'].includes(read.status)
    || read.chainState !== String(row.state);
}

/** One page shares a four-second budget; at most four pools are read at a time. */
export async function attachTargetOwnerFundingStatus(result, { provider, config, timeoutMs = 4000 } = {}) {
  if (!targetOwnerGuardEnabled(config)) return result;
  const rows = result.items ?? (result.item ? [result.item] : []), enriched = [...rows];
  const expires = Date.now() + Math.min(8000, Math.max(1, timeoutMs));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next++, row = rows[index];
      if (!pendingState(row)) continue;
      const status = Date.now() >= expires ? unknown(row.pool)
        : await readTargetOwnerFundingStatus({ provider, pool: row.pool, timeoutMs: expires - Date.now() });
      enriched[index] = Object.freeze({ ...row, targetOwnerFunding: status });
    }
  }));
  return Object.freeze({ ...result, ...(result.items ? { items: enriched } : { item: enriched[0] }) });
}

export async function assertTargetOwnerConfigured({ provider, config, pool, blockTag = 'latest' }) {
  if (!targetOwnerGuardEnabled(config)) return null;
  const read = await readTargetOwnerFundingStatus({ provider, pool, blockTag });
  if (!['configured', 'not_applicable'].includes(read.status)) {
    throw Object.assign(new Error(targetOwnerFundingText(read.status)[0]),
      { code: read.status === 'not_configured' ? 'targetOwnerNotConfigured' : 'targetOwnerUnknown', beforeWalletSubmission: true });
  }
  return read;
}
