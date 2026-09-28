import { getAddress } from 'ethers';
import type { IntegratedUpgradePreflight, IntegratedUpgradeResult } from '../shared/integrated-upgrade-plan.mjs';
import type { PauseFactoryName } from './upgrade-pause';

export type UpgradeTransaction = {
  status: 'submitted' | 'confirmed' | 'uncertain';
  from: string;
  dataHash: string;
  txHash?: string;
  address?: string;
};

export type UpgradeBootstrapJournal = {
  hardwareWallet: string;
  salt: string;
  delaySeconds: number;
  schedule?: UpgradeTransaction;
  execute?: UpgradeTransaction;
};

export type UpgradeAuthorityJournal = {
  hardwareWallet: string;
  gasWallet: string;
  deployment?: UpgradeTransaction;
};

export type UpgradeRoleJournal = {
  salt: string;
  delaySeconds: number;
  direct: Partial<Record<number, UpgradeTransaction>>;
  schedule?: UpgradeTransaction;
  execute?: UpgradeTransaction;
};

export type UpgradeTreasuryOperationJournal = {
  schedule?: UpgradeTransaction;
  execute?: UpgradeTransaction;
  preExecutionPreflight?: unknown;
};

export type UpgradeTreasuryJournal = {
  saltSeed: string;
  delaySeconds: number;
  operations: Partial<Record<number, UpgradeTreasuryOperationJournal>>;
};

export type UpgradeJournal = {
  schemaVersion: 1;
  genesisArtifactDigest: string;
  upgradeArtifactDigest: string;
  factory: string;
  salt: string;
  delaySeconds: number;
  pauses?: Partial<Record<PauseFactoryName, UpgradeTransaction>>;
  bootstrap?: UpgradeBootstrapJournal;
  authority?: UpgradeAuthorityJournal;
  role?: UpgradeRoleJournal;
  treasury?: UpgradeTreasuryJournal;
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
  if (record.pauses && (typeof record.pauses !== 'object' || Array.isArray(record.pauses)
      || Object.keys(record.pauses).some(name => name !== 'factory' && name !== 'portfolioFactory'))) {
    throw new Error('本机升级记录中的暂停步骤无效。');
  }
  if (record.bootstrap && (!hash(record.bootstrap.salt)
      || !Number.isSafeInteger(record.bootstrap.delaySeconds)
      || record.bootstrap.delaySeconds < 172800)) {
    throw new Error('本机硬件钱包角色授权计划无效。');
  }
  if (record.bootstrap) getAddress(record.bootstrap.hardwareWallet);
  if (record.authority) {
    getAddress(record.authority.hardwareWallet);
    getAddress(record.authority.gasWallet);
  }
  if (record.role && (!hash(record.role.salt) || !Number.isSafeInteger(record.role.delaySeconds)
      || record.role.delaySeconds < 172800 || !record.role.direct
      || Object.keys(record.role.direct).some(index => !/^[0-5]$/.test(index)))) {
    throw new Error('本机 Factory / Timelock 角色迁移记录无效。');
  }
  if (record.treasury && (!hash(record.treasury.saltSeed)
      || !Number.isSafeInteger(record.treasury.delaySeconds)
      || record.treasury.delaySeconds < 172800 || !record.treasury.operations
      || Object.keys(record.treasury.operations).some(index => !/^(0|[1-9]\d*)$/.test(index)))) {
    throw new Error('本机历史池金库迁移记录无效。');
  }
  for (const tx of [...Object.values(record.pauses || {}), ...Object.values(record.deployments),
    record.bootstrap?.schedule, record.bootstrap?.execute, record.authority?.deployment,
    ...Object.values(record.role?.direct || {}), record.role?.schedule, record.role?.execute,
    ...Object.values(record.treasury?.operations || {}).flatMap(operation => [operation?.schedule,operation?.execute]),
    record.schedule, record.execute].filter(Boolean) as UpgradeTransaction[]) {
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
    pauses: {},
    deployments: {},
  };
}
