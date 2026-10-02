import { SALE_COOLDOWN_SECONDS } from './sale-timings.mjs';
import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { abi, CHAIN_ID, uint } from './chain-client.mjs';
import { readControlledFirstoSale } from './firsto-sale.mjs';
import { readSaleReference, readSaleReview, saleExecutionGate, saleReferenceState,
  DEFAULT_SALE_REVIEW_THRESHOLD_BPS, readSaleReviewThreshold, requiresSaleReview } from './sale-governance-gate.mjs';
import { FIRSTO_SIGNED_EXCHANGE } from '../../deploy/src/firsto-purchase.mjs';
import { settleReadRound } from './read-retry.mjs';
import { fetchLiveJson } from './live-config.mjs';

const DAY = 86400n;
const SALE_COOLDOWN = SALE_COOLDOWN_SECONDS;
const MAX_CANDIDATES = 100n;
const directViews = new Interface([
  'function saleReference(address pool) view returns(uint128 marketPriceWei,uint64 observedAt,bytes32 sourceDigest)',
  'function saleReview(address pool,uint256 proposalId) view returns(uint8 status,uint128 priceWei)',
  'function paused() view returns(bool)', 'function defaultTakerFeeBps() view returns(uint16)',
  'function feeEpoch() view returns(uint256)',
]);
export const nativeGovernanceViews = new Interface([
  'function nativeFirstoSaleVersion() view returns(uint8)',
  'function nativeFirstoAsk() view returns(tuple(address maker,address collection,uint256 tokenId,uint256 nonce,uint128 price,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion) ask,bytes32 orderHash,bool active)',
  'function delist(uint8 action,uint256 cancellationId,uint256 expectedListedProposalId,bool support) returns(uint256 id)',
  'function delistingProposal(uint256 id) view returns(uint256 cancellationId,address proposer,uint256 listedProposalId,uint48 snapshotTs,uint64 expiresAt,uint256 snapshotMemberCount,uint256 yesCount,uint256 yesShares,uint256 noCount,uint256 noShares,bool executed,bool voted)',
]);
const directSnapshots = new WeakMap();
const same = (left, right) => getAddress(left) === getAddress(right);
const sameHash = (left, right) => typeof left === 'string' && typeof right === 'string'
  && /^0x[\da-f]{64}$/i.test(left) && left.toLowerCase() === right.toLowerCase();
const requireGovernance = (condition, message) => { if (!condition) throw new Error(message); };
const nonzero = value => {
  const address = getAddress(value);
  requireGovernance(address !== ZeroAddress, 'A zero address cannot identify a pool or wallet.');
  return address;
};

/** One fixed public GET; publication observations cannot change ownership or voting data. */
export async function fetchNativeFirstoPublication(config, poolInput, expectedAskHash,
  { signal, fetcher = globalThis.fetch, now = Date.now } = {}) {
  const pool = nonzero(poolInput), base = new URL(config.indexBaseUrl);
  requireGovernance(base.origin === config.origin && !base.search && !base.hash
    && !base.username && !base.password && /^0x[\da-f]{64}$/i.test(expectedAskHash),
  'Firsto 发布状态来源与当前网站不一致。');
  const reply = await fetchLiveJson(`${base.href.replace(/\/$/, '')}/v1/display/firsto-ask/${pool}`,
    { maxBytes: 16_384, timeoutMs: 10_000,
      fetcher: (url, options) => fetcher(url, { ...options,
        signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal }) });
  const profile = config.testProfile === true ? 'full-test' : 'formal';
  requireGovernance(reply?.schemaVersion === 1 && reply.chainId === 56
    && same(reply.factory, config.factory ?? config.manifest?.factory)
    && same(reply.exchange, FIRSTO_SIGNED_EXCHANGE) && typeof reply.enabled === 'boolean'
    && typeof reply.stale === 'boolean' && same(reply.item?.pool, pool)
    && (reply.profile == null || reply.profile === profile), 'Firsto 发布状态与当前矿池不一致。');
  const statuses = ['upgrade-required', 'inactive', 'expired', 'buyer-pending', 'publishing', 'publication-accepted',
    'published', 'pending-approval', 'publication-unknown', 'publication-rejected', 'order-conflict',
    'authorization-changed', 'external-awaiting-chain', 'read-unavailable', 'source-unavailable'];
  requireGovernance(statuses.includes(reply.item.status), 'Firsto 发布状态无效。');
  if (reply.item.askHash != null) requireGovernance(sameHash(reply.item.askHash, expectedAskHash), 'Firsto 发布状态属于另一张卖单。');
  if (reply.item.status === 'published') requireGovernance(reply.item.verifiedInOfficialBook === true
    && sameHash(reply.item.askHash, expectedAskHash), 'Firsto 尚未在公开订单中确认本卖单。');
  if (reply.item.priceWei != null) uint(reply.item.priceWei);
  const observed = reply.updatedAt == null ? null : Date.parse(reply.updatedAt);
  requireGovernance(observed === null || Number.isSafeInteger(observed) && observed <= now() + 30_000,
    'Firsto 发布状态时间无效。');
  return Object.freeze({ ...reply, profile,
    stale: reply.stale || observed === null || now() - observed > 90_000 });
}

