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
  creationPaused?: {core: boolean; budget: boolean};
}
export declare function validateIntegratedUpgradePreparationAgainstChain(
  provider: any,
  input: {genesisRecord: any; genesisBundle: any; trustedGenesisManifest: any;
    signer: string; nextPause: 'core' | 'budget'},
): Promise<IntegratedGenesisPreflight & {signer: string; target: string; data: string;
  creationPaused: {core: boolean; budget: boolean}} >;
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
    bootstrapPlan: IntegratedProposerBootstrapPlan;
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
    bootstrapPlan: IntegratedProposerBootstrapPlan;
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
export interface IntegratedTreasuryMigrationOperation {
  target: string;
  expectedOld: string;
  next: string;
  data: string;
  value: '0';
  predecessor: string;
  salt: string;
  delaySeconds: number;
  operationId: string;
  scheduleData: string;
  executeData: string;
}
export interface IntegratedTreasuryMigrationPlan {
  kind: 'integrated-v2-historical-treasury-migration-v1';
  codeResultDigest: string;
  codeUpgradeOperationId: string;
  authorityAddress: string;
  timelock: string;
  saltSeed: string;
  delaySeconds: number;
  operations: IntegratedTreasuryMigrationOperation[];
  roleMigrationComplete: false;
  historicalBnbAndBemOwedRemainWithOldTreasury: true;
}
/** One independent Timelock schedule/execute pair per existing core pool. */
export declare function buildIntegratedTreasuryMigrationPlan(input: {
  genesisRecord: any;
  codeResult: IntegratedUpgradeResult;
  authorityAddress: string;
  saltSeed: string;
  delaySeconds: number;
}): IntegratedTreasuryMigrationPlan;

export interface IntegratedProposerBootstrapPlan {
  kind: 'integrated-v2-proposer-bootstrap-v1';
  timelock: string; oldProposer: string; hardwareWallet: string;
  targets: string[]; values: string[]; payloads: string[]; predecessor: string;
  salt: string; delaySeconds: number; operationId: string;
  scheduleData: string; executeData: string;
}
export declare function buildIntegratedProposerBootstrapPlan(input: {
  genesisRecord: any; genesisBundle: any; trustedGenesisManifest: any;
  hardwareWallet: string; salt: string; delaySeconds: number;
}): IntegratedProposerBootstrapPlan;
export declare function validateIntegratedProposerBootstrapAgainstChain(provider: any,
  plan: IntegratedProposerBootstrapPlan,
  input: {genesisRecord: any; genesisBundle: any; trustedGenesisManifest: any;
    phase: 'unscheduled' | 'ready' | 'done'; signer?: string},
): Promise<IntegratedGenesisPreflight & {phase: 'unscheduled' | 'ready' | 'done';
  operationId: string; readyAt: string; hardwareWallet: string;
  proposerBootstrapped: boolean; oldProposerRetained: true}>;

export interface IntegratedPostCodeGraph extends IntegratedGenesisPreflight {
  codeUpgradeComplete: true; roleMigrationComplete: false; operationId: string;
}
export declare function validateIntegratedPostCodeGraphAgainstChain(provider: any,
  codePlan: IntegratedUpgradePlan,
  input: {genesisRecord: any; genesisBundle: any; trustedGenesisManifest: any;
    upgradeBundle: any; trustedUpgradeArtifactDigest: string},
): Promise<IntegratedPostCodeGraph>;
export declare function integratedAuthorityDeploymentData(input: {
  genesisRecord: any; genesisBundle: any; trustedGenesisManifest: any;
  upgradeBundle: any; trustedUpgradeArtifactDigest: string;
  administratorOne: string; administratorTwo: string; gasWallet: string;
}): string;
export interface IntegratedAuthorityProof extends IntegratedPostCodeGraph {
  authorityAddress: string; authorityCodehash: string; deploymentTxHash: string;
  administratorOne: string; administratorTwo: string; gasWallet: string;
}
export declare function validateIntegratedAuthorityAgainstChain(provider: any,input: {
  codePlan: IntegratedUpgradePlan;
  genesisRecord: any; genesisBundle: any; trustedGenesisManifest: any;
  upgradeBundle: any; trustedUpgradeArtifactDigest: string;
  authorityAddress: string; deploymentTxHash: string;
  administratorOne: string; administratorTwo: string; gasWallet: string;
}): Promise<IntegratedAuthorityProof>;

