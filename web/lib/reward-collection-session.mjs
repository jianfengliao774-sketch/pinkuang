import { ZeroAddress, getAddress } from 'ethers';
import { abi } from './chain-client.mjs';
import { readMemberReceipt } from './member-wallet-transactions.mjs';

const HASH = /^0x[\da-f]{64}$/i;
const KINDS = new Set(['harvest', 'claim', 'withdrawBnb']);
const PREFIX = 'bemine-single-reward-collection:1';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export class RewardCollectionRecoveryError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RewardCollectionRecoveryError';
    this.code = code;
  }
}

function fail(code, message, cause) { throw new RewardCollectionRecoveryError(code, message, cause); }
function address(value, label) {
  try {
    const result = getAddress(value);
    if (result !== ZeroAddress) return result;
  } catch { /* Report one stable recovery error below. */ }
  fail('invalid_identity', `${label}地址无效。`);
}
function digest(value) {
  if (!HASH.test(value ?? '')) fail('invalid_identity', '合约版本摘要无效。');
  return value.toLowerCase();
}
function exact(value, label) {
  try {
    if (typeof value === 'bigint' && value >= 0n) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^(?:0|[1-9]\d*|0x[\da-f]+)$/i.test(value)) return BigInt(value);
  } catch { /* Report one stable recovery error below. */ }
  fail('invalid_transaction', `${label}不是精确非负整数。`);
}
function identity(config, account) {
  const manifest = config?.manifest;
  if (config?.chainId !== undefined && exact(config.chainId, '链号') !== 56n
    || manifest?.chainId !== undefined && exact(manifest.chainId, '部署链号') !== 56n)
    fail('invalid_identity', '归集记录必须绑定 BSC 主网。');
  const factory = address(manifest?.factory ?? config?.factory, '矿池工厂');
  const portfolioFactory = address(manifest?.portfolioFactory ?? config?.portfolioFactory, '预算工厂');
  const artifactDigest = digest(manifest?.artifactDigest ?? config?.artifactDigest);
  if (config?.factory !== undefined && !same(config.factory, factory)
    || config?.portfolioFactory !== undefined && !same(config.portfolioFactory, portfolioFactory)
    || config?.artifactDigest !== undefined && !same(config.artifactDigest, artifactDigest))
    fail('invalid_identity', '页面与部署清单的合约身份不一致。');
  return { account: address(account, '钱包'), factory, portfolioFactory, artifactDigest };
}
function key(binding) {
  return `${PREFIX}:56:${binding.artifactDigest}:${binding.factory.toLowerCase()}:${binding.portfolioFactory.toLowerCase()}:${binding.account.toLowerCase()}`;
}

/** Hold one browser-wide exclusive lock for the entire single-pool collect/verify flow. */
export async function withRewardCollectionLock(config, account, callback,
  { locks = globalThis.navigator?.locks } = {}) {
  const binding = identity(config, account);
  if (typeof callback !== 'function') fail('invalid_job', '归集互斥任务无效。');
  if (typeof locks?.request !== 'function')
    fail('lock_unavailable', '浏览器不支持跨标签页互斥，无法安全执行一键归集。');
  return locks.request(key(binding), { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) fail('active_recovery', '另一标签页正在处理该钱包的单矿池归集。');
    return callback();
  });
}
function expectedData(kind) {
  if (!KINDS.has(kind)) fail('invalid_job', '只支持单矿池收益归集和领取恢复。');
  const method = abi.PoolVault.getFunction(kind);
  if (!method || method.inputs.length !== 0) fail('invalid_job', '单矿池收益调用的 ABI 不可用。');
  return abi.PoolVault.encodeFunctionData(method);
}
function blockFloor(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)
    || BigInt(value) >= 1n << 256n) fail('invalid_job', '归集前区块下限必须是精确十进制整数。');
  return value;
}
function normalizeJob(input, binding) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_job', '归集恢复记录无效。');
  const account = address(input.account, '记录钱包');
  const factory = address(input.factory, '记录工厂');
  if (!same(account, binding.account) || !same(factory, binding.factory))
    fail('identity_mismatch', '归集恢复记录属于其他钱包或工厂。');
  const pool = address(input.pool, '单矿池');
  const data = expectedData(input.kind);
  if (input.data !== undefined && !same(input.data, data))
    fail('invalid_job', '归集恢复记录的调用内容不是指定的单矿池方法。');
  if (input.value !== '0') fail('invalid_job', '归集恢复记录只能是零 BNB 调用。');
  if (!['submitting', 'pending'].includes(input.status)) fail('invalid_job', '归集恢复阶段无效。');
  const hash = input.hash == null ? null : input.hash;
  if (hash !== null && !HASH.test(hash)) fail('invalid_job', '归集恢复交易哈希无效。');
  return { pool, kind: input.kind, hash, status: input.status, account, factory, data,
    value: '0', notBeforeBlock: blockFloor(input.notBeforeBlock) };
}
function storageFor(storage) {
  const selected = storage ?? globalThis.localStorage;
  if (!selected || typeof selected.getItem !== 'function' || typeof selected.setItem !== 'function'
    || typeof selected.removeItem !== 'function') fail('storage_unavailable', '浏览器无法持久保存归集恢复记录。');
  return selected;
}
function stored(selected, storageKey, binding) {
  let raw;
  try { raw = selected.getItem(storageKey); }
  catch (error) { fail('storage_unavailable', '无法读取归集恢复记录，已停止再次发送。', error); }
  if (raw === null) return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { fail('invalid_storage', '归集恢复记录已损坏，已停止再次发送。', error); }
  try { return normalizeJob(parsed, binding); }
  catch (error) { fail('invalid_storage', '归集恢复记录身份或内容不匹配，已停止再次发送。', error); }
}