/** Cache business data by provider, pool and wallet; manual or pushed updates invalidate it. */
export async function readGovernanceSnapshot(provider, options) {
  const { displayOnly = false, cacheMs = 0, refreshToken = 0, force = false, now = Date.now } = options;
  if (!displayOnly || cacheMs <= 0) return readGovernanceSnapshotUncached(provider, options);
  requireGovernance(typeof provider?.request === 'function', 'An EIP-1193 provider is required.');
  const key = [options.factory, options.pool, options.account || ZeroAddress, options.shareMarket || '', options.stage]
    .map(value => String(value).toLowerCase()).join(':');
  let cache = directSnapshots.get(provider);
  if (!cache) { cache = new Map(); directSnapshots.set(provider, cache); }
  const old = cache.get(key), current = now();
  if (!force && old?.refreshToken === refreshToken && current - old.createdAt < cacheMs) return old.promise;
  const entry = { createdAt: current, refreshToken, promise: null };
  entry.promise = readGovernanceSnapshotUncached(provider, options).catch(error => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.set(key, entry);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/** Direct display reads only business getters; strict legacy mode retains its block proof. */
async function readGovernanceSnapshotUncached(provider, { factory: configuredFactory, pool: configuredPool,
  account = ZeroAddress, blockNumber, stage, displayOnly = false, shareMarket: configuredMarket, now = Date.now }) {
  requireGovernance(typeof provider?.request === 'function', 'An EIP-1193 provider is required.');
  requireGovernance(['genesis','fresh-active','code-upgraded','role-migrating','role-wired'].includes(stage),
    'Product stage is required for sale governance.');
  const factory = nonzero(configuredFactory), pool = nonzero(configuredPool), owner = getAddress(account);
  const request = (method, params = []) => provider.request({ method, params });
  let block = null, number = null, timestamp = BigInt(Math.floor(now() / 1000)), tag = 'latest';
  if (!displayOnly) {
    requireGovernance(BigInt(await request('eth_chainId')) === CHAIN_ID, 'Switch to BSC mainnet (56).');
    block = await request('eth_getBlockByNumber', [blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber)), false]);
    requireGovernance(block?.number && block?.hash && block?.timestamp, 'Governance block is unavailable.');
    number = BigInt(block.number); timestamp = BigInt(block.timestamp); tag = toQuantity(number);
    requireGovernance(blockNumber === undefined || number === uint(blockNumber), 'RPC returned another governance block.');
  }
  async function result(to, contract, method, args = [], from) {
    const data = contract.encodeFunctionData(method, args);
    return contract.decodeFunctionResult(method, await request('eth_call', [{ to, data, ...(from ? { from } : {}) }, tag]));
  }
  async function call(to, contract, method, args = []) {
    return (await result(to, contract, method, args))[0];
  }
  const [factoryCode, poolCode, registered, poolFactory, officialFactory, shareMarket, state, purchaseCost,
    activatedAt, activeProposalId, nextProposalId, lastProposed, shares, listedProposalId, expiresAt, salePrice,
    saleReviewThresholdBps] = await Promise.all([
    displayOnly ? null : request('eth_getCode', [factory, tag]), displayOnly ? null : request('eth_getCode', [pool, tag]),
    displayOnly ? null : call(factory, abi.PoolFactory, 'isPool', [pool]), displayOnly ? null : call(pool, abi.PoolVault, 'factory'),
    displayOnly ? null : call(pool, abi.PoolVault, 'OFFICIAL_FACTORY'),
    displayOnly && configuredMarket ? configuredMarket : call(factory, abi.PoolFactory, 'shareMarket'),
    call(pool, abi.PoolVault, 'state'),
    call(pool, abi.PoolVault, 'purchaseCost'), call(pool, abi.PoolVault, 'activatedAt'),
    call(pool, abi.PoolVault, 'activeProposalId'), call(pool, abi.PoolVault, 'nextProposalId'),
    call(pool, abi.PoolVault, 'lastProposed', [owner]), call(pool, abi.PoolVault, 'balanceOf', [owner]),
    call(pool, abi.PoolVault, 'listedProposalId'), call(pool, abi.PoolVault, 'expiresAt'),
    call(pool, abi.PoolVault, 'salePrice'),
    stage === 'genesis' ? DEFAULT_SALE_REVIEW_THRESHOLD_BPS : readSaleReviewThreshold(result, pool),
  ]);
  if (!displayOnly) requireGovernance(factoryCode && factoryCode !== '0x' && poolCode && poolCode !== '0x'
    && registered === true && same(poolFactory, factory) && same(officialFactory, factory),
    'Pool is not registered by the reviewed Factory.');
  const market = nonzero(shareMarket);
  if (!displayOnly) {
    const [marketCode, marketFactory] = await Promise.all([
      request('eth_getCode', [market, tag]), call(market, abi.ShareMarket, 'factory'),
    ]);
    requireGovernance(marketCode && marketCode !== '0x' && same(marketFactory, factory),
      'Firsto reference market is not bound to the reviewed Factory.');
  }
  requireGovernance(state <= 5n && shares <= 100n && nextProposalId >= 1n
    && (activeProposalId === 0n || (activeProposalId < nextProposalId)), 'Governance state is inconsistent.');
  requireGovernance(nextProposalId - (activeProposalId || nextProposalId) <= MAX_CANDIDATES,
    'Too many round candidates; use the contract directly after review.');

  let opener = null;
  if (activeProposalId > 0n) opener = await call(pool, abi.PoolVault, 'getProposal', [activeProposalId]);
  let saleReference = null;
  if (stage !== 'genesis') {
    try { saleReference = displayOnly
      ? saleReferenceState(await result(market, directViews, 'saleReference', [pool]), timestamp)
      : await readSaleReference(request, market, pool, number, timestamp); }
    catch (error) { saleReference = Object.freeze({ available: false,
      reason: error?.shortMessage || error?.message || 'Firsto 市场参考价暂不可读取。' }); }
  }
  const candidates = [];
  async function readCandidate(id) {
    const proposal = id === activeProposalId ? opener : await call(pool, abi.PoolVault, 'getProposal', [id]);
    const inRound = proposal.snapshotTs + DAY === proposal.endsAt && opener.snapshotTs + DAY === opener.endsAt
      && proposal.snapshotTs === opener.snapshotTs && proposal.endsAt === opener.endsAt
      && proposal.snapshotMemberCount === opener.snapshotMemberCount && proposal.snapshotTotalShares === 100n;
    if (!inRound) return null;
    const votes = displayOnly
      ? await settleReadRound({ passed: () => call(pool, abi.PoolVault, 'proposalPassed', [id]),
        hasVoted: () => call(pool, abi.PoolVault, 'hasVoted', [id, owner]) })
      : await Promise.all([call(pool, abi.PoolVault, 'proposalPassed', [id]), call(pool, abi.PoolVault, 'hasVoted', [id, owner])])
        .then(([passed, hasVoted]) => ({ passed, hasVoted }));
    const { passed, hasVoted } = votes;
    const purchaseDiscount = stage === 'genesis' && proposal.price < purchaseCost;
    const requiredYesShares = purchaseDiscount ? 60n : proposal.snapshotTotalShares / 2n + 1n;
    const requiredYesCount = proposal.snapshotMemberCount / 2n + 1n;
    requireGovernance(proposal.price > 0n && proposal.snapshotMemberCount >= 1n
      && proposal.snapshotMemberCount <= 100n && proposal.yesCount <= proposal.snapshotMemberCount
      && proposal.yesShares <= 100n && passed === (
        proposal.yesShares >= requiredYesShares && proposal.yesCount >= requiredYesCount
      ), 'Sale proposal vote state is inconsistent.');
    let saleReview = null;
    if (saleReference?.available && requiresSaleReview(proposal.price, saleReference.priceWei, saleReviewThresholdBps)) {
      try {
        if (displayOnly) {
          const [status, priceWei] = await result(market, directViews, 'saleReview', [pool, id]);
          requireGovernance(status <= 2n, 'Firsto 出售审核状态无效。');
          saleReview = Object.freeze({ status, priceWei });
        } else saleReview = await readSaleReview(request, market, pool, id, number);
      }
      catch { /* A failed review read must never enable execution. */ }
    }
    const gate = stage === 'genesis'
      ? { discounted: purchaseDiscount, reviewRequired: false, reviewApproved: null,
        canExecute: passed && state === 2n && !proposal.executed && timestamp < proposal.endsAt }
      : saleExecutionGate({ proposal, passed, state, timestamp, reference: saleReference, review: saleReview,
        saleReviewThresholdBps });
    return Object.freeze({ id, proposer: getAddress(proposal.proposer), snapshotTs: proposal.snapshotTs,
      endsAt: proposal.endsAt, priceWei: proposal.price, refPriceWei: proposal.refPrice,
      refAt: proposal.refAt, snapshotMemberCount: proposal.snapshotMemberCount,
      yesCount: proposal.yesCount, yesShares: proposal.yesShares, requiredYesCount, requiredYesShares,
      ...gate, saleReview, passed, hasVoted, executed: proposal.executed });
  }
  const ids = [];
  for (let id = activeProposalId; id > 0n && id < nextProposalId; id += 1n) ids.push(id);
  if (displayOnly) {
    const rows = new Array(ids.length); let next = 0, failed = false, failure;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (!failed && next < ids.length) {
        const index = next++;
        try { rows[index] = await readCandidate(ids[index]); }
        catch (error) { if (!failed) { failed = true; failure = error; } }
      }
    }));
    if (failed) throw failure;
    candidates.push(...rows.filter(Boolean));
  } else {
    for (const id of ids) { const candidate = await readCandidate(id); if (candidate) candidates.push(candidate); }
  }
  let snapshotShares = 0n;
  if (owner !== ZeroAddress && candidates.length) {
    snapshotShares = opener.snapshotTs === timestamp ? shares
      : await call(pool, abi.PoolVault, 'getPastShares', [owner, opener.snapshotTs]);
    requireGovernance(snapshotShares <= 100n, 'Invalid snapshot share balance.');
  }
  let firstoSale = null, nativeFirstoSale = null, delisting = null;
  if (state === 3n) {
    try {
      if (displayOnly) {
        const [paused, feeBps, feeEpoch] = await Promise.all([
          call(FIRSTO_SIGNED_EXCHANGE, directViews, 'paused'),
          call(FIRSTO_SIGNED_EXCHANGE, directViews, 'defaultTakerFeeBps'),
          call(FIRSTO_SIGNED_EXCHANGE, directViews, 'feeEpoch'),
        ]);
        requireGovernance(!paused && feeBps <= 10000n, 'Firsto 已暂停或手续费不可用。');
        firstoSale = Object.freeze({ available: true, exchange: FIRSTO_SIGNED_EXCHANGE, feeBps, feeEpoch });
      } else firstoSale = await readControlledFirstoSale(provider, pool, tag);
    }
    catch (error) { firstoSale = Object.freeze({ available: false, reason: error?.shortMessage || error?.message || 'Firsto 成交状态暂不可用。' }); }
    try {
      const version = await call(pool, nativeGovernanceViews, 'nativeFirstoSaleVersion');
      nativeFirstoSale = Object.freeze({ available: true, version, enabled: version === 1n, active: false });
      if (version === 1n) {
        const [nativeResult, delistingResult] = await Promise.allSettled([
          result(pool, nativeGovernanceViews, 'nativeFirstoAsk'),
          result(pool, nativeGovernanceViews, 'delistingProposal', [0n], owner),
        ]);
        if (nativeResult.status === 'fulfilled') {
          const [ask, orderHash, active] = nativeResult.value;
          requireGovernance(typeof active === 'boolean', '原生挂牌状态不可用。');
          if (active) requireGovernance(same(ask.maker, pool) && same(ask.payoutRecipient, pool)
            && ask.nonce === listedProposalId && ask.price === salePrice && ask.expiry === expiresAt
            && /^0x[\da-f]{64}$/i.test(orderHash), '原生挂牌条款与当前挂牌不一致。');
          nativeFirstoSale = Object.freeze({ ...nativeFirstoSale, active, orderHash: active ? orderHash : null });
        } else nativeFirstoSale = Object.freeze({ ...nativeFirstoSale, active: null,
          reason: '原生挂牌授权暂不可读取，请刷新。' });
        if (delistingResult.status === 'fulfilled') {
          const p = delistingResult.value;
          const [cancellationId, proposer, boundProposalId, snapshotTs, cancellationExpiresAt, snapshotMemberCount,
            yesCount, yesShares, noCount, noShares, executed, voted] = p;
          const empty = cancellationId === 0n;
          if (!empty) requireGovernance(boundProposalId === listedProposalId && cancellationExpiresAt === expiresAt
            && snapshotTs <= timestamp && snapshotMemberCount >= 1n && snapshotMemberCount <= 100n
            && yesCount + noCount <= snapshotMemberCount && yesShares + noShares <= 100n
            && getAddress(proposer) !== ZeroAddress, '下架投票状态与当前挂牌不一致。');
          const delistingShares = empty || owner === ZeroAddress ? 0n : snapshotTs === timestamp ? shares
            : await call(pool, abi.PoolVault, 'getPastShares', [owner, snapshotTs]);
          requireGovernance(delistingShares <= 100n, '下架投票快照份额无效。');
          const passed = !empty && yesCount * 2n > snapshotMemberCount && yesShares > 50n;
          const expired = timestamp >= expiresAt;
          delisting = Object.freeze({ available: true, id: cancellationId, proposer: getAddress(proposer),
            listedProposalId: boundProposalId, snapshotTs, expiresAt: cancellationExpiresAt,
            snapshotMemberCount, yesCount, yesShares, noCount, noShares, executed, hasVoted: voted,
            snapshotShares: delistingShares, requiredYesCount: snapshotMemberCount / 2n + 1n,
            requiredYesShares: 51n, passed, expired, canPropose: !expired && shares > 0n && empty,
            canVote: !empty && !expired && !executed && !voted && delistingShares > 0n,
            canExecute: !empty && !expired && !executed && passed });
        } else delisting = Object.freeze({ available: false, reason: '下架投票暂不可读取，请刷新。' });
      }
    } catch (error) {
      nativeFirstoSale = Object.freeze({ available: false, enabled: false, active: false,
        reason: error?.shortMessage || error?.message || '原生挂牌能力暂不可读取。' });
      delisting = Object.freeze({ available: false, reason: '完成原生出售合约升级后可提前投票下架。' });
    }
  }
  if (!displayOnly) {
    const again = await request('eth_getBlockByNumber', [tag, false]);
    requireGovernance(again?.hash === block.hash && BigInt(await request('eth_chainId')) === CHAIN_ID,
      'Chain changed during governance read; refresh.');
  }
  return Object.freeze({ chainId: CHAIN_ID, stage, factory, shareMarket: market, pool, account: owner, blockNumber: number,
    blockHash: block?.hash ?? null, displayOnly, timestampOrigin: displayOnly ? 'local' : 'chain',
    timestamp, state, purchaseCost, activatedAt, activeProposalId,
    nextProposalId, roundAnchor: opener && Object.freeze({ endsAt: opener.endsAt,
      snapshotTs: opener.snapshotTs, executed: opener.executed,
      currentFormat: opener.snapshotTs + DAY === opener.endsAt }),
    lastProposed, shares, snapshotShares, listedProposalId, expiresAt,
    salePrice, firstoSale, nativeFirstoSale, delisting, saleReference, saleReviewThresholdBps, candidates: Object.freeze(candidates) });
}

