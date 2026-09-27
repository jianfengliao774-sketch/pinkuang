import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { JsonRpcProvider, Interface, getAddress, getCreateAddress, keccak256, verifyMessage } from 'ethers';
import { fileURLToPath } from 'node:url';
import { JournalConflict, JournalStore } from './journal-store.mjs';

const MAX_BODY = 64 * 1024;
const CHALLENGE_MS = 5 * 60_000;
const SESSION_MS = 12 * 60 * 60_000;
const TOKEN_COOKIE = 'pinkuang_journal';
const HASH = /^0x[\da-f]{64}$/i;
const DATA = /^0x(?:[\da-f]{2})*$/i;
const DECIMAL = /^(0|[1-9]\d*)$/;
const CHALLENGE = /^[A-Za-z0-9_-]{32}$/;
const STATUSES = new Set(['ready','running','paused','failed','aborted','complete']);
const STEP_STATUSES = new Set(['waiting','signing','submitted','confirmed','rejected','failed','uncertain','cancelled','replaced']);
const LIBRARY_STEPS = new Set(['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation',
  'RewardAccounting','SaleGovernance','SaleSettlement','ShareCheckpoints']);
const FINAL_STEPS = ['AtomicDeployment','PoolVault','PoolFactory','ShareMarket','initialize'];
// Product intents are deliberately narrower than either contract's complete ABI.
// There is no arbitrary call, approval, upgrade, operator purchase or admin route.
export const PRODUCT_POOL_ABI = new Interface([
  'function deposit(uint8 shares) payable', 'function withdrawDeposit()', 'function finalizeFailure()',
  'function harvest()', 'function claim()', 'function withdrawBnb()',
  'function propose(uint256 price,uint256 refPrice,uint64 refAt)', 'function vote(uint256 proposalId,bool support)',
  'function executeSale(uint256 proposalId)', 'function cancelExpired()', 'function completeSale() payable',
  'event Deposited(address indexed user,uint8 shares,uint256 amount,uint256 totalRaised)',
]);
export const PRODUCT_MARKET_ABI = new Interface([
  'function list(address pool,uint256 amount,uint256 pricePerUnit)', 'function fill(uint256 orderId,uint256 amount) payable',
  'function cancel(uint256 orderId)', 'function expire(uint256 orderId)', 'function withdrawBnb()',
]);
const IDENTITY_ABI = new Interface([
  'function isPool(address) view returns(bool)', 'function shareMarket() view returns(address)',
  'function factory() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function unitPriceWei() view returns(uint256)', 'function salePrice() view returns(uint256)',
  'function orders(uint256) view returns(tuple(address seller,address pool,uint256 remaining,uint256 pricePerUnit,bool active))',
]);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ApiError(status, message); };
const identity = value => {
  try { return getAddress(value).toLowerCase(); }
  catch { fail(400, 'Invalid wallet or contract address.'); }
};
const exactRevision = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'Invalid expectedRevision.');
  return value;
};
const hashed = value => createHash('sha256').update(value).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const recordedAddressMatches = (value, expected) => typeof value === 'string'
  && /^0x[\da-f]{40}$/i.test(value) && value.toLowerCase() === expected;

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail(415, 'JSON content type is required.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) fail(413, 'Request body is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!isRecord(value)) throw new Error(); return value; }
  catch { fail(400, 'Invalid JSON object.'); }
}

function validateDeployment(value, account) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.chainId !== 56 || identity(value.account) !== account
    || typeof value.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.id)
    || typeof value.sourceCommit !== 'string' || !/^[\da-f]{40,64}$/i.test(value.sourceCommit)
    || !HASH.test(value.artifactDigest) || !STATUSES.has(value.status)
    || !isRecord(value.input) || !/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value.input.maxGasBudgetBnb)
    || !/^(0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value.input.gasPriceCapGwei)
    || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 32
    || !isRecord(value.addresses) || !DECIMAL.test(value.spentWei)) fail(400, 'Invalid deployment record.');
  const seen = new Set();
  for (const step of value.steps) {
    if (!isRecord(step) || typeof step.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.id)
      || seen.has(step.id) || !STEP_STATUSES.has(step.status)
      || step.nonce !== undefined && (!Number.isSafeInteger(step.nonce) || step.nonce < 0)
      || step.dataHash !== undefined && !HASH.test(step.dataHash)
      || step.txHash !== undefined && !HASH.test(step.txHash)
      || step.replacementHash !== undefined && !HASH.test(step.replacementHash)) fail(400, 'Invalid deployment step.');
    seen.add(step.id);
  }
  return value;
}

