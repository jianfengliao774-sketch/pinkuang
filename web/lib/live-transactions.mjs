import { getAddress, hexlify, toUtf8Bytes, toQuantity } from 'ethers';
import { abi } from './chain-client.mjs';
import { settleReadRound } from './read-retry.mjs';
import { decodeFirstoOrder } from '../../deploy/src/firsto-purchase.mjs';
const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO = `0x${'0'.repeat(40)}`;
const POOL_ACTIONS = new Set(['deposit','withdrawDeposit','finalizeFailure','harvest','claim','withdrawBnb','propose','vote','executeSale','cancelExpired','completeSale','buyFromMarket','buyAlternativeFromMarket','buyFromFirsto','mine']);
const FACTORY_ACTIONS = new Set(['createPool','createFlexiblePoolChecked']);
const MARKET_ACTIONS = new Set(['list','fill','cancel','expire','withdrawBnb']);
const active = new Set();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const address = value => { const result = getAddress(value); requireValue(result !== ZERO, '不能使用零地址。'); return result; };
const exact = value => {
  requireValue(typeof value === 'bigint' || typeof value === 'string' && /^(?:0|[1-9]\d*|0x[0-9a-f]+)$/i.test(value), '交易金额必须使用精确整数。');
  const result = BigInt(value); requireValue(result >= 0n && result < 2n ** 256n, '整数超出合约范围。'); return result;
};
/** Timestamp checkpoints can require new storage between estimation and inclusion. Unused Gas is not charged. */
export function productGasLimit(estimate) {
  const amount = exact(estimate);
  requireValue(amount > 0n, 'Gas 估算无效。');
  const proportional = (amount * 120n + 99n) / 100n;
  const checkpointReserve = amount + 100000n;
  return proportional > checkpointReserve ? proportional : checkpointReserve;
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
  requireValue(exact(chain) === 56n, '请将钱包切换至 BSC 主网。');
  requireValue(Array.isArray(accounts) && same(accounts[0], account), '钱包账户已变化，请重新连接后确认。');
  return address(accounts[0]);
}
/** Invoke only from an explicit user click. Never called by reads or recovery. */
export async function connectWallet(provider) {
  requireValue(provider?.request, '未找到钱包，请使用支持钱包的浏览器。');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  requireValue(Array.isArray(accounts) && accounts.length, '钱包未提供账户。');
  const owner = address(accounts[0]);
  if (exact(await provider.request({ method: 'eth_chainId' })) !== 56n) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
    } catch (error) {
      // Only an unknown network may request installation. Rejection is never retried.
      const code = Number(error?.code) === -32603
        ? error?.data?.originalError?.code : error?.code ?? error?.data?.originalError?.code;
      if (Number(code) !== 4902) throw error;
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
  const owner = await requireWallet(provider, address(account));
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
  await requireWallet(provider, owner);
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
function normalize(config, transaction, action) {
  requireValue(config?.status === 'ready' && Number(config.chainId) === 56, '当前尚未配置已验证的 BSC 部署。');
  const factory = address(config.factory), target = address(transaction.to), account = address(transaction.from);
  requireValue(exact(transaction.chainId) === 56n, '交易目标或网络错误。');
  const targetType = same(target, factory) ? 'factory' : config.shareMarket && same(target, config.shareMarket) ? 'market' : 'pool';
  const contract = targetType === 'factory' ? abi.PoolFactory : targetType === 'pool' ? abi.PoolVault : abi.ShareMarket;
  const allowed = targetType === 'factory' ? FACTORY_ACTIONS : targetType === 'pool' ? POOL_ACTIONS : MARKET_ACTIONS;
  const value = exact(transaction.value ?? '0'), data = transaction.data;
  requireValue(typeof data === 'string' && /^0x(?:[0-9a-f]{2}){4,2048}$/i.test(data), '交易 calldata 格式错误。');
  const decoded = contract.parseTransaction({ data, value });
  const kind = typeof action === 'string' ? action : action?.kind;
  requireValue(decoded && allowed.has(decoded.name) && (kind === decoded.name || kind === 'withdraw' && decoded.name === 'withdrawBnb')
    && contract.encodeFunctionData(decoded.fragment, decoded.args).toLowerCase() === data.toLowerCase(), '操作名称与允许的交易内容不一致。');
  requireValue(['deposit','completeSale','fill'].includes(decoded.name) || value === 0n, '该操作不能附带 BNB。');
  if (decoded.name === 'buyFromFirsto') {
    requireValue(decoded.args[0] === 0n, 'Firsto 批量挂单尚未开放。'); decodeFirstoOrder(decoded.args[1]);
  }
  return { factory, target, targetType, account, value, data: data.toLowerCase(), action: { kind: decoded.name } };
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
  if (result.status === 'confirmed') {
    requireValue(result.receipt.status === 1 && same(result.receipt.to, result.target), '成功回执的目标不匹配。');
    if (result.action === 'deposit') {
      requireValue(same(result.poolAddress, result.target) && exact(result.shares) > 0n && exact(result.shares) <= 100n
        && exact(result.amountWei) > 0n, '认购成功缺少经过验证的份额与付款信息。');
      if (record) {
        const decoded = abi.PoolVault.parseTransaction({ data: record.data });
        requireValue(decoded.name === 'deposit' && decoded.args[0] === exact(result.shares) && record.value === result.amountWei, '认购事件与原始份额或付款不一致。');
      }
    }
  }
  return { ...result, hash: result.transactionHash };
}
/** Read-only recovery through the fixed server RPC. No wallet permission, signing, send or retry. */
export async function recoverPending({ provider, config = {}, account, hash, onState, fetcher = globalThis.fetch }) {
  const owner = address(account);
  if (provider) await requireWallet(provider, owner);
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
  requireValue(!active.has(lane), '这个钱包正在提交另一笔交易。');
  active.add(lane);
  let record, hash;
  try {
    await requireWallet(provider, owner);
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
    requireValue(tx && same(tx.from, owner) && same(tx.to, owner) && tx.chainId === '0x38'
      && tx.nonce === toQuantity(nonce) && tx.data === '0x' && tx.value === '0x0'
      && tx.gas === '0x5208' && tx.type === '0x0', '取消交易必须是原 nonce 的零金额自转。');
    const gasPrice = exact(tx.gasPrice), gas = 21_000n;
    requireValue(gasPrice > 0n && gasPrice <= 3_000_000_000n && gasPrice <= exact(config.maxGasPriceWei ?? '3000000000')
      && gas * gasPrice <= exact(config.maxTransactionGasWei ?? '10000000000000000'), '取消交易 Gas 费用超出页面限制。');
    const cancellation = ack.record.cancellationRequests?.at(-1);
    requireValue(cancellation && Object.entries(tx).every(([key, value]) => cancellation[key] === value)
      && ack.record.cancellationRequests.length === (record.cancellationRequests?.length ?? 0) + 1,
    '服务器没有保存取消签名意图，已停止发送。');
    record = ack.record;
    await requireWallet(provider, owner);
    const [latest, pending, code, balance, current] = await Promise.all([
      provider.request({ method: 'eth_getTransactionCount', params: [owner, 'latest'] }),
      provider.request({ method: 'eth_getTransactionCount', params: [owner, 'pending'] }),
      provider.request({ method: 'eth_getCode', params: [owner, 'latest'] }),
      provider.request({ method: 'eth_getBalance', params: [owner, 'latest'] }),
      readPending({ account: owner, config, fetcher }),
    ]);
    requireValue(exact(latest) === nonce && exact(pending) >= nonce && exact(pending) <= nonce + 1n,
      '原 nonce 已变化或钱包还有其他待处理交易，请先核对钱包交易哈希。');
    requireValue(code === '0x', '此钱包不支持页面内取消，请使用钱包自身的恢复功能。');
    requireValue(exact(balance) >= gas * gasPrice, 'BNB 余额不足以支付取消交易的 Gas。');
    requireValue(current.revision === ack.revision && current.record?.nonce === record.nonce
      && same(current.record.account, owner), '待处理记录已变化，请重新核对后再取消。');
    await provider.request({ method: 'eth_call', params: [{ from: owner, to: owner, value:'0x0',data:'0x',gas:'0x5208' }, 'latest'] });
    await requireWallet(provider, owner);
    emit(onState, { status:'awaiting-signature', operation:'cancel-pending', record, gasLimit:gas.toString(),
      gasPriceWei:gasPrice.toString(), maxGasWei:(gas * gasPrice).toString() });
    // Build the request from validated fields, never forward unknown server properties to the wallet.
    hash = await provider.request({ method:'eth_sendTransaction', params:[{ from:owner,to:owner,chainId:'0x38',nonce:toQuantity(nonce),
      data:'0x',value:'0x0',gas:'0x5208',gasPrice:toQuantity(gasPrice),type:'0x0' }] });
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
/** One explicit user action = at most one eth_sendTransaction. Server ACK precedes the wallet request. */
export async function sendProductTransaction({ provider, config, transaction, action, onState, fetcher = globalThis.fetch }) {
  const normalized = normalize(config, transaction, action), { account, factory, target, targetType, value, data } = normalized;
  const lane = account.toLowerCase();
  requireValue(!active.has(lane), '这个钱包正在提交另一笔交易。');
  active.add(lane);
  let record, hash, revision;
  try {
    emit(onState, { status: 'preparing' });
    // Independent reads overlap, but every started read settles before an intent can be saved.
    const { session, view } = await settleReadRound({
      wallet: () => requireWallet(provider, account),
      session: () => request(config, 'session', 'GET', undefined, account, fetcher),
      view: () => readPending({ account, config, fetcher }),
    });
    requireValue(same(session.account, account), '请先点击连接钱包并完成本站登录。');
    requireValue(!view.record, '这个钱包有待核对交易，请先核对回执；不要重复发送。');
    revision = view.revision;
    const unsigned = { from: account, to: target, data, value: toQuantity(value) };
    const { latest, pending, estimate, price, balance } = await settleReadRound({
      simulation: () => provider.request({ method: 'eth_call', params: [unsigned, 'latest'] }),
      latest: () => provider.request({ method: 'eth_getTransactionCount', params: [account, 'latest'] }),
      pending: () => provider.request({ method: 'eth_getTransactionCount', params: [account, 'pending'] }),
      estimate: () => provider.request({ method: 'eth_estimateGas', params: [unsigned] }),
      price: () => provider.request({ method: 'eth_gasPrice' }),
      balance: () => provider.request({ method: 'eth_getBalance', params: [account, 'latest'] }),
    });
    const nonce = exact(latest), gas = productGasLimit(estimate), gasPrice = exact(price);
    requireValue(nonce === exact(pending) && nonce <= BigInt(Number.MAX_SAFE_INTEGER), '钱包存在其他待确认交易，请先在钱包中处理。');
    requireValue(gas > 0n && gas <= exact(config.maxGasLimit ?? '5000000') && gasPrice > 0n
      && gasPrice <= exact(config.maxGasPriceWei ?? '3000000000') && gas * gasPrice <= exact(config.maxTransactionGasWei ?? '10000000000000000'), 'Gas 费用超出页面限制，请稍后重试。');
    requireValue(exact(balance) >= value + gas * gasPrice, 'BNB 余额不足以支付款项和 Gas。');
    const prepared = { version: 2, chainId: 56, account, factory, target, targetType, nonce: Number(nonce),
      action: normalized.action, data, value: value.toString(), gas: gas.toString(), gasPrice: gasPrice.toString(), submittedAt: new Date().toISOString() };
    emit(onState, { status: 'recording-intent' });
    const ack = await request(config, 'market', 'PUT', { record: prepared, expectedRevision: revision }, account, fetcher);
    requireValue(Number.isSafeInteger(ack.revision) && ack.revision === revision + 1, '签名前记录未得到可靠确认，已停止发送。');
    record = prepared; revision = ack.revision;
    emit(onState, { status: 'authorizing' });
    const permit = await request(config, 'market/arm', 'POST', { expectedRevision: revision }, account, fetcher);
    requireValue(permit.revision === revision + 1 && permit.record
      && ['version','chainId','nonce','data','value','gas','gasPrice','submittedAt','targetType'].every(key => permit.record[key] === prepared[key])
      && same(permit.record.account, account) && same(permit.record.factory, factory) && same(permit.record.target, target)
      && permit.record.action?.kind === normalized.action.kind, '签名许可与确认内容不一致，已停止发送。');
    const expectedTx = { ...unsigned, chainId: '0x38', nonce: toQuantity(nonce), gas: toQuantity(gas), gasPrice: toQuantity(gasPrice), type: '0x0' };
    requireValue(permit.transaction && Object.entries(expectedTx).every(([key, value]) => same(permit.transaction[key], value)), '签名许可交易内容不一致，已停止发送。');
    record = permit.record; revision = permit.revision;
    await requireWallet(provider, account);
    const [lastNonce, pendingNonce] = await Promise.all(['latest','pending'].map(tag => provider.request({ method: 'eth_getTransactionCount', params: [account, tag] })));
    requireValue(exact(lastNonce) === nonce && exact(pendingNonce) === nonce, '签名前钱包 nonce 已变化，原意图已保留，请核对。');
    emit(onState, { status: 'awaiting-signature', record, gasLimit: gas.toString(), gasPriceWei: gasPrice.toString(), maxGasWei: (gas * gasPrice).toString() });
    hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...unsigned, chainId: '0x38', nonce: toQuantity(nonce), gas: toQuantity(gas), gasPrice: toQuantity(gasPrice), type: '0x0' }] });
    requireValue(typeof hash === 'string' && HASH.test(hash), '钱包未返回有效哈希，发送结果待核对。');
    record = { ...record, hash };
    await request(config, 'market', 'PUT', { record, expectedRevision: revision }, account, fetcher);
    emit(onState, { status: 'pending', hash, record });
    return await recoverPending({ provider, account, config, hash, onState, fetcher });
  } catch (error) {
    if (!record) throw error;
    const rejected = error.code === 4001 || error.code === 'ACTION_REJECTED';
    const result = { status: 'pending', record, ...(hash && HASH.test(hash) ? { hash } : {}),
      message: rejected ? '钱包请求已取消。签名前意图已保留，需核对 nonce 后才能继续；不会自动重发。' : (error.message || '交易结果待核对。') };
    emit(onState, result); return result;
  } finally { active.delete(lane); }
}
