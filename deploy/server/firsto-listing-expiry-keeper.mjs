/** Permissionless expiry only, using the existing durable shared Gas-wallet lane. */
import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Contract, Interface, Transaction, getAddress, keccak256, parseEther, parseUnits } from 'ethers';
import { acquireKeeperLock, acquireWalletLock, readJournal, writeJournal, reconcilePending } from '../scripts/purchase-keeper.mjs';
import { writeFirstoAskStatus } from './firsto-ask-publisher-store.mjs';

const poolAbi = new Interface(['function cancelExpired()', 'function nativeFirstoSaleVersion() view returns(uint8)',
  'function factory() view returns(address)', 'function state() view returns(uint8)',
  'function listedProposalId() view returns(uint256)', 'function expiresAt() view returns(uint64)']);
const factoryAbi = ['function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)',
  'function isPool(address) view returns(bool)'];
export const FIRSTO_EXPIRY_CALLDATA = poolAbi.encodeFunctionData('cancelExpired');
const terminal = tx => tx && ['confirmed', 'reverted', 'cancelled', 'cancel-reverted'].includes(tx.phase);
const same = (a, b) => getAddress(a) === getAddress(b);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const busyError = error => /Keeper lock already exists:/.test(error.message ?? '')
  || error.message === 'Wallet has an unresolved transaction in another pool journal. Reconcile that journal first.';
const messages = {
  disabled: '完成原生出售合约升级后自动解除到期挂牌。', idle: '当前没有到期挂牌。',
  waiting: '挂牌尚未到期。', queued: '等待后台交易队列空闲后解除到期挂牌。',
  pending: '正在解除到期挂牌，等待交易确认。', active: '已解除到期挂牌，可以重新发起出售投票。',
  closed: '矿机已售出，无需解除挂牌。', 'gas-paused': '到期挂牌等待可用网络费。',
  retrying: '上次解除挂牌未成功，后台稍后重新处理。',
  'review-required': '解除挂牌交易需恢复处理，原交易记录已保留。',
  'read-unavailable': '到期挂牌读取暂不可用，保留原交易记录。',
};

export function firstoExpiryKeeperConfiguration(env, { journal, expectedGasWallet } = {}) {
  if (env.BEMINE_FIRSTO_EXPIRY_ENABLE !== '1') return null;
  const journalDir = env.BEMINE_FIRSTO_EXPIRY_JOURNAL_DIR, statusPath = env.BEMINE_FIRSTO_EXPIRY_STATUS_PATH;
  need(isAbsolute(journalDir ?? '') && dirname(journalDir) === dirname(journal ?? '') && journalDir !== journal,
    'Listing expiry requires an isolated private journal directory in the existing signer lane.');
  const info = lstatSync(journalDir);
  need(info.isDirectory() && !info.isSymbolicLink() && (process.platform === 'win32' || !(info.mode & 0o077)),
    'Listing expiry journal directory must be private and real.');
  need(isAbsolute(statusPath ?? '') && dirname(statusPath) !== journalDir && dirname(statusPath) !== dirname(journal),
    'Listing expiry requires a separate public status path.');
  const maxGasWei = parseEther(env.BEMINE_FIRSTO_EXPIRY_MAX_GAS_BNB ?? '0.001'),
    hourlyGasWei = parseEther(env.BEMINE_FIRSTO_EXPIRY_HOURLY_GAS_BNB ?? '0.01'),
    maxGasPrice = parseUnits(env.BEMINE_FIRSTO_EXPIRY_MAX_GAS_PRICE_GWEI ?? '1', 'gwei');
  need(maxGasWei > 0n && maxGasWei <= parseEther('0.01') && hourlyGasWei >= maxGasWei
    && hourlyGasWei <= parseEther('0.1') && maxGasPrice > 0n && maxGasPrice <= parseUnits('3', 'gwei'),
    'Listing expiry Gas bounds exceed the reviewed limits.');
  return { journalDir, statusPath, expectedGasWallet: getAddress(expectedGasWallet), maxGasWei, hourlyGasWei,
    maxGasPrice, maxGasLimit: 300_000n, intervalMs: 10_000, retryIntervalMs: 60_000, maxAttempts: 2, batch: 10, maxPools: 1000 };
}

