import { ZeroAddress, getAddress, toQuantity } from 'ethers';
import { abi, CHAIN_ID, uint } from './chain-client.mjs';

const DAY = 86400n;
const WEEK = 7n * DAY;
const MAX_CANDIDATES = 100n;
const same = (left, right) => getAddress(left) === getAddress(right);
const requireGovernance = (condition, message) => { if (!condition) throw new Error(message); };
const nonzero = value => {
  const address = getAddress(value);
  requireGovernance(address !== ZeroAddress, 'A zero address cannot identify a pool or wallet.');
  return address;
};

/** Read every candidate in the current sale round at one finalized RPC block. */
export async function readGovernanceSnapshot(provider, { factory: configuredFactory, pool: configuredPool, account = ZeroAddress, blockNumber }) {
  requireGovernance(typeof provider?.request === 'function', 'An EIP-1193 provider is required.');
  const factory = nonzero(configuredFactory), pool = nonzero(configuredPool), owner = getAddress(account);
  const request = (method, params = []) => provider.request({ method, params });
  requireGovernance(BigInt(await request('eth_chainId')) === CHAIN_ID, 'Switch to BSC mainnet (56).');
  const block = await request('eth_getBlockByNumber', [blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber)), false]);
  requireGovernance(block?.number && block?.hash && block?.timestamp, 'Governance block is unavailable.');
  const number = BigInt(block.number), timestamp = BigInt(block.timestamp), tag = toQuantity(number);
  requireGovernance(blockNumber === undefined || number === uint(blockNumber), 'RPC returned another governance block.');
  async function call(to, contract, method, args = []) {
    const data = contract.encodeFunctionData(method, args);
    return contract.decodeFunctionResult(method, await request('eth_call', [{ to, data }, tag]))[0];
  }
  const [factoryCode, poolCode, registered, poolFactory, officialFactory, state, purchaseCost,
    activatedAt, activeProposalId, nextProposalId, lastProposed, shares, listedProposalId, expiresAt, salePrice] = await Promise.all([
    request('eth_getCode', [factory, tag]), request('eth_getCode', [pool, tag]),
    call(factory, abi.PoolFactory, 'isPool', [pool]), call(pool, abi.PoolVault, 'factory'),
    call(pool, abi.PoolVault, 'OFFICIAL_FACTORY'), call(pool, abi.PoolVault, 'state'),
    call(pool, abi.PoolVault, 'purchaseCost'), call(pool, abi.PoolVault, 'activatedAt'),
    call(pool, abi.PoolVault, 'activeProposalId'), call(pool, abi.PoolVault, 'nextProposalId'),
    call(pool, abi.PoolVault, 'lastProposed', [owner]), call(pool, abi.PoolVault, 'balanceOf', [owner]),
    call(pool, abi.PoolVault, 'listedProposalId'), call(pool, abi.PoolVault, 'expiresAt'),
    call(pool, abi.PoolVault, 'salePrice'),
  ]);
  requireGovernance(factoryCode && factoryCode !== '0x' && poolCode && poolCode !== '0x'
    && registered === true && same(poolFactory, factory) && same(officialFactory, factory),
  'Pool is not registered by the reviewed Factory.');
  requireGovernance(state <= 5n && shares <= 100n && nextProposalId >= 1n
    && (activeProposalId === 0n || (activeProposalId < nextProposalId)), 'Governance state is inconsistent.');
  requireGovernance(nextProposalId - (activeProposalId || nextProposalId) <= MAX_CANDIDATES,
    'Too many round candidates; use the contract directly after review.');

  let opener = null;
  if (activeProposalId > 0n) opener = await call(pool, abi.PoolVault, 'getProposal', [activeProposalId]);
  const candidates = [];
  for (let id = activeProposalId; id > 0n && id < nextProposalId; id += 1n) {
    const proposal = id === activeProposalId ? opener : await call(pool, abi.PoolVault, 'getProposal', [id]);
    const inRound = proposal.snapshotTs + DAY === proposal.endsAt && opener.snapshotTs + DAY === opener.endsAt
      && proposal.snapshotTs === opener.snapshotTs && proposal.endsAt === opener.endsAt
      && proposal.snapshotMemberCount === opener.snapshotMemberCount && proposal.snapshotTotalShares === 100n;
    if (!inRound) continue;
    const [passed, hasVoted] = await Promise.all([
      call(pool, abi.PoolVault, 'proposalPassed', [id]),
      call(pool, abi.PoolVault, 'hasVoted', [id, owner]),
    ]);
    const discounted = proposal.price < purchaseCost;
    const requiredYesShares = discounted ? 60n : 51n;
    const requiredYesCount = proposal.snapshotMemberCount / 2n + 1n;
    requireGovernance(proposal.price > 0n && proposal.snapshotMemberCount >= 1n
      && proposal.snapshotMemberCount <= 100n && proposal.yesCount <= proposal.snapshotMemberCount
      && proposal.yesShares <= 100n && passed === (
        proposal.yesShares >= requiredYesShares && proposal.yesCount >= requiredYesCount
      ), 'Sale proposal vote state is inconsistent.');
    candidates.push(Object.freeze({ id, proposer: getAddress(proposal.proposer), snapshotTs: proposal.snapshotTs,
      endsAt: proposal.endsAt, priceWei: proposal.price, refPriceWei: proposal.refPrice,
      refAt: proposal.refAt, snapshotMemberCount: proposal.snapshotMemberCount,
      yesCount: proposal.yesCount, yesShares: proposal.yesShares, requiredYesCount, requiredYesShares,
      discounted, passed, hasVoted, executed: proposal.executed }));
  }
  let snapshotShares = 0n;
  if (owner !== ZeroAddress && candidates.length) {
    snapshotShares = opener.snapshotTs === timestamp ? shares
      : await call(pool, abi.PoolVault, 'getPastShares', [owner, opener.snapshotTs]);
    requireGovernance(snapshotShares <= 100n, 'Invalid snapshot share balance.');
  }
  const again = await request('eth_getBlockByNumber', [tag, false]);
  requireGovernance(again?.hash === block.hash && BigInt(await request('eth_chainId')) === CHAIN_ID,
    'Chain changed during governance read; refresh.');
  return Object.freeze({ chainId: CHAIN_ID, factory, pool, account: owner, blockNumber: number,
    blockHash: block.hash, timestamp, state, purchaseCost, activatedAt, activeProposalId,
    nextProposalId, roundAnchor: opener && Object.freeze({ endsAt: opener.endsAt,
      snapshotTs: opener.snapshotTs, executed: opener.executed,
      currentFormat: opener.snapshotTs + DAY === opener.endsAt }),
    lastProposed, shares, snapshotShares, listedProposalId, expiresAt,
    salePrice, candidates: Object.freeze(candidates) });
}

