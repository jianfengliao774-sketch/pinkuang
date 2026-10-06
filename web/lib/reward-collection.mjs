import { ZeroAddress, getAddress, toQuantity } from 'ethers';
import { abi, CHAIN_ID, uint } from './chain-client.mjs';
import { settleReadRound } from './read-retry.mjs';

const HASH = /^0x[\da-f]{64}$/i;
const UINT256 = 1n << 256n;
const MODES = new Set(['collect-and-claim', 'collect-only', 'claim-only']);
const KINDS = new Set(['harvest', 'claim', 'withdrawBnb']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function address(value) {
  const result = getAddress(value);
  if (result === ZeroAddress) throw new Error('A nonzero address is required.');
  return result;
}

function amount(value, name) {
  if (typeof value !== 'bigint' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)))
    throw new Error(`${name} must be an exact unsigned amount.`);
  const result = BigInt(value);
  if (result < 0n || result >= UINT256) throw new Error(`${name} is outside uint256.`);
  return result;
}

function receiptBlock(value) {
  if (typeof value === 'string' && /^0x[\da-f]+$/i.test(value))
    return amount(BigInt(value), 'Receipt block');
  return amount(value, 'Receipt block');
}

function configuredChainId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^0x[\da-f]+$/i.test(value)) return amount(BigInt(value), 'Chain ID');
  return amount(value, 'Chain ID');
}

function maybeAmount(value, name) {
  return value == null ? null : amount(value, name);
}

function poolState(row) {
  if (row.state != null) {
    const state = amount(row.state, 'Pool state');
    if (state > 5n) throw new Error('Unknown pool state.');
    return state;
  }
  const state = { Funding: 0n, Funded: 1n, Active: 2n, Listed: 3n, Closed: 4n, Refunding: 5n }[row.status];
  return state ?? null;
}

/** Scope is the already loaded single-pool positions, never the whole wallet. */
export function buildRewardCollectionPlan({ positions, account, config } = {}) {
  const owner = address(account);
  const factory = address(config?.manifest?.factory ?? config?.factory);
  if (config?.status && config.status !== 'ready') throw new Error('The reviewed product is not ready.');
  if (config?.factory && !same(config.factory, factory)) throw new Error('Configured Factory identity differs.');
  if (config?.chainId != null && configuredChainId(config.chainId) !== CHAIN_ID
    || config?.manifest?.chainId != null && configuredChainId(config.manifest.chainId) !== CHAIN_ID)
    throw new Error('The configured chain is not BSC mainnet.');
  const rows = Array.isArray(positions) ? positions : positions?.items;
  if (!Array.isArray(rows)) throw new Error('Loaded single-pool positions are required.');
  const items = [], seen = new Map();
  for (const row of rows) {
    if (row?.kind === 'portfolio') continue;
    if (row?.trusted !== true) throw new Error('A loaded pool is not trusted.');
    const pool = address(row.pool ?? row.poolAddress);
    if (same(pool, factory)) throw new Error('Factory is not a pool.');
    const shares = maybeAmount(row.shares, 'Shares');
    const claimableBEM = maybeAmount(row.claimableBEM ?? row.claimableBem, 'Claimable BEM');
    const bnbOwed = maybeAmount(row.bnbOwed, 'BNB owed');
    if (shares !== null && shares > 100n) throw new Error('Pool shares exceed 100.');
    const state = poolState(row); // Validate the cached value, but never use it as the transaction gate.
    const harvest = shares !== null && shares > 0n;
    // Null is unknown, not zero. A zero-share holder can have historical credits.
    const couldClaim = claimableBEM === null || bnbOwed === null
      || claimableBEM > 0n || bnbOwed > 0n;
    const previous = seen.get(pool.toLowerCase());
    const identity = `${state}:${shares}:${claimableBEM}:${bnbOwed}`;
    if (previous !== undefined) {
      if (previous !== identity) throw new Error('Conflicting duplicate pool positions.');
      continue;
    }
    seen.set(pool.toLowerCase(), identity);
    if (harvest || couldClaim) items.push(Object.freeze({ pool, harvest }));
  }
  return Object.freeze({ account: owner, factory, chainId: CHAIN_ID,
    scope: 'loaded-single-pools', items: Object.freeze(items) });
}

function header(raw, expectedBlock) {
  if (!raw || typeof raw.number !== 'string' || !/^0x[\da-f]+$/i.test(raw.number)
    || !HASH.test(raw.hash ?? '')) throw new Error('RPC block unavailable.');
  const number = amount(BigInt(raw.number), 'Block number');
  if (expectedBlock != null && number !== expectedBlock) throw new Error('RPC returned a different block.');
  return { number, hash: raw.hash.toLowerCase() };
}

