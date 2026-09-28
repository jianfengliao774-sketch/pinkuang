import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getAddress, keccak256, parseEther, parseUnits } from 'ethers';
import { acquireKeeperLock, acquireWalletLock, gasBudget, readJournal, reconcilePending, recoverPending, writeJournal } from './purchase-keeper.mjs';
import { readKeeperPrivateKey } from './keeper-credential.mjs';

const FACTORY_ABI = ['function operator() view returns(address)', 'function treasury() view returns(address)',
  'function shareMarket() view returns(address)', 'function poolCount() view returns(uint256)',
  'function allPools(uint256) view returns(address)'];
const MARKET_ABI = ['function factory() view returns(address)', 'function bnbOwed(address) view returns(uint256)',
  'function withdrawBnb()'];
const POOL_ABI = ['function factory() view returns(address)', 'function treasury() view returns(address)',
  'function bnbOwed(address) view returns(uint256)', 'function withdrawBnb()'];
const WITHDRAW = new Interface(['function withdrawBnb()']).encodeFunctionData('withdrawBnb');
const same = (a, b) => getAddress(a) === getAddress(b);
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

export function parseTreasuryArguments(args) {
  const values = {};
  const keys = new Set(['factory', 'rpc', 'journal-dir', 'max-gas-bnb', 'max-gas-price-gwei', 'max-pools']);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!key || Object.hasOwn(values, key)) throw new Error(`Invalid or repeated option: ${args[i]}`);
    if (['send', 'help', 'rebroadcast', 'speed-up', 'cancel-pending'].includes(key)) values[key] = true;
    else if (keys.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) values[key] = args[++i];
    else throw new Error(`Unknown option or missing value: --${key}`);
  }
  if (values.help) return { help: true };
  if (!values.factory) throw new Error('--factory is required.');
  if (values.send && !values['journal-dir']) throw new Error('--send requires --journal-dir.');
  const recoveryModes = Number(!!values.rebroadcast) + Number(!!values['speed-up']) + Number(!!values['cancel-pending']);
  if (recoveryModes > 1 || (recoveryModes && !values.send)) throw new Error('Choose one explicit send-mode recovery action.');
  const rpc = values.rpc ?? 'https://bsc-dataseed.bnbchain.org', url = new URL(rpc);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) {
    throw new Error('Use HTTPS RPC (HTTP loopback is for local tests only).');
  }
  const maxPools = Number(values['max-pools'] ?? 1000);
  if (!Number.isSafeInteger(maxPools) || maxPools < 1 || maxPools > 10_000) throw new Error('Invalid pool scan bound.');
  const maxGasWei = parseEther(values['max-gas-bnb'] ?? '0.01');
  const maxGasPrice = parseUnits(values['max-gas-price-gwei'] ?? '1', 'gwei');
  if (maxGasWei <= 0n || maxGasPrice <= 0n) throw new Error('Gas limits must be positive.');
  return { factory: getAddress(values.factory), rpc, send: values.send === true,
    journalDir: resolve(values['journal-dir'] ?? 'keeper-journal/treasury'), maxPools, maxGasWei, maxGasPrice,
    rebroadcast: values.rebroadcast === true, speedUp: values['speed-up'] === true,
    cancelPending: values['cancel-pending'] === true };
}

/** Collect only when the exact owed BNB exceeds the worst-case fee for this transaction. */
export function feeCollectionDecision(owedWei, gasEstimate, gasPrice, journal, maxGasWei) {
  if (owedWei <= 0n || gasEstimate <= 0n || gasPrice <= 0n) return { allowed: false, reason: 'nothing-owed-or-gas-unavailable' };
  const gasLimit = (gasEstimate * 120n + 99n) / 100n;
  const budget = gasBudget(journal, gasLimit, gasPrice, maxGasWei);
  if (!budget.allowed) return { allowed: false, reason: 'gas-budget-exceeded', gasLimit, maximumFeeWei: budget.reservedFee };
  if (owedWei <= budget.maximumNextFee) return { allowed: false, reason: 'fee-exceeds-claim', gasLimit, maximumFeeWei: budget.maximumNextFee };
  return { allowed: true, gasLimit, maximumFeeWei: budget.maximumNextFee };
}

