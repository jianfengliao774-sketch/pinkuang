import { getAddress } from 'ethers';
import { displayAmount } from './amount-display.mjs';
import { freshUserExitReady } from './fresh-user-exits.mjs';
import { freshWalletActionReady } from './fresh-wallet-actions.mjs';

export const POOL_STATES = ['Funding', 'Funded', 'Active', 'Listed', 'Closed', 'Refunding'];
export const shortAddress = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';
/** Formatting never feeds back into transaction amounts. */
export const amount = displayAmount;
/** Open a preview from the loaded page; the contract applies its own rules. */
export function currentActionSourceReady({ client, config, source, action, targetType='pool' }) {
  if (config?.displayOnly === true) return !!client && config.status === 'ready'
    && config.walletSessionReady !== false && !!source;
  if (client && freshWalletActionReady(config, targetType, action)) return true;
  const v4Ready = config?.productFamily !== 'fresh-v4'
    || config.operationalReady === true && config.stale !== true && config.transactionReady !== false
    || freshUserExitReady(config,targetType,action);
  return !!client && !!config && !!source && source.stale !== true
    && source.readMode !== 'verified_snapshot' && v4Ready;
}
/** Historical detail values may be displayed, but cannot enable any action preview. */
export function currentDetailActionReady({ cachedPage, loading, busy,
  loadedRoute, routePool, detailPool, loadedAccount, account, ...context }) {
  const directWallet = freshWalletActionReady(context.config, context.targetType ?? 'pool', context.action);
  const currentIdentity = typeof routePool === 'string' && typeof detailPool === 'string'
    && loadedRoute === `detail/${routePool}` && routePool.toLowerCase() === detailPool.toLowerCase()
    && (directWallet || (loadedAccount?.toLowerCase() || '') === (account?.toLowerCase() || ''));
  return currentActionSourceReady(context) && currentIdentity && !busy
    && (directWallet || (context.config?.displayOnly === true || !cachedPage) && !loading);
}
export function currentPositionsActionReady({ positionsAccount, account, wallet, positionsLoaded,
  loading, error, ...context }) {
  return currentActionSourceReady(context) && !!wallet && !!account && !!positionsLoaded
    && positionsAccount?.toLowerCase() === account.toLowerCase() && !loading && !error;
}
export function currentMarketOrderActionReady({ route, marketTab, readIdentity, account, wallet,
  loading, error, order, ...context }) {
  const owner = account?.toLowerCase() || '';
  return currentActionSourceReady(context) && route === 'market' && !!wallet && !!account
    && (marketTab === 'shares' || marketTab === 'mine')
    && readIdentity === `${marketTab}:${owner}` && !loading && !error
    && order?.active === true && order.requiresLatestSimulation === true
    && order.executable === false;
}
/** Subscription also needs current pool eligibility; action preparation rechecks the chain. */
export function canOpenFundingAction({ detail, ...context }) {
  return currentDetailActionReady({ ...context, action: 'deposit' })
    && (context.config?.displayOnly === true || detail?.trusted === true) && detail.depositPaused === false
    && typeof detail.remaining === 'number' && Number.isFinite(detail.remaining)
    && detail.remaining > 0;
}
export function sumKnown(rows, field) {
  if (rows.some(row => row[field] === null || row[field] === undefined)) return null;
  return rows.reduce((total, row) => total + BigInt(row[field]), 0n);
}
export function viewPool(row) {
  if (!row) return null;
  const token = row.params?.circuitId ?? row.tokenId;
  const collection = row.params?.circuits ?? row.collection;
  const name = collection?.toLowerCase() === '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c' ? 'Behemoth' : collection ? 'TapeOut' : '—';
  return { ...row, id: row.pool, poolAddress: row.pool, tokenId: token?.toString() ?? '—', name,
    status: row.state == null ? 'Unknown' : POOL_STATES[Number(row.state)] ?? 'Unknown',
    funded: row.totalSupply == null ? null : Number(row.totalSupply),
    remaining: row.totalSupply == null ? null : Math.max(0, 100 - Number(row.totalSupply)),
    color: name === 'Behemoth' ? 'violet' : 'blue', daily: null,
    members: row.memberCount == null ? null : Number(row.memberCount) };
}
export function parseProductRoute(hash) {
  const [route, input] = (hash.replace(/^#/, '') || 'home').split('/');
  if (route === 'detail' || route === 'portfolio') {
    try { return { route, pool: getAddress(input) }; } catch { return { route, pool: null, invalid: true }; }
  }
  return { route: ['home', 'overview', 'pools', 'market', 'rewards', 'governance', 'records', 'operator', 'notifications'].includes(route) ? route : 'home', pool: null };
}
export const explorerAddress = address => `https://bscscan.com/address/${getAddress(address)}`;
export const explorerTransaction = hash => /^0x[\da-f]{64}$/i.test(hash ?? '') ? `https://bscscan.com/tx/${hash}` : null;
export function exportActivityCsv(rows) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [['Block', 'Event', 'Contract', 'Transaction', 'Fields'], ...rows.map(row => [row.blockNumber, row.event ?? row.name, row.contract ?? row.address, row.transactionHash ?? row.txHash, JSON.stringify(row.args ?? row.fields ?? {}, (_, v) => typeof v === 'bigint' ? v.toString() : v)])].map(row => row.map(cell).join(',')).join('\r\n');
}
