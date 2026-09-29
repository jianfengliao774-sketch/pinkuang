import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getAddress,
  keccak256, parseEther, parseUnits, verifyTypedData } from 'ethers';
import { acquireKeeperLock, acquireWalletLock, gasBudget, readJournal, reconcilePending, writeJournal } from './purchase-keeper.mjs';
import { readKeeperPrivateKey } from './keeper-credential.mjs';
import { authorityTypedAction } from '../shared/authority-typed.mjs';

const abi = new Interface([
  'function administratorOne() view returns(address)', 'function administratorTwo() view returns(address)',
  'function gasWallet() view returns(address)',
  'function nonces(address) view returns(uint256)',
  'function reviewSale(address,address,uint256,uint128,bool,uint256,uint256,bytes)',
  'function reviewChildSale(address,uint256,bool,uint256,uint256,bytes)',
  'function setSaleReference(address,address,uint128,uint64,bytes32,uint256,uint256,bytes)',
  'function claimFees(address[],address[],address,uint256,uint256,bytes)',
  'function executeOperation(address,bytes) returns(bytes)',
  'function executeApprovedOperation(address,bytes,uint256,uint256,bytes) returns(bytes)',
  'function buyBudgetOfficial(address,address,uint256,uint256,uint256,uint256,bytes) returns(uint256)',
  'function buyBudgetFirsto(address,address,bytes,uint256,uint256,uint256,bytes) returns(uint256)',
]);
const same = (a, b) => getAddress(a) === getAddress(b);
const mineSelector = new Interface(['function mine(bytes)']).getFunction('mine').selector;
const calldata = data => typeof data === 'string' && /^0x[0-9a-f]{8}(?:[0-9a-f]{2})*$/i.test(data);

export async function authorityGasLimit(_provider, _transaction, fixedLimit) {
  if (fixedLimit === undefined) throw new Error('Authority send requires an explicit reviewed Gas limit.');
  const value = BigInt(fixedLimit);
  if (value <= 0n || value > 10_000_000n) throw new Error('Authority Gas limit must be 1–10,000,000.');
  return value;
}

