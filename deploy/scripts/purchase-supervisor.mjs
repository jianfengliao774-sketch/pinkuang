import { existsSync, lstatSync, readFileSync, realpathSync, statSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, JsonRpcProvider, Wallet, getAddress, parseEther, parseUnits } from 'ethers';
import { acquireKeeperLock, acquireWalletLock, createKeeperRuntime, KEEPER_STATE_ROOT,
  readJournal, runKeeperCycle, writeJournal } from './purchase-keeper.mjs';
import { readKeeperPrivateKey } from './keeper-credential.mjs';

const FACTORY_ABI = ['function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)'];
const POOL_ABI = ['function state() view returns(uint8)'];
const serial = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const unresolved = journal => journal.transaction && !['confirmed', 'reverted', 'cancelled', 'cancel-reverted'].includes(journal.transaction.phase);

export function parseSupervisorArguments(args) {
  const values = {};
  const keys = new Set(['factory', 'rpc', 'journal-dir', 'interval', 'max-pools', 'max-gas-bnb', 'max-gas-price-gwei', 'pages', 'sort', 'from']);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index].startsWith('--') ? args[index].slice(2) : '';
    if (!key || Object.hasOwn(values, key)) throw new Error(`Invalid or repeated option: ${args[index]}`);
    if (['send', 'once', 'help', 'fresh-graph'].includes(key)) values[key] = true;
    else if (keys.has(key) && args[index + 1] && !args[index + 1].startsWith('--')) values[key] = args[++index];
    else throw new Error(`Unknown option or missing value: --${key}`);
  }
  if (values.help) return { help: true };
  if (!values.factory) throw new Error('--factory is required.');
  if (values.send && !values['journal-dir']) throw new Error('--send requires an explicit --journal-dir.');
  const rpc = values.rpc ?? 'https://bsc-rpc.publicnode.com', url = new URL(rpc);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) throw new Error('Use HTTPS RPC (HTTP loopback is allowed only for tests).');
  const interval = Number(values.interval ?? 2), maxPools = Number(values['max-pools'] ?? 1000), pages = Number(values.pages ?? 3);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60 || !Number.isSafeInteger(maxPools) || maxPools < 1 || maxPools > 10000
    || !Number.isSafeInteger(pages) || pages < 1 || pages > 10) throw new Error('Invalid interval, max-pools or pages.');
  const sort = values.sort ?? 'capacity';
  if (!['capacity', 'price'].includes(sort)) throw new Error('Invalid candidate sort.');
  const maxGasWei = parseEther(values['max-gas-bnb'] ?? '0.01'), maxGasPrice = parseUnits(values['max-gas-price-gwei'] ?? '1', 'gwei');
  if (maxGasWei <= 0n || maxGasPrice <= 0n) throw new Error('Gas limits must be positive.');
  return { factory: getAddress(values.factory), rpc, interval, maxPools, pages, sort,
    send: values.send === true, once: values.once === true, from: values.from ? getAddress(values.from) : null,
    freshGraph: values['fresh-graph'] === true,
    journalDirExplicitAbsolute: Boolean(values['journal-dir'] && isAbsolute(values['journal-dir'])),
    journalDir: resolve(values['journal-dir'] ?? 'keeper-journal/purchase'),
    maxGasWei, maxGasPrice };
}

export function selectPools(pools, journalFor, states, cursor = 0) {
  const pending = pools.filter(pool => unresolved(journalFor(pool)));
  if (pending.length > 1) throw new Error('More than one unresolved purchase journal exists for this wallet; manual review is required.');
  if (pending.length) return { selected: pending, nextCursor: cursor };
  const funded = pools.filter(pool => states.get(pool) === 1n);
  if (!funded.length) return { selected: [], nextCursor: 0 };
  const offset = cursor % funded.length;
  return { selected: [...funded.slice(offset), ...funded.slice(0, offset)], nextCursor: (offset + 1) % funded.length };
}

function loadSigner(provider) {
  const file = process.env.KEEPER_PRIVATE_KEY_FILE;
  if (!file) throw new Error('Set KEEPER_PRIVATE_KEY_FILE to a private 0600 credential file before --send.');
  const path = resolve(file), stat = lstatSync(path);
  if (!isPrivateCredential(path, stat, process.env.CREDENTIALS_DIRECTORY)) throw new Error('Keeper credential must be a private regular file.');
  const key = readFileSync(path, 'utf8').trim();
  if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('Keeper credential is invalid.');
  return new Wallet(key, provider);
}

export function isPrivateCredential(path, stat, credentialsDirectory) {
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const mode = stat.mode & 0o777;
  if (mode === 0o600 || mode === 0o400) return true;
  return mode === 0o440 && stat.uid === 0 && credentialsDirectory
    && path === resolve(credentialsDirectory, 'keeper.key')
    && path.startsWith('/run/credentials/');
}

async function refreshPools(provider, options, known) {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Purchase supervisor only supports BSC mainnet.');
  const factory = new Contract(options.factory, FACTORY_ABI, provider), count = Number(await factory.poolCount());
  if (!Number.isSafeInteger(count) || count > options.maxPools || count < known.length) throw new Error('Factory pool index changed or exceeded the scan bound.');
  for (let index = known.length; index < count; index += 1) known.push(getAddress(await factory.allPools(index)));
  if (new Set(known.map(pool => pool.toLowerCase())).size !== known.length) throw new Error('Factory contains duplicate pool addresses.');
  return known;
}

