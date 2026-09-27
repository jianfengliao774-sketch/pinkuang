import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getAddress, keccak256, parseEther, parseUnits } from 'ethers';
import { KEEPER_STATE_ROOT, MINING, OFFICIAL_COLLECTIONS, acquireKeeperLock, acquireWalletLock,
  gasBudget, readJournal, reconcilePending, writeJournal } from './purchase-keeper.mjs';
import { fetchTaskVectors, startSamples } from './mining-proofs.mjs';

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const poolAbi = new Interface([
  'function factory() view returns(address)', 'function state() view returns(uint8)',
  'function params() view returns(tuple(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline))',
  'function mine(bytes data) returns(bytes)',
]);
const factoryAbi = ['function isPool(address) view returns(bool)', 'function operator() view returns(address)'];
const miningAbi = new Interface([
  'function minerKey(address,uint256) view returns(bytes32)',
  'function getMiner(bytes32) view returns(tuple(address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function STOP_COOLDOWN() view returns(uint256)', 'function armedAt(bytes32) view returns(uint64)',
  'function cachedDepth(address,uint256) view returns(bool cached,uint32 depth,uint32 live)',
  'function sampleCountFor(uint32,uint32) view returns(uint32)', 'function arm(address,uint256)',
  'function ceCount(uint32,address) view returns(uint256)',
  'function passesCounterexamples(address,uint256,uint32,uint32,uint256) view returns(bool)',
  'function start(address,uint256,uint32,uint256,bytes[],bytes[],bytes32[][],bytes32) returns(bytes32)',
]);
const nftAbi = ['function ownerOf(uint256) view returns(address)', 'function circuitInfo(uint256) view returns(uint32,uint32,uint32,uint32)'];
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

export function parseMiningArguments(args) {
  const values = {};
  const flags = new Set(['send', 'once', 'help']);
  const keys = new Set(['factory', 'pool', 'rpc', 'journal', 'interval', 'max-gas-bnb', 'max-gas-price-gwei']);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!key || Object.hasOwn(values, key)) throw new Error(`Invalid or repeated option: ${args[i]}`);
    if (flags.has(key)) values[key] = true;
    else if (keys.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) values[key] = args[++i];
    else throw new Error(`Unknown option or missing value: --${key}`);
  }
  if (values.help) return { help: true };
  if (!values.factory || !values.pool) throw new Error('--factory and --pool are required.');
  const factory = getAddress(values.factory), pool = getAddress(values.pool);
  const interval = Number(values.interval ?? 3);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60) throw new Error('--interval must be 1–60 seconds.');
  const rpc = values.rpc ?? 'https://bsc-dataseed.bnbchain.org', url = new URL(rpc);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) {
    throw new Error('Use an HTTPS RPC (HTTP loopback is allowed for local tests).');
  }
  if (values.send && !values.journal) throw new Error('--send requires an explicit private journal path.');
  const maxGasWei = parseEther(values['max-gas-bnb'] ?? '0.02');
  const maxGasPrice = parseUnits(values['max-gas-price-gwei'] ?? '1', 'gwei');
  if (maxGasWei <= 0n || maxGasPrice <= 0n) throw new Error('Gas limits must be positive.');
  return { factory, pool, rpc, send: values.send === true, once: values.once === true, interval,
    journal: resolve(values.journal ?? `keeper-journal/mining-${pool.toLowerCase()}.json`), maxGasWei, maxGasPrice };
}

export function miningDecision(miner, blockNumber, cooldown) {
  if (miner.status === 1n) return { status: 'mining-active' };
  // Real Mining.stop enters status 3 and zeroes both weights; the purchased Vault
  // already enforced pure verified, nonoptimal status before it received the NFT.
  if (miner.status !== 3n) return { status: 'inactive-requires-review', reason: `protocol-status-${miner.status}` };
  if (miner.optimal || miner.taskId === 0n || miner.verifWeight !== 0n || miner.unverWeight !== 0n) {
    return { status: 'inactive-requires-review', reason: 'unexpected-stopped-miner-fields' };
  }
  if (miner.stopBlock === 0n) return { status: 'inactive-requires-review', reason: 'missing-stop-block' };
  if (BigInt(blockNumber) <= miner.stopBlock + cooldown) {
    return { status: 'stop-cooldown', blocksRemaining: miner.stopBlock + cooldown + 1n - BigInt(blockNumber) };
  }
  return { status: 'restart-eligible' };
}