export function prepareAuthorityCall(command) {
  const authority = getAddress(command.authority);
  const expectedCodehash = command.expectedCodehash;
  if (expectedCodehash !== undefined && !/^0x[0-9a-f]{64}$/i.test(expectedCodehash)) {
    throw new Error('Expected Authority runtime codehash is invalid.');
  }
  const kind = command.kind;
  if (!['reviewSale', 'reviewChildSale', 'setSaleReference', 'claimFees', 'executeOperation',
    'executeApprovedOperation', 'buyBudgetOfficial', 'buyBudgetFirsto'].includes(kind)) {
    throw new Error('Unsupported authority action.');
  }
  const args = command.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Missing action parameters.');
  if (kind === 'executeOperation') {
    if (!calldata(args.data) || args.data.slice(0,10).toLowerCase() !== mineSelector)
      throw new Error('Only a registered miner mine(bytes) call can be relayed without an administrator signature.');
    return { authority, expectedCodehash, kind,
      data: abi.encodeFunctionData(kind, [getAddress(args.target), args.data]) };
  }
  const nonce = BigInt(command.nonce), deadline = BigInt(command.deadline);
  if (nonce < 0n || deadline <= 0n || typeof command.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(command.signature)) {
    throw new Error('Invalid administrator signature, nonce or deadline.');
  }
  let target, data, signer;
  if (kind === 'reviewSale') {
    target = getAddress(args.market);
    data = abi.encodeFunctionData(kind, [target, args.pool, args.proposalId, args.priceWei,
      args.approved, nonce, deadline, command.signature]);
  } else if (kind === 'reviewChildSale') {
    target = getAddress(args.portfolio);
    data = abi.encodeFunctionData(kind, [target, args.proposalId, args.approved, nonce, deadline, command.signature]);
  } else if (kind === 'setSaleReference') {
    target = getAddress(args.market);
    data = abi.encodeFunctionData(kind, [target, args.pool, args.priceWei, args.observedAt,
      args.digest, nonce, deadline, command.signature]);
  } else if (kind === 'executeApprovedOperation') {
    if (!calldata(args.data)) throw new Error('Approved operation calldata is invalid.');
    target = getAddress(args.target);
    data = abi.encodeFunctionData(kind, [target,args.data,nonce,deadline,command.signature]);
  } else if (kind === 'buyBudgetOfficial') {
    target = getAddress(args.portfolio);
    const child = getAddress(args.child), listingId = BigInt(args.listingId), maxCost = BigInt(args.maxCost);
    if (listingId < 0n || maxCost <= 0n) throw new Error('Budget listing and maxCost are invalid.');
    data = abi.encodeFunctionData(kind,[target,child,listingId,maxCost,nonce,deadline,command.signature]);
  } else if (kind === 'buyBudgetFirsto') {
    target = getAddress(args.portfolio);
    const child = getAddress(args.child), maxCost = BigInt(args.maxCost);
    if (maxCost <= 0n || typeof args.encodedOrder !== 'string'
      || !/^0x[0-9a-f]+$/i.test(args.encodedOrder) || args.encodedOrder.length % 2 !== 0)
      throw new Error('Budget Firsto order or maxCost is invalid.');
    data = abi.encodeFunctionData(kind,[target,child,args.encodedOrder,maxCost,nonce,deadline,command.signature]);
  } else {
    target = authority;
    signer = getAddress(args.recipient);
    if (!Array.isArray(args.markets) || !Array.isArray(args.pools)) throw new Error('Fee sources must be arrays.');
    data = abi.encodeFunctionData(kind, [args.markets, args.pools, signer, nonce, deadline, command.signature]);
  }
  const { domain, types, primaryType, message } = authorityTypedAction(authority, kind, args, nonce, deadline);
  const recovered = verifyTypedData(domain, types, message, command.signature);
  if (signer && !same(recovered, signer)) throw new Error('Fee recipient must be the administrator who signed.');
  return { authority, expectedCodehash, kind, data, signer: recovered, nonce, deadline,
    domain, types, primaryType, value: message };
}

export function parseAuthorityArguments(args) {
  const values = {};
  const keys = new Set(['command', 'journal', 'rpc', 'max-gas-bnb', 'max-gas-price-gwei',
    'gas-limit', 'expected-hash', 'acknowledge-failure']);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!key || Object.hasOwn(values, key)) throw new Error(`Invalid or repeated option: ${args[i]}`);
    if (['send', 'help', 'rebroadcast-signed'].includes(key)) values[key] = true;
    else if (keys.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) values[key] = args[++i];
    else throw new Error(`Unknown option or missing value: --${key}`);
  }
  if (values.help) return { help: true };
  if (!values.command) throw new Error('--command is required.');
  if (values.send && !values.journal) throw new Error('--send requires a private journal path.');
  if (values['acknowledge-failure'] && (!values.journal || values.send || values['rebroadcast-signed']
    || !/^0x[0-9a-f]{64}$/i.test(values['acknowledge-failure'])))
    throw new Error('Failure acknowledgement requires a private journal, exact hash and no send flags.');
  if (values.send && !values['rebroadcast-signed'] && !values['gas-limit'])
    throw new Error('New Authority sends require an explicit reviewed --gas-limit; no simulation is performed.');
  if (values['rebroadcast-signed'] && (!values.send || !/^0x[0-9a-f]{64}$/i.test(values['expected-hash'] ?? '')))
    throw new Error('Manual rebroadcast requires --send and the exact --expected-hash.');
  if (values['expected-hash'] && !values['rebroadcast-signed']) throw new Error('--expected-hash requires --rebroadcast-signed.');
  const gasLimit = values['gas-limit'] === undefined ? undefined : BigInt(values['gas-limit']);
  if (gasLimit !== undefined && (gasLimit <= 0n || gasLimit > 10_000_000n))
    throw new Error('--gas-limit must be 1–10,000,000.');
  const rpc = values.rpc ?? 'https://bsc-dataseed.bnbchain.org', url = new URL(rpc);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) {
    throw new Error('Use HTTPS RPC (HTTP loopback is for local tests only).');
  }
  const maxGasWei = parseEther(values['max-gas-bnb'] ?? '0.01');
  const maxGasPrice = parseUnits(values['max-gas-price-gwei'] ?? '1', 'gwei');
  if (maxGasWei <= 0n || maxGasPrice <= 0n) throw new Error('Gas limits must be positive.');
  return { command: resolve(values.command), journal: resolve(values.journal ?? 'keeper-journal/authority.json'),
    rpc, send: values.send === true, maxGasWei, maxGasPrice,
    gasLimit, rebroadcastSigned: values['rebroadcast-signed'] === true,
    expectedHash: values['expected-hash']?.toLowerCase(),
    acknowledgeFailure: values['acknowledge-failure']?.toLowerCase() };
}

