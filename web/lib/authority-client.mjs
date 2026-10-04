import { Interface, ZeroAddress, concat, getAddress, keccak256, verifyTypedData } from 'ethers';
import { abi } from './chain-client.mjs';
import { authorityTypedAction } from '../../deploy/shared/authority-typed.mjs';
import { boundedReadPreview } from './bounded-read-preview.mjs';
import { requireMachineAvailable } from '../../deploy/shared/machine-reservation.mjs';

const need = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);
const authorityAbi = new Interface([
  'function administratorOne() view returns(address)',
  'function administratorTwo() view returns(address)',
  'function gasWallet() view returns(address)',
  'function coreFactory() view returns(address)',
  'function budgetFactory() view returns(address)',
  'function nonces(address) view returns(uint256)',
]);
const integer = value => { const n = BigInt(value); need(n >= 0n, '金额、编号或时间不能为负。'); return n; };
const creationNames = new Set(['createPool', 'createPoolWithExpiry', 'createBudgetChildPool',
  'createFlexiblePool', 'createFlexiblePoolChecked']);
const HASH = /^0x[\da-f]{64}$/i;
const sameBytes = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const signedKinds = new Set(['reviewSale', 'reviewChildSale', 'setSaleReference', 'claimFees',
  'executeApprovedOperation', 'buyBudgetOfficial', 'buyBudgetFirsto']);

/** Include the complete signed envelope: a reverted nonce can be signed again. */
export function authorityCommandData(command) {
  need(command && signedKinds.has(command.kind) && command.args
    && /^0x[\da-f]{130}$/i.test(command.signature ?? ''), '管理员签名内容不完整。');
  const fragment = abi.PlatformAuthority.getFunction(command.kind);
  const values = fragment.inputs.map(input => ['nonce', 'deadline', 'signature'].includes(input.name)
    ? command[input.name] : command.args[input.name]);
  return abi.PlatformAuthority.encodeFunctionData(fragment, values);
}

export function authorityOperationId(command) {
  return keccak256(concat([getAddress(command.authority), authorityCommandData(command)]));
}

/** Latest shared journal status is useful only for this exact submitted command. */
export function authorityStatusForRequest(status, operationId, hash = null) {
  if (!HASH.test(operationId ?? '') || !HASH.test(status?.operationId ?? '')
    || !sameBytes(status.operationId, operationId)
    || hash && (!HASH.test(status.hash ?? '') || !sameBytes(status.hash, hash))) return null;
  return status;
}

function relayMetadata(result) {
  if (!result || typeof result !== 'object') return null;
  const safe = {};
  for (const name of ['status', 'rawStatus', 'reason', 'message', 'kind'])
    if (typeof result[name] === 'string') safe[name] = result[name];
  for (const name of ['hash', 'requestId', 'operationId'])
    if (HASH.test(result[name] ?? '')) safe[name] = result[name];
  for (const name of ['accepted', 'archived', 'recoveryRequired'])
    if (typeof result[name] === 'boolean') safe[name] = result[name];
  if (Number.isSafeInteger(result.blockNumber) && result.blockNumber >= 0) safe.blockNumber = result.blockNumber;
  return safe;
}

/** Inspect the signed bytes, never the picker selection or an older preview's permission. */
function creationReservation(config, kind, args) {
  if (kind !== 'executeApprovedOperation') return null;
  need(config.factory, '当前 Factory 配置不可用。');
  if (!same(args.target, config.factory)) return null;
  const call = abi.PoolFactory.parseTransaction({ data: args.data });
  need(call && creationNames.has(call.name)
    && abi.PoolFactory.encodeFunctionData(call.fragment, call.args).toLowerCase() === args.data.toLowerCase(),
  '管理员建池 calldata 不规范。');
  return { factory: getAddress(config.factory), collection: call.args[0].circuits,
    tokenId: call.args[0].circuitId };
}

/** Build only an action that PlatformAuthority itself can authorize. */
export function authorityAction(authority, kind, args, nonce, deadline) {
  need(args && typeof args === 'object' && !Array.isArray(args), '管理员操作参数无效。');
  const n = integer(nonce), expires = integer(deadline);
  need(expires > 0n, '签名有效期无效。');
  return authorityTypedAction(authority, kind, args, n, expires);
}