function validateMarket(value, account) {
  if (value?.version === 2) return validateProduct(value, account);
  if (!isRecord(value) || value.version !== 1 || value.chainId !== 56 || identity(value.account) !== account
    || identity(value.factory) === identity(value.market) || !Number.isSafeInteger(value.nonce) || value.nonce < 0
    || !isRecord(value.action) || !['list','fill','cancel','withdraw'].includes(value.action.kind)
    || typeof value.submittedAt !== 'string' || value.submittedAt.length > 50
    || typeof value.data !== 'string' || !DATA.test(value.data) || value.data.length > 16_384
    || typeof value.value !== 'string' || !DECIMAL.test(value.value)
    || value.hash !== undefined && !HASH.test(value.hash)
    || value.recoveryHashes !== undefined && (!Array.isArray(value.recoveryHashes) || value.recoveryHashes.length > 16
      || value.recoveryHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash)))) fail(400, 'Invalid market intent.');
  validateCancellationRequests(value);
  return value;
}

function validateCancellationRequests(record) {
  if (record.cancellationRequests === undefined) return;
  if (!Array.isArray(record.cancellationRequests) || record.cancellationRequests.length > 16) fail(400, 'Invalid cancellation history.');
  for (const tx of record.cancellationRequests) {
    if (!isRecord(tx) || identity(tx.from) !== identity(record.account) || identity(tx.to) !== identity(record.account)
      || tx.chainId !== '0x38' || tx.nonce !== `0x${record.nonce.toString(16)}` || tx.data !== '0x' || tx.value !== '0x0'
      || tx.gas !== '0x5208' || tx.type !== '0x0' || typeof tx.gasPrice !== 'string' || !/^0x[\da-f]{1,16}$/i.test(tx.gasPrice)
      || BigInt(tx.gasPrice) < 1n || BigInt(tx.gasPrice) > 3_000_000_000n
      || typeof tx.createdAt !== 'string' || tx.createdAt.length > 50) fail(400, 'Invalid cancellation transaction.');
  }
}

function decodeProduct(value) {
  const contract = value.targetType === 'pool' ? PRODUCT_POOL_ABI : PRODUCT_MARKET_ABI;
  let decoded;
  try { decoded = contract.parseTransaction({ data: value.data, value: BigInt(value.value) }); }
  catch { fail(400, 'Unsupported product call.'); }
  if (!decoded || decoded.name !== value.action.kind
    || contract.encodeFunctionData(decoded.fragment, decoded.args).toLowerCase() !== value.data.toLowerCase())
    fail(400, 'Product action and exact calldata must match an allowed selector.');
  if (!['deposit','completeSale','fill'].includes(decoded.name) && value.value !== '0') fail(400, 'This product call cannot send BNB.');
  if (decoded.name === 'deposit' && (decoded.args[0] < 1n || decoded.args[0] > 100n)
    || decoded.name === 'list' && (decoded.args[1] < 1n || decoded.args[1] > 100n)
    || decoded.name === 'fill' && (decoded.args[1] < 1n || decoded.args[1] > 100n)) fail(400, 'Invalid share quantity.');
  if (decoded.name === 'propose' && decoded.args[0] === 0n) fail(400, 'Whole miner sale price must be positive.');
  return decoded;
}

function validateProduct(value, account) {
  if (!isRecord(value) || value.chainId !== 56 || identity(value.account) !== account
    || !['pool','market'].includes(value.targetType) || identity(value.factory) === identity(value.target)
    || !Number.isSafeInteger(value.nonce) || value.nonce < 0 || !isRecord(value.action)
    || typeof value.action.kind !== 'string' || typeof value.submittedAt !== 'string' || value.submittedAt.length > 50
    || typeof value.data !== 'string' || !DATA.test(value.data) || value.data.length > 1024
    || typeof value.value !== 'string' || !DECIMAL.test(value.value) || value.value.length > 78 || BigInt(value.value) >= 2n ** 256n
    || value.hash !== undefined && !HASH.test(value.hash)
    || value.recoveryHashes !== undefined && (!Array.isArray(value.recoveryHashes) || value.recoveryHashes.length > 16
      || value.recoveryHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash)))) fail(400, 'Invalid product intent.');
  decodeProduct(value);
  validateCancellationRequests(value);
  return value;
}

/** Only an explicit wallet-signed, zero-value EOA self-transfer can consume an unsent/unknown nonce. */
export async function cancellationIntent(provider, record) {
  if (!provider) fail(503, 'BSC cancellation verifier is unavailable.');
  try {
    if (BigInt(await provider.send('eth_chainId', [])) !== 56n) fail(503, 'Cancellation RPC is not BSC mainnet.');
    const [latest, pending, code, balance, fees] = await Promise.all([
      provider.getTransactionCount(record.account, 'latest'), provider.getTransactionCount(record.account, 'pending'),
      provider.getCode(record.account, 'latest'), provider.getBalance(record.account), provider.getFeeData(),
    ]);
    if (latest !== record.nonce || pending < latest || pending > latest + 1)
      fail(409, 'Recorded nonce was consumed or other transactions are queued. Recover the wallet transaction hash first.');
    if (code !== '0x') fail(409, 'Automatic cancellation is only available for a plain EOA; use the wallet recovery flow.');
    let gasPrice = fees.gasPrice;
    if (!gasPrice || gasPrice < 1n) fail(503, 'Cancellation Gas price is unavailable.');
    // A known original or previous cancellation can require a higher replacement fee.
    const knownHashes = [...new Set([record.hash, ...(record.recoveryHashes ?? [])].filter(Boolean))];
    for (const known of knownHashes) {
      const tx = await provider.getTransaction(known);
      if (tx && tx.chainId === 56n && identity(tx.from) === identity(record.account) && tx.nonce === record.nonce
        && tx.gasPrice && tx.gasPrice > gasPrice) gasPrice = tx.gasPrice;
    }
    gasPrice = (gasPrice * 120n + 99n) / 100n;
    if (gasPrice > 3_000_000_000n || balance < 21_000n * gasPrice) fail(409, 'Cancellation Gas cap exceeded or BNB balance insufficient. Use wallet recovery after reviewing fees.');
    const transaction = { chainId:'0x38', from:record.account, to:record.account, nonce:`0x${record.nonce.toString(16)}`,
      data:'0x', value:'0x0', gas:'0x5208', gasPrice:`0x${gasPrice.toString(16)}`, type:'0x0' };
    await provider.send('eth_call', [{ from:record.account,to:record.account,data:'0x',value:'0x0',gas:'0x5208' }, 'latest']);
    if (BigInt(await provider.send('eth_chainId', [])) !== 56n) fail(409, 'Chain changed during cancellation verification.');
    return transaction;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(503, 'Cancellation RPC could not be verified.');
  }
}