/** One pinned, canonical BSC read. Factory registration and Vault binding are checked anew. */
export async function readRewardBalances({ provider, pool: poolInput, account: accountInput,
  factory: factoryInput, minBlockNumber } = {}) {
  if (typeof provider?.request !== 'function') throw new Error('An EIP-1193 read provider is required.');
  const pool = address(poolInput), account = address(accountInput), factory = address(factoryInput);
  const minimum = minBlockNumber == null ? 0n : amount(minBlockNumber, 'Minimum block');
  const request = (method, params = []) => provider.request({ method, params });
  const first = await settleReadRound({
    chain: () => request('eth_chainId'),
    block: () => request('eth_getBlockByNumber', ['latest', false]),
  });
  if (amount(BigInt(first.chain), 'Chain ID') !== CHAIN_ID) throw new Error('Switch to BSC mainnet (56).');
  const block = header(first.block);
  if (block.number < minimum) throw new Error('RPC has not reached the confirmed transaction block.');
  const blockTag = toQuantity(block.number);
  const call = async (to, contract, method, args = []) => {
    const data = contract.encodeFunctionData(method, args);
    const encoded = await request('eth_call', [{ to, data }, blockTag]);
    return contract.decodeFunctionResult(method, encoded)[0];
  };
  const values = await settleReadRound({
    registered: () => call(factory, abi.PoolFactory, 'isPool', [pool]),
    poolFactory: () => call(pool, abi.PoolVault, 'factory'),
    state: () => call(pool, abi.PoolVault, 'state'),
    shares: () => call(pool, abi.PoolVault, 'balanceOf', [account]),
    claimableBEM: () => call(pool, abi.PoolVault, 'claimable', [account]),
    bnbOwed: () => call(pool, abi.PoolVault, 'bnbOwed', [account]),
  });
  if (values.registered !== true || !same(values.poolFactory, factory))
    throw new Error('Pool is not registered to the reviewed Factory.');
  const state = amount(values.state, 'Pool state');
  const shares = amount(values.shares, 'Shares');
  const claimableBEM = amount(values.claimableBEM, 'Claimable BEM');
  const bnbOwed = amount(values.bnbOwed, 'BNB owed');
  if (state > 5n || shares > 100n) throw new Error('Pool state or shares are invalid.');
  const last = await settleReadRound({
    chain: () => request('eth_chainId'),
    block: () => request('eth_getBlockByNumber', [blockTag, false]),
  });
  if (amount(BigInt(last.chain), 'Chain ID') !== CHAIN_ID
    || header(last.block, block.number).hash !== block.hash) throw new Error('Chain changed during reward read.');
  return Object.freeze({ pool, account, factory, chainId: CHAIN_ID,
    blockNumber: block.number, blockHash: block.hash, state, shares, claimableBEM, bnbOwed });
}

function checkedBalances(raw, plan, item, minimum) {
  if (!raw || !same(raw.pool, item.pool) || !same(raw.account, plan.account)
    || !same(raw.factory, plan.factory) || amount(raw.chainId, 'Chain ID') !== CHAIN_ID
    || !HASH.test(raw.blockHash ?? '')) throw new Error('Reward read identity changed.');
  const blockNumber = amount(raw.blockNumber, 'Block number');
  const state = amount(raw.state, 'Pool state');
  const shares = amount(raw.shares, 'Shares');
  const claimableBEM = amount(raw.claimableBEM, 'Claimable BEM');
  const bnbOwed = amount(raw.bnbOwed, 'BNB owed');
  if (blockNumber < minimum || state > 5n || shares > 100n)
    throw new Error('Reward read is stale or invalid.');
  return Object.freeze({ ...raw, blockNumber, state, shares, claimableBEM, bnbOwed });
}