/** ABI disclosure only: reuse a known chain price without another request or user input. */
export function proposalReferenceRecord(snapshot) {
  const market = snapshot.stage !== 'genesis' && snapshot.saleReference?.available;
  return {
    refPriceWei: uint(market ? snapshot.saleReference.priceWei : snapshot.purchaseCost).toString(),
    refAt: uint(market ? snapshot.saleReference.observedAt : snapshot.activatedAt, 64).toString(),
  };
}

/** Build exact unsigned calldata from an internally consistent chain snapshot. */
export function governanceAction(snapshot, from, action) {
  const account = nonzero(from);
  requireGovernance(snapshot?.chainId === CHAIN_ID && same(snapshot.account, account),
    'Governance snapshot belongs to another wallet or chain.');
  if (action?.expectedAccount !== undefined) requireGovernance(same(account, action.expectedAccount), 'Wallet changed; review again.');
  if (action?.expectedPool !== undefined) requireGovernance(same(snapshot.pool, action.expectedPool), 'Pool changed; review again.');
  const open = snapshot.state === 2n && snapshot.timestamp >= snapshot.activatedAt + SALE_COOLDOWN;
  const candidate = id => snapshot.candidates.find(item => item.id === uint(id));
  let method, args = [], value = 0n, chosen = null;
  if (action?.kind === 'propose') {
    const price = uint(action.priceWei), reference = uint(action.refPriceWei), refAt = uint(action.refAt, 64);
    requireGovernance(snapshot.state === 2n, '矿池目前不在挖矿运行状态，不能发起整机出售提案。');
    requireGovernance(snapshot.timestamp >= snapshot.activatedAt + SALE_COOLDOWN,
      `矿机激活满 3 天后才能发起整机出售提案；开放时间：${new Date(Number(snapshot.activatedAt + SALE_COOLDOWN) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）。`);
    requireGovernance(snapshot.shares > 0n, '当前钱包没有该矿池份额，不能发起出售提案。');
    requireGovernance(price > 0n && reference > 0n, '出售价格和参考价都必须大于 0 BNB。');
    requireGovernance(refAt <= snapshot.timestamp, snapshot.displayOnly
      ? '参考价观察时间晚于当前时间，请重新输入。' : '参考价观察时间晚于链上快照，请重新预览。');
    requireGovernance(snapshot.lastProposed === 0n || snapshot.timestamp >= snapshot.lastProposed + SALE_COOLDOWN,
      'This wallet must wait three days before proposing again.');
    const opener = snapshot.roundAnchor;
    if (opener && !opener.executed && snapshot.timestamp < opener.endsAt) {
      requireGovernance(opener.currentFormat, 'An older sale proposal must expire before a new round.');
      requireGovernance(snapshot.candidates.length < Number(MAX_CANDIDATES), 'This round is full.');
    } else if (opener) {
      requireGovernance(snapshot.timestamp >= opener.endsAt + SALE_COOLDOWN - DAY, 'Next sale round is not open yet.');
    } else {
      requireGovernance(snapshot.activeProposalId === 0n, 'Unsupported older governance round.');
    }
    method = 'propose'; args = [price, reference, refAt];
  } else if (action?.kind === 'vote' || action?.kind === 'executeSale') {
    chosen = candidate(action.proposalId);
    requireGovernance(chosen && open && snapshot.timestamp < chosen.endsAt && !chosen.executed,
      'Sale candidate is not open for voting or execution.');
    if (action.kind === 'vote') {
      requireGovernance(typeof action.support === 'boolean' && snapshot.snapshotShares > 0n && !chosen.hasVoted,
        'This wallet cannot vote again or had no shares at the snapshot.');
      method = 'vote'; args = [chosen.id, action.support];
    } else {
      requireGovernance(chosen.passed, 'The sale candidate has not reached both vote thresholds.');
      requireGovernance(chosen.canExecute, 'Firsto market reference or required platform review is not ready; refresh.');
      method = 'executeSale'; args = [chosen.id];
    }
  } else if (action?.kind === 'cancelExpired') {
    requireGovernance(snapshot.state === 3n && snapshot.listedProposalId > 0n
      && snapshot.timestamp >= snapshot.expiresAt, 'The whole-miner listing has not expired.');
    method = 'cancelExpired';
  } else if (action?.kind === 'delist') {
    const operation = uint(action.delistAction, 8), cancellationId = uint(action.cancellationId);
    requireGovernance(snapshot.nativeFirstoSale?.enabled === true && snapshot.delisting?.available === true
      && snapshot.state === 3n && snapshot.listedProposalId > 0n && snapshot.timestamp < snapshot.expiresAt,
    '当前挂牌已成交、到期或尚未启用提前下架。');
    requireGovernance(uint(action.expectedListedProposalId) === snapshot.listedProposalId,
      '挂牌提案已变化，请重新预览下架操作。');
    requireGovernance(typeof action.support === 'boolean' && operation <= 2n, '下架投票操作无效。');
    const p = snapshot.delisting;
    if (operation === 0n) requireGovernance(cancellationId === 0n && p.canPropose, '当前不能发起下架投票。');
    else {
      requireGovernance(cancellationId === p.id && p.listedProposalId === snapshot.listedProposalId
        && !p.executed && !p.expired, '下架投票已结束或挂牌已变化。');
      if (operation === 1n) requireGovernance(p.canVote, '当前钱包已投票或没有下架投票快照份额。');
      else requireGovernance(p.canExecute && p.passed, '下架投票尚未达到人数与份额均严格过半。');
    }
    method = 'delist'; args = [operation, cancellationId, snapshot.listedProposalId, action.support];
  } else if (action?.kind === 'completeFirstoSale') {
    chosen = candidate(snapshot.listedProposalId);
    requireGovernance(snapshot.state === 3n && chosen?.executed && snapshot.timestamp < snapshot.expiresAt
      && snapshot.salePrice > 0n && chosen.priceWei === snapshot.salePrice,
    'The whole-miner listing is not open at this exact price.');
    requireGovernance(snapshot.firstoSale?.available === true, snapshot.displayOnly
      ? 'Firsto 成交费率暂不可用。' : '受控 Firsto 成交版本或费率尚未核验。');
    const { feeBps, feeEpoch } = snapshot.firstoSale;
    if (action.expectedFeeBps !== undefined) requireGovernance(feeBps === uint(action.expectedFeeBps, 16), 'Firsto fee changed; review again.');
    if (action.expectedFeeEpoch !== undefined) requireGovernance(feeEpoch === uint(action.expectedFeeEpoch), 'Firsto fee epoch changed; review again.');
    value = uint(snapshot.salePrice + snapshot.salePrice * feeBps / 10000n);
    method = 'completeFirstoSale'; args = [chosen.id, snapshot.salePrice, feeBps, feeEpoch];
  } else throw new Error('Unsupported sale governance action.');
  if (action.expectedProposalId !== undefined) requireGovernance(chosen?.id === uint(action.expectedProposalId), 'Proposal changed; review again.');
  if (action.expectedPriceWei !== undefined) requireGovernance((chosen?.priceWei ?? (method === 'propose' ? uint(action.priceWei) : snapshot.salePrice)) === uint(action.expectedPriceWei), 'Price changed; review again.');
  return Object.freeze({ transaction: Object.freeze({ chainId: '0x38', from: account, to: snapshot.pool,
    data: (method === 'delist' ? nativeGovernanceViews : abi.PoolVault).encodeFunctionData(method, args), value: toQuantity(value) }),
  quote: Object.freeze({ action: method, proposalId: chosen?.id ?? null, pool: snapshot.pool,
    priceWei: chosen?.priceWei ?? (method === 'propose' ? uint(action.priceWei) : snapshot.salePrice),
    paymentWei: value, feeWei: value === 0n ? 0n : snapshot.salePrice / 100n,
    holderNetWei: value === 0n ? 0n : snapshot.salePrice - snapshot.salePrice / 100n,
    sourceFeeWei: value === 0n ? 0n : value - snapshot.salePrice,
    marketReferenceWei: snapshot.saleReference?.available ? snapshot.saleReference.priceWei : null,
    marketReferenceObservedAt: snapshot.saleReference?.available ? snapshot.saleReference.observedAt : null,
    reviewRequired: chosen?.reviewRequired ?? null,
    saleReviewThresholdBps: snapshot.saleReviewThresholdBps,
    saleReviewStatus: chosen?.saleReview?.status ?? null,
    saleReviewPriceWei: chosen?.saleReview?.priceWei ?? null,
    feeBps: snapshot.firstoSale?.feeBps ?? null, feeEpoch: snapshot.firstoSale?.feeEpoch ?? null,
    cancellationId: method === 'delist' ? uint(action.cancellationId) : null,
    delistAction: method === 'delist' ? uint(action.delistAction, 8) : null,
    listedProposalId: snapshot.listedProposalId,
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash }) });
}

/** Reuse direct display data for an unsigned preview; the contract applies execution rules. */
export async function prepareGovernanceAction(provider, { factory, pool, account, action, stage,
  displayOnly = false, shareMarket, snapshot: currentSnapshot, now = Date.now }) {
  const snapshot = displayOnly && currentSnapshot?.displayOnly
    ? currentSnapshot : await readGovernanceSnapshot(provider, { factory, pool, account, stage, displayOnly, shareMarket, now });
  requireGovernance(same(snapshot.factory, factory) && same(snapshot.pool, pool), 'Governance data belongs to another pool.');
  requireGovernance(snapshot.stage === stage && (!shareMarket || same(snapshot.shareMarket, shareMarket)),
    'Governance data belongs to another product configuration.');
  return Object.freeze({ snapshot, ...governanceAction(snapshot, account, action) });
}