/** The trusted server RPC validates registration/value before issuing the first durable signing ACK. */
export async function verifyProductIntent(provider, record, allowedFactories) {
  if (!provider) fail(503, 'BSC product verifier is unavailable.');
  if (!allowedFactories.has(identity(record.factory))) fail(403, 'This Factory is not enabled for product transactions.');
  const decoded = decodeProduct(record);
  try {
    if (BigInt(await provider.send('eth_chainId', [])) !== 56n) fail(503, 'Product RPC is not BSC mainnet.');
    const block = await provider.getBlock('latest');
    if (!block?.hash) fail(503, 'Product block is unavailable.');
    const tag = `0x${block.number.toString(16)}`;
    const call = async (to, method, args = []) => IDENTITY_ABI.decodeFunctionResult(method,
      await provider.send('eth_call', [{ to, data: IDENTITY_ABI.encodeFunctionData(method, args) }, tag]))[0];
    const code = async to => { if (await provider.getCode(to, block.number) === '0x') fail(409, 'Product contract has no code.'); };
    const registeredPool = async pool => {
      await code(pool);
      if (!await call(record.factory, 'isPool', [pool]) || identity(await call(pool, 'factory')) !== identity(record.factory)
        || identity(await call(pool, 'OFFICIAL_FACTORY')) !== identity(record.factory)) fail(409, 'Pool is not registered to this Factory.');
    };
    await code(record.factory); await code(record.target);
    if (record.targetType === 'pool') {
      await registeredPool(record.target);
      if (decoded.name === 'deposit' && BigInt(record.value) !== decoded.args[0] * await call(record.target, 'unitPriceWei'))
        fail(409, 'Deposit value differs from the current share price.');
      if (decoded.name === 'completeSale' && (BigInt(record.value) === 0n || BigInt(record.value) !== await call(record.target, 'salePrice')))
        fail(409, 'Whole miner sale payment differs from the approved price.');
    } else {
      if (identity(await call(record.factory, 'shareMarket')) !== identity(record.target)
        || identity(await call(record.target, 'factory')) !== identity(record.factory)) fail(409, 'Market is not registered to this Factory.');
      if (decoded.name === 'list') await registeredPool(decoded.args[0]);
      if (['fill','cancel','expire'].includes(decoded.name)) {
        const order = await call(record.target, 'orders', [decoded.args[0]]);
        await registeredPool(order.pool);
        if (decoded.name === 'fill' && BigInt(record.value) !== order.pricePerUnit * decoded.args[1]) fail(409, 'Order price changed.');
      }
    }
    const [latestNonce, pendingNonce] = await Promise.all([
      provider.getTransactionCount(record.account, 'latest'), provider.getTransactionCount(record.account, 'pending'),
    ]);
    if (record.nonce !== latestNonce || record.nonce !== pendingNonce) fail(409, 'Wallet nonce is already pending or changed.');
    // Contract simulation is authoritative for state, ownership, voting thresholds and deadlines.
    await provider.send('eth_call', [{ from: record.account, to: record.target, data: record.data,
      value: `0x${BigInt(record.value).toString(16)}` }, tag]);
    const again = await provider.getBlock(block.number);
    if (again?.hash !== block.hash || BigInt(await provider.send('eth_chainId', [])) !== 56n) fail(409, 'Chain changed during product verification.');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(409, 'Product identity, value or transaction simulation could not be verified.');
  }
}