/** Strictly serial wallet queue; every known hash is recorded before waiting. */
export async function runRewardCollection({ plan, mode = 'collect-and-claim', isCurrent = () => true,
  readBalances, send, waitReceipt, onProgress = () => {}, onRecord = () => {} } = {}) {
  if (!MODES.has(mode) || plan?.scope !== 'loaded-single-pools' || plan.chainId !== CHAIN_ID
    || !Array.isArray(plan.items) || typeof readBalances !== 'function'
    || typeof send !== 'function' || typeof waitReceipt !== 'function'
    || typeof isCurrent !== 'function' || typeof onProgress !== 'function'
    || typeof onRecord !== 'function') throw new Error('Invalid reward collection queue.');
  const account = address(plan.account), factory = address(plan.factory);
  const items = plan.items.map(item => {
    if (!item || typeof item.harvest !== 'boolean') throw new Error('Invalid pool plan item.');
    return { pool: address(item.pool), harvest: item.harvest };
  });
  if (new Set(items.map(item => item.pool.toLowerCase())).size !== items.length)
    throw new Error('Duplicate pool in reward collection queue.');
  const checkedPlan = { ...plan, account, factory };
  const records = [], steps = [];
  const stats = () => Object.freeze({
    confirmed: steps.filter(step => step.status === 'confirmed').length,
    reverted: steps.filter(step => step.status === 'failed').length,
    skippedZero: steps.filter(step => step.reason === 'zero_balance').length,
  });
  const finish = (status, reason = null, error = null) => Object.freeze({ status, reason,
    error: error?.message ?? null, mode, records: Object.freeze([...records]),
    steps: Object.freeze([...steps]), stats: stats() });
  const current = () => {
    try { return isCurrent() === true; } catch { return false; }
  };
  let stopReason = null, stopError = null;
  const stop = (reason, error) => { stopReason = reason; stopError = error; };
  for (const [index, item] of items.entries()) {
    if (!current()) return finish('stopped', 'wallet_changed');
    if (mode === 'collect-only' && !item.harvest) continue;
    let minimum = 0n;
    const progress = async (phase, kind, extras = {}) => {
      try {
        await onProgress({ phase, status: phase, mode, kind, pool: item.pool, account,
          index, total: items.length, stats: stats(), ...extras });
      } catch (error) { stop('record_failed', error); }
    };
    const fresh = async kind => {
      if (!current()) { stop('wallet_changed'); return null; }
      await progress('reading', kind);
      if (stopReason) return null;
      if (!current()) { stop('wallet_changed'); return null; }
      let raw;
      try {
        raw = await readBalances({ pool: item.pool, account, factory, minBlockNumber: minimum });
        if (!current()) { stop('wallet_changed'); return null; }
        return checkedBalances(raw, checkedPlan, item, minimum);
      } catch (error) { stop('read_failed', error); return null; }
    };
    const transact = async (kind, balances) => {
      if (!KINDS.has(kind) || !current()) { stop('wallet_changed'); return; }
      await progress('submitting', kind);
      if (stopReason) return;
      if (!current()) { stop('wallet_changed'); return; }
      let hash;
      try {
        const sent = await send({ mode, kind, pool: item.pool, account, factory, item, balances });
        hash = typeof sent === 'string' ? sent : sent?.hash;
      } catch (error) {
        stop(error?.code === 4001 || error?.code === 'ACTION_REJECTED' ? 'wallet_rejected'
          : error?.beforeWalletSubmission === true ? 'preflight_failed' : 'send_unknown', error);
        return;
      }
      if (!HASH.test(hash ?? '')) { stop('send_unknown', new Error('Wallet returned no transaction hash.')); return; }
      const pending = Object.freeze({ pool: item.pool, kind, hash, status: 'pending' });
      records.push(pending);
      steps.push(pending);
      try { await onRecord(pending); } catch (error) { stop('record_failed', error); return; }
      await progress('waiting', kind, { hash });
      if (stopReason) return;
      if (!current()) { stop('wallet_changed'); return; }
      let receipt;
      try { receipt = await waitReceipt({ mode, kind, pool: item.pool, account, hash }); }
      catch (error) { stop('receipt_unknown', error); return; }
      if (!current()) { stop('wallet_changed'); return; }
      if (!receipt || !['confirmed', 'failed', 'pending'].includes(receipt.status)
        || receipt.hash != null && !same(receipt.hash, hash)) {
        stop('receipt_unknown', new Error('Transaction receipt is not verified.')); return;
      }
      if (receipt.status === 'pending') { stop('receipt_pending'); return; }
      let blockNumber;
      try { blockNumber = receiptBlock(receipt.blockNumber); }
      catch (error) { stop('receipt_unknown', error); return; }
      if (blockNumber === 0n) { stop('receipt_unknown', new Error('Receipt block is missing.')); return; }
      const settled = Object.freeze({ pool: item.pool, kind, hash, status: receipt.status, blockNumber });
      records[records.length - 1] = settled;
      steps[steps.length - 1] = settled;
      try { await onRecord(settled); } catch (error) { stop('record_failed', error); return; }
      minimum = blockNumber > minimum ? blockNumber : minimum;
      await progress('settled', kind, { receiptStatus: receipt.status });
    };
    let balances = await fresh(mode === 'claim-only' ? 'claim' : item.harvest ? 'harvest' : 'claim');
    if (stopReason) return finish('stopped', stopReason, stopError);
    if (mode !== 'claim-only' && item.harvest && (balances.state === 2n || balances.state === 3n)
      && balances.shares > 0n) {
      await transact('harvest', balances);
      if (stopReason) return finish('stopped', stopReason, stopError);
      if (mode !== 'collect-only') {
        balances = await fresh('claim');
        if (stopReason) return finish('stopped', stopReason, stopError);
      }
    }
    else if (mode !== 'claim-only' && item.harvest)
      steps.push(Object.freeze({ pool: item.pool, kind: 'harvest', status: 'skipped', reason: 'ineligible' }));
    if (mode === 'collect-only') continue;
    if (balances.claimableBEM > 0n) {
      await transact('claim', balances);
      if (stopReason) return finish('stopped', stopReason, stopError);
      balances = await fresh('withdrawBnb');
      if (stopReason) return finish('stopped', stopReason, stopError);
    } else steps.push(Object.freeze({ pool: item.pool, kind: 'claim', status: 'skipped', reason: 'zero_balance' }));
    if (balances.bnbOwed > 0n) {
      await transact('withdrawBnb', balances);
      if (stopReason) return finish('stopped', stopReason, stopError);
    } else steps.push(Object.freeze({ pool: item.pool, kind: 'withdrawBnb', status: 'skipped', reason: 'zero_balance' }));
  }
  return finish('completed');
}