/** One coherent chain block determines expiry; a local clock or API hint never does. */
export async function readFirstoListingExpiry(provider, { factory, pool }) {
  const block = await provider.getBlock('latest');
  need(block && Number.isSafeInteger(block.number) && Number.isSafeInteger(block.timestamp)
    && /^0x[\da-f]{64}$/i.test(block.hash ?? ''), 'Listing expiry block is unavailable.');
  const overrides = { blockTag: block.number }, vault = new Contract(pool, poolAbi, provider),
    registry = new Contract(factory, factoryAbi, provider);
  const [registered, boundFactory, version, state, listedProposalId, expiresAt] = await Promise.all([
    registry.isPool(pool, overrides), vault.factory(overrides), vault.nativeFirstoSaleVersion(overrides),
    vault.state(overrides), vault.listedProposalId(overrides), vault.expiresAt(overrides),
  ]);
  need(registered === true && same(boundFactory, factory), 'Listing expiry pool is not registered in the trusted Factory.');
  return { pool, version, state, listedProposalId, expiresAt, timestamp: BigInt(block.timestamp), blockNumber: block.number,
    blockHash: block.hash, eligible: version === 1n && state === 3n && listedProposalId > 0n
      && expiresAt > 0n && BigInt(block.timestamp) >= expiresAt };
}

/** Additional action binding; generic journal code supplies nonce/raw/finality validation. */
export function assertFirstoExpiryJournal(journal, { factory, pool, expectedGasWallet }) {
  const tx = journal.transaction;
  if (!tx) return;
  need(tx.kind === 'automaticFirstoListingExpiry' && same(tx.to, pool) && same(tx.from, expectedGasWallet)
    && tx.data?.toLowerCase() === FIRSTO_EXPIRY_CALLDATA.toLowerCase() && tx.value === '0'
    && same(journal.factory, factory) && same(journal.pool, pool)
    && tx.expiry && /^(?:[1-9]\d*)$/.test(tx.expiry.listedProposalId ?? '')
    && /^(?:[1-9]\d*)$/.test(tx.expiry.expiresAt ?? ''), 'Expiry journal targets a different action or listing.');
  for (const attempt of tx.attempts ?? []) {
    const raw = Transaction.from(attempt.raw);
    need(raw.isSigned() && raw.type === 0 && raw.chainId === 56n && same(raw.to, pool)
      && same(raw.from, expectedGasWallet) && raw.data.toLowerCase() === FIRSTO_EXPIRY_CALLDATA.toLowerCase()
      && raw.value === 0n && raw.nonce === tx.nonce && keccak256(attempt.raw) === attempt.hash,
      'Expiry journal signed bytes differ from the exact permissionless action.');
  }
}