/** Read-only chain proof that an account nonce is finalized. */
async function finalizedNonce(provider, account, nonce, hash) {
  if (!provider) fail(503, 'BSC receipt verifier is unavailable.');
  if (typeof hash !== 'string' || !HASH.test(hash)) fail(400, 'A transaction hash is required.');
  try {
    const rawChainId = await provider.send('eth_chainId', []);
    if (typeof rawChainId !== 'string' || !/^0x[\da-f]+$/i.test(rawChainId) || BigInt(rawChainId) !== 56n)
      fail(503, 'Receipt RPC is not BSC mainnet.');
    const [tx, receipt, latest, finalized] = await Promise.all([
      provider.getTransaction(hash), provider.getTransactionReceipt(hash), provider.getBlock('latest'), provider.getBlock('finalized'),
    ]);
    if (!tx || !receipt || !latest || !finalized?.hash) fail(409, 'Transaction is not finalized.');
    if (tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.hash.toLowerCase() !== hash.toLowerCase()
      || tx.chainId !== 56n || identity(tx.from) !== account.toLowerCase() || identity(receipt.from) !== account.toLowerCase()
      || tx.nonce !== nonce || tx.blockNumber !== receipt.blockNumber || tx.blockHash !== receipt.blockHash
      || (tx.to ?? '').toLowerCase() !== (receipt.to ?? '').toLowerCase()
      || receipt.status !== 0 && receipt.status !== 1) fail(409, 'Transaction does not match the recorded wallet nonce.');
    const canonical = await provider.getBlock(receipt.blockNumber);
    if (canonical?.hash !== receipt.blockHash || latest.number - receipt.blockNumber + 1 < 2
      || finalized.number < receipt.blockNumber
      || await provider.getTransactionCount(account, finalized.number) <= nonce) fail(409, 'Transaction is not finalized on the canonical chain.');
    const [again, finalizedAgain, chainAgain] = await Promise.all([
      provider.getBlock(receipt.blockNumber), provider.getBlock(finalized.number), provider.send('eth_chainId', []),
    ]);
    if (again?.hash !== receipt.blockHash || finalizedAgain?.hash !== finalized.hash || BigInt(chainAgain) !== 56n)
      fail(409, 'Chain changed during receipt verification.');
    return { tx, receipt };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(503, 'Receipt RPC could not be verified.');
  }
}

export async function verifyMarketFinalized(provider, record, hash) {
  const { tx, receipt } = await finalizedNonce(provider, record.account, record.nonce, hash);
  const target = record.version === 2 ? record.target : record.market;
  const matches = tx.to?.toLowerCase() === target.toLowerCase() && tx.data.toLowerCase() === record.data.toLowerCase()
    && tx.value.toString() === record.value;
  if (record.version !== 2 && record.hash?.toLowerCase() === hash.toLowerCase()
    && !matches) fail(409, 'Original market transaction payload differs.');
  const cancelled = tx.to?.toLowerCase() === record.account.toLowerCase() && tx.data === '0x' && tx.value === 0n;
  const result = { action: record.action.kind, status: matches ? (receipt.status === 1 ? 'confirmed' : 'reverted')
    : cancelled && receipt.status === 1 ? 'cancelled' : 'replaced', finalized: true, transactionHash: hash.toLowerCase(),
    account: record.account, target, nonce: record.nonce, factory: record.factory,
    receipt: { status: receipt.status, transactionHash: hash.toLowerCase(), to: receipt.to,
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash } };
  if (record.version === 2 && record.targetType === 'pool' && record.action.kind === 'deposit' && result.status === 'confirmed') {
    const expected = decodeProduct(record);
    const deposits = (receipt.logs ?? []).filter(log => !log.removed && log.address?.toLowerCase() === target.toLowerCase()).flatMap(log => {
      try { const parsed = PRODUCT_POOL_ABI.parseLog(log); return parsed?.name === 'Deposited' ? [parsed] : []; }
      catch { return []; }
    });
    if (deposits.length !== 1 || identity(deposits[0].args.user) !== record.account.toLowerCase()
      || deposits[0].args.shares !== expected.args[0] || deposits[0].args.amount.toString() !== record.value)
      fail(409, 'Finalized deposit event does not match the recorded pool, account, shares and payment.');
    Object.assign(result, { poolAddress: target, shares: expected.args[0].toString(), amountWei: record.value });
  }
  return result;
}

