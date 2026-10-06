import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256 } from 'ethers';
import { decodeFreshSingleCallEnvelope, FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR,
  FRESH_BALANCE_ENFORCER } from './fresh-activation-execution.mjs';

const abi = new Interface([
  'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function upgradeTo(address)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)',
]);
const same = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const HASH = /^0x[\da-f]{64}$/i, HEX = /^0x(?:[\da-f]{2})+$/i;
const need = (condition, message) => { if (!condition) throw new Error(message); };
function address(value) { const result = getAddress(value); need(result !== ZeroAddress, '排程地址无效。'); return result; }

function expectedSchedule(expected) {
  const plan = expected.schedulePlan;
  need(plan && HEX.test(expected.data ?? '') && same(expected.to, plan.to)
    && same(expected.data, plan.scheduleData) && same(keccak256(expected.data), expected.dataHash),
  '排程完整操作参数与原记录不一致。');
  const to = address(plan.to), target = address(plan.target), replacement = address(plan.replacement);
  need(plan.value === '0' && same(plan.predecessor, ZeroHash) && HASH.test(plan.salt ?? '')
    && !same(plan.salt, ZeroHash) && Number.isSafeInteger(plan.delaySeconds) && plan.delaySeconds >= 172800,
  '排程必须保持单调用、零金额、唯一 salt 和至少 48 小时等待。');
  const payload = abi.encodeFunctionData('upgradeTo', [replacement]);
  need(same(payload, plan.payload), '排程补丁调用与原记录不一致。');
  const args = [target, 0n, payload, ZeroHash, plan.salt];
  const data = abi.encodeFunctionData('schedule', [...args, plan.delaySeconds]);
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'bytes', 'bytes32', 'bytes32'], args));
  need(same(data, expected.data) && same(operationId, plan.operationId), '排程编码或操作摘要与原记录不一致。');
  return { ...plan, to, target, replacement, payload, scheduleData: data, operationId };
}
function logBinding(log, receipt, tx) {
  need(log.removed !== true && same(log.transactionHash, tx.hash) && same(log.blockHash, receipt.blockHash)
    && log.blockNumber === receipt.blockNumber && log.transactionIndex === receipt.index,
  '排程事件与原交易区块不一致。');
}
function exactEvent(log, name, values, receipt, tx) {
  logBinding(log, receipt, tx);
  const encoded = abi.encodeEventLog(abi.getEvent(name), values);
  need(Array.isArray(log.topics) && log.topics.length === encoded.topics.length
    && log.topics.every((topic, index) => same(topic, encoded.topics[index])) && same(log.data, encoded.data),
  '排程事件与本次完整操作不一致。');
}
function successfulScheduleEvents(plan, receipt, tx) {
  need(Array.isArray(receipt.logs), '排程回执缺少完整事件。');
  const atTimelock = receipt.logs.filter(log => same(log.address, plan.to));
  const scheduled = atTimelock.filter(log => same(log.topics?.[0], abi.getEvent('CallScheduled').topicHash));
  const salts = atTimelock.filter(log => same(log.topics?.[0], abi.getEvent('CallSalt').topicHash));
  need(scheduled.length === 1 && salts.length === 1, '排程回执缺少唯一完整 CallScheduled 或 CallSalt 事件。');
  exactEvent(scheduled[0], 'CallScheduled', [plan.operationId, 0n, plan.target, 0n, plan.payload,
    ZeroHash, BigInt(plan.delaySeconds)], receipt, tx);
  exactEvent(salts[0], 'CallSalt', [plan.operationId, plan.salt], receipt, tx);
}

/** Called only after the original nonce/hash/sender and canonical receipt inclusion checks.
 * The reviewed non-upgradeable wrapper runtimes are read at the current finalized
 * canonical anchor, as in fresh-activation-chain-proof. Successful Timelock events
 * prove the result; no historical account delegation is claimed from current code.
 * A reverted wrapper never releases the original intent for a retry.
 */
export async function verifyPortfolioDustScheduleReceipt(provider, { tx, receipt, expected, finalized }) {
  const plan = expectedSchedule(expected);
  let runtimeProof, runtimeAnchor = null;
  if (!same(tx.to, plan.to)) {
    need(same(tx.to, FRESH_DELEGATION_MANAGER.address), '原排程交易目标不是固定 Timelock 或已审查的钱包封装。');
    need(Number.isSafeInteger(finalized?.number) && finalized.number >= receipt.blockNumber && HASH.test(finalized.hash ?? ''),
      '钱包封装缺少规范的 finalized 核验区块。');
    const [managerCode, delegatorCode, enforcerCode] = await Promise.all([
      provider.getCode(FRESH_DELEGATION_MANAGER.address, finalized.number),
      provider.getCode(FRESH_DELEGATOR.address, finalized.number),
      provider.getCode(FRESH_BALANCE_ENFORCER.address, finalized.number),
    ]);
    runtimeProof = { managerCode, delegatorCode, enforcerCode };
    runtimeAnchor = { blockNumber: finalized.number, blockHash: finalized.hash };
  }
  const envelope = decodeFreshSingleCallEnvelope({ account: expected.from, target: plan.to,
    data: plan.scheduleData, tx, receipt, runtimeProof });
  if (runtimeAnchor) {
    const again = await provider.getBlock(runtimeAnchor.blockNumber);
    need(again?.number === runtimeAnchor.blockNumber && same(again.hash, runtimeAnchor.blockHash),
      '钱包封装核验期间规范区块发生变化。');
  }
  need(envelope.kind !== 'wrapped' || receipt.status === 1,
    '原钱包封装交易已回滚，记录保留；尚未证明排程未生效，不会允许重发。');
  if (receipt.status === 1) successfulScheduleEvents(plan, receipt, tx);
  return { envelopeKind: envelope.kind, operationId: plan.operationId, scheduleDataHash: expected.dataHash,
    ...(runtimeAnchor ? { runtimeAnchor, contextHash: envelope.contextHash } : {}) };
}
