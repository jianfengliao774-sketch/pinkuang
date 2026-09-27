import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, JsonRpcProvider, Wallet, getAddress, parseEther, parseUnits } from 'ethers';
import { acquireKeeperLock, acquireWalletLock, KEEPER_STATE_ROOT, readJournal, writeJournal } from './purchase-keeper.mjs';
import { runMiningCycle } from './mining-keeper.mjs';

const factoryAbi = ['function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)'];
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const unresolved = journal => journal.transaction && !['confirmed', 'reverted', 'cancelled', 'cancel-reverted'].includes(journal.transaction.phase);
const followup = journal => ['arming', 'starting'].includes(journal.miningStage)
  && journal.transaction?.phase === 'confirmed';
const failed = journal => ['reverted', 'cancelled', 'cancel-reverted'].includes(journal.transaction?.phase);

export function prioritizePools(pools, journalFor, cursor, batch = 10) {
  const urgent = pools.filter(pool => {
    const journal = journalFor(pool);
    return unresolved(journal) || followup(journal) || failed(journal);
  });
  if (urgent.length > 1) throw new Error('Multiple mining journals need the same operator wallet; resolve them manually.');
  if (urgent.length) return { selected: urgent, nextCursor: cursor };
  if (!pools.length) return { selected: [], nextCursor: 0 };
  const selected = Array.from({ length: Math.min(batch, pools.length) }, (_, index) => pools[(cursor + index) % pools.length]);
  return { selected, nextCursor: (cursor + selected.length) % pools.length };
}

export function parseSupervisorArguments(args) {
  const values = {};
  const keys = new Set(['factory', 'rpc', 'journal-dir', 'interval', 'batch', 'max-pools', 'max-gas-bnb', 'max-gas-price-gwei']);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!key || Object.hasOwn(values, key)) throw new Error(`Invalid or repeated option: ${args[i]}`);
    if (['send', 'once', 'help'].includes(key)) values[key] = true;
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
  return { factory: getAddress(values.factory), rpc, interval, batch, maxPools, send: values.send === true,
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

export async function runSupervisorCycle(provider, options, signer, state) {
  const pools = await refreshPools(provider, options, state.pools);
  const journalPath = pool => resolve(options.journalDir, `${pool.toLowerCase()}.json`);
  const journalFor = pool => readJournal(journalPath(pool), { factory: options.factory, pool });
  const { selected, nextCursor } = prioritizePools(pools, journalFor, state.cursor, options.batch);
  state.cursor = nextCursor;
  if (!selected.length) return { status: 'no-registered-pools', poolCount: 0 };
  const results = [];
  for (const pool of selected) {
    const journal = journalPath(pool);
    const releaseJournal = acquireKeeperLock(journal);
    let releaseWallet;
    try {
      if (options.send) {
        releaseWallet = acquireWalletLock(signer.address, journal);
        if (!existsSync(journal)) writeJournal(journal, journalFor(pool));
      }
      const result = await runMiningCycle(provider, { ...options, pool, journal }, signer);
      results.push({ pool, ...result });
      if (options.send && (unresolved(journalFor(pool)) || followup(journalFor(pool)) || failed(journalFor(pool))
        || /review-required|unknown|nonce-or-chain-changed/.test(result.status))) break;
    } finally { releaseWallet?.(); releaseJournal(); }
  }
  return { status: 'scanned', poolCount: pools.length, checked: results.length, results };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSupervisorArguments(args);
  if (options.help) {
    console.log('Automatic mining supervisor: node scripts/mining-supervisor.mjs --factory 0x... [--once]\n' +
      'Default is read-only. Use --journal-dir /private/path --send with KEEPER_PRIVATE_KEY to monitor existing and newly created pools.');
    return;
  }
  const releaseFactory = acquireKeeperLock(resolve(KEEPER_STATE_ROOT, 'mining-factories', `56-${options.factory.toLowerCase()}`));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const request = new FetchRequest(options.rpc); request.timeout = 15_000;
    const provider = new JsonRpcProvider(request);
    let signer = null;
    if (options.send) {
      const key = process.env.KEEPER_PRIVATE_KEY;
      if (!/^0x[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('Set KEEPER_PRIVATE_KEY in the process environment.');
      signer = new Wallet(key, provider);
      mkdirSync(options.journalDir, { recursive: true, mode: 0o700 });
      if ((statSync(options.journalDir).mode & 0o077) !== 0) throw new Error('Journal directory must be private (0700).');
    }
    const state = { pools: [], cursor: 0 };
    do {
      try {
        const result = await runSupervisorCycle(provider, { ...options, shouldStop: () => stopping }, signer, state);
        console.log(json({ at: new Date().toISOString(), mode: options.send ? 'send' : 'dry-run', ...result }));
        if (result.results?.some(item => /review-required|unknown|nonce-or-chain-changed/.test(item.status))) break;
      } catch (error) {
        const detail = String(error.shortMessage ?? error.message).replace(/0x[0-9a-f]{130,}/ig, '[signed-data-redacted]');
        console.error(json({ at: new Date().toISOString(), status: 'supervisor-error',
          message: (signer ? detail.split(process.env.KEEPER_PRIVATE_KEY).join('[redacted]') : detail).slice(0, 300) }));
        if (options.once) { process.exitCode = 1; break; }
      }
      if (options.once || stopping) break;
      await new Promise(done => setTimeout(done, options.interval * 1000));
    } while (true);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop); releaseFactory();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(error => {
  console.error(String(error.message ?? error).slice(0, 300)); process.exitCode = 1;
});
