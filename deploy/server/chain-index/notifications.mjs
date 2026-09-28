import { ZeroAddress } from 'ethers';

const zero = ZeroAddress.toLowerCase();
const address = value => {
  if (!/^0x[0-9a-f]{40}$/i.test(String(value))) throw new Error('Invalid notification address.');
  return value.toLowerCase();
};
const count = value => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid notification count.');
  return n;
};
const identity = event => `${event.txHash}:${event.logIndex}`;
const requireMatch = condition => { if (!condition) throw new Error('Notification history is incomplete or unsupported.'); };

/** Replay integer-share ownership. ShareMarket locks seller balances, never owns tokens. */
export function replayNotificationPool(pool, logs, { market, factory, timestamp }) {
  const balances = new Map(), proposals = new Map(), rounds = new Map();
  let purchaseCostWei = null, activeRound = null, currentListing = null, saleCompleted = null;
  let purchased = false, closed = false, circuitId = pool.circuitId;
  const holdings = () => [...balances].filter(([, shares]) => shares > 0n)
    .map(([account, shares]) => ({ account, shares: shares.toString() })).sort((a, b) => a.account.localeCompare(b.account));
  for (const event of logs) {
    const a = event.args, at = count(event.timestamp);
    if (event.name === 'Transfer') {
      const from = address(a.from), to = address(a.to), amount = BigInt(a.value);
      requireMatch(amount >= 0n);
      if (from !== zero) {
        const before = balances.get(from) ?? 0n;
        requireMatch(before >= amount); balances.set(from, before - amount);
      }
      if (to !== zero) balances.set(to, (balances.get(to) ?? 0n) + amount);
      requireMatch(![market, factory, pool.address].some(owner => (balances.get(owner) ?? 0n) !== 0n));
      // Current contracts cannot change ownership within a live frozen round.
      if (from !== zero && to !== zero && amount > 0n && activeRound && at < activeRound.endsAt) {
        requireMatch(false);
      }
    } else if (event.name === 'AlternativeMinerSelected') {
      circuitId = String(a.acquiredCircuitId);
    } else if (event.name === 'Purchased') {
      purchaseCostWei = String(a.cost); requireMatch(BigInt(purchaseCostWei) > 0n); purchased = true;
    } else if (event.name === 'SaleProposed') {
      const proposalId = String(a.proposalId), endsAt = count(a.endsAt);
      requireMatch(!proposals.has(proposalId) && purchased && !closed && !currentListing);
      const proposal = { proposalId, proposer: address(a.proposer), priceWei: String(a.price),
        endsAt, createdAt: at, eventId: identity(event), createdBlock: event.blockNumber,
        snapshotTs: null, owners: [], votes: [], yesCount: 0, yesShares: '0', executed: false,
        listing: null, completed: null, expired: null };
      requireMatch(BigInt(proposal.priceWei) > 0n);
      proposals.set(proposalId, proposal);
    } else if (event.name === 'SaleSnapshotRecorded') {
      const proposal = proposals.get(String(a.proposalId)), snapshotTs = count(a.snapshotTs);
      const members = count(a.members ?? a.snapshotMemberCount), shares = count(a.shares ?? a.snapshotTotalShares);
      requireMatch(proposal && proposal.snapshotTs === null && snapshotTs + 86400 === proposal.endsAt && shares === 100);
      let round = rounds.get(snapshotTs);
      if (!round) {
        const owners = holdings();
        requireMatch(owners.length === members && owners.length <= 100
          && owners.reduce((sum, owner) => sum + BigInt(owner.shares), 0n) === 100n);
        requireMatch(snapshotTs === proposal.createdAt);
        round = { snapshotTs, endsAt: proposal.endsAt, owners, opener: proposal.proposalId };
        rounds.set(snapshotTs, round); activeRound = round;
      }
      requireMatch(round.endsAt === proposal.endsAt && round.owners.length === members);
      Object.assign(proposal, { snapshotTs, owners: round.owners.map(owner => ({ ...owner })), roundId: round.opener });
    } else if (event.name === 'Voted') {
      const proposal = proposals.get(String(a.proposalId)), voter = address(a.voter), weight = String(a.weight);
      requireMatch(proposal && proposal.snapshotTs !== null && proposal.endsAt > at
        && proposal.owners.some(owner => owner.account === voter && owner.shares === weight)
        && !proposal.votes.some(vote => vote.account === voter));
      proposal.votes.push({ account: voter, support: Boolean(a.support), shares: weight });
      if (a.support) { proposal.yesCount++; proposal.yesShares = (BigInt(proposal.yesShares) + BigInt(weight)).toString(); }
    } else if (event.name === 'SaleListed') {
      const proposal = proposals.get(String(a.proposalId));
      requireMatch(proposal && proposal.snapshotTs !== null && !currentListing && !proposal.executed
        && String(a.price) === proposal.priceWei && at < proposal.endsAt);
      proposal.executed = true;
      proposal.listing = { eventId: identity(event), timestamp: at, blockNumber: event.blockNumber, expiresAt: count(a.expiresAt) };
      currentListing = proposal;
    } else if (event.name === 'SaleExpired') {
      requireMatch(currentListing && currentListing.proposalId === String(a.proposalId));
      currentListing.expired = { eventId: identity(event), timestamp: at, blockNumber: event.blockNumber };
      currentListing = null;
    } else if (event.name === 'SaleCompleted') {
      requireMatch(currentListing && !closed && String(a.gross) === currentListing.priceWei);
      saleCompleted = { eventId: identity(event), timestamp: at, blockNumber: event.blockNumber,
        grossWei: String(a.gross), toMembersWei: String(a.toMembers) };
      currentListing.completed = saleCompleted; closed = true;
    }
  }
  for (const proposal of proposals.values()) {
    requireMatch(proposal.snapshotTs !== null);
    proposal.requiredYesCount = Math.floor(proposal.owners.length / 2) + 1;
    proposal.requiredYesShares = BigInt(proposal.priceWei) < BigInt(purchaseCostWei) ? 60 : 51;
    proposal.passed = proposal.yesCount >= proposal.requiredYesCount && BigInt(proposal.yesShares) >= BigInt(proposal.requiredYesShares);
    requireMatch(!proposal.executed || proposal.passed);
    const roundExecuted = [...proposals.values()].some(other => other.roundId === proposal.roundId && other.executed);
    proposal.roundExecuted = roundExecuted;
    proposal.open = !closed && !currentListing && !roundExecuted && proposal.endsAt > timestamp
      && activeRound?.opener === proposal.roundId;
  }
  return { ...pool, circuitId, verified: false, purchased, purchaseCostWei, owners: holdings(),
    state: closed ? 'Closed' : currentListing ? 'Listed' : purchased ? 'Active' : 'Funding',
    activeProposalId: activeRound?.opener ?? '0', listedProposalId: currentListing?.proposalId ?? '0',
    proposalCount: proposals.size, proposals: [...proposals.values()], saleCompleted };
}

