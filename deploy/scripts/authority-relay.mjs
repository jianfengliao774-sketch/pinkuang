import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getAddress,
  keccak256, parseEther, parseUnits, toUtf8Bytes, verifyTypedData } from 'ethers';
import { acquireKeeperLock, acquireWalletLock, gasBudget, readJournal, reconcilePending, writeJournal } from './purchase-keeper.mjs';
import { readKeeperPrivateKey } from './keeper-credential.mjs';

const abi = new Interface([
  'function administratorOne() view returns(address)', 'function administratorTwo() view returns(address)',
  'function gasWallet() view returns(address)',
  'function nonces(address) view returns(uint256)',
  'function reviewSale(address,address,uint256,uint128,bool,uint256,uint256,bytes)',
  'function reviewChildSale(address,uint256,bool,uint256,uint256,bytes)',
  'function setSaleReference(address,address,uint128,uint64,bytes32,uint256,uint256,bytes)',
  'function claimFees(address[],address[],address,uint256,uint256,bytes)',
  'function executeOperation(address,bytes) returns(bytes)',
]);
const coder = AbiCoder.defaultAbiCoder();
const TYPES = { Action: [
  { name: 'kind', type: 'bytes32' }, { name: 'target', type: 'address' },
  { name: 'paramsHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] };
const kindHash = name => keccak256(toUtf8Bytes(name));
const same = (a, b) => getAddress(a) === getAddress(b);

export function prepareAuthorityCall(command) {
  const authority = getAddress(command.authority);
  const kind = command.kind;
  if (!['reviewSale', 'reviewChildSale', 'setSaleReference', 'claimFees', 'executeOperation'].includes(kind)) {
    throw new Error('Unsupported authority action.');
  }
  const args = command.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Missing action parameters.');
  if (kind === 'executeOperation') {
    if (typeof args.data !== 'string' || !/^0x[0-9a-f]{8}(?:[0-9a-f]{2})*$/i.test(args.data)) {
      throw new Error('Routine operation calldata is invalid.');
    }
    return { authority, kind, data: abi.encodeFunctionData(kind, [getAddress(args.target), args.data]) };
  }
  const nonce = BigInt(command.nonce), deadline = BigInt(command.deadline);
  if (nonce < 0n || deadline <= 0n || typeof command.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(command.signature)) {
    throw new Error('Invalid administrator signature, nonce or deadline.');
  }
  let target, paramsHash, data, signer;
  if (kind === 'reviewSale') {
    target = getAddress(args.market);
    paramsHash = keccak256(coder.encode(['address', 'uint256', 'uint128', 'bool'],
      [getAddress(args.pool), args.proposalId, args.priceWei, args.approved]));
    data = abi.encodeFunctionData(kind, [target, args.pool, args.proposalId, args.priceWei,
      args.approved, nonce, deadline, command.signature]);
  } else if (kind === 'reviewChildSale') {
    target = getAddress(args.portfolio);
    paramsHash = keccak256(coder.encode(['uint256', 'bool'], [args.proposalId, args.approved]));
    data = abi.encodeFunctionData(kind, [target, args.proposalId, args.approved, nonce, deadline, command.signature]);
  } else if (kind === 'setSaleReference') {
    target = getAddress(args.market);
    paramsHash = keccak256(coder.encode(['address', 'uint128', 'uint64', 'bytes32'],
      [getAddress(args.pool), args.priceWei, args.observedAt, args.digest]));
    data = abi.encodeFunctionData(kind, [target, args.pool, args.priceWei, args.observedAt,
      args.digest, nonce, deadline, command.signature]);
  } else {
    target = authority;
    signer = getAddress(args.recipient);
    if (!Array.isArray(args.markets) || !Array.isArray(args.pools)) throw new Error('Fee sources must be arrays.');
    paramsHash = keccak256(coder.encode(['address[]', 'address[]', 'address'],
      [args.markets.map(getAddress), args.pools.map(getAddress), signer]));
    data = abi.encodeFunctionData(kind, [args.markets, args.pools, signer, nonce, deadline, command.signature]);
  }
  const domain = { name: 'BEMine Platform Authority', version: '1', chainId: 56, verifyingContract: authority };
  const value = { kind: kindHash({ reviewSale: 'REVIEW_SALE', reviewChildSale: 'REVIEW_CHILD_SALE',
    setSaleReference: 'SALE_REFERENCE', claimFees: 'CLAIM_FEES' }[kind]), target, paramsHash, nonce, deadline };
  const recovered = verifyTypedData(domain, TYPES, value, command.signature);
  if (signer && !same(recovered, signer)) throw new Error('Fee recipient must be the administrator who signed.');
  return { authority, kind, data, signer: recovered, nonce, deadline, domain, types: TYPES, value };
}

export function parseAuthorityArguments(args) {
  const values = {};
  const keys = new Set(['command', 'journal', 'rpc', 'max-gas-bnb', 'max-gas-price-gwei']);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!key || Object.hasOwn(values, key)) throw new Error(`Invalid or repeated option: ${args[i]}`);
    if (['send', 'help'].includes(key)) values[key] = true;
    else if (keys.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) values[key] = args[++i];
    else throw new Error(`Unknown option or missing value: --${key}`);
  }
  if (values.help) return { help: true };
  if (!values.command) throw new Error('--command is required.');
  if (values.send && !values.journal) throw new Error('--send requires a private journal path.');
  const rpc = values.rpc ?? 'https://bsc-dataseed.bnbchain.org', url = new URL(rpc);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) {
    throw new Error('Use HTTPS RPC (HTTP loopback is for local tests only).');
  }
  const maxGasWei = parseEther(values['max-gas-bnb'] ?? '0.01');
  const maxGasPrice = parseUnits(values['max-gas-price-gwei'] ?? '1', 'gwei');
  if (maxGasWei <= 0n || maxGasPrice <= 0n) throw new Error('Gas limits must be positive.');
  return { command: resolve(values.command), journal: resolve(values.journal ?? 'keeper-journal/authority.json'),
    rpc, send: values.send === true, maxGasWei, maxGasPrice };
}