export async function acknowledgeFinalizedAuthorityFailure(provider, options, journal) {
  const tx = journal.transaction;
  if (tx?.phase !== 'reverted'
    || !options.acknowledgeFailure || tx.hash.toLowerCase() !== options.acknowledgeFailure
    || tx.finality !== 'bsc-finalized' || !journal.gasReceipts?.[tx.hash])
    throw new Error('Only the exact finalized failed Authority transaction can be manually acknowledged.');
  const [network, transaction, receipt, finalized, latest, queued] = await Promise.all([
    provider.getNetwork(), provider.getTransaction(tx.hash), provider.getTransactionReceipt(tx.hash),
    provider.getBlock('finalized'), provider.getTransactionCount(tx.from, 'latest'),
    provider.getTransactionCount(tx.from, 'pending'),
  ]);
  if (network.chainId !== 56n || !transaction || !receipt || !finalized
    || receipt.hash.toLowerCase() !== tx.hash.toLowerCase()
    || transaction.hash.toLowerCase() !== tx.hash.toLowerCase()
    || !same(transaction.from, tx.from) || !same(transaction.to, tx.to)
    || !same(receipt.from, tx.from) || !same(receipt.to, tx.to)
    || transaction.nonce !== tx.nonce || transaction.data.toLowerCase() !== tx.data.toLowerCase()
    || transaction.value !== 0n || transaction.chainId !== 56n
    || receipt.blockNumber !== tx.blockNumber || receipt.blockHash.toLowerCase() !== tx.blockHash.toLowerCase()
    || receipt.status !== 0
    || finalized.number < receipt.blockNumber || latest <= tx.nonce || queued < latest
    || journal.gasReceipts[tx.hash] !== tx.gasCostWei)
    throw new Error('Finalized receipt, transaction identity, wallet nonce or Gas ledger changed; retain review hold.');
  const canonical = await provider.getBlock(receipt.blockNumber);
  if (!canonical || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
    throw new Error('Failure receipt is not canonical; retain review hold.');
  const gasCost = receipt.fee ?? (receipt.gasUsed * receipt.gasPrice);
  if (typeof gasCost !== 'bigint' || gasCost.toString() !== tx.gasCostWei)
    throw new Error('Failure receipt Gas cost differs from the private ledger; retain review hold.');
  const reviewed = journal.reviewedAuthorityFailures ?? [];
  if (!Array.isArray(reviewed) || reviewed.length >= 1000)
    throw new Error('Review history is full or malformed; archive the private journal first.');
  reviewed.push({ hash: tx.hash, phase: tx.phase, nonce: tx.nonce,
    finalizedBlockNumber: finalized.number, acknowledgedAt: new Date().toISOString() });
  journal.reviewedAuthorityFailures = reviewed;
  journal.previousTransaction = tx;
  journal.transaction = null;
  writeJournal(options.journal, journal);
  return { status: 'failure-acknowledged', hash: tx.hash,
    message: 'The finalized failure is archived. This command did not sign or broadcast a transaction.' };
}

export async function manuallyRebroadcastSigned(provider, options, signer, prepared, journal, pendingResult) {
  const pending = journal.transaction, attempt = pending?.attempts?.[0];
  if (pendingResult?.status !== 'pending-not-indexed' || pending?.phase !== 'signed'
    || pending.attempts?.length !== 1 || attempt?.broadcastCount !== 0
    || !options.expectedHash || pending.hash.toLowerCase() !== options.expectedHash
    || attempt.hash.toLowerCase() !== options.expectedHash
    || pending.kind !== prepared.kind || !same(pending.to, prepared.authority)
    || pending.data.toLowerCase() !== prepared.data.toLowerCase()
    || !same(pending.from, signer.address)) {
    throw new Error('Manual recovery must name the exact unbroadcast signed transaction and original administrator action.');
  }
  const [network, latest, queued, balance] = await Promise.all([
    provider.getNetwork(), provider.getTransactionCount(signer.address, 'latest'),
    provider.getTransactionCount(signer.address, 'pending'), provider.getBalance(signer.address),
  ]);
  if (network.chainId !== 56n || latest !== pending.nonce || queued !== pending.nonce)
    return { status: 'nonce-or-chain-changed-before-broadcast', hash: pending.hash };
  const gasPrice = BigInt(attempt.gasPrice), gasLimit = BigInt(attempt.gasLimit);
  const budget = gasBudget(journal, gasLimit, gasPrice, options.maxGasWei);
  if (gasPrice > options.maxGasPrice || !budget.allowed || balance < budget.reservedFee)
    return { status: 'gas-budget-or-balance-exceeded', hash: pending.hash };
  attempt.broadcastCount = 1;
  writeJournal(options.journal, journal);
  try {
    const sent = await provider.broadcastTransaction(attempt.raw);
    if (sent.hash.toLowerCase() !== pending.hash.toLowerCase()) throw new Error('RPC returned another transaction hash.');
    pending.phase = 'broadcast'; writeJournal(options.journal, journal);
    return { status: 'broadcast', hash: pending.hash, kind: pending.kind };
  } catch {
    return { status: 'broadcast-result-unknown', hash: pending.hash,
      message: 'Exact signed bytes were submitted but the RPC result is uncertain. Reconcile the receipt before another Gas-wallet action.' };
  }
}

export async function runAuthorityRelay(provider, options, signer = null) {
  const command = options.commandObject ?? JSON.parse(readFileSync(options.command, 'utf8'));
  const prepared = prepareAuthorityCall(command);
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Authority relay only supports BSC mainnet.');
  if (options.acknowledgeFailure) {
    const journalOptions = { factory: prepared.authority, pool: prepared.authority,
      transactionTarget: prepared.authority, journal: options.journal };
    return acknowledgeFinalizedAuthorityFailure(provider, options,
      readJournal(options.journal, journalOptions));
  }
  if (options.send && !prepared.expectedCodehash) {
    throw new Error('Send mode requires the independently reviewed Authority runtime codehash.');
  }
  let journal;
  let pendingResult;
  if (options.send) {
    if (!signer) throw new Error('Send mode requires the Gas wallet credential.');
    const journalOptions = { factory: prepared.authority, pool: prepared.authority,
      transactionTarget: prepared.authority, journal: options.journal };
    journal = readJournal(options.journal, journalOptions);
    if (journal.transaction && !same(journal.transaction.from, signer.address)) throw new Error('Journal belongs to another Gas wallet.');
    pendingResult = await reconcilePending(provider, journalOptions, journal);
    if (pendingResult && !options.rebroadcastSigned) return {
      status: journal.transaction?.phase === 'signed'
        && journal.transaction.attempts?.[0]?.broadcastCount === 0
        && pendingResult.status === 'pending-not-indexed' ? 'signed-awaiting-manual-broadcast'
        : journal.transaction?.phase === 'signed' && pendingResult.status === 'pending-not-indexed'
          ? 'broadcast-result-unknown' : pendingResult.status,
      hash: pendingResult.hash, kind: journal.transaction?.kind,
      message: journal.transaction?.phase === 'signed'
        && journal.transaction.attempts?.[0]?.broadcastCount === 0
        && pendingResult.status === 'pending-not-indexed'
        ? 'Signed bytes and hash are durable; only an explicit, hash-pinned manual rebroadcast may send these exact bytes.'
        : pendingResult.message };
    if (['reverted', 'cancelled', 'cancel-reverted'].includes(journal.transaction?.phase)) {
      return { status: 'previous-operation-failed-review-required', hash: journal.transaction.hash,
        kind: journal.transaction.kind };
    }
  }
  const authority = new Contract(prepared.authority, abi, provider);
  const [code, first, second, gasWallet] = await Promise.all([
    provider.getCode(prepared.authority), authority.administratorOne(), authority.administratorTwo(), authority.gasWallet(),
  ]);
  if (code === '0x') throw new Error('Authority contract has no code.');
  if (prepared.expectedCodehash && keccak256(code).toLowerCase() !== prepared.expectedCodehash.toLowerCase()) {
    throw new Error('Authority runtime differs from the reviewed deployment proof.');
  }
  if (prepared.signer && !same(prepared.signer, first) && !same(prepared.signer, second)) {
    throw new Error('Signature is not from a current administrator.');
  }
  if (prepared.deadline && BigInt(Math.floor(Date.now() / 1000)) > prepared.deadline) throw new Error('Administrator signature expired.');
  if (prepared.signer && await authority.nonces(prepared.signer) !== prepared.nonce) {
    throw new Error('Administrator signature nonce is not current.');
  }
  if (!options.send) return { status: 'read-only', kind: prepared.kind, authority: prepared.authority,
    signer: prepared.signer, gasWallet: getAddress(gasWallet), calldataHash: keccak256(prepared.data) };
  if (!signer || !same(signer.address, gasWallet)) throw new Error('Keeper credential is not the current authority Gas wallet.');
  if (options.rebroadcastSigned)
    return manuallyRebroadcastSigned(provider, options, signer, prepared, journal, pendingResult);
  // Both HTTP and CLI paths require a reviewed fixed bound. Never run a
  // pre-send eth_estimateGas simulation here.
  const [gasLimit, fee, balance, latestNonce, pendingNonce, latestBlock] = await Promise.all([
    authorityGasLimit(provider,
      { from: signer.address, to: prepared.authority, data: prepared.data, value: 0n }, options.gasLimit),
    provider.getFeeData(), provider.getBalance(signer.address),
    provider.getTransactionCount(signer.address, 'latest'), provider.getTransactionCount(signer.address, 'pending'),
    provider.getBlock('latest'),
  ]);
  if (latestNonce !== pendingNonce) return { status: 'gas-wallet-has-pending-transaction' };
  if (!fee.gasPrice || fee.gasPrice > options.maxGasPrice) return { status: 'gas-price-over-limit' };
  if (!latestBlock || gasLimit <= 0n || gasLimit > latestBlock.gasLimit) return { status: 'gas-exceeds-block-limit' };
  const budget = gasBudget(journal, gasLimit, fee.gasPrice, options.maxGasWei);
  if (!budget.allowed || balance < budget.reservedFee) return { status: 'gas-budget-or-balance-exceeded' };
  const raw = await signer.signTransaction({ type: 0, chainId: 56, to: prepared.authority,
    data: prepared.data, value: 0n, nonce: latestNonce, gasLimit, gasPrice: fee.gasPrice });
  const hash = keccak256(raw);
  if (journal.transaction) journal.previousTransaction = journal.transaction;
  journal.transaction = { phase: 'signed', kind: prepared.kind, from: signer.address, nonce: latestNonce, to: prepared.authority,
    data: prepared.data, value: '0', createdAt: new Date().toISOString(), hash, speedUps: 0,
    attempts: [{ kind: 'purchase', raw, hash, gasLimit: gasLimit.toString(), gasPrice: fee.gasPrice.toString(),
      createdAt: new Date().toISOString(), broadcastCount: 0 }] };
  writeJournal(options.journal, journal);
  const [network, latestAgain, pendingAgain] = await Promise.all([
    provider.getNetwork(), provider.getTransactionCount(signer.address, 'latest'),
    provider.getTransactionCount(signer.address, 'pending'),
  ]);
  if (network.chainId !== 56n || latestAgain !== latestNonce || pendingAgain !== latestNonce) {
    return { status: 'nonce-or-chain-changed-before-broadcast', hash };
  }
  journal.transaction.attempts[0].broadcastCount = 1;
  writeJournal(options.journal, journal);
  try {
    const sent = await provider.broadcastTransaction(raw);
    if (sent.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC returned another transaction hash.');
    journal.transaction.phase = 'broadcast'; writeJournal(options.journal, journal);
    return { status: 'broadcast', hash, kind: prepared.kind };
  } catch {
    return { status: 'broadcast-result-unknown', hash,
      message: 'Signed bytes are durable. Resolve this receipt before another Gas-wallet operation.' };
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseAuthorityArguments(args);
  if (options.help) {
    console.log('Authority relay: node scripts/authority-relay.mjs --command /private/action.json --journal /private/authority.json [--send --gas-limit N].\n' +
      'Default read-only. Send mode reads a systemd keeper-private-key credential or KEEPER_PRIVATE_KEY.\n' +
      'Manual recovery: add --send --rebroadcast-signed --expected-hash 0x... to send only the exact durable signed bytes.\n' +
      'After independently reviewing a BSC-finalized failure, --acknowledge-failure 0x... archives the hold without sending.\n' +
      'Only use command files from a private operator-controlled directory; admin signatures never grant arbitrary targets.');
    return;
  }
  if (options.send) {
    const file = lstatSync(options.command);
    if (!file.isFile() || (file.mode & 0o077) !== 0
      || (statSync(dirname(options.command)).mode & 0o077) !== 0) {
      throw new Error('Send-mode command must be a regular private 0600 file.');
    }
  }
  const releaseJournal = acquireKeeperLock(options.journal);
  let releaseWallet;
  try {
    const request = new FetchRequest(options.rpc); request.timeout = 15_000;
    const provider = new JsonRpcProvider(request);
    let signer = null;
    if (options.send) {
      try { signer = new Wallet(readKeeperPrivateKey(), provider); }
      catch { throw new Error('Gas credential is unavailable or invalid.'); }
      mkdirSync(dirname(options.journal), { recursive: true, mode: 0o700 });
      if ((statSync(dirname(options.journal)).mode & 0o077) !== 0) throw new Error('Journal directory must be private (0700).');
      releaseWallet = acquireWalletLock(signer.address, options.journal);
      if (!existsSync(options.journal)) {
        const command = prepareAuthorityCall(JSON.parse(readFileSync(options.command, 'utf8')));
        writeJournal(options.journal, readJournal(options.journal,
          { factory: command.authority, pool: command.authority, transactionTarget: command.authority }));
      }
    }
    console.log(JSON.stringify(await runAuthorityRelay(provider, options, signer)));
  } finally { releaseWallet?.(); releaseJournal(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(error => {
  console.error(String(error.shortMessage ?? error.message).replace(/0x[0-9a-f]{130,}/ig, '[signed-data-redacted]').slice(0, 300));
  process.exitCode = 1;
});