export async function readMiningState(provider, options) {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Mining keeper only supports BSC mainnet.');
  const block = await provider.getBlock('latest');
  if (!block || !Number.isSafeInteger(block.number)) throw new Error('Latest block unavailable.');
  const at = { blockTag: block.number };
  const factory = new Contract(options.factory, factoryAbi, provider), pool = new Contract(options.pool, poolAbi, provider);
  const [registered, bound, state, params, operator] = await Promise.all([
    factory.isPool(options.pool, at), pool.factory(at), pool.state(at), pool.params(at), factory.operator(at),
  ]);
  if (!registered || !same(bound, options.factory)) throw new Error('Pool is not registered with this factory.');
  if (!OFFICIAL_COLLECTIONS.some(item => same(item, params.circuits))) throw new Error('Pool uses an unsupported NFT collection.');
  if (state !== 2n) return { status: 'pool-not-active', blockNumber: block.number, state };
  const nft = new Contract(params.circuits, nftAbi, provider), mining = new Contract(MINING, miningAbi, provider);
  const [owner, key] = await Promise.all([nft.ownerOf(params.circuitId, at), mining.minerKey(params.circuits, params.circuitId, at)]);
  if (!same(owner, options.pool)) throw new Error('Pool does not own the actual acquired NFT.');
  const [miner, cooldown, armedAt] = await Promise.all([
    mining.getMiner(key, at), mining.STOP_COOLDOWN(at), mining.armedAt(key, at),
  ]);
  if (!same(miner.circuits, params.circuits) || miner.circuitId !== params.circuitId) throw new Error('Mining record identifies another NFT.');
  return { ...miningDecision(miner, block.number, cooldown), blockNumber: block.number, blockHash: block.hash,
    blockGasLimit: block.gasLimit, circuits: params.circuits, circuitId: params.circuitId, miner, key, armedAt, operator };
}

async function verifiedTaskBoundary(provider, state) {
  const mining = new Contract(MINING, miningAbi, provider);
  const count = await mining.ceCount(state.miner.taskId, state.circuits);
  if (count === 0n) return true;
  try {
    return await mining.passesCounterexamples(state.circuits, state.circuitId,
      state.miner.taskId, state.miner.gateCount, 12_000_000n);
  } catch {
    return false; // Unknown validity is not permission to restart as a verified miner.
  }
}

export function assertStage(journal, options) {
  const tx = journal.transaction;
  if (!tx) return;
  if (!['arming', 'starting', 'monitoring'].includes(journal.miningStage)) throw new Error('Mining journal has an unknown stage.');
  const parsed = poolAbi.parseTransaction({ data: tx.data });
  if (parsed?.name !== 'mine' || !tx.to || !same(tx.to, options.pool) || tx.value !== '0') {
    throw new Error('Mining journal targets a different action.');
  }
  const inner = miningAbi.parseTransaction({ data: parsed.args[0] });
  if (journal.miningStage === 'monitoring' ? !['arm', 'start'].includes(inner?.name)
    : inner?.name !== (journal.miningStage === 'arming' ? 'arm' : 'start')) {
    throw new Error('Mining journal action and stage disagree.');
  }
}