/** Build exact unsigned calldata from an internally consistent chain snapshot. */
export function governanceAction(snapshot, from, action) {
  const account = nonzero(from);
  requireGovernance(snapshot?.chainId === CHAIN_ID && same(snapshot.account, account),
    'Governance snapshot belongs to another wallet or chain.');
  const open = snapshot.state === 2n && snapshot.timestamp >= snapshot.activatedAt + WEEK;
  const candidate = id => snapshot.candidates.find(item => item.id === uint(id));
  let method, args = [], value = 0n, chosen = null;
  if (action?.kind === 'propose') {
    const price = uint(action.priceWei), reference = uint(action.refPriceWei), refAt = uint(action.refAt, 64);
    requireGovernance(open && snapshot.shares > 0n && price > 0n && reference > 0n && refAt <= snapshot.timestamp,
      'An active member must disclose a positive price and an observed reference.');
    requireGovernance(snapshot.lastProposed === 0n || snapshot.timestamp >= snapshot.lastProposed + WEEK,
      'This wallet must wait seven days before proposing again.');
    const opener = snapshot.roundAnchor;
    if (opener && !opener.executed && snapshot.timestamp < opener.endsAt) {
      requireGovernance(opener.currentFormat, 'An older sale proposal must expire before a new round.');
      requireGovernance(snapshot.candidates.length < Number(MAX_CANDIDATES), 'This round is full.');
    } else if (opener) {
      requireGovernance(snapshot.timestamp >= opener.endsAt + WEEK - DAY, 'Next sale round is not open yet.');
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
      method = 'executeSale'; args = [chosen.id];
    }
  } else if (action?.kind === 'cancelExpired') {
    requireGovernance(snapshot.state === 3n && snapshot.listedProposalId > 0n
      && snapshot.timestamp >= snapshot.expiresAt, 'The whole-miner listing has not expired.');
    method = 'cancelExpired';
  } else if (action?.kind === 'completeSale') {
    chosen = candidate(snapshot.listedProposalId);
    requireGovernance(snapshot.state === 3n && chosen?.executed && snapshot.timestamp < snapshot.expiresAt
      && snapshot.salePrice > 0n && chosen.priceWei === snapshot.salePrice,
    'The whole-miner listing is not open at this exact price.');
    method = 'completeSale'; value = snapshot.salePrice;
  } else throw new Error('Unsupported sale governance action.');
  return Object.freeze({ transaction: Object.freeze({ chainId: '0x38', from: account, to: snapshot.pool,
    data: abi.PoolVault.encodeFunctionData(method, args), value: toQuantity(value) }),
  quote: Object.freeze({ action: method, proposalId: chosen?.id ?? null, pool: snapshot.pool,
    priceWei: chosen?.priceWei ?? (method === 'propose' ? uint(action.priceWei) : snapshot.salePrice),
    paymentWei: value, feeWei: value / 100n, holderNetWei: value - value / 100n,
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash }) });
}

/** Refresh the candidate and sale state immediately before simulation and journaling. */
export async function prepareGovernanceAction(provider, { factory, pool, account, action }) {
  const snapshot = await readGovernanceSnapshot(provider, { factory, pool, account });
  return Object.freeze({ snapshot, ...governanceAction(snapshot, account, action) });
}