/** A mined withdrawal may no longer be owed but its nonce still needs finality. */
export function unresolvedTreasuryJournal(options) {
  if (!existsSync(options.journalDir)) return null;
  const pending = [];
  for (const name of readdirSync(options.journalDir)) {
    if (!/^0x[0-9a-f]{40}\.json$/i.test(name)) continue;
    const address = getAddress(name.slice(0, -5));
    const path = resolve(options.journalDir, name);
    const journal = readJournal(path, { factory: options.factory, pool: address });
    if (journal.transaction && !['confirmed', 'reverted', 'cancelled', 'cancel-reverted'].includes(journal.transaction.phase)) {
      pending.push({ kind: 'pending-treasury', address, owedWei: 0n });
    }
  }
  if (pending.length > 1) throw new Error('Multiple treasury journals need the same wallet; reconcile them manually.');
  return pending[0] ?? null;
}

/** Budget all fee withdrawals together, rather than granting every pool a fresh allowance. */
export function remainingTreasuryGasBudget(options, currentJournal) {
  let otherSpent = 0n;
  if (existsSync(options.journalDir)) for (const name of readdirSync(options.journalDir)) {
    if (!/^0x[0-9a-f]{40}\.json$/i.test(name)) continue;
    const address = getAddress(name.slice(0, -5));
    const journal = readJournal(resolve(options.journalDir, name), { factory: options.factory, pool: address });
    if (!same(address, currentJournal.pool)) otherSpent += BigInt(journal.gasSpentWei);
  }
  return options.maxGasWei > otherSpent ? options.maxGasWei - otherSpent : 0n;
}

export async function discoverTreasuryCredits(provider, options, account) {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Treasury collector only supports BSC mainnet.');
  const block = await provider.getBlock('latest');
  if (!block || !Number.isSafeInteger(block.number)) throw new Error('Latest BSC block unavailable.');
  const at = { blockTag: block.number };
  const factory = new Contract(options.factory, FACTORY_ABI, provider);
  const [treasury, operator, marketAddress, countRaw] = await Promise.all([
    factory.treasury(at), factory.operator(at), factory.shareMarket(at), factory.poolCount(at),
  ]);
  if (!same(treasury, account)) throw new Error('The chosen wallet is not the current Factory treasury. No fee transaction was signed.');
  const count = Number(countRaw);
  if (!Number.isSafeInteger(count) || count > options.maxPools) throw new Error('Factory pool count exceeded the reviewed scan bound.');
  const targets = [];
  if (marketAddress !== '0x0000000000000000000000000000000000000000') {
    const market = new Contract(marketAddress, MARKET_ABI, provider);
    if (!same(await market.factory(at), options.factory)) throw new Error('ShareMarket is not bound to the reviewed Factory.');
    const owed = await market.bnbOwed(account, at);
    if (owed > 0n) targets.push({ kind: 'share-market', address: getAddress(marketAddress), owedWei: owed });
  }
  for (let i = 0; i < count; i += 1) {
    const address = getAddress(await factory.allPools(i, at));
    const pool = new Contract(address, POOL_ABI, provider);
    const [bound, poolTreasury, owed] = await Promise.all([pool.factory(at), pool.treasury(at), pool.bnbOwed(account, at)]);
    if (!same(bound, options.factory)) throw new Error('Factory index contains an unbound pool.');
    if (same(poolTreasury, account) && owed > 0n) targets.push({ kind: 'pool', address, owedWei: owed });
  }
  targets.sort((a, b) => a.owedWei === b.owedWei ? a.address.localeCompare(b.address) : a.owedWei > b.owedWei ? -1 : 1);
  return { blockNumber: block.number, blockHash: block.hash, treasury: getAddress(treasury), operator: getAddress(operator),
    market: getAddress(marketAddress), poolCount: count, targets };
}

