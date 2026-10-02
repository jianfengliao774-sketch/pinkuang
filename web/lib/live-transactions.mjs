import { Interface, getAddress, hexlify, toUtf8Bytes, toQuantity } from 'ethers';
import { abi, ARTIFACT_DIGEST } from './chain-client.mjs';
import genesisContracts from './contracts.genesis.json' with { type: 'json' };
import { GENESIS_ARTIFACT_DIGEST, PRODUCT_STAGES, fetchLiveJson } from './live-config.mjs';
import { validateCurrentProductGraph } from './product-config.mjs';
import { settleReadRound } from './read-retry.mjs';
import { PORTFOLIO_ACTIONS } from './live-portfolios.mjs';
import { decodeFirstoOrder } from '../../deploy/src/firsto-purchase.mjs';
import { isFreshUserExit, isFreshUserExitTransaction } from './fresh-user-exits.mjs';
import { freshWalletActionReady, isFreshWalletAction, isFreshWalletActionTransaction } from './fresh-wallet-actions.mjs';
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO = `0x${'0'.repeat(40)}`;
const POOL_ACTIONS = new Set(['deposit','withdrawDeposit','finalizeFailure','harvest','claim','withdrawBnb','propose','vote','executeSale','cancelExpired','completeFirstoSale','buyFromMarket','buyAlternativeFromMarket','buyFromFirsto','mine']);
const FACTORY_ACTIONS = new Set(['createPool','createFlexiblePoolChecked','createBudgetChildPool']);
const MARKET_ACTIONS = new Set(['list','fill','cancel','expire','withdrawBnb']);
const genesisAbi = Object.freeze(Object.fromEntries(Object.entries(genesisContracts.abis)
  .map(([name, fragments]) => [name, new Interface(fragments)])));
const active = new Set();
// The largest fixed product limit is 5M Gas and the accepted price ceiling is
// 3 gwei. Keep the default cost envelope consistent with both limits so an
// otherwise valid quote is not rejected between 2 and 3 gwei.
const DEFAULT_MAX_TRANSACTION_GAS_WEI = '15000000000000000';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sameNullable = (a, b) => a == null && b == null || same(a, b);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const address = value => { const result = getAddress(value); requireValue(result !== ZERO, '不能使用零地址。'); return result; };
const exact = (value, label = '交易金额') => {
  requireValue(typeof value === 'bigint' || typeof value === 'string' && /^(?:0|[1-9]\d*|0x[0-9a-f]+)$/i.test(value), `${label}必须使用精确整数。`);
  const result = BigInt(value); requireValue(result >= 0n && result < 2n ** 256n, '整数超出合约范围。'); return result;
};
// Some EIP-1193 wallets return small RPC quantities as numbers. Accept only values
// that JavaScript can represent exactly; never coerce an imprecise Wei amount.
const rpcQuantity = (value, label) => typeof value === 'number'
  ? (requireValue(Number.isSafeInteger(value) && value >= 0, `${label}不是精确的非负整数。`), BigInt(value))
  : exact(value, label);
