import { getAddress } from 'ethers';
import type { IntegratedUpgradePreflight, IntegratedUpgradeResult } from '../shared/integrated-upgrade-plan.mjs';

export type UpgradeTransaction = {
  status: 'submitted' | 'confirmed' | 'uncertain';
  from: string;
  dataHash: string;
  txHash?: string;
  address?: string;
};

export type UpgradeJournal = {
  schemaVersion: 1;
  genesisArtifactDigest: string;
  upgradeArtifactDigest: string;
  factory: string;
  salt: string;
  delaySeconds: number;
  deployments: Record<string, UpgradeTransaction>;
  schedule?: UpgradeTransaction;
  execute?: UpgradeTransaction;
  preExecutionPreflight?: IntegratedUpgradePreflight & {phase: 'scheduled'};
  postProof?: IntegratedUpgradeResult;
};

const hash = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

export function upgradeJournalKey(factory: string, oldDigest: string, newDigest: string): string {
  if (!hash(oldDigest) || !hash(newDigest)) throw new Error('合约产物摘要格式无效。');
  return `pinkuang.upgrade.v1.${getAddress(factory).toLowerCase()}.${oldDigest.toLowerCase()}.${newDigest.toLowerCase()}`;
}

export function parseUpgradeJournal(value: unknown, expected: {
  factory: string; genesisArtifactDigest: string; upgradeArtifactDigest: string;
}): UpgradeJournal {
  const record = value as Partial<UpgradeJournal> | null;
  if (!record || record.schemaVersion !== 1 || !record.factory
      || getAddress(record.factory) !== getAddress(expected.factory)
      || record.genesisArtifactDigest?.toLowerCase() !== expected.genesisArtifactDigest.toLowerCase()
      || record.upgradeArtifactDigest?.toLowerCase() !== expected.upgradeArtifactDigest.toLowerCase()
      || !hash(record.salt) || !Number.isSafeInteger(record.delaySeconds)
      || Number(record.delaySeconds) < 172800 || !record.deployments || typeof record.deployments !== 'object') {
    throw new Error('本机升级记录与当前部署不匹配，不能据此继续签名。');
  }
  for (const tx of [...Object.values(record.deployments), record.schedule, record.execute].filter(Boolean) as UpgradeTransaction[]) {
    if (!['submitted', 'confirmed', 'uncertain'].includes(tx.status)
        || !hash(tx.dataHash) || !tx.from
        || (tx.txHash !== undefined && !hash(tx.txHash))
        || (tx.address !== undefined && !getAddress(tx.address))) {
      throw new Error('本机升级记录中的交易字段无效。');
    }
    getAddress(tx.from);
  }
  return record as UpgradeJournal;
}

export function newUpgradeJournal(expected: {
  factory: string; genesisArtifactDigest: string; upgradeArtifactDigest: string;
}, salt: string): UpgradeJournal {
  if (!hash(salt)) throw new Error('升级批次 salt 必须为 32 字节。');
  return {
    schemaVersion: 1,
    factory: getAddress(expected.factory),
    genesisArtifactDigest: expected.genesisArtifactDigest.toLowerCase(),
    upgradeArtifactDigest: expected.upgradeArtifactDigest.toLowerCase(),
    salt: salt.toLowerCase(),
    delaySeconds: 172800,
    deployments: {},
  };
}
