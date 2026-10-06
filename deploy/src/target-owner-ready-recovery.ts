import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import {
  TARGET_OWNER_DEPLOYMENTS, parseTargetOwnerJournal, targetOwnerJournalKey, targetOwnerPending,
  type TargetOwnerContext, type TargetOwnerJournal, type UpgradeTransaction,
} from './target-owner-upgrade-ui';

type FinalizedBlock = { number: number; hash: string; timestamp: number };
export type ReadyTargetOwnerScheduledProof = {
  phase: string; baselineVerified: boolean; replacementDeploymentVerified: boolean;
  verifiedDeploymentNames: readonly string[];
  deployments: Record<string, { address: string; txHash: string }>;
  candidateArtifactDigest: string; reviewCatalogDigest: string;
  operationId: string; operation: string; ready: boolean; readyAt: number | null;
  timelockTimestamp: string; codeUpgradeComplete: boolean;
  blockNumber: number; blockHash: string; checkedAt: string;
};
/** These values must come from a fresh shared full-graph preflight and its canonical finalized
 * snapshot. This is a trusted read callback, never data accepted from an imported file. */
export type ReadyTargetOwnerProof = {
  checked: ReadyTargetOwnerScheduledProof;
  finalized: FinalizedBlock;
  chainId: 56;
  canonical: true;
};
export type ReadyScheduleReceipt = {
  status: number | null; hash: string; from: string; blockNumber: number; blockHash: string;
};
export type ReadyTargetOwnerRecordSwitch = Readonly<{
  sourceJournal: TargetOwnerJournal;
  preservedJournal: TargetOwnerJournal;
  replacementJournal: TargetOwnerJournal;
  sourceOperationId: string;
  targetOperationId: string;
  sourceJournalJson: string;
  archiveJson: string;
  archiveDigest: string;
}>;
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const preparedSwitches = new WeakMap<object, number>();
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const need: (condition: unknown, reason: string) => asserts condition = (condition, reason) => {
  if (!condition) throw new Error(reason);
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function completeSchedule(journal: TargetOwnerJournal, imported: boolean) {
  need(!journal.execute, '存在执行升级记录，不能切换排程。');
  need(TARGET_OWNER_DEPLOYMENTS.every(name => journal.deployments[name]?.status === 'confirmed'),
    '切换排程需要三个已确认部署；未知部署必须保留原流程。');
  const pending = targetOwnerPending(journal);
  need(!pending || !imported && pending === 'schedule', '未知部署或执行请求不能由其他排程替代。');
  need(journal.schedule && hash(journal.schedule.txHash), '原排程必须有可核验的完整交易哈希。');
  if (imported) need(journal.schedule.status === 'confirmed' && !pending, '恢复的到期排程必须已确认且没有待处理请求。');
}
function checkProof(value: ReadyTargetOwnerProof, journal: TargetOwnerJournal, requireReady: boolean,
  context: TargetOwnerContext): ReadyTargetOwnerScheduledProof {
  const proof = value?.checked, block = value?.finalized, now = Date.now();
  need(value?.chainId === 56 && value.canonical === true && block && proof,
    '排程缺少当前 BSC 最终规范区块的完整证明。');
  need(Number.isSafeInteger(block.number) && block.number > 0 && hash(block.hash)
    && Number.isSafeInteger(block.timestamp) && block.timestamp > 0
    && block.timestamp * 1000 <= now + 30000 && now - block.timestamp * 1000 <= 120000
    && proof.blockNumber === block.number && same(proof.blockHash, block.hash),
  '排程证明不是当前最终区块，或规范区块已变化。');
  const checkedAt = Date.parse(proof.checkedAt);
  need(Number.isFinite(checkedAt) && new Date(checkedAt).toISOString() === proof.checkedAt
    && checkedAt <= now + 5000 && now - checkedAt <= 120000, '排程证明已过期，需要重新读取链上状态。');
  need(proof.phase === 'scheduled' && proof.baselineVerified === true
    && proof.replacementDeploymentVerified === true && proof.codeUpgradeComplete === false
    && ['waiting', 'ready'].includes(proof.operation) && proof.ready === (proof.operation === 'ready')
    && hash(proof.operationId) && BigInt(proof.operationId) !== 0n
    && proof.verifiedDeploymentNames?.length === 3
    && TARGET_OWNER_DEPLOYMENTS.every((name, index) => proof.verifiedDeploymentNames[index] === name)
    && Object.keys(proof.deployments ?? {}).length === 3
    && TARGET_OWNER_DEPLOYMENTS.every(name => {
      const verified = proof.deployments[name], recorded = journal.deployments[name]!;
      return verified && getAddress(verified.address) === getAddress(recorded.address!)
        && same(verified.txHash, recorded.txHash!);
    }) && same(proof.candidateArtifactDigest, context.candidateArtifactDigest)
    && same(proof.reviewCatalogDigest, context.catalogDigest),
  '排程没有绑定本页完整正式图、三个原部署与原排程。');
  need(Number.isSafeInteger(proof.readyAt) && proof.readyAt! > 1
    && /^[1-9]\d*$/.test(proof.timelockTimestamp) && BigInt(proof.timelockTimestamp) === BigInt(proof.readyAt!)
    && (proof.ready ? proof.readyAt! <= block.timestamp : proof.readyAt! > block.timestamp),
  '排程到期时间与当前链上状态不同。');
  need(!requireReady || proof.operation === 'ready' && proof.ready === true,
    '恢复的原排程尚未到期，不能正式执行升级。');
  return proof;
}

/** Read-only preparation. A current submitted schedule is promoted only after the strict receipt
 * callback succeeds AND a fresh full-graph scheduled preflight confirms the same record. */
export async function prepareReadyTargetOwnerRecordSwitch(
  existing: TargetOwnerJournal,
  imported: TargetOwnerJournal,
  context: TargetOwnerContext,
  verifyPendingSchedule: (journal: TargetOwnerJournal, original: UpgradeTransaction) => Promise<ReadyScheduleReceipt | null>,
  prove: (journal: TargetOwnerJournal, role: 'existing' | 'imported') => Promise<ReadyTargetOwnerProof>,
): Promise<ReadyTargetOwnerRecordSwitch> {
  const source = parseTargetOwnerJournal(existing, context), replacement = parseTargetOwnerJournal(imported, context);
  const sourceJson = JSON.stringify(source), importedJson = JSON.stringify(replacement);
  const unchanged = () => need(JSON.stringify(parseTargetOwnerJournal(existing, context)) === sourceJson
    && JSON.stringify(parseTargetOwnerJournal(imported, context)) === importedJson,
  '核验期间升级记录已变化；原记录不能被覆盖。');
  completeSchedule(source, false); completeSchedule(replacement, true);
  need(!same(source.salt, replacement.salt), '恢复文件仍是当前排程，不能切换。');
  let promoted = source, receipt: ReadyScheduleReceipt | null = null;
  if (targetOwnerPending(source)) {
    receipt = await verifyPendingSchedule(parseTargetOwnerJournal(source, context), { ...source.schedule! });
    unchanged();
    need(receipt && receipt.status === 1 && hash(receipt.hash) && same(receipt.hash, source.schedule!.txHash!)
      && getAddress(receipt.from) === getAddress(source.schedule!.from)
      && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber > 0 && hash(receipt.blockHash),
    '当前排程没有匹配的最终成功回执；未知或失败记录已保留。');
    promoted = parseTargetOwnerJournal({ ...source, schedule: { ...source.schedule!, status: 'confirmed' } }, context);
  }
  const sourceValue = await prove(parseTargetOwnerJournal(promoted, context), 'existing');
  const sourceProof = checkProof(sourceValue, promoted, false, context);
  unchanged();
  if (receipt) need(receipt.blockNumber <= sourceProof.blockNumber,
    '当前排程回执尚未最终确认；原记录已保留。');
  const targetValue = await prove(parseTargetOwnerJournal(replacement, context), 'imported');
  const targetProof = checkProof(targetValue, replacement, true, context);
  unchanged();
  // The second full-graph read can take time. Neither proof may age out while preparing the switch.
  checkProof(sourceValue, promoted, false, context); checkProof(targetValue, replacement, true, context);
  need(!same(sourceProof.operationId, targetProof.operationId), '恢复文件与当前排程具有相同操作 ID。');
  // No readiness claims from the imported journal are persisted as execution authority.
  const archiveJson = JSON.stringify({ schemaVersion: 1, kind: 'target-owner-preserved-schedule-v1',
    sourceOperationId: sourceProof.operationId, targetOperationId: targetProof.operationId,
    sourceJournal: source, confirmedJournal: promoted });
  const prepared = freeze({ sourceJournal: source, preservedJournal: promoted, replacementJournal: replacement,
    sourceOperationId: sourceProof.operationId, targetOperationId: targetProof.operationId,
    sourceJournalJson: sourceJson, archiveJson, archiveDigest: keccak256(toUtf8Bytes(archiveJson)) });
  preparedSwitches.set(prepared, Math.min(sourceValue.finalized.timestamp * 1000 + 120000,
    targetValue.finalized.timestamp * 1000 + 120000, Date.parse(sourceProof.checkedAt) + 120000,
    Date.parse(targetProof.checkedAt) + 120000));
  return prepared;
}

/** Call inside the existing exclusive journal lock. This writes only immutable history, never the
 * current key. The caller must then persist replacementJournal using its same currentRaw barrier. */
export function preserveReadyTargetOwnerRecordSwitch(
  storage: Storage,
  currentKey: string,
  currentRaw: string,
  prepared: ReadyTargetOwnerRecordSwitch,
  assertCurrent: () => void,
): { archiveKey: string; replacementJournal: TargetOwnerJournal } {
  const expiresAt = preparedSwitches.get(prepared);
  need(expiresAt !== undefined, '必须先完整核验两个排程，不能保存未验证的恢复文件。');
  const context = prepared.sourceJournal;
  need(currentKey === targetOwnerJournalKey(context), '当前记录键与已核验的正式升级不匹配。');
  const barrier = () => {
    assertCurrent();
    need(Date.now() <= expiresAt, '已核验的排程证明过期，需要重新读取后再恢复。');
    need(storage.getItem(currentKey) === currentRaw, '另一标签已更新当前升级记录，不能覆盖。');
    need(JSON.stringify(parseTargetOwnerJournal(JSON.parse(currentRaw), context)) === prepared.sourceJournalJson,
      '当前记录与刚才核验的原排程不同。');
  };
  barrier();
  const archiveKey = `${currentKey}.preserved.${prepared.sourceOperationId.toLowerCase()}.${prepared.archiveDigest.slice(2)}`;
  const previous = storage.getItem(archiveKey);
  need(previous === null || previous === prepared.archiveJson, '历史键已有不同记录；不能覆盖原排程。');
  barrier();
  if (previous === null) storage.setItem(archiveKey, prepared.archiveJson);
  barrier();
  need(storage.getItem(archiveKey) === prepared.archiveJson, '原排程历史没有完整保存，当前记录已保留。');
  barrier();
  return { archiveKey, replacementJournal: parseTargetOwnerJournal(prepared.replacementJournal, context) };
}