async function submitAction(provider, options, signer, journal, stage, data, gasEstimate) {
  if (!options.send) return { status: `dry-run-${stage}`, gasEstimate };
  if (!signer) throw new Error('Send mode requires the operator key.');
  if (options.shouldStop?.()) return { status: 'stopped-before-signing' };
  const from = await signer.getAddress();
  const [fee, balance, pendingNonce, latestNonce, network, latestBlock] = await Promise.all([
    provider.getFeeData(), provider.getBalance(from), provider.getTransactionCount(from, 'pending'), provider.getTransactionCount(from, 'latest'),
    provider.getNetwork(), provider.getBlock('latest'),
  ]);
  if (network.chainId !== 56n) throw new Error('RPC changed away from BSC before signing.');
  if (pendingNonce !== latestNonce) return { status: 'operator-wallet-has-pending-transaction' };
  const gasPrice = fee.gasPrice, gasLimit = (gasEstimate * 120n + 99n) / 100n;
  if (!latestBlock || gasLimit > latestBlock.gasLimit) return { status: 'mining-gas-exceeds-block-limit' };
  if (!gasPrice || gasPrice > options.maxGasPrice) return { status: 'gas-price-over-limit' };
  const budget = gasBudget(journal, gasLimit, gasPrice, options.maxGasWei);
  if (!budget.allowed || balance < budget.reservedFee) return { status: 'gas-budget-or-balance-exceeded' };
  if (options.shouldStop?.()) return { status: 'stopped-before-signing' };
  const raw = await signer.signTransaction({ type: 0, chainId: 56, to: options.pool, data,
    value: 0n, nonce: pendingNonce, gasLimit, gasPrice });
  const hash = keccak256(raw);
  if (journal.transaction) journal.previousTransaction = journal.transaction;
  journal.transaction = { phase: 'signed', from, nonce: pendingNonce, to: options.pool, data, value: '0',
    createdAt: new Date().toISOString(), hash, speedUps: 0, attempts: [{ kind: 'purchase', raw, hash,
      gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), createdAt: new Date().toISOString(), broadcastCount: 0 }] };
  journal.miningStage = stage;
  writeJournal(options.journal, journal); // Exact signed bytes are durable before RPC broadcast.
  const [latest, queued, broadcastNetwork] = await Promise.all([provider.getTransactionCount(from, 'latest'),
    provider.getTransactionCount(from, 'pending'), provider.getNetwork()]);
  if (broadcastNetwork.chainId !== 56n || latest !== pendingNonce || queued !== pendingNonce) {
    return { status: 'nonce-or-chain-changed-before-broadcast', hash };
  }
  if (options.shouldStop?.()) return { status: 'stopped-before-broadcast', hash };
  journal.transaction.attempts[0].broadcastCount = 1;
  writeJournal(options.journal, journal);
  try {
    const sent = await provider.broadcastTransaction(raw);
    if (!same(sent.hash, hash)) throw new Error('RPC returned a different hash.');
    journal.transaction.phase = 'broadcast'; writeJournal(options.journal, journal);
    return { status: `${stage}-broadcast`, hash };
  } catch {
    return { status: 'broadcast-result-unknown', hash, message: 'Signed hash retained. Resolve the receipt; no automatic new nonce.' };
  }
}

