import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, Wallet, getAddress, parseEther, parseUnits } from 'ethers';
import { createRuntimeRpcProvider } from '../shared/runtime-rpc-selection.mjs';
import { acquireKeeperLock, acquireWalletLock, KEEPER_STATE_ROOT, readJournal, writeJournal } from './purchase-keeper.mjs';
import { assertStage, readMiningState, runMiningCycle } from './mining-keeper.mjs';
import { createFreshWorkerReadiness } from './fresh-worker-readiness.mjs';
import { configureFreshPurchase, verifyFreshPurchaseGraph, verifyFreshPurchasePool } from './fresh-purchase-guard.mjs';
import { readKeeperPrivateKey } from './keeper-credential.mjs';

const factoryAbi = ['function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)'];
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const unresolved = journal => journal.transaction && !['confirmed', 'reverted', 'cancelled', 'cancel-reverted'].includes(journal.transaction.phase);
const followup = journal => ['arming', 'starting'].includes(journal.miningStage)
  && journal.transaction?.phase === 'confirmed';
export const walletReviewRequired = status => /unknown|nonce-or-chain-changed|operator-wallet-has-pending-transaction/.test(status ?? '');
export const poolReviewRequired = status => /review-required|inactive-requires-review/.test(status ?? '');
const ordinaryWalletWait = new Set(['operator-wallet-has-pending-transaction', 'pending-receipt',
  'pending-not-indexed', 'pending-confirmations', 'pending-finality', 'pending-finality-rpc-unavailable',
  'receipt-not-canonical', 'broadcast-result-unknown', 'arming-broadcast', 'starting-broadcast',
  'stopped-before-broadcast']);
const walletContention = error => error.message === 'Wallet has an unresolved transaction in another pool journal. Reconcile that journal first.'
  || /^Keeper lock already exists: .+\. Another process holds it\.$/.test(error.message ?? '');
export const awaitingWallet = result => result.results?.some(row => row.walletWait === true) === true;
/** A waiting scan keeps the last heartbeat, but cannot renew proof of readiness. */
export function publishSupervisorReadiness(heartbeat, proof, result) {
  if (awaitingWallet(result)) return false;
  heartbeat.publish(proof.graph, proof.block, result);
  return true;
}
export function reportOperatorReview(result, send, log = console.error) {
  const review = result.results?.find(item => !item.walletWait && (item.walletBlocked || walletReviewRequired(item.status)));
  if (!review && !(send && result.status === 'all-pools-quarantined')) return false;
  log(json({ at: new Date().toISOString(), status: 'operator-review-required',
    pool: review?.pool ?? null, reason: review?.status ?? result.status,
    message: 'No automatic rebroadcast. Inspect pool journals before resuming.' }));
  process.exitCode = 2;
  return true;
}

export function prioritizePools(pools, journalFor, cursor, batch = 10, quarantined = new Set(), cooldowns = new Map(), now = Date.now()) {
  const eligible = pools.filter(pool => !quarantined.has(pool) && (cooldowns.get(pool) ?? 0) <= now);
  const urgent = eligible.filter(pool => {
    const journal = journalFor(pool);
    return unresolved(journal) || followup(journal);
  });
  if (urgent.length > 1) throw new Error('Multiple mining journals need the same operator wallet; resolve them manually.');
  if (urgent.length) return { selected: urgent, nextCursor: cursor };
  if (!eligible.length) return { selected: [], nextCursor: 0 };
  const selected = Array.from({ length: Math.min(batch, eligible.length) }, (_, index) => eligible[(cursor + index) % eligible.length]);
  return { selected, nextCursor: (cursor + selected.length) % eligible.length };
}

export function parseSupervisorArguments(args) {
  const values = {};
  const keys = new Set(['factory', 'authority', 'rpc', 'journal-dir', 'interval', 'batch', 'max-pools', 'max-gas-bnb', 'max-gas-price-gwei']);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!key || Object.hasOwn(values, key)) throw new Error(`Invalid or repeated option: ${args[i]}`);
    if (['send', 'once', 'help', 'fresh-graph'].includes(key)) values[key] = true;
    else if (keys.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) values[key] = args[++i];
    else throw new Error(`Unknown option or missing value: --${key}`);
  }
  if (values.help) return { help: true };
  if (!values.factory) throw new Error('--factory is required.');
  if (values.send && !values['journal-dir']) throw new Error('--send requires --journal-dir.');
  const rpc = values.rpc ?? 'https://bsc-dataseed.bnbchain.org', url = new URL(rpc);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) {
    throw new Error('Use HTTPS RPC (HTTP loopback is allowed for local tests).');
  }
  const interval = Number(values.interval ?? 3), batch = Number(values.batch ?? 10), maxPools = Number(values['max-pools'] ?? 1000);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60 || !Number.isSafeInteger(batch) || batch < 1 || batch > 100
    || !Number.isSafeInteger(maxPools) || maxPools < 1 || maxPools > 10_000) throw new Error('Invalid interval, batch or max-pools.');
  const maxGasWei = parseEther(values['max-gas-bnb'] ?? '0.02');
  const maxGasPrice = parseUnits(values['max-gas-price-gwei'] ?? '1', 'gwei');
  if (maxGasWei <= 0n || maxGasPrice <= 0n) throw new Error('Gas limits must be positive.');
  return { factory: getAddress(values.factory), authority: values.authority ? getAddress(values.authority) : undefined,
    rpc, interval, batch, maxPools, send: values.send === true,
    freshGraph: values['fresh-graph'] === true,
    journalDirExplicitAbsolute: Boolean(values['journal-dir'] && isAbsolute(values['journal-dir'])),
    once: values.once === true, journalDir: resolve(values['journal-dir'] ?? 'keeper-journal/mining'), maxGasWei, maxGasPrice };
}