/** A fresh operator preview already contains exact Factory calldata; bind that byte string. */
export function approvedOperatorCall(config, transaction, { pool } = {}) {
  need(config?.stage === 'fresh-active', '仅新部署使用管理员签名代付。');
  need(transaction?.value === '0x0' || transaction?.value === '0x', '管理员代付交易不得附带 BNB。');
  const target = getAddress(transaction.to);
  const core = getAddress(config.factory), budget = getAddress(config.portfolioFactory);
  const contract = target === core ? abi.PoolFactory : target === budget ? abi.BudgetPortfolioFactory
    : pool && same(pool, target) ? abi.PoolVault : null;
  const parsed = contract?.parseTransaction({ data: transaction.data });
  if (parsed?.name === 'mine' && pool && same(pool, target)) {
    const reclaim = new Interface(['function reclaim(bytes32)']);
    const inner = reclaim.parseTransaction({ data: parsed.args[0] });
    need(inner?.name === 'reclaim' && reclaim.encodeFunctionData(inner.fragment, inner.args).toLowerCase() === parsed.args[0].toLowerCase()
      && abi.PoolVault.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() === transaction.data.toLowerCase(),
    '管理员只能签名已核对矿池的精确回收；挖矿准备与启动由独立服务执行。');
    return { target, data: transaction.data };
  }
  need(parsed && (target !== core || ['createPool','createPoolWithExpiry','createBudgetChildPool',
    'createFlexiblePool','createFlexiblePoolChecked'].includes(parsed.name))
    && (target !== budget || parsed.name === 'createPortfolio'), '只有已预览的建池或预算项目能由管理员代付。');
  need([core, budget].includes(target)
    && contract.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() === transaction.data.toLowerCase(), '管理员建池 calldata 不规范。');
  return { target, data: transaction.data };
}

/** Sign one verified child/order and its exact previewed cost, never a reusable budget. */
export function approvedPortfolioPurchase(config, prepared) {
  need(config?.stage === 'fresh-active' && prepared?.procurement && prepared.row?.pool,
    '预算采购缺少当前项目与逐笔报价核验。');
  const { transaction, procurement } = prepared;
  need(BigInt(transaction.value) === 0n && BigInt(transaction.chainId) === 56n
    && same(transaction.to, prepared.row.pool), '预算采购目标或付款发生变化。');
  const parsed = abi.BudgetPortfolioVault.parseTransaction({ data: transaction.data });
  need(parsed && ['buyOfficial', 'buyFirsto'].includes(parsed.name)
    && abi.BudgetPortfolioVault.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() === transaction.data.toLowerCase(),
  '预算采购 calldata 不规范。');
  need(same(parsed.args[0], procurement.child) && integer(procurement.priceWei) > 0n
    && integer(procurement.priceWei) <= integer(procurement.capWei), '本台采购超过已预览的上限。');
  const args = { portfolio: getAddress(transaction.to), child: getAddress(parsed.args[0]), maxCost: integer(procurement.priceWei).toString() };
  if (parsed.name === 'buyOfficial') {
    need(procurement.route === 'official', '采购来源已改变。');
    return { kind: 'buyBudgetOfficial', args: { ...args, listingId: parsed.args[1].toString() } };
  }
  need(procurement.route === 'firsto' && parsed.args[1].toLowerCase() === procurement.frozenOrder?.toLowerCase(), 'Firsto 签名订单已改变。');
  return { kind: 'buyBudgetFirsto', args: { ...args, encodedOrder: parsed.args[1] } };
}

const emit = (callback, status) => { try { callback?.({ status }); } catch { /* UI cannot alter submission. */ } };

// Tokens never expose a reusable signature payload and do not survive serialization.
const preparedSignatures = new WeakMap();
const stable = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString()
  : item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const frozenCopy = value => {
  const copy = JSON.parse(stable(value));
  const freeze = item => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; };
  return freeze(copy);
};
const signaturePayload = signed => ({ types: { EIP712Domain: [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
], ...signed.types }, primaryType: signed.primaryType, domain: signed.domain, message: signed.message });

