/** The ten deployable replacements are a fixed reviewed dependency graph. */
export declare const INTEGRATED_SECURITY_UPGRADE_KIND: 'integrated-v2-security-upgrade-v1';
export declare const integratedUpgradeDeploymentOrder: readonly [
  'PoolFunds', 'FlexiblePurchase', 'SaleSettlement', 'FirstoSale', 'SaleGovernance', 'PoolVault',
  'PoolFactory', 'ShareMarket', 'BudgetPortfolioVault', 'BudgetPortfolioFactory'
];
export type IntegratedReplacementName = typeof integratedUpgradeDeploymentOrder[number];
export type IntegratedReplacements = Record<IntegratedReplacementName, string>;
export interface IntegratedUpgradePlan {
  kind: typeof INTEGRATED_SECURITY_UPGRADE_KIND;
  genesisRecordDigest: string;
  genesisArtifactDigest: string;
  upgradeArtifactDigest: string;
  replacements: IntegratedReplacements;
  lensPolicy: 'legacy-readonly-ignore-governance-thresholds';
  lensAddress: string;
  lensCodehash: string;
  predecessor: string;
  salt: string;
  delaySeconds: number;
  steps: Array<{name: string; target: string; implementation: string; data: string; value: '0'}>;
  targets: string[];
  values: string[];
  payloads: string[];
  operationId: string;
  scheduleData: string;
  executeData: string;
}
export interface IntegratedUpgradeCheck { label: string; passed: true }
export interface HistoricalTreasury { kind: 'pool' | 'portfolio'; index: number; address: string; treasury: string }
export interface IntegratedUpgradePreflight {
  phase: 'unscheduled' | 'scheduled';
  operationId: string;
  readyAt: string;
  checkedAt: string;
  blockNumber: number;
  blockHash: string;
  checks: IntegratedUpgradeCheck[];
  replacementCodehash: IntegratedReplacements;
  registry: {initialized: true; ready: true; cursor: string; cutoff: string};
  poolCount: string;
  portfolioCount: string;
  historical: HistoricalTreasury[];
}
export interface IntegratedGenesisPreflight {
  checkedAt: string;
  blockNumber: number;
  blockHash: string;
  checks: IntegratedUpgradeCheck[];
  registry: {initialized: true; ready: true; cursor: string; cutoff: string};
  poolCount: string;
  portfolioCount: string;
  historical: HistoricalTreasury[];
}
export declare function integratedUpgradeDeploymentData(
  name: IntegratedReplacementName,
  upgradeBundle: any,
  addresses: Record<string,string>,
): string;
/** Produces calldata only. Requires an independently trusted build digest. */
export declare function buildIntegratedUpgradePlan(input: {
  genesisRecord: any;
  genesisBundle: any;
  trustedGenesisManifest: any;
  upgradeBundle: any;
  trustedUpgradeArtifactDigest: string;
  replacements: IntegratedReplacements;
  salt: string;
  delaySeconds: number;
}): IntegratedUpgradePlan;
/** Genesis-only preflight for the first implementation-deployment signature. */
export declare function validateIntegratedUpgradeGenesisAgainstChain(
  provider: any,
  input: { genesisRecord: any; genesisBundle: any; trustedGenesisManifest: any },
): Promise<IntegratedGenesisPreflight>;
/** Proves an exact prefix of finalized replacement bytecode before the next wallet deployment. */
export declare function validateIntegratedUpgradePartialReplacementsAgainstChain(
  provider: any,
  input: {
    genesisRecord: any;
    genesisBundle: any;
    trustedGenesisManifest: any;
    upgradeBundle: any;
    trustedUpgradeArtifactDigest: string;
    deployments: Partial<IntegratedReplacements>;
  },
): Promise<IntegratedGenesisPreflight & { replacements: Partial<IntegratedReplacements> }>;
/** Pinned-finalized read-only preflight. It never signs or sends a transaction. */
export declare function validateIntegratedUpgradePlanAgainstChain(
  provider: any,
  plan: IntegratedUpgradePlan,
  input: {
    genesisRecord: any;
    genesisBundle: any;
    trustedGenesisManifest: any;
    upgradeBundle: any;
    trustedUpgradeArtifactDigest: string;
    proposer: string;
  },
): Promise<IntegratedUpgradePreflight>;
/** Rechecks the pinned old graph, replacement bytecode and ready Timelock batch before executeBatch. */
export declare function validateIntegratedUpgradeScheduledAgainstChain(
  provider: any,
  plan: IntegratedUpgradePlan,
  input: {
    genesisRecord: any;
    genesisBundle: any;
    trustedGenesisManifest: any;
    upgradeBundle: any;
    trustedUpgradeArtifactDigest: string;
    proposer: string;
  },
): Promise<IntegratedUpgradePreflight & { phase: 'scheduled' }>;
export interface IntegratedUpgradeResult {
  codeUpgradeComplete: true;
  roleMigrationComplete: false;
  operationId: string;
  checkedAt: string;
  blockNumber: number;
  blockHash: string;
  scheduleTxHash: string;
  executeTxHash: string;
  poolCount: string;
  portfolioCount: string;
  historical: HistoricalTreasury[];
  legacyTreasuryResidual: HistoricalTreasury[];
  checks: IntegratedUpgradeCheck[];
}
/** Requires finalized schedule/execute receipts and proves the post-upgrade graph. */
export declare function validateIntegratedUpgradeResultAgainstChain(
  provider: any,
  plan: IntegratedUpgradePlan,
  input: {
    genesisRecord: any;
    genesisBundle: any;
    trustedGenesisManifest: any;
    upgradeBundle: any;
    trustedUpgradeArtifactDigest: string;
    preExecutionPreflight: IntegratedUpgradePreflight;
    scheduleTxHash: string;
    executeTxHash: string;
  },
): Promise<IntegratedUpgradeResult>;