export function createFirstoListingExpiryKeeper({ config, provider, signer, factory, verifyDeployment, dependencies = {} }) {
  need(config && signer && typeof verifyDeployment === 'function', 'Listing expiry requires the existing Gas signer and trusted graph.');
  factory = getAddress(factory);
  const now = dependencies.now ?? Date.now, lockJournal = dependencies.lockJournal ?? acquireKeeperLock,
    lockWallet = dependencies.lockWallet ?? acquireWalletLock, read = dependencies.readJournal ?? readJournal,
    write = dependencies.writeJournal ?? writeJournal, reconcile = dependencies.reconcilePending ?? reconcilePending,
    readExpiry = dependencies.readExpiry ?? readFirstoListingExpiry, publishStatus = dependencies.publishStatus ?? writeFirstoAskStatus;
  let stopped = false, task = null, cursor = 0; const pools = [], rows = {};
  const snapshot = { schemaVersion: 1, kind: 'firsto-listing-expiry-keeper-v1', chainId: 56,
    factory, enabled: false, updatedAt: new Date(now()).toISOString(), pools: rows };
  const flush = () => { snapshot.updatedAt = new Date(now()).toISOString(); publishStatus(config.statusPath, snapshot); };
  const row = (pool, status, fields = {}) => {
    rows[pool.toLowerCase()] = { ...rows[pool.toLowerCase()], pool, status, message: messages[status], ...fields }; flush();
  };
  const optionsFor = pool => ({ factory, pool, transactionTarget: pool,
    journal: resolve(config.journalDir, `${pool.toLowerCase()}.json`) });
  const load = pool => {
    const options = optionsFor(pool);
    if (!dependencies.readJournal && existsSync(options.journal)) {
      const file = lstatSync(options.journal);
      need(file.isFile() && !file.isSymbolicLink() && file.size <= 2 * 1024 * 1024,
        'Expiry journal is not a bounded regular file.');
    }
    const journal = read(options.journal, options);
    assertFirstoExpiryJournal(journal, { factory, pool, expectedGasWallet: config.expectedGasWallet });
    if (journal.expiryAttempts) need(typeof journal.expiryAttempts === 'object' && !Array.isArray(journal.expiryAttempts)
      && Object.keys(journal.expiryAttempts).length <= 1000 && Object.entries(journal.expiryAttempts).every(([key, value]) =>
        /^[1-9]\d*:[1-9]\d*$/.test(key) && Number.isSafeInteger(value.count) && value.count > 0
          && Number.isSafeInteger(value.lastAttemptAt)), 'Expiry attempt accounting is malformed.');
    return { options, journal };
  };
  function rememberGas(journal) {
    journal.expiryGasLedger ??= [];
    const tx = journal.transaction;
    if (terminal(tx) && !journal.expiryGasLedger.some(item => item.hash === tx.hash))
      journal.expiryGasLedger.push({ hash: tx.hash, at: Date.parse(tx.confirmedAt), costWei: tx.gasCostWei });
    need(journal.expiryGasLedger.length <= 1000 && journal.expiryGasLedger.every(item => /^0x[\da-f]{64}$/i.test(item.hash)
      && Number.isSafeInteger(item.at) && /^(?:0|[1-9]\d*)$/.test(item.costWei ?? '')), 'Expiry Gas accounting is malformed.');
    journal.expiryGasLedger = journal.expiryGasLedger.filter(item => item.at > now() - 3_600_000);
    return journal.expiryGasLedger.reduce((sum, item) => sum + BigInt(item.costWei), 0n);
  }
  async function discover() {
    if (dependencies.discoverPools) pools.splice(0, pools.length, ...(await dependencies.discoverPools()).map(getAddress));
    else {
      const registry = new Contract(factory, factoryAbi, provider), count = Number(await registry.poolCount());
      need(Number.isSafeInteger(count) && count <= config.maxPools && count >= pools.length, 'Expiry Factory registry changed.');
      for (let i = pools.length; i < count; i++) pools.push(getAddress(await registry.allPools(i)));
    }
    need(pools.length <= config.maxPools && new Set(pools.map(pool => pool.toLowerCase())).size === pools.length,
      'Expiry registry is incomplete or duplicated.');
  }
  async function tick() {
    if (stopped) return;
    const graph = await verifyDeployment();
    snapshot.enabled = graph?.nativeSaleUpgrade?.version === 1;
    if (!snapshot.enabled) { flush(); return; }
    need((await provider.getNetwork()).chainId === 56n, 'Expiry RPC must be BSC mainnet.');
    await discover();
    // Pending jobs have priority even when normal round-robin reaches another
    // pool. Their shared wallet pointer must reconcile before any new nonce.
    const known = new Map(pools.map(pool => [pool, load(pool)]));
    const unresolved = pools.filter(pool => known.get(pool).journal.transaction && !terminal(known.get(pool).journal.transaction));
    need(unresolved.length <= 1, 'More than one expiry journal holds the shared wallet nonce; reconcile before sending.');
    const selected = unresolved.length ? unresolved : Array.from({ length: Math.min(config.batch, pools.length) },
      (_, i) => pools[(cursor + i) % pools.length]);
    if (!unresolved.length) cursor = pools.length ? (cursor + selected.length) % pools.length : 0;
    let spent = 0n;
    for (const { journal } of known.values()) spent += rememberGas(journal);
    for (const pool of selected) {
      if (stopped) return;
      const options = optionsFor(pool); let releaseJournal, releaseWallet;
      try {
        releaseJournal = lockJournal(options.journal);
        const { journal } = load(pool);
        const spentBefore = rememberGas(journal);
        const result = await reconcile(provider, options, journal);
        spent += rememberGas(journal) - spentBefore; write(options.journal, journal);
        if (journal.transaction && !terminal(journal.transaction)) {
          row(pool, result?.terminal ? 'review-required' : 'pending', { hash: journal.transaction.hash }); return;
        }
        let state;
        try { state = await readExpiry(provider, { factory, pool }); }
        catch { row(pool, 'read-unavailable'); continue; }
        if (state.version !== 1n) { row(pool, 'disabled'); continue; }
        if (!state.eligible) { row(pool, state.state === 2n ? 'active' : state.state === 4n ? 'closed'
          : state.state === 3n ? 'waiting' : 'idle'); continue; }
        const listingKey = `${state.listedProposalId}:${state.expiresAt}`;
        if (journal.transaction?.phase === 'confirmed'
          && `${journal.transaction.expiry.listedProposalId}:${journal.transaction.expiry.expiresAt}` === listingKey) {
          row(pool, 'review-required', { hash: journal.transaction.hash }); continue;
        }
        const previous = journal.expiryAttempts?.[listingKey];
        if (previous && previous.count >= config.maxAttempts) { row(pool, 'review-required', { hash: journal.transaction?.hash }); continue; }
        if (previous && now() - previous.lastAttemptAt < config.retryIntervalMs) { row(pool, 'retrying'); continue; }
        const from = getAddress(await signer.getAddress());
        need(same(from, config.expectedGasWallet), 'Expiry signer is not the reviewed existing Gas wallet.');
        // A real empty journal must exist before acquiring the persistent
        // wallet pointer, preserving recovery across a process crash.
        releaseWallet = lockWallet(from, options.journal);
        const currentGraph = await verifyDeployment();
        need(currentGraph?.nativeSaleUpgrade?.version === 1, 'Native expiry graph is no longer active.');
        const current = await readExpiry(provider, { factory, pool });
        if (!current.eligible || `${current.listedProposalId}:${current.expiresAt}` !== listingKey) {
          row(pool, 'idle'); continue;
        }
        const request = { from, to: pool, data: FIRSTO_EXPIRY_CALLDATA, value: 0n };
        let estimate;
        try { estimate = await provider.estimateGas(request); }
        catch { row(pool, 'retrying'); continue; }
        const gasLimit = (estimate * 120n + 99n) / 100n;
        const [fee, balance, latest, pending, network, block] = await Promise.all([
          provider.getFeeData(), provider.getBalance(from), provider.getTransactionCount(from, 'latest'),
          provider.getTransactionCount(from, 'pending'), provider.getNetwork(), provider.getBlock('latest'),
        ]);
        need(network.chainId === 56n, 'Expiry RPC chain changed before signing.');
        if (latest !== pending) { row(pool, 'queued'); return; }
        if (estimate <= 0n || gasLimit > config.maxGasLimit || !block || gasLimit > block.gasLimit || !fee.gasPrice
          || fee.gasPrice > config.maxGasPrice || gasLimit * fee.gasPrice > config.maxGasWei
          || spent + gasLimit * fee.gasPrice > config.hourlyGasWei || balance < gasLimit * fee.gasPrice) {
          row(pool, 'gas-paused'); continue;
        }
        if (stopped) return;
        const raw = await signer.signTransaction({ ...request, type: 0, chainId: 56, nonce: pending, gasLimit, gasPrice: fee.gasPrice });
        const hash = keccak256(raw), createdAt = new Date(now()).toISOString();
        journal.previousTransaction = journal.transaction;
        journal.transaction = { phase: 'signed', kind: 'automaticFirstoListingExpiry', from, nonce: pending, to: pool,
          data: FIRSTO_EXPIRY_CALLDATA, value: '0', createdAt, hash, speedUps: 0,
          expiry: { listedProposalId: current.listedProposalId.toString(), expiresAt: current.expiresAt.toString() },
          attempts: [{ kind: 'purchase', raw, hash, gasLimit: gasLimit.toString(), gasPrice: fee.gasPrice.toString(), createdAt, broadcastCount: 0 }] };
        assertFirstoExpiryJournal(journal, { factory, pool, expectedGasWallet: from });
        journal.expiryAttempts ??= {};
        journal.expiryAttempts[listingKey] = { count: (previous?.count ?? 0) + 1, lastAttemptAt: now() };
        write(options.journal, journal); // Exact signed bytes precede any broadcast.
        const [newLatest, newPending, newNetwork] = await Promise.all([
          provider.getTransactionCount(from, 'latest'), provider.getTransactionCount(from, 'pending'), provider.getNetwork(),
        ]);
        if (stopped || newNetwork.chainId !== 56n || newLatest !== pending || newPending !== pending) {
          row(pool, 'review-required', { hash }); return;
        }
        journal.transaction.attempts[0].broadcastCount = 1; write(options.journal, journal);
        try {
          const sent = await provider.broadcastTransaction(raw);
          need(sent.hash.toLowerCase() === hash.toLowerCase(), 'Expiry broadcast hash differs from its signed bytes.');
          journal.transaction.phase = 'broadcast'; write(options.journal, journal);
        } catch { /* Reconcile exact bytes; never automatically resend an unknown transaction. */ }
        row(pool, 'pending', { hash, listedProposalId: current.listedProposalId.toString() }); return;
      } catch (error) {
        if (busyError(error)) { row(pool, 'queued'); return; }
        throw error;
      } finally { releaseWallet?.(); releaseJournal?.(); }
    }
    flush();
  }
  return { tick() { if (task) return task; task = tick().finally(() => { task = null; }); return task; },
    snapshot: () => structuredClone(snapshot), async close() { stopped = true; await task; } };
}

export function trackFirstoListingExpiry(keeper, { intervalMs = 10_000, onError = () =>
  console.error('Firsto listing expiry unavailable; retaining the original transaction reservation.') } = {}) {
  let stopped = false, timer, task;
  const check = () => { if (stopped) return; task = Promise.resolve().then(() => keeper.tick()).catch(onError)
    .finally(() => { if (!stopped) { timer = setTimeout(check, intervalMs); timer.unref?.(); } }); };
  check(); return async () => { stopped = true; clearTimeout(timer); await task; };
}
