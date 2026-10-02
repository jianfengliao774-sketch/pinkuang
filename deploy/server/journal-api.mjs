import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FetchRequest, Interface, JsonRpcProvider, getAddress, getCreateAddress, keccak256, toUtf8Bytes, verifyMessage } from 'ethers';
import { fileURLToPath } from 'node:url';
import { JournalConflict, JournalStore } from './journal-store.mjs';
import { validateFreshActivation, verifyFinalizedFreshAttempt, verifyRecoveredFreshSigning, verifyConfirmedFreshActivation } from './fresh-activation-journal.mjs';
import { verifyInitializationExecution } from '../shared/initialization-proof.mjs';
import { productGraphConfiguration, verifyProductGraph } from './product-graph.mjs';
import { decodeFirstoOrder, verifyFirstoSignedAsk } from '../src/firsto-purchase.mjs';
import { fetchOfficialCandidates } from '../scripts/official-market-discovery.mjs';
import { PRODUCT_PORTFOLIO_ABI, PRODUCT_PORTFOLIO_FACTORY_ABI, verifyPortfolioIntent } from './portfolio-intent.mjs';
import { verifyControlledFirstoSale } from './firsto-sale-preflight.mjs';
import { readBudgetCandidates } from './budget-candidates.mjs';
import { isFreshWalletAction } from '../shared/fresh-wallet-actions.mjs';
import { freshProductConfiguration, createFreshProductGate, FRESH_AUTHORITY_ONLY } from './fresh-product-gate.mjs';
import { verifyCurrentAuthorityAdministrator } from './authority-role.mjs';
import { validateBudgetQueue } from '../shared/budget-queue.mjs';
import { legacyFactoryConfiguration, verifyCreationCutover } from './creation-cutover.mjs';
import { clientAddress, createRequestLimiter } from './request-limiter.mjs';
import { verifyGasSignerAttestation } from '../shared/gas-signer-attestation.mjs';
import { firstoAskPublisherConfiguration, createFirstoAskApiWorker, trackFirstoAsks } from './firsto-ask-publisher.mjs';
export { PRODUCT_PORTFOLIO_ABI, PRODUCT_PORTFOLIO_FACTORY_ABI } from './portfolio-intent.mjs';

const MAX_BODY = 64 * 1024;
const CHALLENGE_MS = 5 * 60_000;
const SESSION_MS = 12 * 60 * 60_000;
const TOKEN_COOKIE = 'pinkuang_journal';
// The pre-genesis v4 deployment journal belongs to this hardware wallet alone.
// Compare the authenticated address, not its code: EIP-7702 delegation does not
// change wallet ownership or make the Gas wallet / administrators deployers.
const FRESH_DEPLOYMENT_ACCOUNT = '0x042B23288E2316DFb6503488292FD0Ad2F811Ae7'.toLowerCase();
const OFFICIAL_CACHE_MS = 5_000;
const OFFICIAL_GRAPH_CACHE_MS = 5_000;
const SIGNING_GRAPH_CACHE_MS = 5_000;
const PRODUCT_GRAPH_SNAPSHOT_MS = 45_000;
const PRODUCT_GRAPH_STALE_MS = 2 * 60_000;
// Keep a fresh display proof warm with margin before the 45-second current
// window ends, without redoing the full graph every 15 seconds while idle.
const PRODUCT_GRAPH_REFRESH_MS = 40_000;
const TRANSIENT_PRODUCT_RPC_CODES = new Set([
  'NETWORK_ERROR', 'TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
  'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
]);

export function isTransientProductRpcFailure(error) {
  if (error instanceof ProductGraphAnchorUnavailable) return true;
  if (error instanceof ApiError) return false;
  for (let current=error, depth=0; current && depth<5; current=current.cause, depth++) {
    if (current instanceof ApiError) return false;
    if (TRANSIENT_PRODUCT_RPC_CODES.has(current.code)) return true;
    const status=Number.parseInt(String(current.status ?? current.response?.status
      ?? current.info?.responseStatus ?? ''),10);
    if (status===429 || status>=500 && status<=599) return true;
    const rpcCode=Number(current.info?.error?.code ?? current.error?.code
      ?? current.info?.error?.error?.code ?? current.code);
    if (rpcCode===-32000 || rpcCode===-32603) return true;
  }
  return false;
}
const OFFICIAL_SCAN_MS = 60_000;
const OFFICIAL_RPC_TIMEOUT_MS = 9_000;
const MAX_OFFICIAL_SCANS = 2;
const MAX_OFFICIAL_GRAPH_PROOFS = 2;
const MAX_BUDGET_GRAPH_PROOFS = 1;
const OFFICIAL_GRAPH_PROOF_BURST = 2;
const OFFICIAL_GRAPH_PROOF_REFILL_MS = 4_000;
// Public budget previews have a smaller, independently replenishing proof
// allowance. They cannot drain official-pool graph tokens or occupy both
// shared candidate-proof slots.
const BUDGET_GRAPH_PROOF_BURST = 1;
const BUDGET_GRAPH_PROOF_REFILL_MS = 8_000;
// Each visitor has its own cap in each candidate lane. Cached proofs and
// identical in-flight proofs do not consume either allowance.
const OFFICIAL_CLIENT_GRAPH_BURST = 1;
const OFFICIAL_CLIENT_GRAPH_REFILL_MS = 8_000;
const MAX_OFFICIAL_BLOCK_AGE = 120;
const OFFICIAL_REQUEST_BURST = 6;
const OFFICIAL_REQUEST_REFILL_MS = 500;
const OFFICIAL_CLIENT_REQUEST_BURST = 3;
const OFFICIAL_CLIENT_REQUEST_REFILL_MS = 1_000;
const MAX_OFFICIAL_CLIENTS = 4_096;
const PRODUCT_INTENT_WINDOW_MS = 60_000;
const PRODUCT_INTENT_PER_ACCOUNT = 8;
const PRODUCT_INTENT_PER_IP = 24;
const MAX_PRODUCT_INTENT_ACCOUNTS = 4_096;
// Match the browser's 5M Gas and 3 gwei hard ceilings. This bounds the fee
// reservation without adding eth_call or eth_estimateGas to wallet submission.
const MAX_PRODUCT_TRANSACTION_GAS_WEI = 15_000_000_000_000_000n;
const OFFICIAL_COLLECTIONS = new Set([
  '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c',
  '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c',
]);
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
// There is no arbitrary call, approval or upgrade route; operator actions are checked separately.
export const PRODUCT_POOL_ABI = new Interface([
  'function buyFromMarket(uint256 listingId)', 'function buyAlternativeFromMarket(uint256 listingId)', 'function mine(bytes data)',
  'function buyFromFirsto(uint8 kind,bytes encodedOrder)',
  'function deposit(uint8 shares) payable', 'function withdrawDeposit()', 'function finalizeFailure()',
  'function harvest()', 'function claim()', 'function withdrawBnb()',
  'function propose(uint256 price,uint256 refPrice,uint64 refAt)', 'function vote(uint256 proposalId,bool support)',
  'function executeSale(uint256 proposalId)', 'function cancelExpired()', 'function completeSale() payable',
  'function completeFirstoSale(uint256 expectedProposalId,uint256 expectedSalePrice,uint16 expectedFeeBps,uint256 expectedFeeEpoch) payable',
  'function delist(uint8 action,uint256 cancellationId,uint256 expectedListedProposalId,bool support) returns(uint256 id)',
  'event Deposited(address indexed user,uint8 shares,uint256 amount,uint256 totalRaised)',
]);
export const PRODUCT_MARKET_ABI = new Interface([
  'function list(address pool,uint256 amount,uint256 pricePerUnit)', 'function fill(uint256 orderId,uint256 amount) payable',
  'function cancel(uint256 orderId)', 'function expire(uint256 orderId)', 'function withdrawBnb()',
]);
const PARAMS = '(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline)';
const FLEXIBLE = '(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)';
export const PRODUCT_FACTORY_ABI = new Interface([
  `function createPool(${PARAMS} params)`,
  `function createBudgetChildPool(${PARAMS} params,address subscriber)`,
  `function createFlexiblePoolChecked(${PARAMS} params,${FLEXIBLE} config,uint32 expectedTaskId,uint128 expectedReferenceWeight)`,
  'event PoolCreated(address indexed pool,address indexed circuits,uint256 indexed circuitId,uint256 targetRaise,uint256 priceCap,address treasury)',
]);
const MINING_ABI = new Interface(['function arm(address circuits,uint256 circuitId)','function reclaim(bytes32 key)']);
const MACHINE_REGISTRY_ABI = new Interface(['function machineRegistryStatus() view returns(bool initialized,bool ready,uint256 cursor,uint256 cutoff)',
  'function machinePool(address,uint256) view returns(address)']);
const TIMELOCK_EXECUTION_ABI = new Interface([
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
]);
const IDENTITY_ABI = new Interface([
  'function operator() view returns(address)',

  'function isPool(address) view returns(bool)', 'function shareMarket() view returns(address)',
  'function factory() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function legacyFactory() view returns(address)',
  'function unitPriceWei() view returns(uint256)', 'function salePrice() view returns(uint256)',
  'function feeBps() view returns(uint16)', 'function buyerFeeBps() view returns(uint16)',
  'function orders(uint256) view returns(tuple(address seller,address pool,uint256 remaining,uint256 pricePerUnit,bool active))',
]);
const OFFICIAL_POOL_READ_ABI = new Interface([
  'function state() view returns(uint8)',
  `function params() view returns(${PARAMS})`,
  `function flexiblePurchase() view returns(bool enabled,uint256 referenceCircuitId,${FLEXIBLE} config)`,
  'function purchaseModel() view returns(bool initialized,uint32 taskId)',
  'function purchaseReferenceWeight() view returns(uint128)',
]);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class ProductGraphAnchorUnavailable extends Error {}
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
  if (!isRecord(value) || value.schemaVersion !== 1 || (value.kind !== undefined && value.kind !== 'integrated-v2') || value.chainId !== 56 || identity(value.account) !== account
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
      || step.rejectionKind !== undefined && !['pre-send','wallet-rejected'].includes(step.rejectionKind)
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
      || tx.gas !== '0x5208' || !['0x0','0x2'].includes(tx.type)
      || tx.type === '0x2' && record.version !== 2
      || (tx.type === '0x0'
        ? !boundedCancellationFee(tx.gasPrice) || tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined
        : !boundedCancellationFee(tx.maxFeePerGas) || !boundedCancellationFee(tx.maxPriorityFeePerGas)
          || BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas) || tx.gasPrice !== undefined)
      || typeof tx.createdAt !== 'string' || tx.createdAt.length > 50) fail(400, 'Invalid cancellation transaction.');
  }
}

const boundedCancellationFee = value => typeof value === 'string' && /^0x[\da-f]{1,16}$/i.test(value)
  && BigInt(value) >= 1n && BigInt(value) <= 3_000_000_000n;

function decodeProduct(value) {
  const contract = ({factory:PRODUCT_FACTORY_ABI,pool:PRODUCT_POOL_ABI,market:PRODUCT_MARKET_ABI,
    portfolio:PRODUCT_PORTFOLIO_ABI,portfolioFactory:PRODUCT_PORTFOLIO_FACTORY_ABI,portfolioMarket:PRODUCT_MARKET_ABI})[value.targetType];
  if (!contract) fail(400,'Unsupported product target type.');
  let decoded;
  try { decoded = contract.parseTransaction({ data: value.data, value: BigInt(value.value) }); }
  catch { fail(400, 'Unsupported product call.'); }
  if (!decoded || decoded.name !== value.action.kind
    || contract.encodeFunctionData(decoded.fragment, decoded.args).toLowerCase() !== value.data.toLowerCase())
    fail(400, 'Product action and exact calldata must match an allowed selector.');
  if (!['deposit','completeSale','completeFirstoSale','fill'].includes(decoded.name) && value.value !== '0') fail(400, 'This product call cannot send BNB.');
  if (decoded.name === 'deposit' && (decoded.args[0] < 1n || decoded.args[0] > 100n)
    || decoded.name === 'list' && (decoded.args[1] < 1n || decoded.args[1] > 100n)
    || decoded.name === 'fill' && (decoded.args[1] < 1n || decoded.args[1] > 100n)) fail(400, 'Invalid share quantity.');
  if (decoded.name === 'propose' && decoded.args[0] === 0n) fail(400, 'Whole miner sale price must be positive.');
  if (decoded.name === 'proposeChildSale' && decoded.args[1] === 0n) fail(400,'Child sale price must be positive.');
  if (decoded.name === 'delist' && (decoded.args[0] > 2n || decoded.args[2] === 0n
    || decoded.args[0] === 0n && decoded.args[1] !== 0n || decoded.args[0] !== 0n && decoded.args[1] === 0n))
    fail(400, 'Delisting must bind the current listing and exact create, vote or execute action.');
  if (decoded.name === 'buyFirsto') {
    try { decodeFirstoOrder(decoded.args[1]); } catch { fail(400,'Invalid canonical Firsto order.'); }
  }
  if (decoded.name === 'buyFromFirsto') {
    if (decoded.args[0] !== 0n) fail(400, 'Firsto batch purchases are not enabled.');
    try { decodeFirstoOrder(decoded.args[1]); } catch { fail(400, 'Invalid canonical Firsto order.'); }
  }
  if (decoded.name === 'mine') {
    let inner;
    try { inner = MINING_ABI.parseTransaction({data:decoded.args[0]}); } catch { fail(400, 'Unsupported mining call.'); }
    if (!inner || MINING_ABI.encodeFunctionData(inner.fragment,inner.args).toLowerCase() !== decoded.args[0].toLowerCase())
      fail(400, 'Mining call must use exact arm or reclaim calldata.');
  }
  return decoded;
}

function validateProduct(value, account) {
  if (!isRecord(value) || value.chainId !== 56 || identity(value.account) !== account
    || !['pool','market','factory','portfolio','portfolioFactory','portfolioMarket'].includes(value.targetType)
    || ['factory','portfolioFactory'].includes(value.targetType) !== (identity(value.factory) === identity(value.target))
    || !Number.isSafeInteger(value.nonce) || value.nonce < 0 || !isRecord(value.action)
    || typeof value.action.kind !== 'string' || typeof value.submittedAt !== 'string' || value.submittedAt.length > 50
    || typeof value.data !== 'string' || !DATA.test(value.data) || value.data.length > 8194
    || typeof value.value !== 'string' || !DECIMAL.test(value.value) || value.value.length > 78 || BigInt(value.value) >= 2n ** 256n
    || value.hash !== undefined && !HASH.test(value.hash)
    || value.recoveryHashes !== undefined && (!Array.isArray(value.recoveryHashes) || value.recoveryHashes.length > 16
      || value.recoveryHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash)))) fail(400, 'Invalid product intent.');
  if (typeof value.gas !== 'string' || !DECIMAL.test(value.gas) || value.gas.length > 9 || BigInt(value.gas) < 21000n || BigInt(value.gas) > 30_000_000n
    || typeof value.gasPrice !== 'string' || !DECIMAL.test(value.gasPrice) || value.gasPrice.length > 10
    || BigInt(value.gasPrice) < 1n || BigInt(value.gasPrice) > 3_000_000_000n
    || BigInt(value.gas)*BigInt(value.gasPrice) > MAX_PRODUCT_TRANSACTION_GAS_WEI) fail(400, 'Invalid product Gas limits.');
  decodeProduct(value);
  validateCancellationRequests(value);
  return value;
}