export async function runMiningCycle(provider, options, signer = null, fetcher = fetch) {
  const journal = readJournal(options.journal, options);
  assertStage(journal, options);
  const pending = await reconcilePending(provider, options, journal);
  if (pending) return pending; // Never sign another transaction until this one is BSC-finalized.
  if (journal.transaction?.phase === 'reverted' || journal.transaction?.phase === 'cancelled'
    || journal.transaction?.phase === 'cancel-reverted') return { status: 'previous-mining-transaction-failed-review-required' };
  const state = await readMiningState(provider, options);
  if (state.status === 'pool-not-active') return state;
  if (options.send && !same(await signer.getAddress(), state.operator)) throw new Error('Keeper key is not the current Factory operator.');
  if (state.status === 'mining-active') {
    if (state.miner.optimal || state.miner.verifWeight === 0n || state.miner.unverWeight !== 0n) {
      return { status: 'mining-active-but-quality-changed-review-required', circuitId: state.circuitId,
        verifiedWeight: state.miner.verifWeight, unverifiedWeight: state.miner.unverWeight };
    }
    if (options.send && journal.transaction?.phase === 'confirmed' && journal.miningStage !== 'monitoring') {
      journal.miningStage = 'monitoring'; journal.armRetries = 0; writeJournal(options.journal, journal);
    }
    return { status: 'mining-active', circuitId: state.circuitId };
  }
  if (journal.miningStage === 'starting') return { status: 'start-finalized-but-miner-not-active-review-required', minerStatus: state.miner.status };
  if (journal.miningStage === 'arming' && journal.transaction?.phase === 'confirmed') {
    const anchor = journal.transaction.blockNumber;
    if (state.status !== 'restart-eligible' || state.armedAt !== BigInt(anchor)) {
      return { status: 'arm-finalized-but-miner-state-changed-review-required', minerStatus: state.miner.status };
    }
    if (!await verifiedTaskBoundary(provider, state)) {
      return { status: 'task-counterexample-check-failed-review-required', taskId: state.miner.taskId };
    }
    const age = state.blockNumber - anchor;
    if (age > 60) {
      if (!options.send) return { status: 'arm-anchor-expired-dry-run', anchor, age };
      journal.armRetries = (journal.armRetries ?? 0) + 1;
      if (journal.armRetries > 2) return { status: 'arm-anchor-expired-review-required', anchor, age };
      journal.miningStage = 'monitoring'; writeJournal(options.journal, journal);
      return { status: 'arm-anchor-expired-retrying', anchor, age, attempt: journal.armRetries };
    }
    const block = await provider.getBlock(anchor);
    if (!block || !same(block.hash, journal.transaction.blockHash)) throw new Error('Arm anchor block is no longer canonical.');
    const tree = await fetchTaskVectors(state.miner.taskId, fetcher);
    const mining = new Contract(MINING, miningAbi, provider);
    const depth = await mining.cachedDepth(state.circuits, state.circuitId);
    const live = depth.live === 0n ? (await new Contract(state.circuits, nftAbi, provider).circuitInfo(state.circuitId))[3] : depth.live;
    const count = Number(await mining.sampleCountFor(live, tree.task.cycles));
    const samples = startSamples(tree, block.hash, state.circuits, state.circuitId, count);
    const inner = miningAbi.encodeFunctionData('start', [state.circuits, state.circuitId, state.miner.taskId,
      anchor, samples.inputs, samples.outputs, samples.proofs, '0x' + '00'.repeat(32)]);
    const data = poolAbi.encodeFunctionData('mine', [inner]);
    // Full protocol proof, ownership and Vault permission are checked in the simulation.
    let gasEstimate;
    try { gasEstimate = await provider.estimateGas({ from: state.operator, to: options.pool, data, value: 0n }); }
    catch { return { status: 'start-proof-simulation-failed-review-required', anchor, taskId: state.miner.taskId }; }
    return submitAction(provider, options, signer, journal, 'starting', data, gasEstimate);
  }
  if (state.status !== 'restart-eligible') return state;
  if (!await verifiedTaskBoundary(provider, state)) {
    return { status: 'task-counterexample-check-failed-review-required', taskId: state.miner.taskId };
  }
  // Fetch and validate the full proof bank before spending gas on the anchor.
  await fetchTaskVectors(state.miner.taskId, fetcher);
  const data = poolAbi.encodeFunctionData('mine', [miningAbi.encodeFunctionData('arm', [state.circuits, state.circuitId])]);
  let gasEstimate;
  try { gasEstimate = await provider.estimateGas({ from: state.operator, to: options.pool, data, value: 0n }); }
  catch { return { status: 'arm-simulation-failed-review-required', circuitId: state.circuitId }; }
  return submitAction(provider, options, signer, journal, 'arming', data, gasEstimate);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseMiningArguments(args);
  if (options.help) {
    console.log('Mining keeper: node scripts/mining-keeper.mjs --factory 0x... --pool 0x... [--rpc HTTPS] [--once]\n' +
      'Default is read-only. To enable automatic transactions use --journal /private/path/mining.json --send and KEEPER_PRIVATE_KEY in the process environment.\n' +
      'Use one service per pool and one operator wallet executor. The private journal must be preserved for ambiguous transactions.');
    return;
  }
  const releaseJournal = acquireKeeperLock(options.journal);
  let releasePool;
  try { releasePool = acquireKeeperLock(resolve(KEEPER_STATE_ROOT, 'mining-pools', `56-${options.pool.toLowerCase()}`)); }
  catch (error) { releaseJournal(); throw error; }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let releaseWallet;
  try {
    const request = new FetchRequest(options.rpc); request.timeout = 15_000;
    const provider = new JsonRpcProvider(request);
    let signer;
    if (options.send) {
      const key = process.env.KEEPER_PRIVATE_KEY;
      if (!/^0x[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('Set KEEPER_PRIVATE_KEY in the process environment.');
      signer = new Wallet(key, provider);
      const journalDirectory = dirname(options.journal);
      mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
      if ((statSync(journalDirectory).mode & 0o077) !== 0) throw new Error('Mining journal directory must be private (0700).');
      releaseWallet = acquireWalletLock(signer.address, options.journal);
      if (!existsSync(options.journal)) writeJournal(options.journal, readJournal(options.journal, options));
    }
    do {
      try {
        const result = await runMiningCycle(provider, { ...options, shouldStop: () => stopping }, signer);
        console.log(json({ at: new Date().toISOString(), pool: options.pool, mode: options.send ? 'send' : 'dry-run', ...result }));
        if (options.once || stopping || /review-required|failed|unknown|nonce-or-chain-changed/.test(result.status)) break;
      } catch (error) {
        const detail = String(error.shortMessage ?? error.message).replace(/0x[0-9a-f]{130,}/ig, '[signed-data-redacted]');
        console.error(json({ at: new Date().toISOString(), status: 'cycle-error',
          message: (signer ? detail.split(process.env.KEEPER_PRIVATE_KEY).join('[redacted]') : detail).slice(0, 300) }));
        if (options.once || stopping) { process.exitCode = 1; break; }
      }
      await new Promise(done => setTimeout(done, options.interval * 1000));
    } while (true);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    releaseWallet?.(); releasePool(); releaseJournal();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(error => {
  console.error(String(error.message ?? error).slice(0, 300)); process.exitCode = 1;
});