async function batches(items, action) {
  for (let first = 0; first < items.length; first += 8) {
    const results = await Promise.allSettled(items.slice(first, first + 8).map(action));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

/** Independent block-pinned reads prevent omitted ownership/vote logs from authorizing a send. */
export async function verifyNotificationPool(pool, call) {
  const [next, cost, state, active, listed] = await Promise.all([
    call('nextProposalId'), call('purchaseCost'), call('state'), call('activeProposalId'), call('listedProposalId'),
  ]);
  requireMatch(BigInt(next) === BigInt(pool.proposalCount) + 1n);
  if (pool.proposals.length === 0) return { ...pool, verified: true };
  const states = { Active: 2, Listed: 3, Closed: 4 };
  const params = await call('params');
  requireMatch(String(cost) === pool.purchaseCostWei && count(state) === states[pool.state]
    && String(active) === pool.activeProposalId && String(listed) === pool.listedProposalId
    && address(params.circuits) === pool.collection && String(params.circuitId) === pool.circuitId);
  const verifiedRounds = new Set();
  for (const proposal of pool.proposals) {
    const onchain = await call('getProposal', [proposal.proposalId]);
    requireMatch(address(onchain.proposer) === proposal.proposer && count(onchain.snapshotTs) === proposal.snapshotTs
      && count(onchain.endsAt) === proposal.endsAt && String(onchain.price) === proposal.priceWei
      && count(onchain.snapshotMemberCount) === proposal.owners.length && String(onchain.snapshotTotalShares) === '100'
      && count(onchain.yesCount) === proposal.yesCount && String(onchain.yesShares) === proposal.yesShares
      && onchain.executed === proposal.executed);
    if (!verifiedRounds.has(proposal.snapshotTs)) {
      requireMatch(count(await call('getPastMemberCount', [proposal.snapshotTs])) === proposal.owners.length);
      await batches(proposal.owners, async owner => {
        requireMatch(String(await call('getPastShares', [owner.account, proposal.snapshotTs])) === owner.shares);
      });
      verifiedRounds.add(proposal.snapshotTs);
    }
    await batches(proposal.owners, async owner => {
      requireMatch(await call('hasVoted', [proposal.proposalId, owner.account])
        === proposal.votes.some(vote => vote.account === owner.account));
    });
  }
  return { ...pool, verified: true };
}

export async function notificationPage(index, iface, options = {}) {
  if (index.notificationReadInFlight) throw new Error('Notification snapshot read already running.');
  index.notificationReadInFlight = true;
  try { return await buildNotificationPage(index, iface, options); }
  finally { index.notificationReadInFlight = false; }
}

async function buildNotificationPage(index, iface, { cursor = 0, limit = 5, atBlock, atHash, anchorBlock, anchorHash } = {}) {
  const deadline = Date.now() + 20_000;
  const source = index.status();
  requireMatch(source.complete && source.indexedBlockHash && Number.isSafeInteger(cursor) && cursor >= 0
    && Number.isSafeInteger(limit) && limit >= 1 && limit <= 10);
  if (atBlock !== undefined || atHash !== undefined) requireMatch(atBlock === source.indexedThrough && atHash === source.indexedBlockHash);
  if (anchorBlock !== undefined || anchorHash !== undefined) {
    requireMatch(Number.isSafeInteger(anchorBlock) && anchorBlock <= source.indexedThrough
      && index._header(anchorBlock)?.hash === anchorHash);
  }
  const key = `${source.indexedThrough}:${source.indexedBlockHash}`;
  if (index.notificationCache?.key !== key) index.notificationCache = { key, pools: new Map() };
  const cache = index.notificationCache;
  const page = index.pools({ cursor, limit });
  const items = [];
  for (const pool of page.items) {
    if (!cache.pools.has(pool.address)) {
      const rows = index.db.prepare(`SELECT l.block_number AS blockNumber,l.log_index AS logIndex,l.tx_hash AS txHash,
        l.name,l.args,h.timestamp FROM logs l JOIN headers h ON h.number=l.block_number
        WHERE l.kind='pool' AND l.address=? AND l.name IN
        ('Transfer','Purchased','AlternativeMinerSelected','SaleProposed','SaleSnapshotRecorded','Voted','SaleListed','SaleExpired','SaleCompleted')
        ORDER BY l.block_number,l.tx_index,l.log_index LIMIT 50001`).all(pool.address);
      requireMatch(rows.length <= 50000);
      const replayed = replayNotificationPool(pool, rows.map(row => ({ ...row, args: JSON.parse(row.args) })),
        { market: source.market, factory: source.factory, timestamp: source.indexedTimestamp });
      // Preserve all proposal count for missing-history detection; verify bounded recent records only.
      replayed.proposals = replayed.proposals.filter(proposal => proposal.endsAt >= source.indexedTimestamp - 10 * 86400);
      requireMatch(replayed.proposals.length <= 200);
      const call = async (name, args = []) => {
        if (Date.now() >= deadline) throw new Error('Notification snapshot read deadline exceeded.');
        const response = await index.provider.call({ to: pool.address,
          data: iface.encodeFunctionData(name, args), blockTag: source.indexedThrough });
        return iface.decodeFunctionResult(name, response)[0];
      };
      cache.pools.set(pool.address, await verifyNotificationPool(replayed, call));
    }
    items.push(cache.pools.get(pool.address));
  }
  const current = index.status();
  requireMatch(current.complete && current.indexedThrough === source.indexedThrough && current.indexedBlockHash === source.indexedBlockHash);
  const canonical = await index.provider.getBlock(source.indexedThrough);
  requireMatch(canonical?.hash?.toLowerCase() === source.indexedBlockHash);
  return { schemaVersion: 1, items, nextCursor: page.nextCursor, anchorVerified: anchorBlock === undefined ? null : true };
}