function productWalletTransaction(record, envelope = 'dynamic') {
  const hex=value=>`0x${BigInt(value).toString(16)}`;
  const fee=hex(record.gasPrice);
  const transaction={chainId:'0x38',from:record.account,to:record.target,
    nonce:hex(record.nonce),data:record.data,value:hex(record.value),gas:hex(record.gas)};
  return envelope === 'legacy' ? {...transaction,gasPrice:fee,type:'0x0'}
    : {...transaction,maxFeePerGas:fee,maxPriorityFeePerGas:fee,type:'0x2'};
}

/** Only an explicit wallet-signed, zero-value EOA self-transfer can consume an unsent/unknown nonce. */
export async function cancellationIntent(provider, record, envelope = record.version === 2 ? 'dynamic' : 'legacy') {
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
    // A known type-2 replacement must raise both its maximum and priority fee.
    // Remember earlier cancellation ACKs too: a wallet may have sent one without
    // returning its hash, so the next ACK cannot reuse the same fee.
    const knownHashes = [...new Set([record.hash, ...(record.recoveryHashes ?? [])].filter(Boolean))];
    for (const known of knownHashes) {
      const tx = await provider.getTransaction(known);
      if (tx && tx.chainId === 56n && identity(tx.from) === identity(record.account) && tx.nonce === record.nonce) {
        for (const fee of [tx.gasPrice,tx.maxFeePerGas,tx.maxPriorityFeePerGas])
          if (typeof fee === 'bigint' && fee > gasPrice) gasPrice = fee;
      }
    }
    for (const prior of record.cancellationRequests ?? []) {
      const fee = prior.type === '0x2' ? BigInt(prior.maxFeePerGas) : BigInt(prior.gasPrice);
      if (fee > gasPrice) gasPrice = fee;
    }
    gasPrice = (gasPrice * 120n + 99n) / 100n;
    if (gasPrice > 3_000_000_000n || balance < 21_000n * gasPrice) fail(409, 'Cancellation Gas cap exceeded or BNB balance insufficient. Use wallet recovery after reviewing fees.');
    const transaction = { chainId:'0x38', from:record.account, to:record.account, nonce:`0x${record.nonce.toString(16)}`,
      data:'0x', value:'0x0', gas:'0x5208' };
    const fee = `0x${gasPrice.toString(16)}`;
    if (record.version === 2 && envelope !== 'legacy')
      Object.assign(transaction,{maxFeePerGas:fee,maxPriorityFeePerGas:fee,type:'0x2'});
    else Object.assign(transaction,{gasPrice:fee,type:'0x0'});
    if (BigInt(await provider.send('eth_chainId', [])) !== 56n) fail(409, 'Chain changed during cancellation verification.');
    return transaction;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(503, 'Cancellation RPC could not be verified.');
  }
}

/** The trusted server RPC validates registration/value before issuing the first durable signing ACK. */
export async function verifyProductIntent(provider, record, allowedFactories, graphVerifier, { legacyFactory, freshProductVerifier } = {}) {
  if (!provider) fail(503, 'BSC product verifier is unavailable.');
  if (!allowedFactories.has(identity(record.factory))) fail(403, 'This Factory is not enabled for product transactions.');
  const decoded = decodeProduct(record);
  try {
    if (BigInt(await provider.send('eth_chainId', [])) !== 56n) fail(503, 'Product RPC is not BSC mainnet.');
    const needsFreshServices=!isFreshWalletAction(record.targetType,decoded.name,record.value)
      && !FRESH_AUTHORITY_ONLY.has(decoded.name) && !['factory','portfolioFactory'].includes(record.targetType);
    const preparedFreshVerifier=needsFreshServices && typeof freshProductVerifier?.prepareIndex==='function'
      ? await freshProductVerifier.prepareIndex() : null;
    const block = await provider.getBlock('latest');
    if (!block?.hash) fail(503, 'Product block is unavailable.');
    const tag = `0x${block.number.toString(16)}`;
    if (typeof graphVerifier !== 'function') fail(503, 'Trusted product graph verifier is unavailable.');
    const graph = await graphVerifier(provider, record.factory, block);
    if (graph?.freshAuthority) {
      if (!freshProductVerifier) fail(409, 'Fresh product signing is not enabled in this process.');
      if (FRESH_AUTHORITY_ONLY.has(decoded.name) || record.targetType === 'factory' || record.targetType === 'portfolioFactory')
        fail(403, 'Fresh operator actions require an administrator signature through the isolated Authority relay.');
      // A member's deposit/share/governance/claim transaction is sent by that
      // wallet. An offline purchase/mining worker cannot prevent this path.
      // Registered targets, canonical calldata, exact value, fees and nonce
      // are still verified below; operator calls keep their service proof.
      if (!isFreshWalletAction(record.targetType, decoded.name, record.value))
        await (preparedFreshVerifier??freshProductVerifier)(provider, graph, block);
    }
    // This selector does not exist on the independently pinned genesis Factory.
    // A stale page must not reserve a nonce for candidate-only calldata before
    // the reviewed upgrade has actually become the verified chain graph.
    if (decoded.name === 'createBudgetChildPool' && !graph?.securityUpgrade)
      fail(409, 'Budget child creation requires the verified upgraded Factory.');
    if (decoded.name === 'delist' && graph?.nativeSaleUpgrade?.version !== 1)
      fail(409, 'Delisting requires the verified native-sale upgrade.');
    await verifyCreationCutover(provider, record, decoded, block, legacyFactory, fail,
      { freshGraphVerified: graph?.freshFactoryVerified === true && Boolean(graph?.freshAuthority) });
    const call = async (to, method, args = []) => IDENTITY_ABI.decodeFunctionResult(method,
      await provider.send('eth_call', [{ to, data: IDENTITY_ABI.encodeFunctionData(method, args) }, tag]))[0];
    const code = async to => { if (await provider.getCode(to, block.number) === '0x') fail(409, 'Product contract has no code.'); };
    const registeredPool = async pool => {
      await code(pool);
      if (!await call(record.factory, 'isPool', [pool])
        || record.targetType !== 'portfolioMarket' && identity(await call(pool, 'factory')) !== identity(record.factory)
        || identity(await call(pool, 'OFFICIAL_FACTORY')) !== identity(record.factory)) fail(409, 'Pool is not registered to this Factory.');
    };
    await code(record.factory); await code(record.target);
    if (['portfolio','portfolioFactory'].includes(record.targetType)) {
      await verifyPortfolioIntent(provider,record,decoded,block,graph,fail);
    } else if (record.targetType === 'factory') {
      if (identity(record.target) !== identity(record.factory) || identity(await call(record.factory, 'operator')) !== identity(record.account))
        fail(403, 'Only the configured Factory operator may create pools.');
      // A legacy factory cannot guarantee the user's one-machine-one-project rule.
      // Creation stays closed until the upgraded on-chain registry is fully initialized.
      const status=MACHINE_REGISTRY_ABI.decodeFunctionResult('machineRegistryStatus',await provider.send('eth_call',[
        {to:record.factory,data:MACHINE_REGISTRY_ABI.encodeFunctionData('machineRegistryStatus')},tag]));
      if (!status.initialized || !status.ready || status.cursor!==status.cutoff)
        fail(409,'Machine registry is not ready; creation requires the verified uniqueness upgrade.');
      const params=decoded.args[0];
      const occupied=MACHINE_REGISTRY_ABI.decodeFunctionResult('machinePool',await provider.send('eth_call',[
        {to:record.factory,data:MACHINE_REGISTRY_ABI.encodeFunctionData('machinePool',[params.circuits,params.circuitId])},tag]))[0];
      if (identity(occupied)!=='0x0000000000000000000000000000000000000000')
        fail(409,`This machine already has a project: ${occupied}.`);
      if (decoded.name === 'createBudgetChildPool') {
        const subscriber = identity(decoded.args[1]);
        await code(subscriber);
        const budgetFactory = identity(await call(subscriber, 'OFFICIAL_FACTORY'));
        if (!allowedFactories.has(budgetFactory) || !await call(budgetFactory, 'isPool', [subscriber])
          || identity(await call(subscriber, 'legacyFactory')) !== identity(record.factory))
          fail(409, 'Budget child subscriber is not a registered project of this Factory.');
      }
    } else if (record.targetType === 'pool') {
      await registeredPool(record.target);
      if (['buyFromMarket','buyAlternativeFromMarket','buyFromFirsto','mine'].includes(decoded.name)
        && identity(await call(record.factory, 'operator')) !== identity(record.account)) fail(403, 'Only the Factory operator may operate mining or purchase.');
      if (decoded.name === 'buyFromFirsto') await verifyFirstoSignedAsk({ request:({ method,params }) => provider.send(method,params) },
        decodeFirstoOrder(decoded.args[1]), { blockTag:tag });
      if (decoded.name === 'deposit' && BigInt(record.value) !== decoded.args[0] * await call(record.target, 'unitPriceWei'))
        fail(409, 'Deposit value differs from the current share price.');
      if (decoded.name === 'completeSale') fail(409,'Legacy whole miner sale is disabled; review the controlled Firsto sale.');
      if (decoded.name === 'completeFirstoSale') await verifyControlledFirstoSale(provider,record,decoded,block);
    } else {
      if (record.targetType === 'portfolioMarket' && (graph?.productKind !== 'budget' || identity(graph.factory) !== identity(record.factory)))
        fail(409,'The reviewed integrated portfolio market is required.');
      if (identity(await call(record.factory, 'shareMarket')) !== identity(record.target)
        || identity(await call(record.target, 'factory')) !== identity(record.factory)) fail(409, 'Market is not registered to this Factory.');
      if (decoded.name === 'list' || decoded.name === 'fill') {
        let sellerFeeBps, buyerFeeBps;
        try { [sellerFeeBps, buyerFeeBps] = await Promise.all([
          call(record.target, 'feeBps'), call(record.target, 'buyerFeeBps'),
        ]); } catch { fail(409, 'Bilateral 1% Market upgrade is not verified.'); }
        if (sellerFeeBps !== 100n || buyerFeeBps !== 100n) fail(409, 'Bilateral 1% Market fee changed.');
      }
      if (decoded.name === 'list') await registeredPool(decoded.args[0]);
      if (['fill','cancel','expire'].includes(decoded.name)) {
        const order = await call(record.target, 'orders', [decoded.args[0]]);
        await registeredPool(order.pool);
        if (decoded.name === 'fill') {
          const gross = order.pricePerUnit * decoded.args[1];
          if (gross >= 2n ** 256n || gross + gross / 100n >= 2n ** 256n
            || BigInt(record.value) !== gross + gross / 100n)
            fail(409, 'Order price or buyer fee changed.');
        }
      }
    }
    const [latestNonce, pendingNonce] = await Promise.all([
      provider.getTransactionCount(record.account, 'latest'), provider.getTransactionCount(record.account, 'pending'),
    ]);
    if (record.nonce !== latestNonce || record.nonce !== pendingNonce) fail(409, 'Wallet nonce is already pending or changed.');
    // Validate the exact requested fee and available funds without simulating
    // this transaction; execution success remains subject to wallet confirmation.
    const [fees,balance]=await Promise.all([provider.getFeeData(),provider.getBalance(record.account)]);
    if (!fees.gasPrice || fees.gasPrice > BigInt(record.gasPrice)
      || balance < BigInt(record.value)+BigInt(record.gas)*BigInt(record.gasPrice)) fail(409, 'Product Gas quote changed or balance is insufficient. Review a fresh transaction.');
    const [again,finalLatestNonce,finalPendingNonce] = await Promise.all([provider.getBlock(block.number),
      provider.getTransactionCount(record.account,'latest'),provider.getTransactionCount(record.account,'pending')]);
    if (finalLatestNonce !== record.nonce || finalPendingNonce !== record.nonce) fail(409, 'Wallet nonce changed during product verification.');
    if (again?.hash !== block.hash || BigInt(await provider.send('eth_chainId', [])) !== 56n) fail(409, 'Chain changed during product verification.');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(409, 'Product identity, value or transaction checks could not be verified.');
  }
}

/** Read-only chain proof that an account nonce is finalized. */
async function finalizedNonce(provider, account, nonce, hash, canonicalInclusion = false) {
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
      || (canonicalInclusion
        ? !Number.isSafeInteger(receipt.index) || receipt.index < 0 || tx.index !== receipt.index
          || !Array.isArray(canonical.transactions) || canonical.transactions[receipt.index]?.toLowerCase() !== hash.toLowerCase()
        : await provider.getTransactionCount(account, finalized.number) <= nonce)) fail(409, 'Transaction is not finalized on the canonical chain.');
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

/** Independent, read-only nonce witness. It never clears or rewrites a saved intent. */
async function currentAccountNonce(provider, account) {
  if (!provider) fail(503, '服务器 BSC RPC 暂不可用；请稍后重新核对，部署记录保持不变。');
  const checkNetwork = value => {
    if (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value) || BigInt(value) !== 56n)
      fail(503, '服务器 RPC 不是 BSC 主网；请检查 RPC 配置后重新核对。');
  };
  try {
    checkNetwork(await provider.send('eth_chainId', []));
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(account, 'latest'), provider.getTransactionCount(account, 'pending'),
    ]);
    if (!Number.isSafeInteger(latest) || latest < 0 || !Number.isSafeInteger(pending) || pending < latest)
      fail(503, '服务器 RPC 返回的交易序号无效或不一致；请稍后重新核对，不能据此重发。');
    checkNetwork(await provider.send('eth_chainId', []));
    return { latest, pending };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(503, '服务器暂时无法独立核对交易序号；请稍后重试，部署记录保持不变。');
  }
}

