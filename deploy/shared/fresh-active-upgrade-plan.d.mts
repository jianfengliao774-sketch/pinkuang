export declare const FRESH_ACTIVE_UPGRADE_KIND: 'fresh-v5-active-security-upgrade-v1';
export declare const freshUpgradeDeploymentOrder: readonly ['PoolFunds','FlexiblePurchase','SaleSettlement',
  'SaleGovernance','FirstoSale','PoolVault','FreshPoolFactory','ShareMarket','BudgetPortfolioVault','BudgetPortfolioFactory'];
export type FreshReplacementName = typeof freshUpgradeDeploymentOrder[number];
export type FreshReplacements = Record<FreshReplacementName,string>;
export interface FreshUpgradeInputs {
  genesisRecord: any; genesisBundle: any; trustedGenesisManifest: any;
  upgradeBundle: any; trustedUpgradeArtifactDigest: string;
}
export interface FreshActiveAuthority {
  address: string; codehash: string; administratorOne: string; administratorTwo: string; gasWallet: string;
}
export interface FreshActiveGraphProof {
  blockNumber: number; blockHash: string; checkedAt: string;
  checks: Array<{label:string;passed:true}>;
  authority: FreshActiveAuthority; proposer: string; minDelay: string;
  creationPaused: {core:boolean;budget:boolean};
  registry: {initialized:true;ready:true;cursor:string;cutoff:string};
  poolCount: string; portfolioCount: string;
  historical: Array<{kind:'pool'|'portfolio';index:number;address:string;treasury:string}>;
}
export interface FreshActiveUpgradePlan {
  kind: typeof FRESH_ACTIVE_UPGRADE_KIND;
  genesisRecordDigest: string; genesisArtifactDigest: string; upgradeArtifactDigest: string;
  authority: FreshActiveAuthority; proposer: string; replacements: FreshReplacements;
  predecessor: string; salt: string; delaySeconds: number;
  steps: Array<{name:string;target:string;implementation:string|null;data:string;value:'0'}>;
  targets: string[]; values: string[]; payloads: string[]; operationId: string;
  scheduleData: string; executeData: string; creationRemainsPaused: true;
}
export interface FreshActiveUpgradeProof extends FreshActiveGraphProof {
  phase:'unscheduled'|'scheduled'|'done'; operationId:string; readyAt:string;
  codeUpgradeComplete:boolean; creationRemainsPaused:boolean;
}
export declare function freshUpgradeDeploymentData(name:FreshReplacementName,bundle:any,addresses:Record<string,string>):string;
export declare function buildFreshActiveUpgradePlan(input:FreshUpgradeInputs & {
  replacements:FreshReplacements;salt:string;delaySeconds:number;
}):FreshActiveUpgradePlan;
export declare function validateFreshActiveGraphAgainstChain(provider:any,input:FreshUpgradeInputs & {
  signer?:string;
}):Promise<FreshActiveGraphProof>;
export declare function validateFreshActiveReplacementsAgainstChain(provider:any,input:FreshUpgradeInputs & {
  deployments:Partial<FreshReplacements>;signer?:string;
}):Promise<FreshActiveGraphProof & {replacements:Partial<FreshReplacements>}>;
export declare function validateFreshActiveUpgradeAgainstChain(provider:any,plan:FreshActiveUpgradePlan,input:FreshUpgradeInputs & {
  proposer:string;phase:'unscheduled'|'scheduled'|'done';preExecutionPreflight?:FreshActiveGraphProof;
}):Promise<FreshActiveUpgradeProof>;