function rejectedType2Envelope(error) {
  if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return false;
  const messages = [error?.message, error?.shortMessage, error?.data?.message, error?.info?.error?.message]
    .filter(value => typeof value === 'string').join(' ');
  return /(?:0x2|type\s*2|1559|maxFeePerGas)/i.test(messages)
    && (/(?:invalid|unsupported|unknown|unrecognized|not supported).{0,80}(?:transaction (?:envelope|type)|eip.?1559|maxFeePerGas)/i.test(messages)
      || /(?:transaction type|eip.?1559|maxFeePerGas).{0,80}(?:unsupported|not supported|invalid)/i.test(messages));
}
// Fixed submission limits avoid a wallet-side estimate and keep simple market
// orders from reserving the full complex-vault Gas budget. These are caps, not
// claims that a transaction will succeed. Unused Gas is not charged.
export function productGasLimit(kind, targetType) {
  if (targetType === 'market' || targetType === 'portfolioMarket') {
    if (kind === 'list' || kind === 'cancel' || kind === 'expire' || kind === 'withdrawBnb') return 1_000_000n;
    if (kind === 'fill') return 3_000_000n;
  }
  return 5_000_000n;
}
const emit = (callback, state) => { try { callback?.(state); } catch { /* UI callbacks cannot erase a persisted transaction. */ } };
export class JournalError extends Error { constructor(status, message) { super(message); this.status = status; } }
function journalBase(config = {}) {
  const base = config.journalBase ?? '/api/journal';
  requireValue(/^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(base) && !base.includes('..'), '交易记录必须使用本站服务。');
  return base.replace(/\/$/, '');
}
async function request(config, path, method = 'GET', body, account, fetcher = globalThis.fetch) {
  const response = await fetcher(`${journalBase(config)}/${path}`, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(account ? { 'X-Pinkuang-Account': account } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new JournalError(response.status, result.error || `交易记录服务不可用（${response.status}）。`);
  return result;
}
export async function requireWallet(provider, account) {
  requireValue(provider?.request, '请先连接钱包。');
  const { chain, accounts } = await settleReadRound({
    chain: () => provider.request({ method: 'eth_chainId' }),
    accounts: () => provider.request({ method: 'eth_accounts' }),
  });
  requireValue(rpcQuantity(chain, '钱包链号') === 56n, '请将钱包切换至 BSC 主网。');
  requireValue(Array.isArray(accounts) && same(accounts[0], account), '钱包账户已变化，请重新连接后确认。');
  return address(accounts[0]);
}
const walletRequestErrorCode = error => Number(error?.code) === -32603
  ? Number(error?.data?.originalError?.code ?? error?.code)
  : Number(error?.code ?? error?.data?.originalError?.code);
/** Invoke only from an explicit user click. Never called by reads or recovery.
 * Re-selecting an injected wallet must request the account picker: requesting
 * accounts alone can silently return the origin's previously granted account. */
export async function connectWallet(provider, { reselectAccount = false } = {}) {
  requireValue(provider?.request, '未找到钱包，请使用支持钱包的浏览器。');
  let reselected = false;
  if (reselectAccount === true) {
    try {
      await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      reselected = true;
    } catch (error) {
      // Other injected wallets may not implement permissions. Fall back once
      // only for an unsupported method, never after rejection or pending work.
      if (![4200, -32601].includes(walletRequestErrorCode(error))) throw error;
    }
  }
  // Permission approval already grants account access. Do not open a second
  // permission prompt; use the account currently exposed by this provider.
  const accounts = await provider.request({ method: reselected ? 'eth_accounts' : 'eth_requestAccounts' });
  requireValue(Array.isArray(accounts) && accounts.length, '钱包未提供账户。');
  const owner = address(accounts[0]);
  if (rpcQuantity(await provider.request({ method: 'eth_chainId' }), '钱包链号') !== 56n) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
    } catch (error) {
      // Only an unknown network may request installation. Rejection is never retried.
      if (walletRequestErrorCode(error) !== 4902) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: '0x38', chainName: 'BNB Smart Chain',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'],
      }] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
    }
  }
  // A successful permission/switch response does not prove the selected account or chain.
  return requireWallet(provider, owner);
}
/** Authentication may prompt personal_sign. Call only from the user's connect/login action. */
export async function authenticate({ provider, account, config = {}, fetcher = globalThis.fetch, onState }) {
  const direct = config.displayOnly === true;
  const owner = direct ? address(account) : await requireWallet(provider, address(account));
  try {
    const current = await request(config, 'session', 'GET', undefined, undefined, fetcher);
    if (same(current.account, owner)) return { account: owner };
  } catch (error) { if (!(error instanceof JournalError) || error.status !== 401) throw error; }
  const challenge = await request(config, 'challenge', 'POST', { account: owner }, undefined, fetcher);
  const origin = globalThis.location?.origin ?? config.origin;
  const lines = typeof challenge.message === 'string' ? challenge.message.split('\n') : [];
  requireValue(typeof origin === 'string' && /^[A-Za-z0-9_-]{32}$/.test(challenge.nonce ?? '') && lines.length === 6
    && lines[0] === 'Pinkuang deployment journal login' && lines[1] === `Origin: ${origin}` && lines[2] === 'Chain ID: 56'
    && lines[3] === `Account: ${owner.toLowerCase()}` && lines[4] === `Nonce: ${challenge.nonce}`
    && lines[5].startsWith('Expires At: '), '服务器登录挑战与本站或钱包不匹配。');
  const expires = Date.parse(lines[5].slice(12));
  requireValue(expires > Date.now() && expires <= Date.now() + 310_000, '登录挑战已过期，请重新登录。');
  await requireWallet(provider, owner);
  emit(onState, { status: 'awaiting-login-signature' });
  const signature = await provider.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(challenge.message)), owner] });
  if (!direct) await requireWallet(provider, owner);
  const session = await request(config, 'session', 'POST', { account: owner, nonce: challenge.nonce, signature }, undefined, fetcher);
  requireValue(same(session.account, owner), '服务器会话的钱包地址不匹配。');
  return { account: owner };
}
export async function readPending({ account, config = {}, fetcher = globalThis.fetch }) {
  const owner = address(account), view = await request(config, 'market', 'GET', undefined, owner, fetcher);
  requireValue(Number.isSafeInteger(view.revision) && view.revision >= 0 && (view.record === null
    || [1,2].includes(view.record?.version) && view.record.chainId === 56 && same(view.record.account, owner)
      && Number.isSafeInteger(view.record.nonce) && view.record.nonce >= 0), '服务器待处理交易格式异常。');
  return view;
}
/** Explicit click only; server CAS refuses any intent whose signing permission was ever consumed. */
export async function abandonPrepared({ account, config = {}, fetcher = globalThis.fetch }) {
  const owner = address(account), view = await readPending({ account: owner, config, fetcher });
  requireValue(view.canAbandon === true && view.record?.version === 2, '这笔交易已进入签名流程，必须核对链上结果。');
  const ack = await request(config, 'market/abandon', 'POST', { expectedRevision: view.revision }, owner, fetcher);
  requireValue(ack.record === null && ack.revision === view.revision + 1, '清除结果待核对，请刷新记录。');
  return { status: 'idle' };
}
function fixedDisplayConfig(config) {
  requireValue(config?.status === 'ready' && config.productFamily === 'fresh-v4'
    && config.stage === 'fresh-active' && config.manifest && config.pinnedManifest
    && Number(config.manifest.chainId) === 56
    && same(config.manifest.artifactDigest, ARTIFACT_DIGEST)
    && same(config.pinnedManifest.artifactDigest, ARTIFACT_DIGEST)
    && same(config.artifactDigest, ARTIFACT_DIGEST), '固定部署清单与当前页面不一致。');
  for (const key of ['factory', 'shareMarket', 'lens', 'beacon', 'timelock',
    'portfolioFactory', 'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation',
    'portfolioFactoryImplementation', 'authority', 'gasWallet']) {
    requireValue(same(config.manifest[key], config.pinnedManifest[key])
      && (config[key] === undefined || same(config[key], config.manifest[key])),
    '固定部署清单的合约地址不一致。');
    address(config.manifest[key]);
  }
  return { ...config.manifest, ...config };
}
function normalize(config, transaction, action) {
  const direct = config?.displayOnly === true;
  if (direct) config = fixedDisplayConfig(config);
  requireValue(config?.status === 'ready' && Number(config.chainId) === 56, '当前尚未配置已验证的 BSC 部署。');
  if (config.manifest) {
    requireValue(direct || (config.readMode === undefined || config.readMode === 'current') && config.stale !== true,
      '历史产品资料仅供展示，请等待最新链上核对。');
    const expected = config.stage === 'genesis' ? GENESIS_ARTIFACT_DIGEST : ARTIFACT_DIGEST;
    requireValue(PRODUCT_STAGES.includes(config.stage) && same(config.manifest.artifactDigest, expected)
      && same(config.artifactDigest, expected), '产品阶段或合约摘要已变化，请刷新页面。');
  }
  const budgetTarget = typeof action === 'object' && ['portfolioFactory', 'portfolio', 'portfolioMarket'].includes(action?.targetType);
  requireValue(!budgetTarget || config.kind === 'integrated-v2' && config.portfolioFactory && config.portfolioMarket, '预算部署尚未核验。');
  const factory = address(budgetTarget ? config.portfolioFactory : config.factory), target = address(transaction.to), account = address(transaction.from);
  requireValue(exact(transaction.chainId, '交易链号') === 56n, '交易目标或网络错误。');
  const targetType = budgetTarget ? same(target, factory) ? 'portfolioFactory' : same(target, config.portfolioMarket) ? 'portfolioMarket' : 'portfolio'
    : same(target, factory) ? 'factory' : config.shareMarket && same(target, config.shareMarket) ? 'market' : 'pool';
  requireValue(!budgetTarget || targetType === action.targetType, '预算操作目标类型不一致。');
  const interfaces = config.stage === 'genesis' ? genesisAbi : abi;
  const contract = targetType === 'portfolioFactory' ? interfaces.BudgetPortfolioFactory : targetType === 'portfolio' ? interfaces.BudgetPortfolioVault
    : targetType === 'factory' ? interfaces.PoolFactory : targetType === 'pool' ? interfaces.PoolVault : interfaces.ShareMarket;
  const allowed = targetType === 'portfolioFactory' ? new Set(['createPortfolio']) : targetType === 'portfolio' ? PORTFOLIO_ACTIONS
    : targetType === 'factory' ? FACTORY_ACTIONS : targetType === 'pool' ? POOL_ACTIONS : MARKET_ACTIONS;
  const value = exact(transaction.value ?? '0', '交易金额'), data = transaction.data;
  requireValue(typeof data === 'string' && /^0x(?:[0-9a-f]{2}){4,2048}$/i.test(data), '交易 calldata 格式错误。');
  const decoded = contract.parseTransaction({ data, value });
  const kind = typeof action === 'string' ? action : action?.kind;
  requireValue(decoded && allowed.has(decoded.name) && (kind === decoded.name || kind === 'withdraw' && decoded.name === 'withdrawBnb')
    && contract.encodeFunctionData(decoded.fragment, decoded.args).toLowerCase() === data.toLowerCase(), '操作名称与允许的交易内容不一致。');
  const userExit = config.stage === 'fresh-active' && config.userExitReady === true && isFreshUserExit(targetType, decoded.name, value);
  const walletAction = freshWalletActionReady(config, targetType, decoded.name) && isFreshWalletAction(targetType, decoded.name, value);
  requireValue(direct || !config.manifest || (config.transactionReady !== false && (config.stage !== 'fresh-active' || config.operationalReady === true)) || userExit || walletAction,
    config.stage === 'fresh-active' ? '新增交易服务尚未启用；仅已核验的领取、退款和撤单可由用户钱包自付 Gas。'
      : '历史产品资料仅供展示，请等待最新链上核对。');
  if (!direct && config.manifest && config.stage !== 'genesis') {
    const oldContract = targetType === 'portfolioFactory' ? genesisAbi.BudgetPortfolioFactory
      : targetType === 'portfolio' ? genesisAbi.BudgetPortfolioVault : targetType === 'factory' ? genesisAbi.PoolFactory
        : targetType === 'pool' ? genesisAbi.PoolVault : genesisAbi.ShareMarket;
    requireValue(oldContract.parseTransaction({ data, value }) || config.operationalReady === true || userExit || walletAction,
      '新合约操作须等待权限、Gas 服务和产品接线全部核验完成。');
  }
  requireValue(['deposit','completeFirstoSale','fill'].includes(decoded.name) || value === 0n, '该操作不能附带 BNB。');
  if (decoded.name === 'buyFromFirsto') {
    requireValue(decoded.args[0] === 0n, 'Firsto 批量挂单尚未开放。'); decodeFirstoOrder(decoded.args[1]);
  }
  return { factory, target, targetType, account, value, data: data.toLowerCase(), action: { kind: decoded.name } };
}
export function validateProductTransactionStage(config, transaction, action) {
  return normalize(config, transaction, action);
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function requireCurrentProductStage(config, fetcher, { wait = pause, now = Date.now, transaction, action } = {}) {
  // Direct mode has a locally build-bound address list, not a current chain
  // attestation. Contracts enforce their own roles and state on execution.
  if (config?.displayOnly === true) { fixedDisplayConfig(config); return; }
  if (!config.manifest) return; // Legacy isolated test fixtures never reach production boot.
  requireValue(typeof config.productGraphUrl === 'string' && typeof config.origin === 'string',
    '缺少已核验的产品阶段，请刷新页面。');
  const url = new URL(config.productGraphUrl);
  requireValue(url.origin === config.origin && url.pathname.endsWith('/api/journal/product-graph')
    && !url.search && !url.hash, '产品阶段必须由本站核验服务提供。');
  // A display-only response is expected while the server refreshes its proof.
  // Wait for a fresh proof before touching the wallet or writing an intent;
  // never retry a submitted transaction or accept the old response for signing.
  const deadline = now() + 8000;
  for (;;) {
    const graph = validateCurrentProductGraph(await fetchLiveJson(url.href, { fetcher, maxBytes: 65536 }), config);
    const userExit = graph.userExitReady === true && isFreshUserExitTransaction(config, transaction, action);
    const walletAction = isFreshWalletActionTransaction({ ...config, readMode: graph.readMode, stale: graph.stale,
      freshFactoryVerified: graph.freshFactoryVerified }, transaction, action);
    // Worker/session readiness is mutable, not part of deployment identity.
    // Authorize this submission using the current graph below and in normalize;
    // never compare its readiness bits with an earlier preview or UI mask.
    requireValue(graph.stage === config.stage && same(graph.artifactDigest, config.artifactDigest)
    && same(graph.manifest.factory, config.factory)
    && same(graph.manifest.shareMarket, config.shareMarket)
    && same(graph.manifest.portfolioFactory, config.portfolioFactory)
    && graph.verifiedBlockNumber >= config.manifest.verifiedBlockNumber
    && graph.stageActivationBlock === config.stageActivationBlock
    && same(graph.stageActivationHash, config.stageActivationHash)
    && sameNullable(graph.operationId, config.operationId)
    && (config.stage !== 'fresh-active' || graph.freshFactoryVerified === true
      && same(graph.freshAuthority?.address, config.freshAuthority?.address)
      && same(graph.freshAuthority?.codehash, config.freshAuthority?.codehash)
      && same(graph.freshAuthority?.deploymentTxHash, config.freshAuthority?.deploymentTxHash)),
    '链上产品阶段已变化，请刷新页面后重新确认交易。');
    if (graph.readMode === 'current' && graph.stale === false && (graph.transactionReady !== false || userExit || walletAction)) return graph;
    requireValue(graph.readMode === 'verified_snapshot' && graph.stale === true
      && graph.transactionReady === false, '产品阶段资料尚未通过最新链上核验。');
    requireValue(now() < deadline, '链上产品阶段仍在刷新，请稍后重试；尚未发送交易。');
    await wait(Math.min(500, Math.max(0, deadline - now())));
  }
}
function validateResult(result, account, record, hash) {
  requireValue(result?.finalized === true && ['confirmed','reverted','cancelled','replaced'].includes(result.status)
    && same(result.account, account) && HASH.test(result.transactionHash ?? '') && same(result.transactionHash, hash)
    && result.receipt && same(result.receipt.transactionHash, hash) && [0,1].includes(result.receipt.status)
    && Number.isSafeInteger(result.receipt.blockNumber) && result.receipt.blockNumber >= 0 && HASH.test(result.receipt.blockHash ?? ''), '服务器最终回执格式异常。');
  if (record) requireValue(result.nonce === record.nonce && same(result.factory, record.factory)
    && same(result.target, record.target ?? record.market) && result.action === record.action.kind, '最终回执与交易意图不匹配。');
  if (result.status === 'cancelled') requireValue(result.receipt.status === 1 && same(result.receipt.to, account), '取消回执必须是本钱包成功的自转交易。');
  if (result.status === 'reverted') requireValue(result.receipt.status === 0, '失败回执状态不匹配。');
  // An older server may label a successful EIP-7702 envelope as a replacement
  // after looking only at the outer destination. That is not proof that an
  // inner product call did not run. Never present it as a cleared intent.
  if (result.status === 'replaced') requireValue(result.receipt.status === 0
    || result.receipt.status === 1 && result.plainEoaReplacementVerified === true
      && ADDRESS.test(result.receipt.to ?? '') && !same(result.receipt.to, result.target),
    '成功的替换交易可能已执行产品操作，不能自动清除待核对意图。');
  if (result.status === 'confirmed') {
    requireValue(result.receipt.status === 1 && same(result.receipt.to, result.target), '成功回执的目标不匹配。');
    if (result.action === 'deposit') {
      requireValue(same(result.poolAddress, result.target) && exact(result.shares) > 0n && exact(result.shares) <= 100n
        && exact(result.amountWei) > 0n, '认购成功缺少经过验证的份额与付款信息。');
      if (record) {
        const decoded = (record.targetType === 'portfolio' ? abi.BudgetPortfolioVault : abi.PoolVault).parseTransaction({ data: record.data });
        requireValue(decoded.name === 'deposit' && decoded.args[0] === exact(result.shares) && record.value === result.amountWei, '认购事件与原始份额或付款不一致。');
      }
    }
  }
  return { ...result, ...(record?.targetType ? { targetType: record.targetType } : {}), hash: result.transactionHash };
}
/** Read-only recovery through the fixed server RPC. No wallet permission, signing, send or retry. */
export async function recoverPending({ provider, config = {}, account, hash, onState, fetcher = globalThis.fetch }) {
  const owner = address(account);
  if (provider && config.displayOnly !== true) await requireWallet(provider, owner);
  const view = await readPending({ account: owner, config, fetcher });
  if (!view.record) {
    if (!hash) return { status: 'idle' };
    requireValue(HASH.test(hash), '请输入有效的交易哈希。');
    const saved = await request(config, `market/result?hash=${encodeURIComponent(hash)}`, 'GET', undefined, owner, fetcher);
    if (!saved.result) return { status: 'idle' };
    const result = validateResult(saved.result, owner, null, hash); emit(onState, result); return result;
  }
  let { record, revision } = view;
  const selected = hash || record.hash || record.recoveryHashes?.at(-1);
  if (!selected) { const result = { status: 'pending', record, message: '钱包发送结果待核对，请补录钱包中的交易哈希；不会自动重发。' }; emit(onState, result); return result; }
  requireValue(HASH.test(selected), '请输入有效的交易哈希。');
  try {
    if (!same(record.hash, selected) && !record.recoveryHashes?.some(item => same(item, selected))) {
      requireValue((record.recoveryHashes?.length ?? 0) < 16, '恢复哈希已达上限，请联系管理员核对。');
      record = { ...record, recoveryHashes: [...(record.recoveryHashes ?? []), selected] };
      revision = (await request(config, 'market', 'PUT', { record, expectedRevision: revision }, owner, fetcher)).revision;
    }
    const finalized = await request(config, 'market', 'DELETE', { hash: selected, expectedRevision: revision }, owner, fetcher);
    const result = validateResult(finalized.result, owner, record, selected); emit(onState, result); return result;
  } catch (error) {
    // Lost DELETE ACK: read durable proof; never repeat a signature or broadcast.
    try {
      const saved = await request(config, `market/result?hash=${encodeURIComponent(selected)}`, 'GET', undefined, owner, fetcher);
      if (saved.result) { const result = validateResult(saved.result, owner, record, selected); emit(onState, result); return result; }
    } catch { /* Fail closed with the original intent and hash. */ }
    const result = { status: 'pending', hash: selected, record, message: error.message || '尚未取得最终回执，请稍后核对。' };
    emit(onState, result); return result;
  }
}
/** Explicit user click only. Cancels this wallet's journal nonce, never an arbitrary transaction. */
export async function cancelPendingNonce({ provider, config = {}, account, onState, fetcher = globalThis.fetch }) {
  const owner = address(account), lane = owner.toLowerCase();
  const direct = config.displayOnly === true;
  requireValue(!active.has(lane), '这个钱包正在提交另一笔交易。');
  active.add(lane);
  let record, hash;
  try {
    if (!direct) await requireWallet(provider, owner);
    const session = await request(config, 'session', 'GET', undefined, owner, fetcher);
    requireValue(same(session.account, owner), '请先点击连接钱包并完成本站登录。');
    const view = await readPending({ account: owner, config, fetcher });
    requireValue(view.record, '没有需要取消的待核对交易。');
    record = view.record;
    requireValue((record.recoveryHashes?.length ?? 0) < 16, '恢复哈希已达上限，请联系管理员核对。');
    const ack = await request(config, 'market/cancel-intent', 'POST', { expectedRevision: view.revision }, owner, fetcher);
    requireValue(Number.isSafeInteger(ack.revision) && ack.revision === view.revision + 1 && ack.record
      && ['version','chainId','nonce','data','value','submittedAt'].every(key => ack.record[key] === record[key])
      && same(ack.record.account, owner) && same(ack.record.factory, record.factory)
      && same(ack.record.target ?? ack.record.market, record.target ?? record.market)
      && ack.record.action?.kind === record.action.kind, '取消意图未得到可靠确认，已停止发送。');
    const tx = ack.transaction, nonce = BigInt(record.nonce);
    requireValue(record.version !== 2 || ack.legacyEnvelopeIssued === (view.legacyEnvelopeIssued === true),
      '取消交易信封的授权状态已变化。');
    const type = record.version === 2 && ack.legacyEnvelopeIssued !== true ? '0x2' : '0x0';
    const requiredFields = type === '0x2'
      ? ['from','to','chainId','nonce','data','value','gas','type','maxFeePerGas','maxPriorityFeePerGas']
      : ['from','to','chainId','nonce','data','value','gas','type','gasPrice'];
    requireValue(tx && Object.keys(tx).sort().join(',') === requiredFields.sort().join(',')
      && same(tx.from, owner) && same(tx.to, owner) && tx.chainId === '0x38'
      && tx.nonce === toQuantity(nonce) && tx.data === '0x' && tx.value === '0x0'
      && tx.gas === '0x5208' && tx.type === type, '取消交易必须是原 nonce 的零金额自转。');
    const gasPrice = exact(type === '0x2' ? tx.maxFeePerGas : tx.gasPrice, '取消交易 Gas 单价'), gas = 21_000n;
    requireValue(type !== '0x2' || exact(tx.maxPriorityFeePerGas, '取消交易优先费') === gasPrice,
      '取消交易 Gas 报价不一致。');
    requireValue(gasPrice > 0n && gasPrice <= 3_000_000_000n && gasPrice <= exact(config.maxGasPriceWei ?? '3000000000')
      && gas * gasPrice <= exact(config.maxTransactionGasWei ?? DEFAULT_MAX_TRANSACTION_GAS_WEI), '取消交易 Gas 费用超出页面限制。');
    const cancellation = ack.record.cancellationRequests?.at(-1);
    requireValue(cancellation && Object.entries(tx).every(([key, value]) => cancellation[key] === value)
      && ack.record.cancellationRequests.length === (record.cancellationRequests?.length ?? 0) + 1,
    '服务器没有保存取消签名意图，已停止发送。');
    record = ack.record;
    const { latest, pending, code, balance, current } = await settleReadRound({
      latest: () => provider.request({ method: 'eth_getTransactionCount', params: [owner, 'latest'] }),
      pending: () => provider.request({ method: 'eth_getTransactionCount', params: [owner, 'pending'] }),
      balance: () => provider.request({ method: 'eth_getBalance', params: [owner, 'latest'] }),
      ...(!direct ? {
        code: () => provider.request({ method: 'eth_getCode', params: [owner, 'latest'] }),
        current: () => readPending({ account: owner, config, fetcher }),
      } : {}),
    });
    requireValue(rpcQuantity(latest, '钱包最新 nonce') === nonce && rpcQuantity(pending, '钱包待处理 nonce') >= nonce && rpcQuantity(pending, '钱包待处理 nonce') <= nonce + 1n,
      '原 nonce 已变化或钱包还有其他待处理交易，请先核对钱包交易哈希。');
    requireValue(direct || code === '0x', '此钱包不支持页面内取消，请使用钱包自身的恢复功能。');
    requireValue(rpcQuantity(balance, '钱包 BNB 余额') >= gas * gasPrice, 'BNB 余额不足以支付取消交易的 Gas。');
    requireValue(direct || current.revision === ack.revision && current.record?.nonce === record.nonce
      && same(current.record.account, owner), '待处理记录已变化，请重新核对后再取消。');
    await requireWallet(provider, owner);
    emit(onState, { status:'awaiting-signature', operation:'cancel-pending', record, gasLimit:gas.toString(),
      gasPriceWei:gasPrice.toString(), maxGasWei:(gas * gasPrice).toString() });
    // Build the request from validated fields, never forward unknown server properties to the wallet.
    hash = await provider.request({ method:'eth_sendTransaction', params:[Object.fromEntries(requiredFields.map(key => [key, tx[key]]))] });
    requireValue(typeof hash === 'string' && HASH.test(hash), '钱包未返回有效取消哈希，发送结果待核对。');
    // Persist the returned hash before checking wallet identity again: a wallet switch must not erase recovery evidence.
    record = { ...record, recoveryHashes:[...(record.recoveryHashes ?? []),hash] };
    await request(config, 'market', 'PUT', { record,expectedRevision:ack.revision }, owner, fetcher);
    const result = await recoverPending({ provider, account:owner,config,hash,fetcher });
    // A cancellation confirmation cannot be reinterpreted as the original deposit/market action.
    requireValue(result.status !== 'confirmed', '取消交易回执与预期不符，请核对原始交易。');
    emit(onState, result);
    return result;
  } catch (error) {
    if (!record) throw error;
    const result = { status:'pending',record,...(hash && HASH.test(hash) ? { hash } : {}),
      message:error.code === 4001 || error.code === 'ACTION_REJECTED'
        ? '取消请求已在钱包中拒绝，原交易意图继续保留；不会自动重试。' : (error.message || '取消交易结果待核对。') };
    emit(onState, result); return result;
  } finally { active.delete(lane); }
}
/** Explicit second click after a wallet rejected the type-2 envelope before broadcast. */
export async function retryLegacyEnvelope({ provider, config = {}, account, onState, fetcher = globalThis.fetch }) {
  const owner = address(account), lane = owner.toLowerCase();
  const direct = config.displayOnly === true;
  requireValue(!active.has(lane), '这个钱包正在提交另一笔交易。');
  active.add(lane);
  let record, hash, revision;
  try {
    if (!direct) await requireWallet(provider, owner);
    const session = await request(config, 'session', 'GET', undefined, owner, fetcher);
    requireValue(same(session.account, owner), '请先点击连接钱包并完成本站登录。');
    const view = await readPending({ account: owner, config, fetcher });
    const original = view.record;
    requireValue(view.canRequestLegacyEnvelope === true && original?.version === 2 && !original.hash
      && !(original.recoveryHashes?.length) && !(original.cancellationRequests?.length),
    '这笔交易不能切换为兼容信封，请先核对钱包交易记录。');
    const transaction = { from: owner, to: original.target, chainId: '0x38', data: original.data, value: original.value };
    const action = { ...original.action, targetType: original.targetType };
    const graph = await requireCurrentProductStage(config, fetcher, { transaction, action });
    const currentConfig = direct ? config : { ...config, readMode: 'current', stale: false,
      transactionReady: graph?.transactionReady ?? config.transactionReady,
      userExitReady: graph?.userExitReady ?? config.userExitReady,
      operationalReady: graph?.operationalReady ?? config.operationalReady };
    const normalized = normalize(currentConfig, transaction, action);
    requireValue(same(normalized.factory, original.factory) && normalized.targetType === original.targetType,
      '兼容交易的产品目标已变化。');
    const nonce = BigInt(original.nonce), gas = exact(original.gas, '兼容交易 Gas'),
      gasPrice = exact(original.gasPrice, '兼容交易 Gas 单价'), value = exact(original.value);
    const [latest, pending, balance] = await Promise.all([
      provider.request({ method: 'eth_getTransactionCount', params: [owner, 'latest'] }),
      provider.request({ method: 'eth_getTransactionCount', params: [owner, 'pending'] }),
      provider.request({ method: 'eth_getBalance', params: [owner, 'latest'] }),
    ]);
    requireValue(rpcQuantity(latest, '钱包最新 nonce') === nonce && rpcQuantity(pending, '钱包待处理 nonce') === nonce,
      '原 nonce 已变化，请先核对原交易。');
    requireValue(gas <= exact(config.maxGasLimit ?? '5000000') && gasPrice > 0n
      && gasPrice <= exact(config.maxGasPriceWei ?? '3000000000')
      && gas * gasPrice <= exact(config.maxTransactionGasWei ?? DEFAULT_MAX_TRANSACTION_GAS_WEI)
      && rpcQuantity(balance, '钱包 BNB 余额') >= value + gas * gasPrice,
    '兼容交易 Gas 或余额超出页面限制。');
    const ack = await request(config, 'market/legacy-envelope', 'POST',
      { expectedRevision: view.revision, walletRejectedType2: true }, owner, fetcher);
    record = ack.record; revision = ack.revision;
    requireValue(ack.legacyEnvelopeAuthorized === true && revision === view.revision + 1 && record
      && ['version','chainId','nonce','data','value','gas','gasPrice','submittedAt','targetType']
        .every(key => record[key] === original[key])
      && same(record.account, owner) && same(record.factory, original.factory)
      && same(record.target, original.target) && record.action?.kind === original.action.kind,
    '兼容交易许可与原意图不一致，已停止发送。');
    const expected = { from: owner, to: original.target, chainId: '0x38', nonce: toQuantity(nonce),
      data: original.data, value: toQuantity(value), gas: toQuantity(gas),
      gasPrice: toQuantity(gasPrice), type: '0x0' };
    requireValue(ack.transaction && Object.keys(ack.transaction).sort().join(',') === Object.keys(expected).sort().join(',')
      && Object.entries(expected).every(([key, item]) => same(ack.transaction[key], item)),
    '兼容交易信封与原意图不一致，已停止发送。');
    const { finalWallet, finalLatest, finalPending, current } = await settleReadRound({
      finalWallet: () => requireWallet(provider, owner),
      ...(!direct ? {
        finalLatest: () => provider.request({ method: 'eth_getTransactionCount', params: [owner, 'latest'] }),
        finalPending: () => provider.request({ method: 'eth_getTransactionCount', params: [owner, 'pending'] }),
        current: () => readPending({ account: owner, config, fetcher }),
      } : {}),
    });
    requireValue(same(finalWallet, owner) && (direct || rpcQuantity(finalLatest, '签名前最新 nonce') === nonce
      && rpcQuantity(finalPending, '签名前待处理 nonce') === nonce && current.revision === revision
      && current.legacyEnvelopeIssued === true
      && current.record?.nonce === original.nonce && same(current.record.account, owner)),
    '签名前钱包或意图已变化，请核对记录。');
    emit(onState, { status: 'awaiting-signature', operation: 'legacy-envelope', record,
      gasLimit: gas.toString(), gasPriceWei: gasPrice.toString(), maxGasWei: (gas * gasPrice).toString() });
    hash = await provider.request({ method: 'eth_sendTransaction', params: [expected] });
    requireValue(typeof hash === 'string' && HASH.test(hash), '钱包未返回有效哈希，发送结果待核对。');
    record = { ...record, hash };
    await request(config, 'market', 'PUT', { record, expectedRevision: revision }, owner, fetcher);
    emit(onState, { status: 'pending', record, hash });
    return await recoverPending({ provider, config, account: owner, hash, onState, fetcher });
  } catch (error) {
    if (!record) throw error;
    const result = { status: 'pending', record, ...(hash && HASH.test(hash) ? { hash } : {}),
      message: error.code === 4001 || error.code === 'ACTION_REJECTED'
        ? '兼容交易已在钱包中拒绝；原意图继续保留，请核对钱包记录。'
        : (error.message || '兼容交易结果待核对，请勿重复发送。') };
    emit(onState, result); return result;
  } finally { active.delete(lane); }
}
/** One explicit user action = at most one eth_sendTransaction. Server ACK precedes the wallet request. */
export async function sendProductTransaction({ provider, config, transaction, action, onState, fetcher = globalThis.fetch }) {
  let lane;
  try { lane = address(transaction?.from).toLowerCase(); }
  catch (error) { if (error && typeof error === 'object') error.beforeIntent = true; throw error; }
  if (active.has(lane)) {
    const error = new Error('这个钱包正在提交另一笔交易。');
    error.beforeIntent = true;
    throw error;
  }
  active.add(lane);
  let record, hash, revision, intentRequestStarted = false;
  try {
    emit(onState, { status: 'preparing' });
    const graph = await requireCurrentProductStage(config, fetcher, { transaction, action });
    // The boot response may have been a verified display-only snapshot. Only
    // a freshly verified response with the identical pinned graph can clear
    // that local display marker for this one submission.
    const currentConfig = graph ? { ...config, readMode: graph.readMode, stale: graph.stale,
      transactionReady: graph.transactionReady, operationalReady: graph.operationalReady, userExitReady: graph.userExitReady } : config;
    const normalized = normalize(currentConfig, transaction, action);
    const { account, factory, target, targetType, value, data } = normalized;
    const direct = currentConfig.displayOnly === true;
    requireValue(provider?.request, '请先连接钱包。');
    // Independent reads overlap, but every started read settles before an intent can be saved.
    const initial = await settleReadRound({
      ...(!direct ? { wallet: () => requireWallet(provider, account) } : {}),
      session: () => request(config, 'session', 'GET', undefined, account, fetcher),
      view: () => readPending({ account, config, fetcher }),
      latest: () => provider.request({ method: 'eth_getTransactionCount', params: [account, 'latest'] }),
      pending: () => provider.request({ method: 'eth_getTransactionCount', params: [account, 'pending'] }),
      price: () => provider.request({ method: 'eth_gasPrice' }),
      balance: () => provider.request({ method: 'eth_getBalance', params: [account, 'latest'] }),
    });
    const { session, view } = initial;
    requireValue(same(session.account, account), '请先点击连接钱包并完成本站登录。');
    requireValue(!view.record, '这个钱包有待核对交易，请先核对回执；不要重复发送。');
    revision = view.revision;
    const unsigned = { from: account, to: target, data, value: toQuantity(value) };
    // The wallet confirmation displays a bounded gas limit. Do not run a
    // transaction simulation or dynamic gas estimate during submission.
    const { latest, pending, price, balance } = initial;
    const nonce = rpcQuantity(latest, '钱包最新 nonce'), gas = productGasLimit(normalized.action.kind, targetType), gasPrice = rpcQuantity(price, '钱包 Gas 单价');
    requireValue(nonce === rpcQuantity(pending, '钱包待处理 nonce') && nonce <= BigInt(Number.MAX_SAFE_INTEGER), '钱包存在其他待确认交易，请先在钱包中处理。');
    requireValue(gas > 0n && gas <= exact(config.maxGasLimit ?? '5000000') && gasPrice > 0n
      && gasPrice <= exact(config.maxGasPriceWei ?? '3000000000') && gas * gasPrice <= exact(config.maxTransactionGasWei ?? DEFAULT_MAX_TRANSACTION_GAS_WEI), 'Gas 费用超出页面限制，请稍后重试。');
    requireValue(rpcQuantity(balance, '钱包 BNB 余额') >= value + gas * gasPrice, 'BNB 余额不足以支付款项和 Gas。');
    const prepared = { version: 2, chainId: 56, account, factory, target, targetType, nonce: Number(nonce),
      action: normalized.action, data, value: value.toString(), gas: gas.toString(), gasPrice: gasPrice.toString(), submittedAt: new Date().toISOString() };
    emit(onState, { status: 'recording-intent' });
    let permit, fastAuthorized = false;
    try {
      intentRequestStarted = true;
      permit = await request(config, 'market/prepare-and-arm', 'POST',
        { record: prepared, expectedRevision: revision }, account, fetcher);
      record = prepared;
      fastAuthorized = true;
    } catch (error) {
      // A 404 identifies an older runtime. Every other failure may have persisted
      // a one-use signing permission, so never retry through the legacy route.
      if (!(error instanceof JournalError) || error.status !== 404) throw error;
      const ack = await request(config, 'market', 'PUT', { record: prepared, expectedRevision: revision }, account, fetcher);
      requireValue(Number.isSafeInteger(ack.revision) && ack.revision === revision + 1, '签名前记录未得到可靠确认，已停止发送。');
      record = prepared;
      emit(onState, { status: 'authorizing' });
      permit = await request(config, 'market/arm', 'POST', { expectedRevision: ack.revision }, account, fetcher);
    }
    requireValue(permit.revision === revision + 2 && permit.record
      && ['version','chainId','nonce','data','value','gas','gasPrice','submittedAt','targetType'].every(key => permit.record[key] === prepared[key])
      && same(permit.record.account, account) && same(permit.record.factory, factory) && same(permit.record.target, target)
      && permit.record.action?.kind === normalized.action.kind, '签名许可与确认内容不一致，已停止发送。');
    const expectedTx = { ...unsigned, chainId: '0x38', nonce: toQuantity(nonce), gas: toQuantity(gas),
      maxFeePerGas: toQuantity(gasPrice), maxPriorityFeePerGas: toQuantity(gasPrice), type: '0x2' };
    requireValue(permit.transaction && Object.keys(permit.transaction).sort().join(',') === Object.keys(expectedTx).sort().join(',')
      && Object.entries(expectedTx).every(([key, value]) => same(permit.transaction[key], value)),
    '签名许可交易内容不一致，已停止发送。');
    record = permit.record; revision = permit.revision;
    if (fastAuthorized) emit(onState, { status: 'authorizing' });
    const { wallet: finalWallet, lastNonce, pendingNonce } = await settleReadRound({
      wallet: () => requireWallet(provider, account),
      ...(!direct ? {
        lastNonce: () => provider.request({ method: 'eth_getTransactionCount', params: [account, 'latest'] }),
        pendingNonce: () => provider.request({ method: 'eth_getTransactionCount', params: [account, 'pending'] }),
      } : {}),
    });
    requireValue(same(finalWallet, account), '签名前钱包账户已变化，请重新连接后确认。');
    requireValue(direct || rpcQuantity(lastNonce, '签名前最新 nonce') === nonce && rpcQuantity(pendingNonce, '签名前待处理 nonce') === nonce, '签名前钱包 nonce 已变化，原意图已保留，请核对。');
    emit(onState, { status: 'awaiting-signature', record, gasLimit: gas.toString(), gasPriceWei: gasPrice.toString(), maxGasWei: (gas * gasPrice).toString() });
    hash = await provider.request({ method: 'eth_sendTransaction', params: [expectedTx] });
    requireValue(typeof hash === 'string' && HASH.test(hash), '钱包未返回有效哈希，发送结果待核对。');
    record = { ...record, hash };
    await request(config, 'market', 'PUT', { record, expectedRevision: revision }, account, fetcher);
    emit(onState, { status: 'pending', hash, record });
    return await recoverPending({ provider, account, config, hash, onState, fetcher });
  } catch (error) {
    if (!record) {
      if (!intentRequestStarted && error && typeof error === 'object') error.beforeIntent = true;
      throw error;
    }
    const rejected = error.code === 4001 || error.code === 'ACTION_REJECTED';
    let legacyEnvelopeRejected = false;
    if (!hash && record.version === 2 && rejectedType2Envelope(error)) {
      try {
        const [latest, pending, view] = await Promise.all([
          provider.request({ method: 'eth_getTransactionCount', params: [record.account, 'latest'] }),
          provider.request({ method: 'eth_getTransactionCount', params: [record.account, 'pending'] }),
          readPending({ account: record.account, config, fetcher }),
        ]);
        legacyEnvelopeRejected = rpcQuantity(latest, '钱包最新 nonce') === BigInt(record.nonce)
          && rpcQuantity(pending, '钱包待处理 nonce') === BigInt(record.nonce)
          && view.revision === revision && view.canRequestLegacyEnvelope === true
          && view.record?.nonce === record.nonce && !view.record.hash
          && !(view.record.recoveryHashes?.length) && !(view.record.cancellationRequests?.length);
      } catch { /* An uncertain wallet or journal outcome cannot offer a retry. */ }
    }
    const result = { status: 'pending', record, ...(hash && HASH.test(hash) ? { hash } : {}),
      ...(legacyEnvelopeRejected ? { legacyEnvelopeRejected: true } : {}),
      message: rejected ? '钱包请求已取消。签名前意图已保留，需核对 nonce 后才能继续；不会自动重发。' : (error.message || '交易结果待核对。') };
    emit(onState, result); return result;
  } finally { active.delete(lane); }
}