/** Prove that a different successful outer call could not act as this EOA. */
async function provePlainEoaReplacement(provider, record, tx, receipt) {
  const target = record.version === 2 ? record.target : record.market;
  if (![0,1,2].includes(tx.type) || tx.authorizationList?.length
    || tx.to?.toLowerCase() === target.toLowerCase() || receipt.blockNumber < 1
    || !Number.isSafeInteger(receipt.index) || receipt.index < 0) return false;
  try {
    const [before, codeBefore, block] = await Promise.all([
      provider.getBlock(receipt.blockNumber - 1), provider.getCode(record.account, receipt.blockNumber - 1),
      provider.getBlock(receipt.blockNumber, true),
    ]);
    if (codeBefore !== '0x' || !before?.hash || block?.parentHash !== before.hash
      || block.hash !== receipt.blockHash) return false;
    // A type-4 authorization earlier in this same block could temporarily
    // delegate the account even if getCode is empty at both block boundaries.
    // Reject unknown envelopes as well. A complete ordered block is required.
    const transactions = block.prefetchedTransactions;
    if (!Array.isArray(transactions) || transactions.length <= receipt.index
      || transactions[receipt.index]?.hash?.toLowerCase() !== tx.hash.toLowerCase()
      || transactions.slice(0,receipt.index).some(prior => ![0,1,2].includes(prior.type))) return false;
    const [beforeAgain,blockAgain]=await Promise.all([
      provider.getBlock(receipt.blockNumber - 1),provider.getBlock(receipt.blockNumber),
    ]);
    return beforeAgain?.hash === before.hash && blockAgain?.hash === block.hash;
  } catch { return false; }
}

export async function verifyMarketFinalized(provider, record, hash) {
  const { tx, receipt } = await finalizedNonce(provider, record.account, record.nonce, hash, record.version === 2);
  const target = record.version === 2 ? record.target : record.market;
  const matches = tx.to?.toLowerCase() === target.toLowerCase() && tx.data.toLowerCase() === record.data.toLowerCase()
    && tx.value.toString() === record.value;
  // The wallet can rewrite a requested type-2 transaction into a type-4 EIP-7702
  // envelope. A successful outer receipt, calldata substring, or product event
  // cannot prove which inner call ran for every supported product action. Keep
  // the nonce reserved until the exact outer call (or a separately proved inner
  // execution) is known. DELETE must not turn an uncertain success into a fresh
  // signing slot.
  // A successful 21,000-gas self-transfer with no authorization list has no
  // execution gas for delegated code, regardless of legacy or EIP-1559 fees.
  const cancelled = receipt.status === 1 && [0,1,2].includes(tx.type) && tx.gasLimit === 21_000n
    && tx.to?.toLowerCase() === record.account.toLowerCase() && tx.data === '0x' && tx.value === 0n
    && (!tx.authorizationList || tx.authorizationList.length === 0);
  const plainEoaReplacementVerified = receipt.status === 1 && !matches && !cancelled
    && await provePlainEoaReplacement(provider, record, tx, receipt);
  if (receipt.status === 1 && !matches && !cancelled && !plainEoaReplacementVerified)
    fail(409, 'Successful replacement may contain an inner product call; keep the journal pending for manual verification.');
  if (record.version !== 2 && record.hash?.toLowerCase() === hash.toLowerCase()
    && !matches) fail(409, 'Original market transaction payload differs.');
  let gasLimitExceeded = false, feeExceeded = false;
  if (record.version === 2 && matches) {
    const gasLimit = BigInt(record.gas), feeCap = BigInt(record.gasPrice);
    // Once the exact outer call is finalized, a wallet-side fee or gas-limit
    // increase cannot change which product action ran. Retain the variance in
    // the immutable result instead of stranding the wallet's signing lane.
    gasLimitExceeded = typeof tx.gasLimit === 'bigint' && tx.gasLimit > gasLimit;
    feeExceeded = [tx.gasPrice,tx.maxFeePerGas,tx.maxPriorityFeePerGas,receipt.gasPrice]
      .some(fee => typeof fee === 'bigint' && fee > feeCap);
  }
  const result = { action: record.action.kind, status: matches ? (receipt.status === 1 ? 'confirmed' : 'reverted')
    : cancelled && receipt.status === 1 ? 'cancelled' : 'replaced', finalized: true, transactionHash: hash.toLowerCase(),
    account: record.account, target, nonce: record.nonce, factory: record.factory,
    receipt: { status: receipt.status, transactionHash: hash.toLowerCase(), to: receipt.to,
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash } };
  if (gasLimitExceeded) result.gasLimitExceeded = true;
  if (feeExceeded) result.feeExceeded = true;
  if (plainEoaReplacementVerified) result.plainEoaReplacementVerified = true;
  if (record.version === 2 && ['pool','portfolio'].includes(record.targetType) && record.action.kind === 'deposit' && result.status === 'confirmed') {
    const expected = decodeProduct(record);
    const deposits = (receipt.logs ?? []).filter(log => !log.removed && log.transactionHash?.toLowerCase() === hash.toLowerCase()
      && log.blockHash === receipt.blockHash && log.address?.toLowerCase() === target.toLowerCase()).flatMap(log => {
      try { const parsed = (record.targetType === 'portfolio' ? PRODUCT_PORTFOLIO_ABI : PRODUCT_POOL_ABI).parseLog(log); return parsed?.name === 'Deposited' ? [parsed] : []; }
      catch { return []; }
    });
    if (deposits.length !== 1 || identity(deposits[0].args.user ?? deposits[0].args.member) !== record.account.toLowerCase()
      || deposits[0].args.shares !== expected.args[0] || deposits[0].args.amount.toString() !== record.value)
      fail(409, 'Finalized deposit event does not match the recorded pool, account, shares and payment.');
    Object.assign(result, { poolAddress: target, shares: expected.args[0].toString(), amountWei: record.value });
  }
  if (record.version === 2 && record.targetType === 'factory' && result.status === 'confirmed') {
    const expected=decodeProduct(record), params=expected.args[0];
    const events=(receipt.logs ?? []).filter(log=>!log.removed && log.transactionHash?.toLowerCase()===hash.toLowerCase()
      && log.blockHash===receipt.blockHash && log.address?.toLowerCase()===target.toLowerCase()).flatMap(log=>{
      try { const parsed=PRODUCT_FACTORY_ABI.parseLog(log); return parsed?.name==='PoolCreated' ? [parsed] : []; } catch {return [];}
    });
    if (events.length!==1 || identity(events[0].args.circuits)!==identity(params.circuits)
      || events[0].args.circuitId!==params.circuitId || events[0].args.targetRaise!==params.targetRaise || events[0].args.priceCap!==params.priceCap)
      fail(409,'Finalized pool creation event differs from the reviewed request.');
    result.poolAddress=getAddress(events[0].args.pool);
  }
  if (record.version === 2 && record.targetType === 'portfolioFactory' && result.status === 'confirmed') {
    const expected=decodeProduct(record);
    const events=(receipt.logs ?? []).filter(log=>!log.removed && log.transactionHash?.toLowerCase()===hash.toLowerCase()
      && log.blockHash===receipt.blockHash && log.address?.toLowerCase()===target.toLowerCase()).flatMap(log=>{
      try { const parsed=PRODUCT_PORTFOLIO_FACTORY_ABI.parseLog(log); return parsed?.name==='PortfolioCreated' ? [parsed] : []; } catch {return [];}
    });
    if (events.length!==1 || ['budgetWei','absoluteCapWei','unitCapWei'].some((field,i)=>events[0].args[field]!==expected.args[i]))
      fail(409,'Finalized portfolio creation event differs from the reviewed request.');
    result.portfolioAddress=getAddress(events[0].args.portfolio);
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

/** Verify each winning transaction against one stable finalized BSC anchor. */
async function finalizedCompletedSteps(provider, account, steps) {
  if (!provider) fail(503, 'BSC receipt verifier is unavailable.');
  try {
    const chainId = await provider.send('eth_chainId', []);
    if (typeof chainId !== 'string' || !/^0x[\da-f]+$/i.test(chainId) || BigInt(chainId) !== 56n)
      fail(503, 'Receipt RPC is not BSC mainnet.');
    const [latest, finalized] = await Promise.all([provider.getBlock('latest'), provider.getBlock('finalized')]);
    if (!latest || !finalized?.hash) fail(409, 'Transaction is not finalized.');
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
        || !Number.isSafeInteger(receipt.index) || receipt.index < 0 || tx.index !== receipt.index
        || (tx.to ?? '').toLowerCase() !== (receipt.to ?? '').toLowerCase()
        || receipt.status !== 0 && receipt.status !== 1) fail(409, 'Transaction does not match the recorded wallet nonce.');
      // A node may discard a replaced pending transaction. Its retained hash is
      // provenance only, never evidence that deployment succeeded. If the node
      // still knows it, it must describe the same deployment intent as the
      // finalized winner; cancellation or a different payload cannot qualify.
      await mapInBatches(step.previousTxHashes ?? [], 4, async hash => {
        const prior = await provider.getTransaction(hash);
        if (!prior) return;
        if (prior.hash?.toLowerCase() !== hash.toLowerCase() || prior.chainId !== 56n
          || !recordedAddressMatches(prior.from, account.toLowerCase()) || prior.nonce !== step.nonce
          || (prior.to ?? '').toLowerCase() !== (tx.to ?? '').toLowerCase()
          || prior.value !== tx.value || prior.data?.toLowerCase() !== tx.data.toLowerCase())
          fail(409, 'Deployment acceleration history differs from the finalized transaction intent.');
      });
      const canonical = await provider.getBlock(receipt.blockNumber);
      // The finalized canonical block itself proves that this wallet nonce was
      // consumed. Public RPCs often prune historical account-state tries; a
      // historical eth_getTransactionCount is neither necessary nor available.
      if (canonical?.hash !== receipt.blockHash || !Array.isArray(canonical.transactions)
        || canonical.transactions[receipt.index]?.toLowerCase() !== step.txHash.toLowerCase()
        || latest.number - receipt.blockNumber + 1 < 2
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

function artifactContentDigest(bundle) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const { sourceCommit: _commit, ...content } = bundle;
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(content))));
}