/** Archival must prove that every terminal deployment nonce is finalized. */
export async function verifyAbortedDeployment(provider, record) {
  if (record?.status !== 'aborted') fail(409, 'Only an aborted deployment can be archived.');
  let terminalSeen = false;
  let priorNonce = -1;
  for (const step of record.steps) {
    if (terminalSeen) {
      if (step.nonce !== undefined || step.status !== 'waiting') fail(409, 'Deployment continued after its terminal transaction.');
      continue;
    }
    if (step.nonce === undefined) fail(409, 'Deployment has an unverified step before its terminal transaction.');
    if (!Number.isSafeInteger(step.nonce) || step.nonce <= priorNonce) fail(409, 'Deployment nonces are not ordered.');
    priorNonce = step.nonce;
    if (!['confirmed','failed','cancelled','replaced'].includes(step.status))
      fail(409, 'Deployment still has an unknown transaction.');
    const hash = step.replacementHash ?? step.txHash;
    if (!Number.isSafeInteger(step.nonce) || step.nonce < 0 || !hash || !step.receipt)
      fail(409, 'Aborted deployment lacks a complete terminal receipt.');
    const { tx, receipt } = await finalizedNonce(provider, record.account, step.nonce, hash);
    if (step.receipt.blockNumber !== receipt.blockNumber || step.receipt.blockHash !== receipt.blockHash
      || step.receipt.status !== receipt.status) fail(409, 'Saved deployment receipt differs from the finalized chain.');
    if (step.status === 'confirmed') {
      const plannedTo = step.id === 'initialize' ? record.addresses.AtomicDeployment : null;
      const sameTarget = plannedTo ? tx.to?.toLowerCase() === plannedTo.toLowerCase() : tx.to === null;
      if (!HASH.test(step.dataHash) || !sameTarget || tx.value !== 0n
        || keccak256(tx.data) !== step.dataHash || receipt.status !== 1)
        fail(409, 'Confirmed deployment step lacks exact finalized chain proof.');
      continue;
    }
    terminalSeen = true;
    if (step.status === 'failed' && receipt.status !== 0 || step.status !== 'failed' && receipt.status !== 1)
      fail(409, 'Terminal deployment outcome differs from the finalized chain.');
    if (step.status === 'cancelled' && (tx.to?.toLowerCase() !== record.account.toLowerCase()
      || tx.data !== '0x' || tx.value !== 0n)) fail(409, 'Cancellation payload does not match the wallet.');
    if (step.status === 'replaced') {
      const plannedTo = step.id === 'initialize' ? record.addresses.AtomicDeployment : null;
      const sameTarget = plannedTo ? tx.to?.toLowerCase() === plannedTo.toLowerCase() : tx.to === null;
      if (!HASH.test(step.dataHash) || keccak256(tx.data) === step.dataHash && sameTarget && tx.value === 0n)
        fail(409, 'Replacement does not differ from the original deployment payload.');
    }
  }
  if (!terminalSeen) fail(409, 'Aborted deployment has no finalized terminal transaction.');
}

async function mapInBatches(items, size, action) {
  const results = [];
  for (let start = 0; start < items.length; start += size) {
    const settled = await Promise.allSettled(items.slice(start, start + size).map((item, offset) => action(item, start + offset)));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    results.push(...settled.map(result => result.value));
  }
  return results;
}

/** Verify all original nonces against one stable finalized BSC anchor. */
async function finalizedCompletedSteps(provider, account, steps) {
  if (!provider) fail(503, 'BSC receipt verifier is unavailable.');
  try {
    const chainId = await provider.send('eth_chainId', []);
    if (typeof chainId !== 'string' || !/^0x[\da-f]+$/i.test(chainId) || BigInt(chainId) !== 56n)
      fail(503, 'Receipt RPC is not BSC mainnet.');
    const [latest, finalized] = await Promise.all([provider.getBlock('latest'), provider.getBlock('finalized')]);
    if (!latest || !finalized?.hash) fail(409, 'Transaction is not finalized.');
    if (await provider.getTransactionCount(account, finalized.number) <= steps.at(-1).nonce)
      fail(409, 'Deployment nonces are not finalized.');
    const proofs = await mapInBatches(steps, 4, async step => {
      const [tx, receipt] = await Promise.all([
        provider.getTransaction(step.txHash), provider.getTransactionReceipt(step.txHash),
      ]);
      if (!tx || !receipt) fail(409, 'Transaction is not finalized.');
      if (tx.hash.toLowerCase() !== step.txHash.toLowerCase()
        || receipt.hash.toLowerCase() !== step.txHash.toLowerCase()
        || tx.chainId !== 56n || identity(tx.from) !== account.toLowerCase()
        || identity(receipt.from) !== account.toLowerCase()
        || tx.nonce !== step.nonce || tx.blockNumber !== receipt.blockNumber
        || tx.blockHash !== receipt.blockHash
        || (tx.to ?? '').toLowerCase() !== (receipt.to ?? '').toLowerCase()
        || receipt.status !== 0 && receipt.status !== 1) fail(409, 'Transaction does not match the recorded wallet nonce.');
      const canonical = await provider.getBlock(receipt.blockNumber);
      if (canonical?.hash !== receipt.blockHash || latest.number - receipt.blockNumber + 1 < 2
        || finalized.number < receipt.blockNumber) fail(409, 'Transaction is not finalized on the canonical chain.');
      return { tx, receipt };
    });
    // Recheck every observed block before accepting the shared anchor; a reorg
    // or inconsistent RPC response during any batch keeps the journal locked.
    const observedBlocks = new Map();
    for (const { receipt } of proofs) {
      const prior = observedBlocks.get(receipt.blockNumber);
      if (prior && prior !== receipt.blockHash) fail(409, 'Chain changed during receipt verification.');
      observedBlocks.set(receipt.blockNumber, receipt.blockHash);
    }
    const observed = [...observedBlocks.entries()];
    await mapInBatches(observed, 4, async ([number, hash]) => {
      if ((await provider.getBlock(number))?.hash !== hash) fail(409, 'Chain changed during receipt verification.');
    });
    const [finalizedAgain, chainAgain] = await Promise.all([
      provider.getBlock(finalized.number), provider.send('eth_chainId', []),
    ]);
    if (finalizedAgain?.hash !== finalized.hash || BigInt(chainAgain) !== 56n)
      fail(409, 'Chain changed during receipt verification.');
    return proofs;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(503, 'Receipt RPC could not be verified.');
  }
}