async function refreshPools(provider, options, known) {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Supervisor only supports BSC mainnet.');
  const factory = new Contract(options.factory, factoryAbi, provider);
  const count = Number(await factory.poolCount());
  if (!Number.isSafeInteger(count) || count > options.maxPools || count < known.length) {
    throw new Error('Factory pool index changed or exceeded the configured scan bound.');
  }
  for (let index = known.length; index < count; index += 1) known.push(getAddress(await factory.allPools(index)));
  if (new Set(known.map(item => item.toLowerCase())).size !== known.length) throw new Error('Factory contains duplicate pool addresses.');
  return known;
}

export async function runSupervisorCycle(provider, options, signer, state, dependencies = {}) {
  const pools = await (dependencies.refreshPools ?? refreshPools)(provider, options, state.pools);
  state.quarantined ??= new Map();
  state.cooldowns ??= new Map();
  const journalPath = pool => resolve(options.journalDir, `${pool.toLowerCase()}.json`);
  const journalFor = pool => (dependencies.readJournal ?? readJournal)(journalPath(pool), { factory: options.factory, pool,
    transactionTarget: options.authority ?? pool });
  const { selected, nextCursor } = prioritizePools(pools, journalFor, state.cursor, options.batch,
    state.quarantined, state.cooldowns, dependencies.now?.() ?? Date.now());
  state.cursor = nextCursor;
  if (!selected.length) return { status: !pools.length ? 'no-registered-pools'
    : state.quarantined.size === pools.length ? 'all-pools-quarantined' : 'waiting-pool-retry',
    poolCount: pools.length, checked: 0, quarantinedCount: state.quarantined.size, results: [] };
  const results = [];
  let walletBusy = false;
  for (const pool of selected) {
    const journal = journalPath(pool);
    let releaseJournal;
    let releaseWallet;
    let acquiringWallet = false;
    try {
      releaseJournal = (dependencies.acquireKeeperLock ?? acquireKeeperLock)(journal);
      const poolOptions = { ...options, pool, journal, transactionTarget: options.authority ?? pool };
      const existing = journalFor(pool);
      if (options.send) {
        // Pending mining actions must reconcile their own journal first. New
        // work is inspected without taking the shared purchase/relay wallet.
        if (!unresolved(existing) && !followup(existing)
          && (!existing.transaction || existing.transaction.phase === 'confirmed')) {
          assertStage(existing, poolOptions);
          const snapshot = await (dependencies.readMiningState ?? readMiningState)(provider, poolOptions);
          if (snapshot.status === 'pool-not-active') {
            results.push({ pool, ...snapshot });
            continue;
          }
          if (snapshot.status !== 'restart-eligible') {
            // Reuse the keeper's identity/quality checks. This invocation
            // cannot sign even if the pool changes state during the reads.
            const observed = await (dependencies.runMiningCycle ?? runMiningCycle)(provider,
              { ...poolOptions, send: false }, null);
            if (!['dry-run-arming', 'dry-run-starting'].includes(observed.status)) {
              results.push({ pool, ...observed });
              if (poolReviewRequired(observed.status)) state.quarantined.set(pool, observed.status);
              continue;
            }
          }
        }
        if (walletBusy) {
          results.push({ pool, status: 'wallet-lane-busy', walletWait: true });
          continue;
        }
        acquiringWallet = true;
        releaseWallet = (dependencies.acquireWalletLock ?? acquireWalletLock)(signer.address, journal);
        acquiringWallet = false;
        if (!existsSync(journal)) writeJournal(journal, journalFor(pool));
      }
      const result = await (dependencies.runMiningCycle ?? runMiningCycle)(provider, poolOptions, signer);
      const record = { pool, ...result };
      results.push(record);
      const pending = options.send && unresolved(journalFor(pool));
      if (options.send && ordinaryWalletWait.has(result.status)
        && (pending || result.status === 'operator-wallet-has-pending-transaction')) {
        // Re-enter the normal receipt-only reconciliation on the next pass.
        // Do not exit, rebroadcast, release the persistent nonce reservation,
        // or claim a complete healthy scan while this wallet is waiting.
        record.walletWait = true;
        break;
      }
      if (pending || walletReviewRequired(result.status)) {
        // A signed pending journal keeps the wallet nonce reserved. Ordinary
        // broadcast waits for receipt reconciliation; review + pending exits.
        if (pending && (poolReviewRequired(result.status) || walletReviewRequired(result.status))) record.walletBlocked = true;
        break;
      }
      if (poolReviewRequired(result.status)) {
        state.quarantined.set(pool, result.status);
        console.error(json({ at: new Date().toISOString(), status: 'pool-review-required', pool, reason: result.status,
          message: 'This pool is paused for manual review; other pools remain eligible.' }));
        continue;
      }
      if (options.send && followup(journalFor(pool))) break;
    } catch (error) {
      if (options.send && acquiringWallet && walletContention(error)) {
        walletBusy = true;
        results.push({ pool, status: 'wallet-lane-busy', walletWait: true });
        continue;
      }
      // A wallet-lock failure or a newly signed pending journal affects every
      // pool using this wallet. Stop globally, never send a different nonce.
      if (options.send && (!releaseWallet || unresolved(journalFor(pool)))) throw error;
      const detail = String(error.shortMessage ?? error.message ?? 'Pool cycle failed.')
        .replace(/0x[0-9a-f]{130,}/ig, '[signed-data-redacted]')
        .split(signer?.privateKey ?? '\0').join('[redacted]');
      state.cooldowns.set(pool, (dependencies.now?.() ?? Date.now()) + 30_000);
      results.push({ pool, status: 'pool-cycle-error' });
      console.error(json({ at: new Date().toISOString(), status: 'pool-cycle-error', pool,
        retryAfterSeconds: 30, message: detail.slice(0, 300) }));
    } finally { releaseWallet?.(); releaseJournal?.(); }
  }
  return { status: 'scanned', poolCount: pools.length, checked: results.length,
    quarantinedCount: state.quarantined.size, results };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSupervisorArguments(args);
  if (options.help) {
    console.log('Automatic mining supervisor: node scripts/mining-supervisor.mjs --factory 0x... [--once]\n' +
      'Default is read-only. Use --journal-dir /private/path --send with a systemd keeper-private-key credential or KEEPER_PRIVATE_KEY to monitor existing and newly created pools.\n' +
      'When Factory operator is PlatformAuthority, add --authority 0x... and use a fresh journal directory.');
    return;
  }
  if (options.send && process.env.BEMINE_PRODUCT_ACTIVATION_PATH && !options.freshGraph)
    throw new Error('Fresh mining requires --fresh-graph before sending.');
  const releaseFactory = acquireKeeperLock(resolve(KEEPER_STATE_ROOT, 'mining-factories', `56-${options.factory.toLowerCase()}`));
  let stopping = false, heartbeat = null, provider = null;
  const stop = () => { stopping = true; heartbeat?.clear(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const request = new FetchRequest(options.rpc); request.timeout = 15_000;
    provider = await createRuntimeRpcProvider(request);
    const freshGuard = options.freshGraph ? configureFreshPurchase(options) : null;
    if (freshGuard) {
      if (getAddress(options.authority) !== getAddress(freshGuard.trusted.freshAuthority.authority.address))
        throw new Error("Fresh mining Authority differs from reviewed graph.");
      options.verifyBeforeSend = (rpc,pool) => verifyFreshPurchasePool(rpc,options,freshGuard,pool);
    }
    let signer = null;
    let keeperKey;
    if (options.send) {
      keeperKey = readKeeperPrivateKey();
      signer = new Wallet(keeperKey, provider);
      if (freshGuard && getAddress(signer.address) !== freshGuard.gasWallet)
        throw new Error("Fresh mining signer differs from Gas wallet.");
      mkdirSync(options.journalDir, { recursive: true, mode: 0o700 });
      if ((statSync(options.journalDir).mode & 0o077) !== 0) throw new Error('Journal directory must be private (0700).');
    }
    if (options.send && freshGuard) heartbeat = createFreshWorkerReadiness('mining');
    const state = { pools: [], cursor: 0, quarantined: new Map(), cooldowns: new Map() };
    do {
      try {
        const proof = freshGuard ? await verifyFreshPurchaseGraph(provider,{...options,reconcileExisting:true},freshGuard) : null;
        const result = await runSupervisorCycle(provider, { ...options, shouldStop: () => stopping }, signer, state);
        console.log(json({ at: new Date().toISOString(), mode: options.send ? 'send' : 'dry-run', ...result }));
        if (reportOperatorReview(result, options.send)) break;
        if (heartbeat && !stopping) publishSupervisorReadiness(heartbeat,proof,result);
      } catch (error) {
        heartbeat?.clear();
        const detail = String(error.shortMessage ?? error.message).replace(/0x[0-9a-f]{130,}/ig, '[signed-data-redacted]');
        console.error(json({ at: new Date().toISOString(), status: 'supervisor-error',
          message: (signer ? detail.split(keeperKey).join('[redacted]') : detail).slice(0, 300) }));
        if (options.once || options.authority) { process.exitCode = 1; break; }
      }
      if (options.once || stopping) break;
      await new Promise(done => setTimeout(done, options.interval * 1000));
    } while (true);
  } finally {
    stop(); provider?.destroy();
    process.off('SIGINT', stop); process.off('SIGTERM', stop); releaseFactory();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(error => {
  console.error(String(error.message ?? error).slice(0, 300)); process.exitCode = 1;
});