export async function runSupervisorCycle(provider, options, signer, state) {
  const pools = await refreshPools(provider, options, state.pools);
  const journalPath = pool => resolve(options.journalDir, `${pool.toLowerCase()}.json`);
  const journalFor = pool => readJournal(journalPath(pool), { factory: options.factory, pool });
  const states = new Map();
  await Promise.all(pools.map(async pool => states.set(pool, await new Contract(pool, POOL_ABI, provider).state())));
  const { selected, nextCursor } = selectPools(pools, journalFor, states, state.cursor);
  state.cursor = nextCursor;
  const results = [];
  for (const pool of selected) {
    const journal = journalPath(pool), releaseJournal = acquireKeeperLock(journal);
    let releaseWallet;
    try {
      if (options.send) {
        releaseWallet = acquireWalletLock(await signer.getAddress(), journal);
        if (!existsSync(journal)) writeJournal(journal, journalFor(pool));
      }
      const runtime = state.runtimes.get(pool) ?? createKeeperRuntime();
      state.runtimes.set(pool, runtime);
      const result = await runKeeperCycle(provider, { ...options, pool, journal, venue: 'auto', refreshInterval: 30 }, signer, fetch, runtime);
      results.push({ pool, ...result });
      if (options.send && (unresolved(journalFor(pool)) || result.terminal || /review-required|unknown|nonce-or-chain-changed/.test(result.status))) break;
    } finally { releaseWallet?.(); releaseJournal(); }
  }
  return { status: 'scanned', poolCount: pools.length, fundedCount: [...states.values()].filter(value => value === 1n).length, results };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSupervisorArguments(args);
  if (options.help) {
    console.log('Automatic purchase supervisor: --factory 0x... [--once]. Read-only by default. Legacy --send requires --journal-dir and KEEPER_PRIVATE_KEY_FILE. Fresh --send requires --fresh-graph, FRESH_PURCHASE_ENABLED=1, a systemd keeper-private-key credential and reviewed deployment evidence.');
    return;
  }
  if (options.send && process.env.BEMINE_PRODUCT_ACTIVATION_PATH && !options.freshGraph)
    throw new Error('Fresh product runtime requires --fresh-graph before automatic purchases.');
  const releaseFactory = acquireKeeperLock(resolve(KEEPER_STATE_ROOT, 'purchase-factories', `56-${options.factory.toLowerCase()}`));
  let stopping = false;
  const state = { pools: [], cursor: 0, runtimes: new Map() };
  const stop = () => {
    stopping = true;
    for (const runtime of state.runtimes.values()) {
      for (const current of [runtime, runtime.autoOfficial, runtime.autoFirsto].filter(Boolean)) {
        current.stopped = true;
        current.abortController.abort();
      }
    }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const request = new FetchRequest(options.rpc); request.timeout = 15_000;
  const provider = new JsonRpcProvider(request);
  try {
    let signer = null;
    let freshGuard = null;
    if (options.freshGraph) {
      const fresh = await import('./fresh-purchase-guard.mjs');
      freshGuard = fresh.configureFreshPurchase(options);
      await fresh.verifyFreshPurchaseGraph(provider, options, freshGuard);
      options.verifyBeforeSend = (currentProvider, pool) =>
        fresh.verifyFreshPurchasePool(currentProvider, options, freshGuard, pool);
    }
    if (options.send) {
      signer = options.freshGraph ? new Wallet(readKeeperPrivateKey(), provider) : loadSigner(provider);
      if (freshGuard && getAddress(await signer.getAddress()) !== freshGuard.gasWallet)
        throw new Error('Fresh purchase signer differs from the reviewed Gas wallet.');
      mkdirSync(options.journalDir, { recursive: true, mode: 0o700 });
      if ((statSync(options.journalDir).mode & 0o077) !== 0) throw new Error('Journal directory must be private (0700).');
    }
    do {
      try {
        const result = await runSupervisorCycle(provider, options, signer, state);
        console.log(serial({ at: new Date().toISOString(), mode: options.send ? 'send' : 'dry-run', ...result }));
        if (result.results.some(item => /review-required|unknown|nonce-or-chain-changed/.test(item.status))) break;
      } catch (error) {
        const message = String(error.shortMessage ?? error.message ?? 'Purchase supervisor cycle failed.')
          .replace(/0x[0-9a-f]{130,}/ig, '[signed-data-redacted]')
          .split(signer?.privateKey ?? '\0').join('[redacted]');
        console.error(serial({ at: new Date().toISOString(), status: 'supervisor-error', message: message.slice(0, 300) }));
        if (options.once || options.freshGraph) { process.exitCode = 1; break; }
      }
      if (options.once || stopping) break;
      await new Promise(done => setTimeout(done, options.interval * 1000));
    } while (!stopping);
  } finally {
    stop();
    await Promise.all([...state.runtimes.values()].flatMap(runtime => [runtime.refreshTask, runtime.autoOfficial?.refreshTask, runtime.autoFirsto?.refreshTask]).filter(Boolean));
    provider.destroy(); process.off('SIGINT', stop); process.off('SIGTERM', stop); releaseFactory();
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(String(error.message ?? error).slice(0, 300)); process.exitCode = 1; });
}