/** A completed deployment may be retired only after proving its original transactions. */
export async function verifyCompletedDeployment(provider, record) {
  if (record?.status !== 'complete') fail(409, 'Only a completed deployment can be archived.');
  const librarySteps = record.steps.slice(0, LIBRARY_STEPS.size);
  if (record.steps.length !== LIBRARY_STEPS.size + FINAL_STEPS.length
    || librarySteps.some(step => !LIBRARY_STEPS.has(step.id))
    || new Set(librarySteps.map(step => step.id)).size !== LIBRARY_STEPS.size
    || FINAL_STEPS.some((id, index) => record.steps[LIBRARY_STEPS.size + index].id !== id))
    fail(409, 'Completed deployment has missing or reordered steps.');
  const verification = record.verification;
  if (!verification || !Array.isArray(verification.checks) || verification.checks.length === 0
    || verification.checks.some(check => check?.passed !== true)
    || !isRecord(verification.code)) fail(409, 'Completed deployment lacks a passed graph verification.');
  let previousNonce = -1;
  for (const step of record.steps) {
    if (step.status !== 'confirmed' || step.replacementHash
      || step.previousTxHashes?.length || !Number.isSafeInteger(step.nonce)
      || step.nonce <= previousNonce || !HASH.test(step.txHash)
      || !HASH.test(step.dataHash) || !isRecord(step.receipt))
      fail(409, 'Completed deployment contains an unknown or replaced transaction.');
    previousNonce = step.nonce;
  }
  const proofs = await finalizedCompletedSteps(provider, record.account, record.steps);
  let actualSpent = 0n;
  for (const [index, step] of record.steps.entries()) {
    const { tx, receipt } = proofs[index];
    if (receipt.status !== 1 || tx.value !== 0n || keccak256(tx.data) !== step.dataHash
      || (step.id === 'initialize'
        ? !recordedAddressMatches(record.addresses.AtomicDeployment, tx.to?.toLowerCase())
        : tx.to !== null)
      || step.receipt.blockNumber !== receipt.blockNumber || step.receipt.blockHash !== receipt.blockHash
      || step.receipt.status !== receipt.status
      || step.receipt.gasUsed !== receipt.gasUsed.toString()
      || step.receipt.gasPrice !== receipt.gasPrice.toString()
      || step.receipt.feeWei !== receipt.fee.toString())
      fail(409, 'Completed deployment transaction or receipt differs from the finalized chain.');
    actualSpent += receipt.fee;
    if (step.id === 'initialize') continue;
    const deployed = getCreateAddress({ from: record.account, nonce: step.nonce }).toLowerCase();
    const recordedCode = verification.code[step.id];
    if (receipt.contractAddress?.toLowerCase() !== deployed
      || !recordedAddressMatches(step.address, deployed) || !recordedAddressMatches(record.addresses[step.id], deployed)
      || !isRecord(recordedCode) || !recordedAddressMatches(recordedCode.address, deployed)
      || !HASH.test(step.codehash) || step.codehash.toLowerCase() !== recordedCode.codehash?.toLowerCase())
      fail(409, 'Completed deployment contract address or recorded code identity differs.');
  }
  if (record.spentWei !== actualSpent.toString()) fail(409, 'Completed deployment total Gas fee differs from finalized receipts.');
}