export interface IntegratedRoleMigrationPlan {
  kind: 'integrated-v2-role-migration-v1';
  codeUpgradeOperationId: string; bootstrapOperationId: string;
  authorityAddress: string; hardwareWallet: string; oldOwner: string; timelock: string;
  delaySeconds: number; salt: string;
  directSteps: Array<{name: string; index: number; target: string; signer: string;
    method: string; next: string; data: string; value: '0'; after: string}>;
  roleBatch: {targets: string[]; values: string[]; payloads: string[];
    predecessor: string; salt: string; operationId: string; delaySeconds: number;
    scheduleData: string; executeData: string};
  historicalTreasuryComplete: false; roleMigrationComplete: false;
}
export declare function buildIntegratedRoleMigrationPlan(input: {
  genesisRecord: any; codePlan: IntegratedUpgradePlan;
  bootstrapPlan: IntegratedProposerBootstrapPlan;
  authorityAddress: string; hardwareWallet: string; salt: string; delaySeconds: number;
}): IntegratedRoleMigrationPlan;
export interface IntegratedRoleState extends IntegratedAuthorityProof {
  applied: boolean[];
  current: {coreOwner: string; coreOperator: string; coreTreasury: string;
    budgetOwner: string; budgetOperator: string; budgetTreasury: string};
  roles: Record<string,boolean>; executorOpen: boolean;
  status: 'unscheduled' | 'waiting' | 'ready' | 'done';
  readyAt: string; nextDirectStep: number; roleWiringComplete: boolean;
  roleOperationId: string; historicalTreasuryComplete: false; roleMigrationComplete: false;
}
export interface IntegratedRoleProofInput {
  codePlan: IntegratedUpgradePlan; bootstrapPlan: IntegratedProposerBootstrapPlan;
  genesisRecord: any; genesisBundle: any; trustedGenesisManifest: any;
  upgradeBundle: any; trustedUpgradeArtifactDigest: string;
  authorityAddress: string; deploymentTxHash: string;
  administratorOne: string; administratorTwo: string; gasWallet: string;
}
export declare function validateIntegratedRoleMigrationStateAgainstChain(provider: any,
  rolePlan: IntegratedRoleMigrationPlan,input: IntegratedRoleProofInput,
): Promise<IntegratedRoleState>;
export declare function validateIntegratedRoleMigrationActionAgainstChain(provider: any,
  rolePlan: IntegratedRoleMigrationPlan,input: IntegratedRoleProofInput & {
    action: {type: 'direct'; index: number} | {type: 'schedule' | 'execute'}; signer: string},
): Promise<IntegratedRoleState & {authorizedSigner: string; action: any;
  calldata: string; target: string}>;

export interface IntegratedTreasuryActionInput extends IntegratedRoleProofInput {
  rolePlan: IntegratedRoleMigrationPlan;
  codeResult: IntegratedUpgradeResult;
  operationIndex: number;
  phase: 'unscheduled' | 'ready'; signer: string;
}
export declare function validateIntegratedTreasuryMigrationActionAgainstChain(provider: any,
  migrationPlan: IntegratedTreasuryMigrationPlan,input: IntegratedTreasuryActionInput,
): Promise<IntegratedRoleState & {phase: 'unscheduled' | 'ready'; operationIndex: number;
  operationId: string; target: string; expectedOld: string; next: string;
  currentState: number; strictHarvestRequired: boolean; oldBnbOwed: string;
  oldBemOwed: string; readyAt: string; calldata: string; transactionTarget: string}>;
export declare function validateIntegratedTreasuryMigrationResultAgainstChain(provider: any,
  migrationPlan: IntegratedTreasuryMigrationPlan,
  input: Omit<IntegratedTreasuryActionInput,'phase'|'signer'> & {
    preExecutionPreflight: Awaited<ReturnType<typeof validateIntegratedTreasuryMigrationActionAgainstChain>>;
    scheduleTxHash: string; executeTxHash: string},
): Promise<IntegratedRoleState & {phase: 'done'; operationIndex: number;
  operationId: string; target: string; oldAccruedFeesRemainWithOldTreasury: true}>;
export declare function validateIntegratedOnChainMigrationCompleteAgainstChain(provider: any,
  migrationPlan: IntegratedTreasuryMigrationPlan,
  input: IntegratedRoleProofInput & {rolePlan: IntegratedRoleMigrationPlan;
    codeResult: IntegratedUpgradeResult},
): Promise<IntegratedRoleState & {historicalTreasuryComplete: true;
  roleMigrationComplete: true; onChainMigrationComplete: true;
  keeperCutoverVerified: false; deploymentComplete: false;
  previousAccruedFeesAreNotRedirected: true}>;

export interface IntegratedCreationResumePlan {
  kind: 'integrated-v2-resume-creation-v1';
  timelock: string; hardwareWallet: string;
  rolePlanDigest: string; migrationPlanDigest: string;
  targets: string[]; values: string[]; payloads: string[];
  predecessor: string; salt: string; delaySeconds: number; operationId: string;
  scheduleData: string; executeData: string;
  keeperCutoverVerified: false; deploymentComplete: false;
}
export declare function buildIntegratedCreationResumePlan(input: {
  genesisRecord: any; rolePlan: IntegratedRoleMigrationPlan;
  migrationPlan: IntegratedTreasuryMigrationPlan; salt: string; delaySeconds: number;
}): IntegratedCreationResumePlan;
export declare function validateIntegratedCreationResumeActionAgainstChain(provider: any,
  resumePlan: IntegratedCreationResumePlan,
  input: IntegratedRoleProofInput & {rolePlan: IntegratedRoleMigrationPlan;
    migrationPlan: IntegratedTreasuryMigrationPlan;
    codeResult: IntegratedUpgradeResult;
    phase: 'unscheduled' | 'ready'; signer: string},
): Promise<Awaited<ReturnType<typeof validateIntegratedOnChainMigrationCompleteAgainstChain>> & {
  phase: 'unscheduled' | 'ready'; operationId: string;
  readyAt: string; transactionTarget: string; calldata: string;
  keeperCutoverVerified: false; deploymentComplete: false; operationalGate: string}>;
export declare function validateIntegratedCreationResumeResultAgainstChain(provider: any,
  resumePlan: IntegratedCreationResumePlan,
  input: IntegratedRoleProofInput & {rolePlan: IntegratedRoleMigrationPlan;
    migrationPlan: IntegratedTreasuryMigrationPlan; codeResult: IntegratedUpgradeResult;
    scheduleTxHash: string; executeTxHash: string},
): Promise<Omit<IntegratedAuthorityProof,'roleMigrationComplete'> & {operationId: string; scheduleTxHash: string;
  executeTxHash: string; codeUpgradeComplete: true; roleMigrationComplete: true;
  historicalTreasuryComplete: true; bothFactoriesUnpaused: true;
  keeperCutoverVerified: false; deploymentComplete: false}>;
