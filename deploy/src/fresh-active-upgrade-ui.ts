import { getAddress, ZeroAddress } from 'ethers';
import { freshUpgradeDeploymentOrder, type FreshActiveGraphProof,
  type FreshReplacementName } from '../shared/fresh-active-upgrade-plan.mjs';
import type { UpgradeTransaction } from './upgrade-journal';

export type FreshUpgradeContext = {
  factory: string; genesisArtifactDigest: string; upgradeArtifactDigest: string;
};
export type FreshActiveUpgradeJournal = FreshUpgradeContext & {
  kind: 'fresh-active-upgrade'; schemaVersion: 1; salt: string; delaySeconds: number;
  deployments: Partial<Record<FreshReplacementName, UpgradeTransaction>>;
  schedule?: UpgradeTransaction; execute?: UpgradeTransaction;
  preExecutionPreflight?: FreshActiveGraphProof;
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const insist: (ok: unknown, reason: string) => asserts ok = (ok, reason) => { if (!ok) throw new Error(reason); };

export function freshActiveUpgradeJournalKey(context: FreshUpgradeContext): string {
  insist(hash(context.genesisArtifactDigest) && hash(context.upgradeArtifactDigest)
    && context.genesisArtifactDigest.toLowerCase() !== context.upgradeArtifactDigest.toLowerCase(),
  '升级记录必须绑定不同的新旧合约产物摘要。');
  return `pinkuang.fresh-active-upgrade.v1.${getAddress(context.factory).toLowerCase()}.`
    + `${context.genesisArtifactDigest.toLowerCase()}.${context.upgradeArtifactDigest.toLowerCase()}`;
}
export function newFreshActiveUpgradeJournal(context: FreshUpgradeContext, salt: string): FreshActiveUpgradeJournal {
  freshActiveUpgradeJournalKey(context);
  insist(hash(salt) && BigInt(salt) !== 0n, '升级 salt 必须为非零 32 字节。');
  return { kind: 'fresh-active-upgrade', schemaVersion: 1, factory: getAddress(context.factory),
    genesisArtifactDigest: context.genesisArtifactDigest.toLowerCase(),
    upgradeArtifactDigest: context.upgradeArtifactDigest.toLowerCase(), salt: salt.toLowerCase(),
    delaySeconds: 172800, deployments: {} };
}
export function parseFreshActiveUpgradeJournal(value: unknown, context: FreshUpgradeContext): FreshActiveUpgradeJournal {
  const journal = value as FreshActiveUpgradeJournal | null;
  insist(journal && journal.kind === 'fresh-active-upgrade' && journal.schemaVersion === 1
    && freshActiveUpgradeJournalKey(journal) === freshActiveUpgradeJournalKey(context)
    && hash(journal.salt) && BigInt(journal.salt) !== 0n
    && Number.isSafeInteger(journal.delaySeconds) && journal.delaySeconds >= 172800
    && journal.deployments && typeof journal.deployments === 'object' && !Array.isArray(journal.deployments),
  '本机升级记录与当前正式 v5 和候选产物不匹配。');
  insist(Object.keys(journal).every(key => ['kind', 'schemaVersion', 'factory', 'genesisArtifactDigest',
    'upgradeArtifactDigest', 'salt', 'delaySeconds', 'deployments', 'schedule', 'execute',
    'preExecutionPreflight'].includes(key)), '本机记录包含其他版本的授权或迁移步骤。');
  insist(Object.keys(journal.deployments).every(name => freshUpgradeDeploymentOrder.includes(name as FreshReplacementName)),
    '本机记录包含不属于本次升级的部署。');
  let ended = false;
  const used = new Set<string>();
  for (const name of freshUpgradeDeploymentOrder) {
    const transaction = journal.deployments[name];
    if (!transaction) { ended = true; continue; }
    insist(!ended, '本机合约部署必须按完整依赖顺序记录。');
    validateTransaction(transaction);
    if (transaction.status === 'confirmed') {
      insist(transaction.txHash && transaction.address && getAddress(transaction.address) !== ZeroAddress,
        '已确认部署缺少原交易哈希或合约地址。');
      const normalized = getAddress(transaction.address).toLowerCase();
      insist(!used.has(normalized), '本机部署记录重复使用合约地址。'); used.add(normalized);
    } else ended = true;
  }
  for (const transaction of [journal.schedule, journal.execute]) {
    if (transaction) {
      validateTransaction(transaction);
      insist(!transaction.address, '时间锁交易不能记录为合约部署。');
      insist(transaction.status !== 'confirmed' || transaction.txHash, '已确认交易缺少原交易哈希。');
    }
  }
  if (journal.schedule || journal.execute) insist(freshUpgradeDeploymentOrder.every(name =>
    journal.deployments[name]?.status === 'confirmed'), '时间锁记录需要完整的十个候选部署。');
  if (journal.execute) insist(journal.schedule?.status === 'confirmed', '执行记录缺少已确认排程。');
  return journal;
}
function validateTransaction(transaction: UpgradeTransaction) {
  insist(transaction && ['submitted', 'confirmed', 'uncertain'].includes(transaction.status)
    && hash(transaction.dataHash) && typeof transaction.from === 'string'
    && (transaction.txHash === undefined || hash(transaction.txHash)), '本机交易字段无效。');
  insist(getAddress(transaction.from) !== ZeroAddress, '交易发送者不能为零地址。');
  if (transaction.status === 'submitted') insist(transaction.txHash, '已提交交易缺少哈希。');
  if (transaction.address !== undefined) getAddress(transaction.address);
}