export async function runAuthorityRelay(provider, options, signer = null) {
  const command = JSON.parse(readFileSync(options.command, 'utf8'));
  const prepared = prepareAuthorityCall(command);
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Authority relay only supports BSC mainnet.');
  let journal;
  if (options.send) {
    if (!signer) throw new Error('Send mode requires the Gas wallet credential.');
    const journalOptions = { factory: prepared.authority, pool: prepared.authority,
      transactionTarget: prepared.authority, journal: options.journal };
    journal = readJournal(options.journal, journalOptions);
    if (journal.transaction && !same(journal.transaction.from, signer.address)) throw new Error('Journal belongs to another Gas wallet.');
    const pending = await reconcilePending(provider, journalOptions, journal);
    if (pending) return { status: pending.status, hash: pending.hash, message: pending.message };
    if (['reverted', 'cancelled', 'cancel-reverted'].includes(journal.transaction?.phase)) {
      return { status: 'previous-operation-failed-review-required', hash: journal.transaction.hash };
    }
  }
  const authority = new Contract(prepared.authority, abi, provider);
  const [code, first, second, gasWallet] = await Promise.all([
    provider.getCode(prepared.authority), authority.administratorOne(), authority.administratorTwo(), authority.gasWallet(),
  ]);
  if (code === '0x') throw new Error('Authority contract has no code.');
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
  const [gasEstimate, fee, balance, latestNonce, pendingNonce, latestBlock] = await Promise.all([
    provider.estimateGas({ from: signer.address, to: prepared.authority, data: prepared.data, value: 0n }),
    provider.getFeeData(), provider.getBalance(signer.address),
    provider.getTransactionCount(signer.address, 'latest'), provider.getTransactionCount(signer.address, 'pending'),
    provider.getBlock('latest'),
  ]);
  if (latestNonce !== pendingNonce) return { status: 'gas-wallet-has-pending-transaction' };
  if (!fee.gasPrice || fee.gasPrice > options.maxGasPrice) return { status: 'gas-price-over-limit' };
  const gasLimit = (gasEstimate * 120n + 99n) / 100n;
  if (!latestBlock || gasLimit > latestBlock.gasLimit) return { status: 'gas-exceeds-block-limit' };
  const budget = gasBudget(journal, gasLimit, fee.gasPrice, options.maxGasWei);
  if (!budget.allowed || balance < budget.reservedFee) return { status: 'gas-budget-or-balance-exceeded' };
  const raw = await signer.signTransaction({ type: 0, chainId: 56, to: prepared.authority,
    data: prepared.data, value: 0n, nonce: latestNonce, gasLimit, gasPrice: fee.gasPrice });
  const hash = keccak256(raw);
  if (journal.transaction) journal.previousTransaction = journal.transaction;
  journal.transaction = { phase: 'signed', from: signer.address, nonce: latestNonce, to: prepared.authority,
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
    console.log('Authority relay: node scripts/authority-relay.mjs --command /private/action.json --journal /private/authority.json [--send].\n' +
      'Default read-only. Send mode reads a systemd keeper-private-key credential or KEEPER_PRIVATE_KEY.\n' +
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
      signer = new Wallet(readKeeperPrivateKey(), provider);
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