async function verifyWrappedCoordinator(provider, record, proofs, execution, suppliedBundle) {
  let bundle;
  try {
    // This is server-owned build data, never a browser-supplied artifact. The
    // optional argument is an explicit dependency used by pure provider tests.
    bundle = suppliedBundle ?? JSON.parse(readFileSync(new URL('../dist/deployment-artifacts.json', import.meta.url), 'utf8'));
  } catch { fail(503, 'Trusted deployment artifact is unavailable for wrapped initialization verification.'); }
  const artifact = bundle?.artifacts?.AtomicDeployment;
  const coordinatorIndex = record.steps.findIndex(step => step.id === 'AtomicDeployment');
  const coordinatorStep = record.steps[coordinatorIndex];
  const creation = proofs[coordinatorIndex];
  if (!artifact || !DATA.test(artifact.bytecode) || artifact.bytecode === '0x'
    || artifactContentDigest(bundle).toLowerCase() !== record.artifactDigest?.toLowerCase()
    || creation?.tx.data.toLowerCase() !== artifact.bytecode.toLowerCase())
    fail(409, 'Wrapped initialization coordinator does not match the trusted deployment artifact.');
  try {
    const currentCode = await provider.getCode(execution.coordinator);
    const codehash = typeof currentCode === 'string' && DATA.test(currentCode) && currentCode !== '0x'
      ? keccak256(currentCode) : null;
    if (!codehash || codehash !== coordinatorStep.codehash.toLowerCase()
      || codehash !== record.verification.code.AtomicDeployment.codehash.toLowerCase())
      fail(409, 'Wrapped initialization coordinator runtime code differs from the confirmed deployment.');
    const iface = new Interface(artifact.abi);
    const read = async name => iface.decodeFunctionResult(name,
      await provider.call({ to: execution.coordinator, data: iface.encodeFunctionData(name) }));
    const [deployer, deployed, prediction, deployment] = await Promise.all([
      read('deployer'), read('deployed'), read('predictedFactory'), read('deployment'),
    ]);
    const names = ['timelock', 'beacon', 'factory', 'shareMarket'];
    if (deployed[0] !== true || !recordedAddressMatches(deployer[0], record.account.toLowerCase())
      || !recordedAddressMatches(prediction[0], execution.addresses.factory.toLowerCase())
      || names.some((name, index) => !recordedAddressMatches(deployment[index], execution.addresses[name].toLowerCase())))
      fail(409, 'Wrapped initialization coordinator state differs from its verified completion events.');
    if (record.kind === 'integrated-v2') {
      const [portfolioPrediction,portfolio] = await Promise.all([read('predictedPortfolioFactory'),read('portfolioDeployment')]);
      if (!recordedAddressMatches(portfolioPrediction[0],execution.addresses.portfolioFactory.toLowerCase())
        || ['portfolioFactory','portfolioBeacon','portfolioShareMarket'].some((name,index)=>
          !recordedAddressMatches(portfolio[index],execution.addresses[name].toLowerCase())))
        fail(409,'Wrapped portfolio initialization state differs from its verified completion events.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(503, 'Wrapped initialization coordinator state could not be independently verified.');
  }
}

/** Archive only after proving every deployment intent's finalized winning transaction. */
export async function verifyCompletedDeployment(provider, record, { trustedArtifactBundle } = {}) {
  if (record?.status !== 'complete') fail(409, 'Only a completed deployment can be archived.');
  if (record.kind !== undefined && record.kind !== 'integrated-v2') fail(409,'Unsupported deployment kind.');
  const libraries = new Set([...LIBRARY_STEPS,...(record.kind === 'integrated-v2' ? ['FirstoSale'] : [])]);
  const factoryStep = record.steps?.[libraries.size + 2]?.id;
  if (record.kind === 'integrated-v2' && !['PoolFactory','FreshPoolFactory'].includes(factoryStep))
    fail(409, 'Completed deployment has an unsupported Factory implementation.');
  const finalSteps = record.kind === 'integrated-v2'
    ? ['AtomicDeployment','PoolVault',factoryStep,
      'ShareMarket','BudgetPortfolioFactory','BudgetPortfolioVault','initialize'] : FINAL_STEPS;
  const librarySteps = record.steps.slice(0, libraries.size);
  if (record.steps.length !== libraries.size + finalSteps.length
    || librarySteps.some(step => !libraries.has(step.id))
    || new Set(librarySteps.map(step => step.id)).size !== libraries.size
    || finalSteps.some((id, index) => record.steps[libraries.size + index].id !== id))
    fail(409, 'Completed deployment has missing or reordered steps.');
  const verification = record.verification;
  if (!verification || !Array.isArray(verification.checks) || verification.checks.length === 0
    || verification.checks.some(check => check?.passed !== true)
    || !isRecord(verification.code)) fail(409, 'Completed deployment lacks a passed graph verification.');
  let previousNonce = -1;
  const transactionHashes = new Set(record.steps.map(step => step.txHash).filter(hash => typeof hash === 'string')
    .map(hash => hash.toLowerCase()));
  for (const step of record.steps) {
    if (step.status !== 'confirmed' || step.replacementHash
      || !Number.isSafeInteger(step.nonce)
      || step.nonce <= previousNonce || !HASH.test(step.txHash)
      || !HASH.test(step.dataHash) || !isRecord(step.receipt))
      fail(409, 'Completed deployment contains an unknown or replaced transaction.');
    const history = step.previousTxHashes === undefined ? [] : step.previousTxHashes;
    if (!Array.isArray(history) || history.length > 16
      || history.length > 0 && step.finalizedRecovery !== true)
      fail(409, 'Completed deployment has invalid acceleration history.');
    for (const hash of history) {
      if (typeof hash !== 'string' || !HASH.test(hash) || transactionHashes.has(hash.toLowerCase()))
        fail(409, 'Completed deployment has invalid acceleration history.');
      transactionHashes.add(hash.toLowerCase());
    }
    previousNonce = step.nonce;
  }
  const proofs = await finalizedCompletedSteps(provider, record.account, record.steps);
  let actualSpent = 0n;
  for (const [index, step] of record.steps.entries()) {
    const { tx, receipt } = proofs[index];
    const exactPayload = keccak256(tx.data) === step.dataHash
      && (step.id === 'initialize'
        ? recordedAddressMatches(record.addresses.AtomicDeployment, tx.to?.toLowerCase()) : tx.to === null);
    if (receipt.status !== 1 || tx.value !== 0n || step.id !== 'initialize' && !exactPayload
      || step.receipt.blockNumber !== receipt.blockNumber || step.receipt.blockHash !== receipt.blockHash
      || step.receipt.status !== receipt.status
      || step.receipt.gasUsed !== receipt.gasUsed.toString()
      || step.receipt.gasPrice !== receipt.gasPrice.toString()
      || step.receipt.feeWei !== receipt.fee.toString())
      fail(409, 'Completed deployment transaction or receipt differs from the finalized chain.');
    actualSpent += receipt.fee;
    if (step.id === 'initialize') {
      if (!exactPayload) {
        let execution;
        try { execution = verifyInitializationExecution({ record, step, tx, receipt }); }
        catch { fail(409, 'Wrapped initialization lacks exact verified coordinator completion evidence.'); }
        if (execution.kind !== 'wrapped') fail(409, 'Initialization payload differs from its recorded intent.');
        await verifyWrappedCoordinator(provider, record, proofs, execution, trustedArtifactBundle);
      }
      continue;
    }
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

/** Isolated, bounded public reads. */
export function createBoundedOfficialProvider(url, timeoutMs = OFFICIAL_RPC_TIMEOUT_MS) {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  request.setThrottleParams({ maxAttempts: 1 });
  return new JsonRpcProvider(request, 56, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
}

/** The signing RPC must not batch independent graph checks: some BSC endpoints
 * return incomplete batch responses, which otherwise reject valid intents. */
export function createProductVerifierProvider(url, timeoutMs = OFFICIAL_RPC_TIMEOUT_MS) {
  // The chain is checked explicitly in verifyProductIntent; avoid ethers'
  // separate eth_chainId bootstrap before every read against this fixed RPC.
  // This signing path must also use the bounded HTTP timeout and no hidden
  // Retry-After wait when its upstream responds with 429.
  return createBoundedOfficialProvider(url, timeoutMs);
}

/** Reuse only a proof for the exact canonical block and configured deployment.
 * Per-intent registration, values, nonce, fees and balance remain fresh in
 * verifyProductIntent, including its final block-hash and chain-ID check. */
export function createPinnedSigningGraphVerifier(graphVerifier, trustedProduct, now = Date.now) {
  if (!trustedProduct) return graphVerifier;
  const digests = [trustedProduct.record?.artifactDigest, trustedProduct.integratedUpgrade?.digest]
    .filter(value => HASH.test(value ?? '')).map(value => value.toLowerCase()).sort();
  if (!digests.length) fail(503, 'Trusted product deployment digest is unavailable.');
  const cache = new Map(), proofs = new Map();
  return async (provider, factory, block) => {
    if (!Number.isSafeInteger(block?.number) || !HASH.test(block?.hash ?? ''))
      fail(503, 'Product block is unavailable.');
    const factoryId = identity(factory), blockHash = block.hash.toLowerCase();
    const key = `${factoryId}:${block.number}:${blockHash}:${digests.join(':')}`;
    const assertPinned = async () => {
      const current = await provider.getBlock(block.number);
      if (current?.hash?.toLowerCase() !== blockHash)
        fail(409, 'Chain changed during product graph verification.');
    };
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      await assertPinned();
      return cached.graph;
    }
    if (cached) cache.delete(key);
    let proof = proofs.get(key);
    if (!proof) {
      proof = (async () => {
        const graph = await graphVerifier(provider, factory, block);
        if (!graph || identity(graph.factory) !== factoryId || graph.blockNumber !== block.number
          || !digests.includes(graph.artifactDigest?.toLowerCase()))
          fail(503, 'Reviewed product graph identity changed.');
        await assertPinned();
        cache.set(key, { graph, expires:now() + SIGNING_GRAPH_CACHE_MS });
        if (cache.size > 64) {
          for (const [item, entry] of cache) if (entry.expires <= now()) cache.delete(item);
          if (cache.size > 64) cache.delete(cache.keys().next().value);
        }
        return graph;
      })();
      proofs.set(key, proof);
      proof.finally(() => { if (proofs.get(key) === proof) proofs.delete(key); }).catch(() => {});
    }
    return proof;
  };
}

export function createJournalService({ dbPath, origin, rpcUrl, secureCookies = false,
  provider: suppliedProvider, currentArtifactDigest, assertSigningInputsCurrent = () => {}, allowedProductFactories = [], productDeploymentRecordPath,
  productDeploymentRecord, productArtifactBundle, productArtifactBundlePath, productGraphVerifier, legacyFactory,
  officialCandidateDiscovery = fetchOfficialCandidates, officialSnapshotFetch = fetch, budgetCandidateDiscovery = readBudgetCandidates,
  officialScanTimeoutMs = OFFICIAL_SCAN_MS, productGraphRefreshMs = PRODUCT_GRAPH_REFRESH_MS,
  now = Date.now, notificationService,
  genesisRecordPath, genesisBundlePath, genesisRecord, genesisBundle,
  integratedUpgradeEvidencePath, integratedUpgradeEvidence, integratedUpgradeArtifactPath,
  integratedUpgradeArtifact, genesisManifestPath, genesisManifest,
  freshActivationEvidencePath, expectedGasWallet,
  salePolicyCatalogPath, salePolicyArtifactPath,
  nativeSaleCatalogPath, nativeSaleArtifactPath,
  firstoAskPublisher = null, firstoAskPublisherDependencies,
  gasWalletAddressReader, gasWalletProofReader, freshConsolePreGenesis = false,
  freshStage2Hold = true, freshProduct = null, freshProductReadinessReader } = {}) {
  if (typeof dbPath !== 'string' || !dbPath) throw new Error('Journal database path is required.');
  if (typeof currentArtifactDigest !== 'function') throw new Error('Current deployment artifact digest provider is required.');
  if (typeof assertSigningInputsCurrent !== 'function') throw new Error('Deployment signing input verifier must be a function.');
  if (!Number.isInteger(officialScanTimeoutMs) || officialScanTimeoutMs < 1 || officialScanTimeoutMs > OFFICIAL_SCAN_MS)
    throw new Error('Official scan timeout must be within the reviewed limit.');
  if (!Number.isSafeInteger(productGraphRefreshMs) || productGraphRefreshMs < 100
    || productGraphRefreshMs > PRODUCT_GRAPH_REFRESH_MS)
    throw new Error('Product graph refresh interval must be within the reviewed limit.');
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin || !['https:', 'http:'].includes(parsedOrigin.protocol)) throw new Error('Exact journal origin is required.');
  if (parsedOrigin.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(parsedOrigin.hostname))
    throw new Error('Journal HTTP origin must be loopback.');
  const cookieSecure = secureCookies || parsedOrigin.protocol === 'https:';
  legacyFactory = legacyFactoryConfiguration(legacyFactory);
  const store = new JournalStore(dbPath);
  const allowChallenge = createRequestLimiter({ perClient: 120 });
  const allowPublicGraph = createRequestLimiter({ windowMs: 10_000, perClient: 4 });
  const allowQuote = createRequestLimiter({ windowMs: 60 * 60_000, perClient: 40 });
  const allowArchive = createRequestLimiter({ windowMs: 60 * 60_000, perClient: 300 });
  const allowProductIntentIp = createRequestLimiter({ windowMs: PRODUCT_INTENT_WINDOW_MS,
    perClient: PRODUCT_INTENT_PER_IP, now });
  const productIntentAccounts = new Map();
  let productIntentWindow = -1;
  const provider = suppliedProvider ?? (rpcUrl ? createProductVerifierProvider(rpcUrl) : null);
  const officialProvider = suppliedProvider ? suppliedProvider : rpcUrl ? createBoundedOfficialProvider(rpcUrl) : null;
  if (!Array.isArray(allowedProductFactories) || allowedProductFactories.length > 32) throw new Error('Invalid product Factory allowlist.');
  const productFactories = new Set(allowedProductFactories.map(identity));
  if (productFactories.has('0x0000000000000000000000000000000000000000')) throw new Error('Zero product Factory is forbidden.');
  const trustedProduct = productGraphConfiguration({recordPath:productDeploymentRecordPath,record:productDeploymentRecord,
    bundle:productArtifactBundle,bundlePath:productArtifactBundlePath ?? new URL('../dist/deployment-artifacts.json',import.meta.url),
    genesisRecordPath,genesisBundlePath,genesisRecord,genesisBundle,
    integratedUpgradeEvidencePath,integratedUpgradeEvidence,integratedUpgradeArtifactPath,
    integratedUpgradeArtifact,genesisManifestPath,genesisManifest,
    productActivationPath:freshActivationEvidencePath,expectedGasWallet,salePolicyCatalogPath,salePolicyArtifactPath,
    nativeSaleCatalogPath,nativeSaleArtifactPath});
  if (gasWalletAddressReader !== undefined && typeof gasWalletAddressReader !== 'function')
    throw new Error('Gas wallet credential address reader is invalid.');
  if (gasWalletProofReader !== undefined && typeof gasWalletProofReader !== 'function')
    throw new Error('Gas wallet signer proof reader is invalid.');
  if (gasWalletAddressReader && gasWalletProofReader)
    throw new Error('Only one Gas wallet proof source may be configured.');
  if (typeof freshConsolePreGenesis !== 'boolean') throw new Error('Fresh console mode must be a boolean.');
  if (typeof freshStage2Hold !== 'boolean') throw new Error('Fresh Stage 2 hold must be a boolean.');
  const credentialStatus = async account => {
    // This HTTP-facing process must not receive a Gas private key. A configured
    // public address is not proof that an isolated signer holds its private key.
    let configured = null;
    try { configured = expectedGasWallet ? getAddress(expectedGasWallet) : null; }
    catch { /* Invalid configuration remains unverified. */ }
    if (gasWalletProofReader && configured) {
      try {
        const genesis = store.deployment(account).record;
        if (genesis?.status === 'complete' && genesis.kind === 'integrated-v2'
          && genesis.chainId === 56 && genesis.account?.toLowerCase() === account.toLowerCase()) {
          const challenge = { chainId: 56, origin, deploymentAccount: getAddress(account),
            deploymentId: genesis.id, artifactDigest: genesis.artifactDigest,
            expectedGasWallet: configured, nonce: `0x${randomBytes(32).toString('hex')}` };
          const proof = await gasWalletProofReader(challenge);
          return { credentialVerified: verifyGasSignerAttestation(challenge, proof), gasWallet: configured };
        }
      } catch { /* Missing, stale or invalid private signer proof never authorizes a write. */ }
      return { credentialVerified: false, gasWallet: configured };
    }
    if (!gasWalletAddressReader) return { credentialVerified: false, gasWallet: configured };
    try {
      const derived = getAddress(gasWalletAddressReader());
      const verified = Boolean(expectedGasWallet) && derived.toLowerCase() === getAddress(expectedGasWallet).toLowerCase();
      return { credentialVerified: verified, gasWallet: verified ? derived : null };
    } catch { return { credentialVerified: false, gasWallet: null }; }
  };
  const graphVerifier = productGraphVerifier ?? ((rpc,factory,block)=>verifyProductGraph(rpc,factory,trustedProduct,block));
  const signingGraphVerifier = createPinnedSigningGraphVerifier(graphVerifier, trustedProduct, now);
  const freshProductVerifier = createFreshProductGate(freshProduct, {trusted:trustedProduct,
    factories:productFactories,machineReader:freshProductReadinessReader,now});
  const productMode = Boolean(trustedProduct) || typeof productGraphVerifier === 'function' && productFactories.size > 0;
  const inFlight = new Set();
  const officialCache = new Map(), officialScans = new Map();
  const publicDiscoveryJobs = new Map();
  const officialGraphCache = new Map(), officialGraphProofs = new Map();
  const activeOfficialGraphClients = new Map();
  const officialRequestClients = new Map(), officialGraphClients = new Map(), budgetGraphClients = new Map();
  const activationBlocks = new Map();
  let lastVerifiedProductGraphSnapshot = null;
  let productGraphRefresh = null;
  let lastProductGraphRefreshAttemptAt = null;
  let lastProductGraphReadAt = null;
  let officialTokens = OFFICIAL_REQUEST_BURST, officialRefillAt = now(), activeOfficialScans = 0;
  let activeOfficialGraphProofs = 0, officialGraphTokens = OFFICIAL_GRAPH_PROOF_BURST;
  let officialGraphRefillAt = now();
  let activeBudgetGraphProofs = 0, budgetGraphTokens = BUDGET_GRAPH_PROOF_BURST;
  let budgetGraphRefillAt = now();
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

  function freshRecoveryBundle(record) {
    // Every recovery uses the exact server-served Authority creation and runtime.
    const bundle = genesisBundle ?? JSON.parse(readFileSync(new URL('../dist/deployment-artifacts.json', import.meta.url), 'utf8'));
    if (artifactContentDigest(bundle).toLowerCase() !== record.genesisArtifactDigest.toLowerCase()
      || record.genesisArtifactDigest.toLowerCase() !== signingBuildDigest())
      fail(409, 'Reviewed Authority creation artifact changed.');
    return bundle;
  }

  function consumeProductIntentBudget(req, account) {
    const window = Math.floor(now() / PRODUCT_INTENT_WINDOW_MS);
    if (window !== productIntentWindow) { productIntentWindow = window; productIntentAccounts.clear(); }
    const count = productIntentAccounts.get(account) ?? 0;
    if (count >= PRODUCT_INTENT_PER_ACCOUNT || !allowProductIntentIp(req))
      fail(429, 'Too many product intent checks; retry shortly.');
    // Keep both dimensions bounded even when many authenticated wallets rotate.
    if (count === 0 && productIntentAccounts.size >= MAX_PRODUCT_INTENT_ACCOUNTS)
      productIntentAccounts.delete(productIntentAccounts.keys().next().value);
    productIntentAccounts.set(account, count + 1);
  }

  function verifyBoundedProductIntent(req, account, record) {
    consumeProductIntentBudget(req, account);
    return verifyProductIntent(provider, record, productFactories, signingGraphVerifier, { legacyFactory, freshProductVerifier });
  }

  function consumeClientToken(map, client, burst, refillMs) {
    const time = now(), prior = map.get(client);
    const available = prior ? Math.min(burst,
      prior.tokens + Math.max(0, time - prior.at) / refillMs) : burst;
    if (prior) map.delete(client);
    if (map.size >= MAX_OFFICIAL_CLIENTS) map.delete(map.keys().next().value);
    map.set(client, { tokens: available >= 1 ? available - 1 : available, at: time });
    return available >= 1;
  }

  function consumeOfficialBudget(req) {
    const time = now();
    officialTokens = Math.min(OFFICIAL_REQUEST_BURST,
      officialTokens + Math.max(0, time - officialRefillAt) / OFFICIAL_REQUEST_REFILL_MS);
    officialRefillAt = time;
    if (officialTokens < 1) fail(429, 'Official market preview is busy; retry shortly.');
    if (!consumeClientToken(officialRequestClients, clientAddress(req),
      OFFICIAL_CLIENT_REQUEST_BURST, OFFICIAL_CLIENT_REQUEST_REFILL_MS))
      fail(429, 'Too many market previews from this client; retry shortly.');
    officialTokens -= 1;
  }

  function consumeOfficialGraphProofBudget(req, budget = false) {
    const time = now();
    if (budget) {
      budgetGraphTokens = Math.min(BUDGET_GRAPH_PROOF_BURST,
        budgetGraphTokens + Math.max(0, time - budgetGraphRefillAt) / BUDGET_GRAPH_PROOF_REFILL_MS);
      budgetGraphRefillAt = time;
      if (budgetGraphTokens < 1) fail(429, 'Budget graph verification is busy; retry shortly.');
    } else {
      officialGraphTokens = Math.min(OFFICIAL_GRAPH_PROOF_BURST,
        officialGraphTokens + Math.max(0, time - officialGraphRefillAt) / OFFICIAL_GRAPH_PROOF_REFILL_MS);
      officialGraphRefillAt = time;
      if (officialGraphTokens < 1) fail(429, 'Product graph verification budget is busy; retry shortly.');
    }
    if (!consumeClientToken(budget ? budgetGraphClients : officialGraphClients, clientAddress(req),
      OFFICIAL_CLIENT_GRAPH_BURST, OFFICIAL_CLIENT_GRAPH_REFILL_MS))
      fail(429, 'Too many product graph proofs from this client; retry shortly.');
    if (budget) budgetGraphTokens -= 1;
    else officialGraphTokens -= 1;
  }

  async function pinnedOfficialBlock(number, hash, missingTransient = false) {
    const block = await officialProvider.getBlock(number);
    if (!block && missingTransient)
      throw new ProductGraphAnchorUnavailable('Verified product block is temporarily unavailable.');
    if (!block || block.number !== number || !HASH.test(block.hash ?? '') ||
      block.hash.toLowerCase() !== hash || !Number.isSafeInteger(block.timestamp)) {
      fail(409, 'Requested BSC block changed or is unavailable.');
    }
    return block;
  }

  async function verifiedOfficialGraph(factory, block, hash, forProductGraph = false, req = null,
    budgetCandidate = false) {
    const key = `${identity(factory)}:${hash}`;
    const proofKey = forProductGraph ? `site:${key}` : key;
    const cached = officialGraphCache.get(key);
    if (cached && cached.expires > now()) return cached.verified;
    if (cached) officialGraphCache.delete(key);
    let proof = officialGraphProofs.get(proofKey);
    if (!proof) {
      // The one-at-a-time, timer-bounded site graph proof has its own slot.
      // Public candidate lookups cannot exhaust its shared preview budget.
      let client = null;
      if (!forProductGraph) {
        client = clientAddress(req);
        if (activeOfficialGraphProofs >= MAX_OFFICIAL_GRAPH_PROOFS)
          fail(503, 'Product graph verification is busy; retry shortly.');
        if (budgetCandidate && activeBudgetGraphProofs >= MAX_BUDGET_GRAPH_PROOFS)
          fail(503, 'Budget graph verification is busy; retry shortly.');
        if (activeOfficialGraphClients.has(client))
          fail(503, 'This client already has a product graph proof running; retry shortly.');
        consumeOfficialGraphProofBudget(req, budgetCandidate);
        activeOfficialGraphProofs += 1;
        if (budgetCandidate) activeBudgetGraphProofs += 1;
        activeOfficialGraphClients.set(client, true);
      }
      proof = Promise.resolve().then(async () => {
        const verified = await graphVerifier(officialProvider, factory, block);
        if (!verified || identity(verified.factory) !== identity(factory) || verified.blockNumber !== block.number ||
          !HASH.test(verified.artifactDigest ?? '') ||
          trustedProduct && ![trustedProduct.record.artifactDigest,
            trustedProduct.integratedUpgrade?.digest].filter(Boolean).some(value =>
            verified.artifactDigest.toLowerCase() === value.toLowerCase()))
          fail(503, 'Reviewed product graph identity changed.');
        await pinnedOfficialBlock(block.number, hash, forProductGraph);
        officialGraphCache.set(key, { verified, expires: now() + OFFICIAL_GRAPH_CACHE_MS });
        if (officialGraphCache.size > 64) {
          for (const [item, entry] of officialGraphCache) if (entry.expires <= now()) officialGraphCache.delete(item);
          if (officialGraphCache.size > 64) officialGraphCache.delete(officialGraphCache.keys().next().value);
        }
        return verified;
      });
      officialGraphProofs.set(proofKey, proof);
      proof.finally(() => {
        if (!forProductGraph) {
          activeOfficialGraphProofs -= 1;
          if (budgetCandidate) activeBudgetGraphProofs -= 1;
          activeOfficialGraphClients.delete(client);
        }
        if (officialGraphProofs.get(proofKey) === proof) officialGraphProofs.delete(proofKey);
      }).catch(() => {});
    }
    return proof;
  }

  /** The operator-owned execute hash identifies the exact stage boundary.
   * Historical eth_call is intentionally avoided: non-archive BSC RPCs may
   * discard old state even while transaction receipts remain available. */
  async function verifiedCodeActivation(operationId, finalized, deploymentBlock) {
    const hash=trustedProduct.integratedUpgrade?.codeExecuteTxHash;
    if (!HASH.test(hash ?? '')) fail(503,'Reviewed upgrade execution hash has not been installed.');
    const plan=trustedProduct.integratedUpgrade.plan;
    const cached=activationBlocks.get(hash);
    if (cached && cached.number <= finalized.number) {
      const again=await officialProvider.getBlock(cached.number);
      if (again?.hash?.toLowerCase()===cached.hash.toLowerCase()) return cached;
      activationBlocks.delete(hash);
    }
    const [tx,receipt]=await Promise.all([
      officialProvider.getTransaction(hash),officialProvider.getTransactionReceipt(hash),
    ]);
    if (!tx || !receipt || tx.hash?.toLowerCase()!==hash.toLowerCase()
      || (receipt.hash ?? receipt.transactionHash)?.toLowerCase()!==hash.toLowerCase()
      || BigInt(tx.chainId) !== 56n || receipt.status !== 1
      || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber <= deploymentBlock
      || receipt.blockNumber > finalized.number || tx.blockNumber !== receipt.blockNumber
      || tx.blockHash?.toLowerCase()!==receipt.blockHash?.toLowerCase()
      || !Number.isSafeInteger(receipt.index) || receipt.index < 0 || tx.index !== receipt.index)
      fail(503,'Reviewed upgrade execution is not a finalized successful transaction.');
    const activated=await officialProvider.getBlock(receipt.blockNumber);
    if (activated?.number!==receipt.blockNumber || activated.hash?.toLowerCase()!==receipt.blockHash.toLowerCase()
      || !Number.isSafeInteger(activated.timestamp) || activated.timestamp<=0
      || activated.transactions?.[receipt.index]?.toLowerCase()!==hash.toLowerCase())
      fail(503,'Reviewed upgrade execution transaction index is not canonical.');
    const events=(receipt.logs ?? []).filter(log=>!log.removed
      && log.address?.toLowerCase()===trustedProduct.record.addresses.timelock.toLowerCase()
      && log.transactionHash?.toLowerCase()===hash.toLowerCase()
      && log.blockHash?.toLowerCase()===activated.hash.toLowerCase()).flatMap(log=>{
        try { const parsed=TIMELOCK_EXECUTION_ABI.parseLog(log); return parsed?.name==='CallExecuted' ? [parsed] : []; }
        catch { return []; }
      });
    if (events.length!==plan.steps.length || events.some((event,index)=>
      event.args.id?.toLowerCase()!==operationId.toLowerCase()
      || event.args.index!==BigInt(index)
      || event.args.target?.toLowerCase()!==plan.targets[index].toLowerCase()
      || event.args.value!==0n
      || event.args.data?.toLowerCase()!==plan.payloads[index].toLowerCase()))
      fail(503,'Reviewed upgrade execution events differ from the fixed plan.');
    const result={number:activated.number,hash:activated.hash,timestamp:activated.timestamp};
    activationBlocks.set(hash,result);
    return result;
  }

  async function officialCandidates(req, url, requestBudgetPaid = false) {
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 3 || new Set(keys).size !== 3 || keys.some(key => !['pool','block','hash'].includes(key)))
      fail(400, 'Exactly pool, block and hash are required.');
    const pool = identity(url.searchParams.get('pool'));
    const blockText = url.searchParams.get('block'), blockHash = url.searchParams.get('hash');
    if (pool === '0x0000000000000000000000000000000000000000' || !/^[1-9]\d*$/.test(blockText ?? '')
      || !Number.isSafeInteger(Number(blockText)) || !HASH.test(blockHash ?? ''))
      fail(400, 'Invalid pool, block number or block hash.');
    const blockNumber = Number(blockText), hash = blockHash.toLowerCase();
    // No untrusted request reaches graph verification or RPC before this process-wide budget.
    if (!requestBudgetPaid) consumeOfficialBudget(req);
    if (!officialProvider || !productMode || trustedProduct && trustedProduct.record.kind !== 'integrated-v2'
      && trustedProduct.upgradeRecord?.schemaVersion !== 2)
      fail(503, 'Reviewed upgraded product graph is unavailable.');
    const factory = trustedProduct?.record?.addresses?.factory ??
      (typeof productGraphVerifier === 'function' && productFactories.size === 1 ? [...productFactories][0] : null);
    if (!factory || !productFactories.has(identity(factory))) fail(503, 'Reviewed Factory is not enabled.');
    try {
      if (BigInt(await officialProvider.send('eth_chainId', [])) !== 56n) fail(503, 'Product RPC is not BSC mainnet.');
      const head = await officialProvider.getBlock('latest');
      if (!Number.isSafeInteger(head?.number) || blockNumber > head.number ||
        head.number - blockNumber > MAX_OFFICIAL_BLOCK_AGE)
        fail(409, 'Requested BSC block is outside the recent purchase window.');
      const block = await pinnedOfficialBlock(blockNumber, hash);
      const tag = `0x${blockNumber.toString(16)}`;
      const read = async (to, iface, name, args = []) => iface.decodeFunctionResult(name,
        await officialProvider.send('eth_call', [{ to, data: iface.encodeFunctionData(name, args) }, tag]));
      // Reject arbitrary pool addresses with inexpensive pinned reads before starting
      // a full schema2 deployment proof. Attribution is only a prefilter: success still
      // requires the full graph proof below.
      if (await officialProvider.getCode(pool, blockNumber) === '0x' || !(await read(factory, IDENTITY_ABI, 'isPool', [pool]))[0] ||
        identity((await read(pool, IDENTITY_ABI, 'factory'))[0]) !== identity(factory) ||
        identity((await read(pool, IDENTITY_ABI, 'OFFICIAL_FACTORY'))[0]) !== identity(factory))
        fail(409, 'Pool is not registered to the reviewed Factory.');
      const [stateRow, paramsRow] = await Promise.all([
        read(pool, OFFICIAL_POOL_READ_ABI, 'state'), read(pool, OFFICIAL_POOL_READ_ABI, 'params'),
      ]);
      const state = stateRow[0], params = paramsRow[0];
      if (state !== 1n || BigInt(block.timestamp) >= params.purchaseDeadline)
        fail(409, 'Pool is not Funded or its purchase window has expired.');
      const verified = await verifiedOfficialGraph(factory, block, hash, false, req);
      await pinnedOfficialBlock(blockNumber, hash);
      const [policy, purchaseModel, referenceRow] = await Promise.all([
        read(pool, OFFICIAL_POOL_READ_ABI, 'flexiblePurchase'),
        read(pool, OFFICIAL_POOL_READ_ABI, 'purchaseModel'),
        read(pool, OFFICIAL_POOL_READ_ABI, 'purchaseReferenceWeight'),
      ]);
      const referenceWeight = referenceRow[0];
      const response = { complete: true, chainId: 56, factory: getAddress(factory),
        artifactDigest: verified.artifactDigest.toLowerCase(), pool: getAddress(pool),
        blockNumber: String(blockNumber), blockHash: hash, flexible: policy.enabled, model: null, candidates: [] };
      if (!policy.enabled) {
        await pinnedOfficialBlock(blockNumber, hash);
        return response;
      }
      if (!OFFICIAL_COLLECTIONS.has(params.circuits.toLowerCase()) || policy.referenceCircuitId !== params.circuitId ||
        !purchaseModel.initialized || referenceWeight === 0n || policy.config.minVerifiedWeight === 0n ||
        policy.config.referencePriceWei === 0n || params.priceCap === 0n)
        fail(503, 'Pool purchase model is incomplete.');
      const constraints = { circuits: getAddress(params.circuits), taskId: purchaseModel.taskId,
        minVerifiedWeight: policy.config.minVerifiedWeight, referenceVerifiedWeight: referenceWeight,
        referencePriceWei: policy.config.referencePriceWei, priceCap: params.priceCap };
      response.model = Object.fromEntries(Object.entries(constraints).map(([key, value]) =>
        [key, typeof value === 'bigint' ? value.toString() : value]));
      const key = `${pool}:${hash}`;
      const cached = officialCache.get(key);
      if (cached && cached.expires > now()) {
        await pinnedOfficialBlock(blockNumber, hash);
        return { ...response, candidates: cached.candidates };
      }
      if (cached) officialCache.delete(key);
      let scan = officialScans.get(key);
      if (!scan) {
        if (activeOfficialScans >= MAX_OFFICIAL_SCANS) fail(503, 'Official market scan is busy; retry shortly.');
        activeOfficialScans += 1;
        const abort = new AbortController();
        const work = Promise.resolve().then(() => officialCandidateDiscovery(officialProvider,
          { blockNumber, signal: abort.signal, now: now() }, constraints, officialSnapshotFetch));
        work.finally(() => { activeOfficialScans -= 1; }).catch(() => {});
        scan = Promise.race([work, new Promise((_, reject) => {
          const timer = setTimeout(() => { abort.abort(); reject(new Error('Official market scan timed out.')); }, officialScanTimeoutMs);
          work.finally(() => clearTimeout(timer)).catch(() => {});
        })]);
        officialScans.set(key, scan);
        scan.finally(() => { if (officialScans.get(key) === scan) officialScans.delete(key); }).catch(() => {});
      }
      let found;
      try { found = await scan; }
      catch { fail(503, 'Complete official market scan unavailable.'); }
      if (found?.complete !== true || found.chainBlock !== blockNumber || !Array.isArray(found.candidates))
        fail(503, 'Complete official market scan unavailable.');
      let candidates;
      try {
        candidates = found.candidates.map(candidate => ({
          listingId: BigInt(candidate.listingId).toString(), collection: getAddress(candidate.collection),
          tokenId: BigInt(candidate.tokenId).toString(), seller: getAddress(candidate.seller),
          priceWei: BigInt(candidate.priceWei).toString(), verifiedWeight: BigInt(candidate.verifiedWeight).toString(),
        }));
      } catch { fail(503, 'Official market scan returned an invalid candidate.'); }
      if (candidates.some(candidate => candidate.collection.toLowerCase() !== constraints.circuits.toLowerCase() ||
        BigInt(candidate.listingId) < 1n || BigInt(candidate.tokenId) < 0n || BigInt(candidate.priceWei) < 1n ||
        BigInt(candidate.priceWei) > constraints.priceCap ||
        BigInt(candidate.verifiedWeight) < constraints.minVerifiedWeight ||
        candidate.seller.toLowerCase() === '0x0000000000000000000000000000000000000000' ||
        BigInt(candidate.priceWei) > (BigInt(candidate.verifiedWeight) >= constraints.referenceVerifiedWeight
          ? constraints.referencePriceWei
          : constraints.referencePriceWei * BigInt(candidate.verifiedWeight) / constraints.referenceVerifiedWeight)))
        fail(503, 'Official market scan returned an invalid candidate.');
      await pinnedOfficialBlock(blockNumber, hash);
      officialCache.set(key, { candidates, expires: now() + OFFICIAL_CACHE_MS });
      if (officialCache.size > 64) {
        for (const [item, entry] of officialCache) if (entry.expires <= now()) officialCache.delete(item);
        if (officialCache.size > 64) officialCache.delete(officialCache.keys().next().value);
      }
      return { ...response, candidates };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      fail(503, 'Verified official market preview is unavailable.');
    }
  }

  async function budgetCandidates(req, url, requestBudgetPaid = false) {
    const keys=[...url.searchParams.keys()];
    if(keys.length!==3 || new Set(keys).size!==3 || keys.some(key=>!['parent','block','hash'].includes(key)))
      fail(400,'Exactly parent, block and hash are required.');
    const parent=identity(url.searchParams.get('parent')), number=Number(url.searchParams.get('block')), hash=url.searchParams.get('hash')?.toLowerCase();
    if(parent==='0x0000000000000000000000000000000000000000' || !/^[1-9]\d*$/.test(url.searchParams.get('block')??'') || !Number.isSafeInteger(number) || !HASH.test(hash??''))
      fail(400,'Invalid budget parent or pinned block.');
    if (!requestBudgetPaid) consumeOfficialBudget(req);
    const factory=trustedProduct?.record?.kind==='integrated-v2' ? trustedProduct.record.addresses.portfolioFactory :
      typeof productGraphVerifier==='function' && productFactories.size===1 ? [...productFactories][0] : null;
    if(!officialProvider || !productMode || !factory || !productFactories.has(identity(factory))) fail(503,'Reviewed budget Factory is unavailable.');
    try {
      if(BigInt(await officialProvider.send('eth_chainId',[]))!==56n) fail(503,'Product RPC is not BSC mainnet.');
      const latest=await officialProvider.getBlock('latest');
      if(!Number.isSafeInteger(latest?.number) || number>latest.number || latest.number-number>MAX_OFFICIAL_BLOCK_AGE) fail(409,'Budget block is outside the recent purchase window.');
      const block=await pinnedOfficialBlock(number,hash);
      // An arbitrary address must not consume a full graph proof. These
      // inexpensive pinned reads are only a prefilter; the complete proof and
      // the legacy Factory binding are still checked before returning data.
      const tag=`0x${number.toString(16)}`;
      const read=async(to,name,args=[])=>IDENTITY_ABI.decodeFunctionResult(name,
        await officialProvider.send('eth_call',[{to,data:IDENTITY_ABI.encodeFunctionData(name,args)},tag]))[0];
      if (await officialProvider.getCode(parent,number)==='0x'
        || !await read(factory,'isPool',[parent])
        || identity(await read(parent,'OFFICIAL_FACTORY'))!==identity(factory))
        fail(409,'Budget parent is not registered to the reviewed Factory.');
      const graph=await verifiedOfficialGraph(factory,block,hash,false,req,true);
      const key=`budget:${parent}:${hash}`, cached=officialCache.get(key);
      if(cached?.expires>now()){await pinnedOfficialBlock(number,hash);return cached.result;}
      let scan=officialScans.get(key);
      if(!scan){
        if(activeOfficialScans>=MAX_OFFICIAL_SCANS) fail(503,'Official market scan is busy; retry shortly.');
        activeOfficialScans++; const abort=new AbortController();
        const work=Promise.resolve().then(()=>budgetCandidateDiscovery({provider:officialProvider,parent,factory,graph,block,
          signal:abort.signal,fetcher:officialSnapshotFetch,now:now()}));
        work.finally(()=>{activeOfficialScans--;}).catch(()=>{});
        scan=Promise.race([work,new Promise((_,reject)=>{const timer=setTimeout(()=>{abort.abort();reject(new Error('Budget scan timed out.'));},officialScanTimeoutMs);
          work.finally(()=>clearTimeout(timer)).catch(()=>{});})]);
        officialScans.set(key,scan);scan.finally(()=>{if(officialScans.get(key)===scan)officialScans.delete(key);}).catch(()=>{});
      }
      const result=await scan;
      if(result?.complete!==true || identity(result.parent)!==parent || identity(result.factory)!==identity(factory)
        || result.chainId!==56 || identity(result.legacyFactory)!==identity(graph.legacyFactory)
        || result.artifactDigest?.toLowerCase()!==graph.artifactDigest.toLowerCase() || result.snapshot?.complete!==true
        || result.snapshot?.blockNumber!==number || result.snapshot?.blockHash?.toLowerCase()!==hash || !Array.isArray(result.candidates))
        fail(503,'Complete budget market scan unavailable.');
      await pinnedOfficialBlock(number,hash);
      officialCache.set(key,{result,expires:now()+OFFICIAL_CACHE_MS});
      if(officialCache.size>64)officialCache.delete(officialCache.keys().next().value);
      return result;
    } catch(error){if(error instanceof ApiError)throw error;fail(503,'Complete budget market scan unavailable; Firsto fallback is not authorized.');}
  }

  /** Public read jobs have no nonce, session, signing permission or caller-selected RPC target. */
  async function discoveryResponse(req,url,kind){
    const discover=kind==='budget'?budgetCandidates:officialCandidates;
    if(!url.searchParams.has('async'))return {status:200,body:await discover(req,url)};
    if(url.searchParams.getAll('async').length!==1||url.searchParams.get('async')!=='1')fail(400,'Invalid discovery mode.');
    const clean=new URL(url);clean.searchParams.delete('async');
    const field=kind==='budget'?'parent':'pool',keys=[...clean.searchParams.keys()];
    if(keys.length!==3||new Set(keys).size!==3||keys.some(key=>![field,'block','hash'].includes(key)))fail(400,'Invalid discovery query.');
    const target=identity(clean.searchParams.get(field)),number=Number(clean.searchParams.get('block')),hash=clean.searchParams.get('hash')?.toLowerCase();
    if(target==='0x0000000000000000000000000000000000000000'||!/^[1-9]\d*$/.test(clean.searchParams.get('block')??'')
      ||!Number.isSafeInteger(number)||!HASH.test(hash??''))fail(400,'Invalid discovery identity.');
    const key=`${kind}:${target}:${hash}`;let job=publicDiscoveryJobs.get(key);
    if(job?.expires<=now()){publicDiscoveryJobs.delete(key);job=null;}
    // Admit the request before creating a shared job. A throttled visitor must
    // not leave a failed job under a canonical key that another visitor needs.
    consumeOfficialBudget(req);
    if(!job){
      if(publicDiscoveryJobs.size>=64){for(const [id,entry] of publicDiscoveryJobs)if(entry.expires<=now())publicDiscoveryJobs.delete(id);
        if(publicDiscoveryJobs.size>=64)fail(503,'Discovery queue is full; retry shortly.');}
      job={status:'scanning',expires:Infinity};publicDiscoveryJobs.set(key,job);
      const finish=(status,value)=>{if(job.status!=='scanning')return;job.status=status;job.expires=now()+OFFICIAL_CACHE_MS;
        if(status==='complete')job.body=value;else job.error=value;};
      const timer=setTimeout(()=>{try{fail(503,'Complete discovery deadline exceeded; refresh the preview.');}catch(error){finish('failed',error);}},OFFICIAL_SCAN_MS);
      const pending=discover(req,clean,true).then(body=>finish('complete',body),error=>finish('failed',error)).finally(()=>clearTimeout(timer));
      inFlight.add(pending);pending.finally(()=>inFlight.delete(pending));
      // Return quickly even when a full chain scan needs many RPC batches.
      await Promise.race([pending,new Promise(resolve=>setTimeout(resolve,10))]);
    }else{
      if(!officialProvider)fail(503,'Product RPC is unavailable.');
      const [chain,,latest]=await Promise.all([officialProvider.send('eth_chainId',[]),pinnedOfficialBlock(number,hash),officialProvider.getBlock('latest')]);
      if(BigInt(chain)!==56n)fail(503,'Product RPC is not BSC mainnet.');
      if(!Number.isSafeInteger(latest?.number)||number>latest.number||latest.number-number>MAX_OFFICIAL_BLOCK_AGE){
        publicDiscoveryJobs.delete(key);fail(409,'Discovery block aged out; refresh the purchase preview.');}
    }
    if(job.status==='failed'){publicDiscoveryJobs.delete(key);throw job.error;}
    if(job.status==='complete')return {status:200,body:job.body};
    return {status:202,body:{complete:false,status:'scanning',chainId:56,[field]:getAddress(target),blockNumber:String(number),blockHash:hash,retryAfterMs:2000}};
  }

  // A cached graph is useful for display while its next finalized proof runs.
  // The signing verifier is separate and never consults this snapshot.
  async function verifyProductGraphSnapshot() {
    const previous=lastVerifiedProductGraphSnapshot;
    try {
      const chain=await officialProvider.send('eth_chainId',[]);
      if (BigInt(chain) !== 56n)
        fail(503, 'Product RPC is not BSC mainnet.');
      if (previous) {
        const anchor=await officialProvider.getBlock(previous.body.verifiedBlockNumber);
        if (!anchor)
          throw new ProductGraphAnchorUnavailable('Verified anchor is temporarily unavailable.');
        if (anchor.number!==previous.body.verifiedBlockNumber
          || anchor.hash?.toLowerCase()!==previous.body.verifiedBlockHash.toLowerCase())
          fail(409,'Verified product anchor changed.');
      }
      const block=await officialProvider.getBlock('finalized');
      if (!Number.isSafeInteger(block?.number) || !HASH.test(block?.hash ?? '')
        || !Number.isSafeInteger(block?.timestamp) || block.timestamp <= 0)
        fail(503, 'A finalized product block is unavailable.');
      const graph=await verifiedOfficialGraph(trustedProduct.record.addresses.factory,block,block.hash,true);
      const old=trustedProduct.record;
      const initial=old.steps.find(step=>step.id==='initialize');
      const activation=graph.securityUpgrade
        ? await verifiedCodeActivation(graph.securityUpgrade.operationId,block,initial.receipt.blockNumber)
        : graph.freshAuthority
          ? await officialProvider.getBlock(graph.freshAuthority.activationBlock)
        : await officialProvider.getBlock(initial.receipt.blockNumber);
      if (!activation)
        throw new ProductGraphAnchorUnavailable('Product activation block is temporarily unavailable.');
      if (!Number.isSafeInteger(activation?.number) || activation.number > block.number
        || !HASH.test(activation.hash ?? '') || !Number.isSafeInteger(activation.timestamp)
        || activation.timestamp <= 0 || (graph.freshAuthority
          ? activation.hash.toLowerCase() !== graph.freshAuthority.activationHash.toLowerCase()
          : !graph.securityUpgrade
            && activation.hash.toLowerCase() !== initial.receipt.blockHash.toLowerCase()))
        fail(503,'Reviewed product activation block changed.');
      const manifestNames={factory:'factory',shareMarket:'shareMarket',lens:'lens',beacon:'beacon',timelock:'timelock',
        portfolioFactory:'portfolioFactory',portfolioMarket:'portfolioShareMarket',
        portfolioBeacon:'portfolioBeacon',portfolioImplementation:'BudgetPortfolioVault',
        portfolioFactoryImplementation:'BudgetPortfolioFactory'};
      const manifestCodehash=Object.fromEntries(Object.entries(manifestNames)
        .map(([key,name])=>[key,graph.salePolicyUpgrade && key==='portfolioImplementation'
          ? old.verification.code.BudgetPortfolioVault.codehash : graph.codehash[name]]));
      const stage=graph.freshAuthority && graph.freshFactoryVerified ? 'fresh-active' : graph.securityUpgrade
        ? graph.securityUpgrade.roleWiringComplete ? 'role-wired'
          : graph.securityUpgrade.roleMigrationStarted ? 'role-migrating' : 'code-upgraded' : 'genesis';
      const manifest={schemaVersion:1,kind:'integrated-v2',chainId:56,
        ...Object.fromEntries(Object.entries(manifestNames)
          .map(([key,name])=>[key,graph.salePolicyUpgrade && key==='portfolioImplementation'
            ? old.addresses.BudgetPortfolioVault : graph.addresses[name]])),
        ...(graph.freshAuthority ? {authority:graph.freshAuthority.address,
          gasWallet:graph.freshAuthority.gasWallet,
          freshAuthority:{address:graph.freshAuthority.address,
            codehash:graph.freshAuthority.codehash,
            deploymentTxHash:graph.freshAuthority.deploymentTxHash,
            administratorOne:graph.freshAuthority.administratorOne,
            administratorTwo:graph.freshAuthority.administratorTwo,
            gasWallet:graph.freshAuthority.gasWallet}} : {}),
        deployment:{txHash:initial.txHash,blockNumber:initial.receipt.blockNumber,
          blockHash:initial.receipt.blockHash},artifactDigest:graph.artifactDigest,
        sourceCommit:graph.securityUpgrade ? trustedProduct.integratedUpgrade.bundle.sourceCommit : old.sourceCommit,
        verifiedAt:new Date(activation.timestamp*1000).toISOString(),
        verifiedBlockNumber:activation.number,verifiedBlockHash:activation.hash,
        codehash:manifestCodehash};
      const body={chainId:56,status:'verified',stage,
        artifactDigest:graph.artifactDigest,genesisArtifactDigest:trustedProduct.record.artifactDigest,
        upgradeArtifactDigest:trustedProduct.integratedUpgrade?.digest ?? null,
        reviewedUpgradeOperationId:trustedProduct.integratedUpgrade?.plan.operationId ?? null,
        reviewedBootstrapOperationId:trustedProduct.integratedUpgrade?.bootstrapPlan.operationId ?? null,
        operationId:graph.securityUpgrade?.operationId ?? null,
        ...(graph.salePolicyUpgrade ? {salePolicyUpgrade:graph.salePolicyUpgrade} : {}),
        ...(graph.nativeSaleUpgrade ? {nativeSaleUpgrade:graph.nativeSaleUpgrade} : {}),
        ...(graph.freshAuthority ? {freshAuthority:{address:graph.freshAuthority.address,
          codehash:graph.freshAuthority.codehash,activationBlock:graph.freshAuthority.activationBlock,
          activationHash:graph.freshAuthority.activationHash,
          deploymentTxHash:graph.freshAuthority.deploymentTxHash,
          administratorOne:graph.freshAuthority.administratorOne,
          administratorTwo:graph.freshAuthority.administratorTwo,
          gasWallet:graph.freshAuthority.gasWallet}} : {}),
        verifiedBlockNumber:block.number,verifiedBlockHash:block.hash,
        stageActivationBlock:activation.number,stageActivationHash:activation.hash,
        factory:trustedProduct.record.addresses.factory,
        portfolioFactory:trustedProduct.record.addresses.portfolioFactory ?? null,
        creationPaused:graph.securityUpgrade ? true : undefined,
        // A verified fresh graph can be displayed independently of old Factories.
        // Product signing remains closed until its separate API/relay cutover.
        ...(stage==='fresh-active' ? {freshFactoryVerified:true} : {}),
        operationalReady:false,
        userExitReady:stage==='fresh-active' && Boolean(freshProductVerifier),
        manifest};
      if (closed) fail(503, 'Journal is unavailable.');
      lastVerifiedProductGraphSnapshot={savedAt:now(),body,graph};
      return body;
    } catch (error) {
      // A transport failure is not evidence that a previously verified graph
      // changed. Keep it for display only, without extending its original age.
      // Unknown failures, chain mismatches and reorgs invalidate it immediately.
      if (!previous || !isTransientProductRpcFailure(error) || now()-previous.savedAt<0
        || now()-previous.savedAt>=PRODUCT_GRAPH_STALE_MS)
        lastVerifiedProductGraphSnapshot=null;
      officialGraphCache.clear();
      if (error instanceof ApiError) throw error;
      fail(503, 'Reviewed product graph could not be verified.');
    }
  }

  function startProductGraphRefresh() {
    if (productGraphRefresh) return productGraphRefresh;
    lastProductGraphRefreshAttemptAt=now();
    const refresh=Promise.resolve().then(verifyProductGraphSnapshot);
    productGraphRefresh=refresh;
    inFlight.add(refresh);
    refresh.finally(() => {
      if (productGraphRefresh === refresh) productGraphRefresh=null;
      inFlight.delete(refresh);
    }).catch(() => {});
    return refresh;
  }

  // Keep a recently visited display warm. After a quiet period, the next
  // visitor must get a new proof before receiving a current graph.
  const productGraphTimer=productMode && trustedProduct && officialProvider
    ? setInterval(()=>{
      const time=now();
      if(!closed && lastProductGraphReadAt!==null && time>=lastProductGraphReadAt
        && time-lastProductGraphReadAt<PRODUCT_GRAPH_STALE_MS
        && (lastProductGraphRefreshAttemptAt===null
          || time-lastProductGraphRefreshAttemptAt>=productGraphRefreshMs))
        startProductGraphRefresh().catch(()=>{});
    },productGraphRefreshMs)
    : null;
  productGraphTimer?.unref?.();
  if(productGraphTimer)startProductGraphRefresh().catch(()=>{});

  // This worker needs the authenticated buyer journal but no key. Keep it in
  // the API uid; the isolated signer retains only permissionless expiry work.
  if (firstoAskPublisher && (!trustedProduct || !officialProvider))
    throw new Error('Native ask publisher requires the reviewed API product graph and read provider.');
  const nativeAskPublisher = firstoAskPublisher ? createFirstoAskApiWorker({
    config: firstoAskPublisher, provider: officialProvider, factory: trustedProduct.record.addresses.factory,
    store, verifyDeployment: async () => {
      if (closed) throw new Error('Native ask publication is closed.');
      const block = await officialProvider.getBlock('latest');
      return graphVerifier(officialProvider, trustedProduct.record.addresses.factory, block);
    }, dependencies: firstoAskPublisherDependencies,
  }) : null;
  const stopNativeAskTracking = nativeAskPublisher
    ? trackFirstoAsks(nativeAskPublisher, { intervalMs: firstoAskPublisher.intervalMs }) : async () => {};

  async function operationalBody(body) {
    if (!freshProductVerifier || body.stage !== 'fresh-active') return body;
    try {
      const verifier=typeof freshProductVerifier.prepareIndex==='function'
        ? await freshProductVerifier.prepareIndex() : freshProductVerifier;
      const block=await officialProvider.getBlock('latest');
      await verifier(officialProvider,lastVerifiedProductGraphSnapshot.graph,block);
      return {...body,operationalReady:true};
    } catch { return {...body,operationalReady:false}; }
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
      const url = new URL(req.url, origin), path = url.pathname;
      const method = req.method;
      if (freshProduct && (/^\/api\/journal\/deployment(?:\/|$)/.test(path)
        || /^\/api\/journal\/fresh-activation(?:\/|$)/.test(path)))
        fail(403, 'Deployment and activation are unavailable in the public product process.');
      if (!['GET','POST','PUT','DELETE'].includes(method)) fail(405, 'Method is not allowed.');
      // Telegram authenticates with its configured secret header, never a wallet
      // cookie. This narrow endpoint is the sole exception to browser Origin checks.
      if (path === '/api/journal/notifications/telegram/webhook') {
        if (method !== 'POST') fail(405, 'Method is not allowed.');
        if (!notificationService) fail(503, 'Notifications are not configured.');
        if (!notificationService.acceptsWebhook(req.headers['x-telegram-bot-api-secret-token']))
          fail(403, 'Invalid notification webhook.');
        await notificationService.handleTelegramUpdate(await readJson(req));
        return send(200, { ok: true });
      }
      if (method !== 'GET' && req.headers.origin !== origin) fail(403, 'Request origin is not allowed.');
      if (method === 'GET' && path === '/api/journal/notifications/capabilities')
        return send(200, notificationService?.capabilities() ?? { enabled: false, botUsername: 'BEMineNotifyBot' });
      if (method === 'GET' && path === '/api/journal/product-graph') {
        if (url.search) fail(400, 'Product graph does not accept caller-selected parameters.');
        if (!officialProvider || !trustedProduct || !productMode)
          fail(503, 'Reviewed product graph is unavailable.');
        lastProductGraphReadAt=now();
        const cached=lastVerifiedProductGraphSnapshot;
        const snapshotAgeMs=cached ? now()-cached.savedAt : Infinity;
        if (snapshotAgeMs>=0 && snapshotAgeMs<PRODUCT_GRAPH_SNAPSHOT_MS)
          return send(200,{...await operationalBody(cached.body),snapshotAgeMs,readMode:'current',stale:false});
        if (cached && snapshotAgeMs>=PRODUCT_GRAPH_SNAPSHOT_MS
          && snapshotAgeMs<PRODUCT_GRAPH_STALE_MS) {
          // The response remains display-only even if a prior transient RPC
          // failure delayed the next background proof. Do not let public reads
          // spin up a fresh proof on every request after a fast failure.
          if (lastProductGraphRefreshAttemptAt===null
            || now()-lastProductGraphRefreshAttemptAt>=productGraphRefreshMs)
            startProductGraphRefresh();
          return send(200,{...cached.body,snapshotAgeMs,readMode:'verified_snapshot',
            stale:true,refreshing:Boolean(productGraphRefresh),transactionReady:false,operationalReady:false,userExitReady:false});
        }
        // Cached verified display reads are cheap and often share a NAT IP.
        // Bound only requests that must wait for a new chain proof.
        if (!allowPublicGraph(req)) fail(429, 'Too many product-graph reads; retry shortly.');
        const body=await startProductGraphRefresh();
        return send(200,{...await operationalBody(body),snapshotAgeMs:0,readMode:'current',stale:false});
      }
      if (method === 'GET' && ['/api/journal/official-candidates','/api/journal/budget-candidates'].includes(path)){
        const response=await discoveryResponse(req,url,path.endsWith('/budget-candidates')?'budget':'official');
        return send(response.status,response.body);
      }
      if (method === 'POST' && path === '/api/journal/challenge') {
        if (!allowChallenge(req)) fail(429, 'Too many wallet challenges; retry shortly.');
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
      if (freshConsolePreGenesis && method !== 'GET' && account !== FRESH_DEPLOYMENT_ACCOUNT)
        fail(403, 'Only the designated v4 deployment wallet may modify the pre-genesis journal.');
      // The pre-genesis deployment console may record only deployment and
      // Authority progress. It must not become a second product market or
      // accept old deployment archives before the independent v4 cutover.
      if (freshConsolePreGenesis && (
        (path === '/api/journal/budget-queue' && method === 'PUT')
        || (path === '/api/journal/quote' && method === 'POST')
        || (path === '/api/journal/deployment/import-archive' && method === 'POST')
        || (path === '/api/journal/market' && method !== 'GET')
        || (path.startsWith('/api/journal/market/') && method !== 'GET')
      )) fail(409, 'Product transactions are unavailable in the pre-genesis deployment console.');
      // Solidity digest is unchanged by this recovery fix. Old tabs must not
      // sign with a client that mistakes a successful wrapper for cancellation.
      if ((path === '/api/journal/fresh-activation' || path.startsWith('/api/journal/fresh-activation/'))
        && req.headers['x-pinkuang-activation-protocol'] !== '2')
        fail(426, '部署台已更新，请刷新页面后继续。');
      if (freshStage2Hold && path.startsWith('/api/journal/fresh-activation') && method !== 'GET')
        fail(409, 'Stage 2 signing is held until failed-transaction recovery is verified.');
      if (path.startsWith('/api/journal/notifications/')) {
        if (!expectedAccount) fail(400, 'The selected wallet is required.');
        if (!notificationService) fail(503, 'Notifications are not configured.');
        const result = await notificationService.handleWallet({ account, method,
          path: path.slice('/api/journal/notifications'.length),
          body: method === 'GET' ? undefined : await readJson(req) });
        return send(result.status, result.body);
      }
      if (method === 'GET' && path === '/api/journal/session') return send(200, { account });
      if (method === 'GET' && path === '/api/journal/build') return send(200, { artifactDigest: signingBuildDigest() });
      if (path === '/api/journal/budget-queue' && ['GET','PUT'].includes(method)) {
        if (freshProduct) {
          try { await verifyCurrentAuthorityAdministrator(provider,trustedProduct,account); }
          catch(error) { fail([403,409,503].includes(error.status)?error.status:503,
            [403,409,503].includes(error.status)?error.message:'Current administrator proof is unavailable.'); }
        }
        if (!expectedAccount) fail(400, 'The selected wallet is required.');
        const url = new URL(req.url, origin);
        if ([...url.searchParams.keys()].some(key => key !== 'parent') || url.searchParams.getAll('parent').length !== 1)
          fail(400, 'Exactly one budget parent is required.');
        const parent = identity(url.searchParams.get('parent'));
        if (method === 'GET') return send(200, store.budgetQueue(account, parent));
        const body = await readJson(req);
        const record = body.record;
        try { validateBudgetQueue(record, { account, parent }); }
        catch { fail(400, 'Invalid purchase queue or wallet identity.'); }
        if (record.approved !== true || identity(record.portfolioFactory) !== identity(trustedProduct?.record?.addresses?.portfolioFactory)
          || identity(record.factory) !== identity(trustedProduct?.record?.addresses?.factory)
          || ![trustedProduct.record.artifactDigest,trustedProduct.integratedUpgrade?.digest]
            .filter(Boolean).some(value => record.artifactDigest.toLowerCase() === value.toLowerCase()))
          fail(409, 'Purchase queue does not match the reviewed deployment.');
        return send(200, { revision: store.putBudgetQueue(account, parent, record, exactRevision(body.expectedRevision)) });
      }
      if (method === 'GET' && path === '/api/journal/deployment') return send(200, store.deployment(account));
      if (method === 'GET' && path === '/api/journal/fresh-activation/config')
        return send(200, { ...await credentialStatus(account), stage2Held: freshStage2Hold });
      if (method === 'GET' && path === '/api/journal/fresh-activation') return send(200, store.freshActivation(account));
      if (method === 'PUT' && path === '/api/journal/fresh-activation') {
        const body = await readJson(req);
        const genesis = store.deployment(account).record;
        const credential = await credentialStatus(account);
        const previous = store.freshActivation(account).record;
        const newSigningIntent = body.record?.steps?.some((step, i) =>
          step.status === 'signing' && previous?.steps[i]?.status !== 'signing');
        if (!credential.credentialVerified && (!previous || newSigningIntent))
          fail(503, 'Gas wallet signer has not been independently attested by an isolated process.');
        let record;
        try { record = validateFreshActivation(body.record, account, genesis,
          credential.gasWallet ?? previous?.gasWallet); }
        catch { fail(400, 'Invalid fresh activation record or genesis deployment.'); }
        if (!previous && record.steps.some(step => step.attempts?.length))
          fail(409, 'A new Stage 2 journal cannot import failed transaction attempts.');
        if (newSigningIntent && record.genesisArtifactDigest.toLowerCase() !== signingBuildDigest())
          fail(409, 'Deployment artifacts changed. Reload before another hardware-wallet signature.');
        if (newSigningIntent && record.steps.some(step => step.attempts?.length)) {
          if (!provider || !previous || !genesis)
            fail(409, 'Recovered Stage 2 history has no independent chain reader.');
          try { await verifyRecoveredFreshSigning(provider, previous, genesis, account,
            freshRecoveryBundle(previous)); }
          catch { fail(409, 'Archived same-nonce winner or current Authority roles changed.'); }
        }
        if(record.steps.some((step,i)=>i>0 && step.status==='confirmed' && previous?.steps?.[i]?.status!=='confirmed')) {
          if(!provider || !previous || !genesis) fail(409,'Confirmed Stage 2 history has no independent chain reader.');
          try { await verifyConfirmedFreshActivation(provider,record,previous,genesis,account,freshRecoveryBundle(record)); }
          catch { fail(409,'Confirmed Stage 2 wallet execution or permission prefix cannot be verified.'); }
        }
        return send(200, { revision: store.putFreshActivation(account, record, exactRevision(body.expectedRevision)) });
      }
      if (method === 'POST' && path === '/api/journal/fresh-activation/release-unused-signing') {
        const body = await readJson(req);
        const revision = exactRevision(body.expectedRevision);
        const current = store.freshActivation(account);
        const step = current.record?.steps.find(item => item.status !== 'confirmed');
        if (current.revision !== revision || current.record?.status !== 'paused'
          || step?.status !== 'signing' || step.id !== body.stepId
          || !Number.isSafeInteger(body.nonce) || body.nonce < 0 || step.nonce !== body.nonce
          || typeof body.dataHash !== 'string' || step.dataHash !== body.dataHash
          || step.txHash || step.receipt)
          fail(409, 'Fresh activation signing intent or revision changed; reload before recovery.');
        const witness = await currentAccountNonce(provider, account);
        if (witness.latest !== body.nonce || witness.pending !== body.nonce)
          fail(409, 'Deployment wallet nonce changed or has a pending transaction; recover its hash first.');
        return send(200, store.releaseUnusedFreshSigning(account, revision,
          body.stepId, body.nonce, body.dataHash));
      }
      if (method === 'POST' && path === '/api/journal/fresh-activation/recover-finalized-attempt') {
        const body = await readJson(req);
        const revision = exactRevision(body.expectedRevision);
        const current = store.freshActivation(account);
        if (current.revision !== revision || !provider || !expectedGasWallet)
          fail(409, 'Fresh activation recovery state or independent chain reader is unavailable.');
        const genesis = store.deployment(account).record;
        try { validateFreshActivation(current.record, account, genesis, getAddress(expectedGasWallet)); }
        catch { fail(409, 'Fresh activation or genesis record failed independent validation.'); }
        let proof;
        try { proof = await verifyFinalizedFreshAttempt(provider, current.record, genesis, account,
          body.stepId, body.nonce, body.winnerHash, freshRecoveryBundle(current.record)); }
        catch { fail(409, 'Finalized same-nonce winner or current Authority roles could not be proven.'); }
        return send(200, store.recoverFinalizedFreshAttempt(account, revision, proof));
      }
      if (method === 'GET' && path === '/api/journal/deployment/nonce') {
        if (new URL(req.url, origin).search) fail(400, 'Nonce verification accepts only the authenticated wallet, with no query parameters.');
        return send(200, await currentAccountNonce(provider, account));
      }
      if (method === 'POST' && path === '/api/journal/deployment/release-invalid-envelope') {
        const body = await readJson(req);
        const revision = exactRevision(body.expectedRevision);
        if (!Number.isSafeInteger(body.nonce) || body.nonce < 0) fail(400, 'Invalid deployment nonce.');
        const current = store.deployment(account);
        if (current.revision !== revision || current.record?.steps.at(-1)?.nonce !== body.nonce)
          fail(409, 'Deployment revision or nonce changed.');
        const witness = await currentAccountNonce(provider, account);
        if (witness.latest !== body.nonce || witness.pending !== body.nonce)
          fail(409, 'Wallet nonce changed or has a pending transaction; recover the transaction hash first.');
        return send(200, store.releaseInvalidEnvelope(account, revision, body.nonce));
      }
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
        if (!allowArchive(req)) fail(429, 'Too many archive writes; retry later.');
        const body = await readJson(req);
        if (typeof body.id !== 'string' || !body.id || body.id.length > 160) fail(400, 'Invalid deployment ID.');
        const current = store.deployment(account);
        if (!current.record || current.revision !== exactRevision(body.expectedRevision) || current.record.id !== body.id)
          fail(409, 'Deployment revision changed.');
        // The active fresh genesis is the only recovery anchor for the separate
        // seven-transaction Authority journal. Archiving it would hide Stage 2
        // and permit another genesis to overwrite that single-wallet journal.
        if (current.record.status === 'complete' && current.record.steps?.some(step => step.id === 'FreshPoolFactory'))
          fail(409, 'Fresh genesis and its Authority activation must remain together in the active deployment journal.');
        const activation = store.freshActivation(account).record;
        if (activation?.deploymentId === body.id && activation.status !== 'complete')
          fail(409, 'Fresh activation is unfinished; recover or complete it before archiving genesis.');
        if (current.record.status === 'aborted') await verifyAbortedDeployment(provider, current.record);
        else if (current.record.status === 'complete') await verifyCompletedDeployment(provider, current.record);
        else fail(409, 'Only a completed or aborted deployment can be archived.');
        return send(200, store.archiveDeployment(account, body.id, exactRevision(body.expectedRevision)));
      }
      if (method === 'POST' && path === '/api/journal/deployment/import-archive') {
        if (!allowArchive(req)) fail(429, 'Too many archive writes; retry later.');
        const body = await readJson(req);
        return send(200, { id: store.importArchive(account, validateDeployment(body.record, account)) });
      }
      if (method === 'GET' && path === '/api/journal/market') {
        const current=store.market(account);
        return send(200,{...current,...(current.record?.version===2 ? {canAbandon:store.canAbandonMarket(account),
          canRequestLegacyEnvelope:store.canRequestLegacyMarketEnvelope(account),
          legacyEnvelopeIssued:store.legacyMarketEnvelopeIssued(account)} : {})});
      }
      if (method === 'POST' && path === '/api/journal/market/abandon') {
        const body=await readJson(req),revision=exactRevision(body.expectedRevision);
        return send(200,{revision:store.abandonMarket(account,revision),record:null});
      }
      if (method === 'GET' && path === '/api/journal/market/result') {
        const hash = new URL(req.url, origin).searchParams.get('hash');
        if (!HASH.test(hash ?? '')) fail(400, 'A transaction hash is required.');
        return send(200, { result: store.marketResult(account, hash) });
      }
      if (method === 'POST' && path === '/api/journal/market/prepare-and-arm') {
        if (!productMode) fail(409, 'Product signing is unavailable.');
        const body=await readJson(req), record=validateMarket(body.record,account), revision=exactRevision(body.expectedRevision);
        if (record.version!==2 || record.hash || record.recoveryHashes?.length || record.cancellationRequests?.length)
          fail(400,'A new unsigned product intent is required.');
        const current=store.market(account);
        if (current.record || current.revision!==revision) fail(409,'Market revision changed.');
        await verifyBoundedProductIntent(req,account,record);
        const next=store.prepareAndArmMarket(account,record,revision);
        return send(200,{revision:next,record,transaction:productWalletTransaction(record)});
      }
      if (method === 'POST' && path === '/api/journal/market/arm') {
        const body=await readJson(req), revision=exactRevision(body.expectedRevision), current=store.market(account);
        if (!current.record || current.record.version !== 2 || current.revision !== revision) fail(409,'Product revision changed.');
        if (current.record.hash || current.record.recoveryHashes?.length || current.record.cancellationRequests?.length)
          fail(409,'Product transaction already has a send or recovery history.');
        await verifyBoundedProductIntent(req,account,current.record);
        const record=current.record;
        const next=store.armMarket(account,revision);
        return send(200,{revision:next,record,transaction:productWalletTransaction(record)});
      }
      if (method === 'POST' && path === '/api/journal/market/legacy-envelope') {
        if (!productMode) fail(409, 'Product signing is unavailable.');
        const body=await readJson(req),revision=exactRevision(body.expectedRevision),current=store.market(account);
        if (body.walletRejectedType2 !== true) fail(400, 'Explicit wallet type-2 rejection acknowledgement is required.');
        if (!current.record || current.record.version!==2 || current.revision!==revision
          || !store.canRequestLegacyMarketEnvelope(account)) fail(409, 'Legacy wallet envelope is unavailable for this product intent.');
        // Recheck the exact saved call, live graph and both nonce views before
        // issuing another envelope. It retains the original nonce, target,
        // calldata and value, so only one of the two envelopes can execute.
        await verifyBoundedProductIntent(req,account,current.record);
        const next=store.authorizeLegacyMarketEnvelope(account,revision);
        return send(200,{revision:next,record:current.record,
          transaction:productWalletTransaction(current.record,'legacy'),legacyEnvelopeAuthorized:true});
      }
      if (method === 'POST' && path === '/api/journal/market/cancel-intent') {
        const body = await readJson(req), revision = exactRevision(body.expectedRevision), current = store.market(account);
        if (!current.record || current.revision !== revision) fail(409, 'Market revision changed.');
        if ((current.record.cancellationRequests?.length ?? 0) >= 16) fail(409, 'Cancellation history is full. Recover the wallet hash instead.');
        const transaction = await cancellationIntent(provider, current.record,
          store.legacyMarketEnvelopeIssued(account) ? 'legacy' : undefined);
        const record = { ...current.record, cancellationRequests: [...(current.record.cancellationRequests ?? []),
          { ...transaction, createdAt:new Date().toISOString() }] };
        validateMarket(record, account);
        return send(200, { revision:store.putMarket(account, record, revision), record, transaction,
          ...(record.version===2 ? {legacyEnvelopeIssued:store.legacyMarketEnvelopeIssued(account)} : {}) });
      }
      if (method === 'PUT' && path === '/api/journal/market') {
        const body = await readJson(req);
        const record = validateMarket(body.record, account), current = store.market(account);
        if (current.revision !== exactRevision(body.expectedRevision)) fail(409, 'Market revision changed.');
        // The legacy market cannot bypass the product graph and one-use signing permission.
        // Preserve existing v1 intents and known-hash browser recovery without granting a new send.
        if (!current.record && productMode && record.version === 1 && !record.hash && !record.recoveryHashes?.length)
          fail(409, '旧市场入口已停止新签名，请从 BEMine 产品页面操作；已有交易可继续补录哈希恢复。');
        // Recovery writes must work even if the allowlist changes or the RPC is down.
        if (!current.record && record.version === 2) await verifyBoundedProductIntent(req, account, record);
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
        if (!allowQuote(req)) fail(429, 'Too many quote writes; retry later.');
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
    /** Internal display handoff; this never refreshes a graph or reads RPC. */
    currentProductGraphSnapshot() {
      const snapshot=lastVerifiedProductGraphSnapshot;
      const age=snapshot ? now()-snapshot.savedAt : Infinity;
      return snapshot && age>=0 && age<PRODUCT_GRAPH_STALE_MS ? structuredClone(snapshot.body) : null;
    },
    async verifyFreshOperationalReadiness() {
      if (closed || !freshProductVerifier || !officialProvider) fail(503, 'Fresh product operations are not enabled.');
      const verifier=typeof freshProductVerifier.prepareIndex==='function'
        ? await freshProductVerifier.prepareIndex() : freshProductVerifier;
      const block = await officialProvider.getBlock('latest');
      const graph = await graphVerifier(officialProvider,trustedProduct.record.addresses.factory,block);
      return verifier(officialProvider,graph,block);
    },
    handle(req, res) {
      const task = respond(req, res);
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    },
    async close() {
      closed = true;
      if(productGraphTimer)clearInterval(productGraphTimer);
      await stopNativeAskTracking();
      await nativeAskPublisher?.close();
      await Promise.allSettled([...inFlight]);
      store.close();
      if (!suppliedProvider) provider?.destroy();
      if (officialProvider !== provider) officialProvider?.destroy();
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
  if (env.BEMINE_FRESH_CONSOLE_PRE_GENESIS !== undefined
    && !['0','1'].includes(env.BEMINE_FRESH_CONSOLE_PRE_GENESIS))
    throw new Error('BEMINE_FRESH_CONSOLE_PRE_GENESIS must be 0 or 1.');
  if (env.BEMINE_FRESH_STAGE2_HOLD !== undefined
    && !['0','1'].includes(env.BEMINE_FRESH_STAGE2_HOLD))
    throw new Error('BEMINE_FRESH_STAGE2_HOLD must be 0 or 1.');
  return { dbPath, origin, rpcUrl,
    firstoAskPublisher: firstoAskPublisherConfiguration(env, { dbPath }),
    freshConsolePreGenesis: env.BEMINE_FRESH_CONSOLE_PRE_GENESIS === '1',
    // Missing configuration must never enable the seven Authority writes.
    // A reviewed cutover must explicitly set 0 after recovery is proven.
    freshStage2Hold: env.BEMINE_FRESH_STAGE2_HOLD !== '0',
    freshProduct: freshProductConfiguration(env),
    legacyFactory: legacyFactoryConfiguration(env.BEMINE_LEGACY_FACTORY),
    allowedProductFactories: (env.BEMINE_JOURNAL_FACTORIES || '').split(',').map(value => value.trim()).filter(Boolean),
    productDeploymentRecordPath: env.BEMINE_DEPLOYMENT_RECORD_PATH,
    productArtifactBundlePath: env.BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH,
    genesisRecordPath: env.BEMINE_GENESIS_RECORD_PATH,
    genesisBundlePath: env.BEMINE_GENESIS_ARTIFACT_PATH,
    integratedUpgradeEvidencePath: env.BEMINE_INTEGRATED_UPGRADE_EVIDENCE_PATH,
    integratedUpgradeArtifactPath: env.BEMINE_INTEGRATED_UPGRADE_ARTIFACT_PATH,
    genesisManifestPath: env.BEMINE_GENESIS_MANIFEST_PATH,
    freshActivationEvidencePath: env.BEMINE_PRODUCT_ACTIVATION_PATH,
    salePolicyCatalogPath: env.BEMINE_SALE_POLICY_CATALOG_PATH,
    salePolicyArtifactPath: env.BEMINE_SALE_POLICY_ARTIFACT_PATH,
    nativeSaleCatalogPath: env.BEMINE_NATIVE_SALE_CATALOG_PATH,
    nativeSaleArtifactPath: env.BEMINE_NATIVE_SALE_ARTIFACT_PATH,
    expectedGasWallet: env.BEMINE_EXPECTED_GAS_WALLET,
    secureCookies: production || origin.startsWith('https://') || env.DEPLOYMENT_JOURNAL_SECURE_COOKIES === '1' };
}