/** One persistent guard per exact BSC deployment and wallet. A malformed active record never means "empty". */
export function readRewardCollectionRecovery(config, account, storage) {
  const binding = identity(config, account);
  return stored(storageFor(storage), key(binding), binding);
}

/** Persist the hashless intent before opening the wallet; only the same intent may acquire its returned hash. */
export function saveRewardCollectionRecovery(config, account, job, storage) {
  const binding = identity(config, account), selected = storageFor(storage), storageKey = key(binding);
  const next = normalizeJob(job, binding), previous = stored(selected, storageKey, binding);
  if (previous) {
    const sameIntent = same(previous.pool, next.pool) && previous.kind === next.kind
      && same(previous.data, next.data) && previous.value === next.value
      && previous.notBeforeBlock === next.notBeforeBlock;
    // Repeating the same hashless save is a second wallet-send attempt, not an
    // idempotent update. Only attach a returned/recovered hash to that intent.
    const attachingHash = previous.hash === null && next.hash !== null && next.status === 'pending';
    const samePendingHash = previous.hash !== null && next.status === 'pending'
      && same(previous.hash, next.hash);
    if (!sameIntent || !(attachingHash || samePendingHash))
      fail('active_recovery', '已有未核对的单矿池交易，不能再次发送。');
  }
  const encoded = JSON.stringify(next);
  try {
    selected.setItem(storageKey, encoded);
    if (selected.getItem(storageKey) !== encoded) fail('storage_unavailable', '归集恢复记录未持久保存，已停止发送。');
  } catch (error) {
    if (error instanceof RewardCollectionRecoveryError) throw error;
    fail('storage_unavailable', '归集恢复记录未持久保存，已停止发送。', error);
  }
  return true;
}

/** Clear only the exact recovery record whose transaction was resolved or explicitly discarded. */
export function clearRewardCollectionRecovery(config, account, storage, expectedJob) {
  const binding = identity(config, account), selected = storageFor(storage), storageKey = key(binding);
  const current = stored(selected, storageKey, binding);
  if (!current) return false;
  const expected = normalizeJob(expectedJob, binding);
  const sameIntent = same(current.pool, expected.pool) && current.kind === expected.kind
    && same(current.account, expected.account) && same(current.factory, expected.factory)
    && same(current.data, expected.data) && current.value === expected.value
    && current.notBeforeBlock === expected.notBeforeBlock;
  if (!sameIntent || (current.hash === null) !== (expected.hash === null)
    || current.hash !== null && !same(current.hash, expected.hash))
    fail('active_recovery', '归集恢复记录已变化，不能清除另一笔交易的恢复锁。');
  try {
    selected.removeItem(storageKey);
    if (selected.getItem(storageKey) !== null) fail('storage_unavailable', '归集恢复记录未清除。');
  } catch (error) {
    if (error instanceof RewardCollectionRecoveryError) throw error;
    fail('storage_unavailable', '归集恢复记录未清除。', error);
  }
  return true;
}

/** Read-only transaction recovery. A user-supplied hash cannot change the recorded method, wallet or pool. */
export async function readRecoveryTransaction({ provider, job, hash: manualHash } = {}) {
  if (typeof provider?.request !== 'function') fail('read_unavailable', '钱包只读查询不可用。');
  const binding = { account: address(job?.account, '记录钱包'), factory: address(job?.factory, '记录工厂') };
  const recorded = normalizeJob(job, binding);
  if (manualHash !== undefined && !HASH.test(manualHash ?? '')) fail('invalid_hash', '手动输入的交易哈希无效。');
  if (recorded.hash && manualHash && !same(recorded.hash, manualHash))
    fail('hash_mismatch', '手动哈希与已保存的交易哈希不一致。');
  const hash = recorded.hash ?? manualHash ?? null;
  if (!hash) return { status: 'pending', hash: null, reason: 'hash_required' };
  const tx = await provider.request({ method: 'eth_getTransactionByHash', params: [hash] });
  if (!tx) return { status: 'pending', hash, reason: 'transaction_unavailable' };
  if (!same(tx.hash, hash) || !same(tx.from, recorded.account) || !same(tx.to, recorded.pool)
    || !same(tx.input ?? tx.data, recorded.data)
    || tx.input !== undefined && tx.data !== undefined && !same(tx.input, tx.data)
    || exact(tx.value, '交易金额') !== 0n || exact(tx.chainId, '交易链号') !== 56n)
    fail('transaction_mismatch', '链上交易与单矿池归集恢复记录不匹配。');
  if (tx.blockNumber != null && exact(tx.blockNumber, '交易区块') <= BigInt(recorded.notBeforeBlock))
    fail('old_transaction', '交易早于本次归集前快照，不能用于解除恢复记录。');

  let observedReceipt;
  const receiptProvider = { request: async request => {
    const reply = await provider.request(request);
    if (request.method === 'eth_getTransactionReceipt') observedReceipt = reply;
    return reply;
  } };
  const result = await readMemberReceipt(receiptProvider,
    { hash, account: recorded.account, target: recorded.pool });
  if (observedReceipt) {
    if (exact(observedReceipt.blockNumber, '回执区块') <= BigInt(recorded.notBeforeBlock))
      fail('old_transaction', '回执早于本次归集前快照，不能用于解除恢复记录。');
    if (!same(tx.blockHash, observedReceipt.blockHash)
      || exact(tx.blockNumber, '交易区块') !== exact(observedReceipt.blockNumber, '回执区块'))
      fail('transaction_mismatch', '交易与回执不属于同一个区块。');
  }
  return { ...result, hash, pool: recorded.pool, kind: recorded.kind };
}