/** Preview only. Read the nonce/reservation now, then freeze the exact later wallet request. */
export async function prepareAuthoritySignature({ provider, readProvider, config, account, kind, args,
  validitySeconds = 600, cacheLifetimeMs = 300000, readTimeoutMs = 8000,
  isCurrent = () => true, signal, onState }) {
  need(config?.displayOnly === true && config.stage === 'fresh-active' && config.status === 'ready',
    '当前配置不支持预先准备管理员签名。');
  need(provider?.request && isCurrent() && !signal?.aborted, '页面或钱包已改变，请重新预览。');
  const signer = getAddress(account), authority = getAddress(config.authority ?? config.manifest?.authority);
  need(authority !== ZeroAddress && signer !== ZeroAddress && Number.isInteger(validitySeconds)
    && validitySeconds > 0 && validitySeconds <= 900 && Number.isSafeInteger(cacheLifetimeMs)
    && cacheLifetimeMs > 0 && cacheLifetimeMs <= 600000, '管理员签名有效期无效。');
  const pinned = config.freshAuthority ?? config.manifest?.freshAuthority;
  need(pinned && same(pinned.address, authority) && /^0x[\da-f]{64}$/i.test(pinned.codehash ?? ''), '管理员签名配置不完整。');
  const configKey = stable(config), argsKey = stable(args), capturedArgs = frozenCopy(args);
  const reservation = creationReservation(config, kind, capturedArgs);
  emit(onState, 'preparing-authority');
  const [nonce] = await boundedReadPreview(async ({ provider: reader }) => Promise.all([
    reader.request({ method: 'eth_call', params: [{ to: authority,
      data: authorityAbi.encodeFunctionData('nonces', [signer]) }, 'latest'] })
      .then(raw => authorityAbi.decodeFunctionResult('nonces', raw)[0]),
    reservation ? requireMachineAvailable(reader, reservation) : null,
  ]), { provider: readProvider, timeoutMs: readTimeoutMs, isCurrent, signal });
  need(isCurrent() && !signal?.aborted && stable(config) === configKey && stable(args) === argsKey,
    '预览期间页面、钱包或操作参数已改变，请重新预览。');
  const createdAt = Date.now(), deadline = (BigInt(Math.floor(createdAt / 1000)) + BigInt(validitySeconds)).toString();
  const signed = frozenCopy(authorityAction(authority, kind, capturedArgs, nonce, deadline));
  const token = Object.freeze({});
  // The read signal may be aborted by its caller's normal cleanup after a successful
  // preview. Only page/wallet epochs govern the token after preparation completes.
  preparedSignatures.set(token, { provider, signer, configKey, kind, argsKey, isCurrent, createdAt,
    expiresAt: Math.min(createdAt + cacheLifetimeMs, Number(deadline) * 1000), signed,
    payload: JSON.stringify(signaturePayload(signed)),
    command: frozenCopy({ authority, expectedCodehash: pinned.codehash.toLowerCase(), kind,
      args: capturedArgs, nonce: nonce.toString(), deadline }) });
  return token;
}

/** One explicit confirmation consumes one token. No read RPC, simulation, retry or relay POST. */
export async function signPreparedAuthorityAction({ prepared, provider, config, account, kind, args,
  isCurrent = () => true, onState }) {
  const stored = prepared && typeof prepared === 'object' ? preparedSignatures.get(prepared) : null;
  need(stored, '管理员签名准备已失效或已使用，请重新预览。');
  preparedSignatures.delete(prepared); // Also consumed by rejection, context mismatch or an unknown wallet result.
  const current = () => {
    need(provider === stored.provider && getAddress(account) === stored.signer
      && stable(config) === stored.configKey && kind === stored.kind && stable(args) === stored.argsKey,
    '钱包、配置或操作参数与预览不同，请重新预览。');
    need(stored.isCurrent() && isCurrent(),
      '页面或钱包已改变，请重新预览。');
  };
  current();
  need(Date.now() >= stored.createdAt && Date.now() < stored.expiresAt,
    '管理员签名准备已过期，请重新预览。');
  emit(onState, 'awaiting-admin-signature');
  current();
  const signature = await stored.provider.request({ method: 'eth_signTypedData_v4',
    params: [stored.signer, stored.payload] });
  current();
  need(Date.now() < Number(stored.command.deadline) * 1000, '管理员签名已过期，请重新预览。');
  need(same(verifyTypedData(stored.signed.domain, stored.signed.types, stored.signed.message, signature), stored.signer),
    '钱包签名与当前管理员地址不一致。');
  // A different transaction may have consumed the cached nonce. Only the relay/chain decides;
  // never obtain a new nonce or sign again as an automatic recovery step.
  return { ...stored.command, signature };
}