function sessionCookie(token, secure) {
  return `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/journal; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function createJournalService({ dbPath, origin, rpcUrl, secureCookies = false,
  provider: suppliedProvider, currentArtifactDigest, assertSigningInputsCurrent = () => {}, allowedProductFactories = [] } = {}) {
  if (typeof dbPath !== 'string' || !dbPath) throw new Error('Journal database path is required.');
  if (typeof currentArtifactDigest !== 'function') throw new Error('Current deployment artifact digest provider is required.');
  if (typeof assertSigningInputsCurrent !== 'function') throw new Error('Deployment signing input verifier must be a function.');
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin || !['https:', 'http:'].includes(parsedOrigin.protocol)) throw new Error('Exact journal origin is required.');
  if (parsedOrigin.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(parsedOrigin.hostname))
    throw new Error('Journal HTTP origin must be loopback.');
  const cookieSecure = secureCookies || parsedOrigin.protocol === 'https:';
  const store = new JournalStore(dbPath);
  const provider = suppliedProvider ?? (rpcUrl ? new JsonRpcProvider(rpcUrl) : null);
  if (!Array.isArray(allowedProductFactories) || allowedProductFactories.length > 32) throw new Error('Invalid product Factory allowlist.');
  const productFactories = new Set(allowedProductFactories.map(identity));
  if (productFactories.has('0x0000000000000000000000000000000000000000')) throw new Error('Zero product Factory is forbidden.');
  const inFlight = new Set();
  let closed = false;

  function buildDigest() {
    try {
      const digest = currentArtifactDigest();
      if (typeof digest !== 'string' || !HASH.test(digest)) throw new Error('Invalid build digest.');
      return digest.toLowerCase();
    } catch { fail(503, 'The deployment artifact served by this server is unavailable.'); }
  }

  function signingBuildDigest() {
    try { assertSigningInputsCurrent(); }
    catch { fail(503, 'Deployment signing inputs changed; regenerate artifacts and reload this page.'); }
    return buildDigest();
  }

  async function respond(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    if (closed) return send(503, { error: 'Journal is unavailable.' });
    try {
      if (!req.url || req.url.length > 2048) fail(400, 'Invalid request URL.');
      const path = new URL(req.url, origin).pathname;
      const method = req.method;
      if (!['GET','POST','PUT','DELETE'].includes(method)) fail(405, 'Method is not allowed.');
      if (method !== 'GET' && req.headers.origin !== origin) fail(403, 'Request origin is not allowed.');
      if (method === 'POST' && path === '/api/journal/challenge') {
        const body = await readJson(req), account = identity(body.account);
        const nonce = randomBytes(24).toString('base64url');
        const expires = Date.now() + CHALLENGE_MS;
        const message = `Pinkuang deployment journal login\nOrigin: ${origin}\nChain ID: 56\nAccount: ${account}\nNonce: ${nonce}\nExpires At: ${new Date(expires).toISOString()}`;
        const active = store.issueChallenge(account, nonce, message, expires);
        return send(200, { message: active.message, nonce: active.nonce });
      }
      if (method === 'POST' && path === '/api/journal/session') {
        const body = await readJson(req), account = identity(body.account);
        if (typeof body.nonce !== 'string' || !CHALLENGE.test(body.nonce) || typeof body.signature !== 'string'
          || body.signature.length > 512) fail(400, 'Invalid wallet login response.');
        const challenge = store.challenge(account, body.nonce);
        if (!challenge || challenge.expires < Date.now()) fail(401, 'Wallet challenge expired.');
        let recovered;
        try { recovered = verifyMessage(challenge.message, body.signature).toLowerCase(); }
        catch { fail(401, 'Wallet signature is invalid.'); }
        if (recovered !== account) fail(401, 'Wallet signature does not match the account.');
        const token = randomBytes(32).toString('base64url');
        if (!store.consumeChallenge(account, body.nonce, hashed(token), Date.now() + SESSION_MS))
          fail(401, 'Wallet challenge has already been used.');
        res.setHeader('Set-Cookie', sessionCookie(token, cookieSecure));
        return send(200, { account });
      }
      const cookies = String(req.headers.cookie ?? '').split(';').map(item => item.trim());
      const token = cookies.find(item => item.startsWith(`${TOKEN_COOKIE}=`))?.slice(TOKEN_COOKIE.length + 1);
      const account = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? store.session(hashed(token)) : null;
      if (!account) fail(401, 'Wallet session is required.');
      const expectedAccount = req.headers['x-pinkuang-account'];
      if (expectedAccount !== undefined && identity(expectedAccount) !== account)
        fail(409, 'Wallet session has switched accounts. Reconnect the selected wallet.');
      if (method === 'GET' && path === '/api/journal/session') return send(200, { account });
      if (method === 'GET' && path === '/api/journal/build') return send(200, { artifactDigest: signingBuildDigest() });
      if (method === 'GET' && path === '/api/journal/deployment') return send(200, store.deployment(account));
      if (method === 'GET' && path === '/api/journal/deployment/archives') {
        const url = new URL(req.url, origin);
        if (url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1)
          fail(400, 'Invalid archive page.');
        const cursor = url.searchParams.get('cursor');
        const rawLimit = url.searchParams.get('limit') ?? '20';
        const limit = Number(rawLimit);
        if (cursor !== null && (!/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)
          || !DECIMAL.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          fail(400, 'Invalid archive page.');
        return send(200, store.archives(account, cursor, limit));
      }
      if (method === 'PUT' && path === '/api/journal/deployment') {
        const body = await readJson(req);
        const record = validateDeployment(body.record, account);
        const previous = store.deployment(account).record;
        const newSigningIntent = !previous || record.steps.some((step, i) =>
          step.status === 'signing' && previous.steps[i]?.status !== 'signing');
        if (newSigningIntent && record.artifactDigest.toLowerCase() !== signingBuildDigest()) {
          fail(409, 'Deployment artifacts changed. Reload this page before another wallet signature.');
        }
        // Progress on an existing intent, especially a returned hash or receipt,
        // must remain durable even if the source or served artifact changes.
        return send(200, { revision: store.putDeployment(account, record, exactRevision(body.expectedRevision)) });
      }
      if (method === 'POST' && path === '/api/journal/deployment/archive') {
        const body = await readJson(req);
        if (typeof body.id !== 'string' || !body.id || body.id.length > 160) fail(400, 'Invalid deployment ID.');
        const current = store.deployment(account);
        if (!current.record || current.revision !== exactRevision(body.expectedRevision) || current.record.id !== body.id)
          fail(409, 'Deployment revision changed.');
        if (current.record.status === 'aborted') await verifyAbortedDeployment(provider, current.record);
        else if (current.record.status === 'complete') await verifyCompletedDeployment(provider, current.record);
        else fail(409, 'Only a completed or aborted deployment can be archived.');
        return send(200, store.archiveDeployment(account, body.id, exactRevision(body.expectedRevision)));
      }
      if (method === 'POST' && path === '/api/journal/deployment/import-archive') {
        const body = await readJson(req);
        return send(200, { id: store.importArchive(account, validateDeployment(body.record, account)) });
      }
      if (method === 'GET' && path === '/api/journal/market') return send(200, store.market(account));
      if (method === 'GET' && path === '/api/journal/market/result') {
        const hash = new URL(req.url, origin).searchParams.get('hash');
        if (!HASH.test(hash ?? '')) fail(400, 'A transaction hash is required.');
        return send(200, { result: store.marketResult(account, hash) });
      }
      if (method === 'POST' && path === '/api/journal/market/cancel-intent') {
        const body = await readJson(req), revision = exactRevision(body.expectedRevision), current = store.market(account);
        if (!current.record || current.revision !== revision) fail(409, 'Market revision changed.');
        if ((current.record.cancellationRequests?.length ?? 0) >= 16) fail(409, 'Cancellation history is full. Recover the wallet hash instead.');
        const transaction = await cancellationIntent(provider, current.record);
        const record = { ...current.record, cancellationRequests: [...(current.record.cancellationRequests ?? []),
          { ...transaction, createdAt:new Date().toISOString() }] };
        validateMarket(record, account);
        return send(200, { revision:store.putMarket(account, record, revision), record, transaction });
      }
      if (method === 'PUT' && path === '/api/journal/market') {
        const body = await readJson(req);
        const record = validateMarket(body.record, account), current = store.market(account);
        if (current.revision !== exactRevision(body.expectedRevision)) fail(409, 'Market revision changed.');
        // Recovery writes must work even if the allowlist changes or the RPC is down.
        if (!current.record && record.version === 2) await verifyProductIntent(provider, record, productFactories);
        return send(200, { revision: store.putMarket(account, record, exactRevision(body.expectedRevision)) });
      }
      if (method === 'DELETE' && path === '/api/journal/market') {
        const body = await readJson(req), expectedRevision = exactRevision(body.expectedRevision);
        const current = store.market(account);
        if (!current.record || current.revision !== expectedRevision) fail(409, 'Market revision changed.');
        const result = await verifyMarketFinalized(provider, current.record, body.hash);
        return send(200, { revision: store.deleteMarket(account, expectedRevision, result), result });
      }
      if (method === 'POST' && path === '/api/journal/quote') {
        const body = await readJson(req);
        if (!isRecord(body.record)) fail(400, 'Invalid quote record.');
        const id = randomUUID(); store.saveQuote(account, id, body.record);
        return send(200, { id });
      }
      if (method === 'GET' && path === '/api/journal/quotes') {
        const url = new URL(req.url, origin);
        const cursor = url.searchParams.get('cursor') ?? '0', limit = url.searchParams.get('limit') ?? '20';
        if (!DECIMAL.test(cursor) || !DECIMAL.test(limit) || !Number.isSafeInteger(Number(cursor))
          || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100)
          fail(400, 'Invalid quote page.');
        return send(200, store.quotes(account, Number(cursor), Number(limit)));
      }
      fail(404, 'Unknown journal route.');
    } catch (error) {
      if (error instanceof JournalConflict) return send(409, { error: error.message });
      if (error instanceof ApiError) return send(error.status, { error: error.message });
      return send(500, { error: 'Journal request failed.' });
    }
  }

  return {
    handle(req, res) {
      const task = respond(req, res);
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    },
    async close() {
      closed = true;
      await Promise.allSettled([...inFlight]);
      store.close();
      if (!suppliedProvider) provider?.destroy();
    },
  };
}

export function journalConfiguration(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const dbPath = env.DEPLOYMENT_JOURNAL_DB || (!production && fileURLToPath(new URL('../.local/journal.sqlite', import.meta.url)));
  const origin = env.DEPLOYMENT_JOURNAL_ORIGIN || (!production && 'http://127.0.0.1:4173');
  const rpcUrl = env.DEPLOYMENT_JOURNAL_RPC_URL;
  if (!dbPath || !origin || production && !rpcUrl) throw new Error('Production journal requires explicit DB, origin and BSC RPC URL.');
  if (rpcUrl && !/^https:\/\//.test(rpcUrl)) throw new Error('Journal BSC RPC URL must use HTTPS.');
  if (production && !/^https:\/\//.test(origin)) throw new Error('Production journal origin must use HTTPS.');
  return { dbPath, origin, rpcUrl,
    allowedProductFactories: (env.BEMINE_JOURNAL_FACTORIES || '').split(',').map(value => value.trim()).filter(Boolean),
    secureCookies: production || origin.startsWith('https://') || env.DEPLOYMENT_JOURNAL_SECURE_COOKIES === '1' };
}
