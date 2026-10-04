import { getAddress, ZeroAddress } from 'ethers';
import { displayAmount } from './amount-display.mjs';
import { freshUserExitReady } from './fresh-user-exits.mjs';
import { freshWalletActionReady } from './fresh-wallet-actions.mjs';

export const POOL_STATES = ['Funding', 'Funded', 'Active', 'Listed', 'Closed', 'Refunding'];
export const shortAddress = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';
/** Formatting never feeds back into transaction amounts. */
export const amount = displayAmount;
const sameAddress = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const validAddress = value => {
  try { const result = getAddress(value); return result === ZeroAddress ? null : result; }
  catch { return null; }
};
const validBlockHash = value => /^0x[\da-f]{64}$/i.test(value ?? '');
const stateNumber = value => typeof value === 'bigint' && value >= 0n && value <= 5n ? Number(value)
  : typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5 ? value : null;

const freshTargetListingEvidence = (proof, now) => {
  const evidence = proof?.listingEvidence, observed = Date.parse(evidence?.observedAt ?? '');
  const validUntil = Date.parse(evidence?.validUntil ?? '');
  return typeof evidence?.observedAt === 'string' && Number.isFinite(observed)
    && new Date(observed).toISOString() === evidence.observedAt
    && typeof evidence?.validUntil === 'string' && Number.isFinite(validUntil)
    && new Date(validUntil).toISOString() === evidence.validUntil
    && Number.isFinite(now) && observed <= now && now - observed <= 120_000 && now < validUntil;
};
/** A missing order is proven only by two successful, recent source checks. */
export function confirmedMissingTargetListing(proof, now = Date.now()) {
  return proof?.listingEvidence?.official === 'absent' && proof?.listingEvidence?.firsto === 'absent'
    && freshTargetListingEvidence(proof, now);
}
/** A current sell order on either venue suffices, even if the other venue is unknown. */
export function confirmedAvailableTargetListing(proof, now = Date.now()) {
  return ['available', 'absent', 'unknown'].includes(proof?.listingEvidence?.official)
    && ['available', 'absent', 'unknown'].includes(proof?.listingEvidence?.firsto)
    && (proof.listingEvidence.official === 'available' || proof.listingEvidence.firsto === 'available')
    && freshTargetListingEvidence(proof, now);
}

/** Used only after the target proof has established that the project is unavailable. */
export const fundingTargetUnavailableText = row => row?.targetAvailability?.reason === 'target_listing_unavailable'
  && sameAddress(row.targetAvailability.currentOwner, row.targetAvailability.originalOwner)
  ? ['目标矿机当前无有效卖单，本项目已下架', 'The target miner has no valid sell order; this project was delisted']
  : ['目标矿机已转移给其他持有人，本项目已下架', 'The target miner was transferred to another holder; this project was delisted'];

/** Display decision from the same-origin owner and listing proof; it never changes contract state. */
export function fundingTargetStatus(row) {
  const expectedState = row?.status === 'Funding' ? 0 : row?.status === 'Funded' ? 1 : null;
  if (expectedState === null || row?.kind === 'portfolio') return 'not_applicable';
  const proof = row?.targetAvailability;
  if (!proof || stateNumber(row.state) !== expectedState || stateNumber(proof.chainState) !== expectedState
    || !Number.isSafeInteger(proof.creationBlock) || proof.creationBlock < 0
    || !Number.isSafeInteger(proof.observedBlock) || proof.observedBlock < proof.creationBlock
    || !validBlockHash(proof.creationBlockHash) || !validBlockHash(proof.observedBlockHash))
    return 'unknown';
  if (proof?.purchaseMode === 'flexible')
    return proof.status === 'not_applicable' ? 'not_applicable' : 'unknown';
  if (proof?.purchaseMode !== 'fixed' || !['available', 'unavailable'].includes(proof.status))
    return 'unknown';
  const pool = validAddress(row.pool), original = validAddress(proof.originalOwner);
  const current = validAddress(proof.currentOwner);
  if (!pool || !original || !current || sameAddress(current, pool))
    return 'unknown';
  if (proof.status === 'available' && sameAddress(current, original))
    return proof.reason === 'target_listing_available' && !confirmedAvailableTargetListing(proof) ? 'unknown' : 'available';
  if (proof.status === 'unavailable' && !sameAddress(current, original)) return 'unavailable';
  if (proof.status === 'unavailable' && proof.reason === 'target_listing_unavailable'
    && sameAddress(current, original) && confirmedMissingTargetListing(proof)) return 'unavailable';
  return 'unknown';
}
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
    && (!context.config?.indexBaseUrl || ['available', 'not_applicable'].includes(fundingTargetStatus(detail)))
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