/** Read the nonce and exact NFT reservation together; only then request the signature. */
export async function signAuthorityAction({ provider, readProvider, config, account, kind, args,
  validitySeconds = 600, readTimeoutMs = 8000, isCurrent = () => true, onState }) {
  need(config?.stage === 'fresh-active' && config?.status === 'ready', '新合约尚未启用。');
  const signer = getAddress(account), authority = getAddress(config.authority ?? config.manifest?.authority);
  need(authority !== ZeroAddress && Number.isInteger(validitySeconds) && validitySeconds > 0 && validitySeconds <= 900,
    '管理员签名有效期无效。');
  const rpc = (method, params = []) => provider.request({ method, params });
  const reservation = creationReservation(config, kind, args);
  if (config.displayOnly === true) {
    const input = { provider, readProvider, config, account, kind, args, validitySeconds, readTimeoutMs, isCurrent, onState };
    const prepared = await prepareAuthoritySignature(input);
    return signPreparedAuthorityAction({ ...input, prepared });
  }
  need(BigInt(await rpc('eth_chainId')) === 56n, '请切换到 BSC 主网。');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  need(/^0x[0-9a-f]{64}$/i.test(block?.hash ?? ''), '当前链上区块不可用。');
  const tag = block.number;
  const read = async (name, params = []) => authorityAbi.decodeFunctionResult(name,
    await rpc('eth_call', [{ to: authority, data: authorityAbi.encodeFunctionData(name, params) }, tag]))[0];
  const [first, second, gasWallet, core, budget, nonce, code] = await Promise.all([
    read('administratorOne'), read('administratorTwo'), read('gasWallet'), read('coreFactory'),
    read('budgetFactory'), read('nonces', [signer]), rpc('eth_getCode', [authority, tag]),
    reservation ? requireMachineAvailable(provider, { ...reservation, blockTag: tag }) : null,
  ]);
  need(same(signer, first) || same(signer, second), '当前钱包不是链上登记的管理员。');
  need(same(core, config.factory) && same(budget, config.portfolioFactory), '管理员合约绑定的 Factory 不一致。');
  if (config.gasWallet ?? config.manifest?.gasWallet) need(same(gasWallet, config.gasWallet ?? config.manifest.gasWallet), 'Gas 钱包与部署配置不一致。');
  need(code && code !== '0x', '管理员合约代码不可用。');
  const deadline = (BigInt(block.timestamp) + BigInt(validitySeconds)).toString();
  const signed = authorityAction(authority, kind, args, nonce, deadline);
  const payload = { types: { EIP712Domain: [
    { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
  ], ...signed.types }, primaryType: signed.primaryType, domain: signed.domain, message: signed.message };
  need(isCurrent(), '页面或钱包已改变，请重新预览。');
  const signature = await rpc('eth_signTypedData_v4', [signer, JSON.stringify(payload)]);
  need(same(verifyTypedData(signed.domain, signed.types, signed.message, signature), signer),
    '钱包签名与当前管理员地址不一致。');
  need((await rpc('eth_getBlockByNumber', [tag, false]))?.hash === block.hash,
    '签名期间区块发生重组；请重新核对。');
  return { authority, expectedCodehash: keccak256(code), kind, args,
    nonce: nonce.toString(), deadline, signature };
}

/** Session/status reconciliation must not postpone the administrator's wallet prompt.
 * Authentication is still required before any relay POST. No transaction is broadcast here. */
export async function prepareAuthoritySubmission({ authenticate, prepared, ...input }) {
  need(typeof authenticate === 'function', '管理员代付需要本站登录会话。');
  const command = prepared === undefined ? await signAuthorityAction(input)
    : await signPreparedAuthorityAction({ ...input, prepared });
  need((input.isCurrent ?? (() => true))(), '页面或钱包已改变，请重新预览。');
  emit(input.onState, 'authenticating');
  await authenticate({ onState: input.onState });
  need((input.isCurrent ?? (() => true))(), '页面或钱包已改变；尚未提交签名。');
  return command;
}

export async function submitAuthorityAction(config, account, command) {
  const requestId = authorityOperationId(command);
  const base = (config.journalBase ?? '/api/journal').replace(/\/$/, '');
  const response = await fetch(`${base}/authority-relay`, { method: 'POST', credentials: 'same-origin',
    cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Pinkuang-Account': getAddress(account) },
    body: JSON.stringify({ command }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw Object.assign(new Error(result?.error
    || `管理员代付服务暂不可用（HTTP ${response.status}）。`),
    { httpStatus: response.status,
      submissionRejected: [400, 401, 403, 404, 405, 409, 413, 415, 429].includes(response.status),
      relayResult: relayMetadata(result) });
  need(sameBytes(result.requestId, requestId), '代付响应不属于本次签名；请保留请求并核对状态，不要重复发送。');
  if (result.accepted === false) throw Object.assign(new Error(result.message || '本次签名请求未被代付服务接受。'),
    { httpStatus: response.status, submissionRejected: true, relayResult: relayMetadata(result) });
  need(result.accepted === true && HASH.test(result.hash ?? '') && authorityStatusForRequest(result, requestId),
    '代付响应尚未证明本次请求已被接受；请核对状态，不要重复发送。');
  return result;
}

export async function authorityActionStatus(config, account) {
  const base = (config.journalBase ?? '/api/journal').replace(/\/$/, '');
  const response = await fetch(`${base}/authority-relay/status`, { credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Pinkuang-Account': getAddress(account) }, signal: AbortSignal.timeout(8000) });
  const result = await response.json().catch(() => null);
  need(response.ok && result, result?.error || `管理员交易状态暂不可用（HTTP ${response.status}）。`);
  return result;
}