async function collectOne(provider, options, signer, target) {
  const path = resolve(options.journalDir, `${target.address.toLowerCase()}.json`);
  if (!existsSync(path)) writeJournal(path, { version: 1, chainId: 56, factory: options.factory,
    pool: target.address, transaction: null, gasSpentWei: '0', gasReceipts: {} });
  const releaseJournal = acquireKeeperLock(path);
  let releaseWallet;
  try {
    const journalOptions = { factory: options.factory, pool: target.address, journal: path };
    const journal = readJournal(path, journalOptions);
    if (journal.transaction && !same(journal.transaction.from, signer.address)) {
      throw new Error('Fee journal belongs to another treasury wallet; recover it with its original signer.');
    }
    releaseWallet = acquireWalletLock(signer.address, path);
    const targetGasBudget = remainingTreasuryGasBudget(options, { ...journal, pool: target.address });
    const pending = await reconcilePending(provider, journalOptions, journal);
    if (pending) return { target: target.address, kind: target.kind,
      ...await recoverPending(provider, { ...journalOptions, maxGasWei: targetGasBudget,
        maxGasPrice: options.maxGasPrice, rebroadcast: options.rebroadcast,
        speedUp: options.speedUp, cancelPending: options.cancelPending }, signer, journal, pending) };
    if (target.kind === 'pending-treasury') {
      return { target: target.address, status: 'previous-fee-transaction-finalized' };
    }
    if (['reverted', 'cancelled', 'cancel-reverted'].includes(journal.transaction?.phase)) {
      return { target: target.address, status: 'previous-fee-transaction-needs-review', hash: journal.transaction.hash };
    }
    if (options.rebroadcast || options.speedUp || options.cancelPending) {
      return { target: target.address, status: 'no-unresolved-fee-transaction' };
    }
    const abi = target.kind === 'pool' ? POOL_ABI : MARKET_ABI;
    const contract = new Contract(target.address, abi, provider);
    const owed = await contract.bnbOwed(signer.address);
    if (owed === 0n) return { target: target.address, status: 'already-collected' };
    const [estimate, fees, balance, latestNonce, pendingNonce, latestBlock] = await Promise.all([
      provider.estimateGas({ from: signer.address, to: target.address, data: WITHDRAW, value: 0n }),
      provider.getFeeData(), provider.getBalance(signer.address),
      provider.getTransactionCount(signer.address, 'latest'), provider.getTransactionCount(signer.address, 'pending'),
      provider.getBlock('latest'),
    ]);
    if (latestNonce !== pendingNonce) return { target: target.address, status: 'wallet-has-pending-transaction' };
    if (!fees.gasPrice || fees.gasPrice > options.maxGasPrice) return { target: target.address, status: 'gas-price-over-limit' };
    const decision = feeCollectionDecision(owed, estimate, fees.gasPrice, journal, targetGasBudget);
    if (!decision.allowed) return { target: target.address, status: decision.reason, owedWei: owed.toString() };
    if (!latestBlock || decision.gasLimit > latestBlock.gasLimit) return { target: target.address, status: 'gas-exceeds-block-limit' };
    if (balance < decision.maximumFeeWei) return { target: target.address, status: 'gas-balance-too-low' };
    const raw = await signer.signTransaction({ type: 0, chainId: 56, to: target.address,
      data: WITHDRAW, value: 0n, nonce: latestNonce, gasLimit: decision.gasLimit, gasPrice: fees.gasPrice });
    const hash = keccak256(raw);
    if (journal.transaction) journal.previousTransaction = journal.transaction;
    journal.transaction = { phase: 'signed', from: signer.address, nonce: latestNonce, to: target.address,
      data: WITHDRAW, value: '0', createdAt: new Date().toISOString(), hash, speedUps: 0,
      attempts: [{ kind: 'purchase', raw, hash, gasLimit: decision.gasLimit.toString(),
        gasPrice: fees.gasPrice.toString(), createdAt: new Date().toISOString(), broadcastCount: 0 }] };
    writeJournal(path, journal); // Persist the signed nonce and exact hash before broadcasting.
    const [network, latestAgain, pendingAgain] = await Promise.all([provider.getNetwork(),
      provider.getTransactionCount(signer.address, 'latest'), provider.getTransactionCount(signer.address, 'pending')]);
    if (network.chainId !== 56n || latestAgain !== latestNonce || pendingAgain !== latestNonce) {
      return { target: target.address, status: 'nonce-or-chain-changed-before-broadcast', hash };
    }
    journal.transaction.attempts[0].broadcastCount = 1;
    writeJournal(path, journal);
    try {
      const sent = await provider.broadcastTransaction(raw);
      if (sent.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC returned another transaction hash.');
      journal.transaction.phase = 'broadcast'; writeJournal(path, journal);
      return { target: target.address, status: 'broadcast', hash, owedWei: owed.toString() };
    } catch {
      return { target: target.address, status: 'broadcast-result-unknown', hash,
        message: 'Signed bytes remain in the private journal. Reconcile this hash before another wallet transaction.' };
    }
  } finally { releaseWallet?.(); releaseJournal(); }
}

export async function runTreasuryCycle(provider, options, signer = null) {
  const account = signer?.address ?? options.account;
  if (!account) throw new Error('A public treasury address is required for read-only mode.');
  if (options.send && !signer) throw new Error('Send mode requires the treasury signer.');
  // Receipt recovery has priority over discovery. A credit can disappear as soon
  // as the pending withdrawal mines, while the wallet nonce still needs finality.
  const pending = options.send ? unresolvedTreasuryJournal(options) : null;
  if (pending) return { status: 'recovering', result: await collectOne(provider, options, signer, pending) };
  if (options.send && (options.rebroadcast || options.speedUp || options.cancelPending)) {
    return { status: 'no-unresolved-fee-transaction' };
  }
  const snapshot = await discoverTreasuryCredits(provider, options, account);
  if (!options.send) return { status: 'read-only', ...snapshot,
    targets: snapshot.targets.map(target => ({ ...target, owedWei: target.owedWei.toString() })) };
  if (!signer || !same(signer.address, snapshot.treasury)) throw new Error('The configured signer is not the Factory treasury.');
  if (!snapshot.targets.length) return { status: 'nothing-owed', blockNumber: snapshot.blockNumber, poolCount: snapshot.poolCount };
  // One send per invocation: mining/purchase tasks get the next chance at the shared operator nonce.
  return { status: 'checked', blockNumber: snapshot.blockNumber, poolCount: snapshot.poolCount,
    result: await collectOne(provider, options, signer, snapshot.targets[0]) };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseTreasuryArguments(args);
  if (options.help) {
    console.log('Read-only: node scripts/treasury-collector.mjs --factory 0x...\n' +
      'Opt-in BNB withdrawal: --journal-dir /private/treasury --send (reads systemd keeper-private-key credential or KEEPER_PRIVATE_KEY).\n' +
      'One transaction maximum per invocation. Schedule after purchase/mining keepers, using their shared wallet lock.\n' +
      'An unresolved signed nonce blocks new work. Explicit recovery: --send --rebroadcast, --speed-up or --cancel-pending.');
    return;
  }
  const request = new FetchRequest(options.rpc); request.timeout = 15_000;
  const provider = new JsonRpcProvider(request);
  let signer = null;
  if (options.send) {
    const key = readKeeperPrivateKey();
    signer = new Wallet(key, provider);
    mkdirSync(options.journalDir, { recursive: true, mode: 0o700 });
    if ((statSync(options.journalDir).mode & 0o077) !== 0) throw new Error('Journal directory must be private (0700).');
  } else {
    const factory = new Contract(options.factory, FACTORY_ABI, provider);
    options.account = await factory.treasury();
  }
  const result = await runTreasuryCycle(provider, options, signer);
  console.log(json({ at: new Date().toISOString(), ...result }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(error => {
  let key;
  try { key = readKeeperPrivateKey(); } catch { /* Read-only mode has no key. */ }
  const message = String(error.shortMessage ?? error.message).replace(/0x[0-9a-f]{130,}/ig, '[signed-data-redacted]');
  console.error(key ? message.split(key).join('[redacted]') : message); process.exitCode = 1;
});
