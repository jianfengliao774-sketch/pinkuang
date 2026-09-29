import { readFileSync } from 'node:fs';
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { FRESH_ADMIN_ONE, FRESH_ADMIN_TWO, FRESH_DEPLOYER, FRESH_GAS_WALLET } from '../../shared/fresh-roles.mjs';

const bundle=JSON.parse(readFileSync(new URL('../../public/deployment-artifacts.json',import.meta.url),'utf8'));
export const addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`);
export const hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const names=['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation','RewardAccounting',
  'SaleGovernance','SaleSettlement','ShareCheckpoints','FirstoSale','AtomicDeployment','PoolVault',
  'FreshPoolFactory','ShareMarket','BudgetPortfolioFactory','BudgetPortfolioVault',
  'factory','shareMarket','lens','beacon','timelock','portfolioFactory','portfolioShareMarket','portfolioBeacon'];
const manifestNames={factory:'factory',shareMarket:'shareMarket',lens:'lens',beacon:'beacon',timelock:'timelock',
  portfolioFactory:'portfolioFactory',portfolioMarket:'portfolioShareMarket',portfolioBeacon:'portfolioBeacon',
  portfolioImplementation:'BudgetPortfolioVault',portfolioFactoryImplementation:'BudgetPortfolioFactory'};
const steps=['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation','RewardAccounting',
  'SaleGovernance','SaleSettlement','ShareCheckpoints','FirstoSale','AtomicDeployment','PoolVault',
  'FreshPoolFactory','ShareMarket','BudgetPortfolioFactory','BudgetPortfolioVault','initialize'];
const activationNames=['deployAuthority','coreOperator','coreTreasury','budgetOperator','budgetTreasury','coreOwner','budgetOwner'];

export function fixture() {
  const {sourceCommit:_source,...body}=bundle;
  const addresses=Object.fromEntries(names.map((name,index)=>[name,addr(index+1)]));
  addresses.portfolioVaultImplementation=addresses.BudgetPortfolioVault;
  addresses.portfolioFactoryImplementation=addresses.BudgetPortfolioFactory;
  const code=Object.fromEntries(names.map(name=>[name,{address:addresses[name],codehash:hash(99)}]));
  const account=FRESH_DEPLOYER, gasWallet=FRESH_GAS_WALLET;
  const record={schemaVersion:1,kind:'integrated-v2',chainId:56,status:'complete',id:'fresh-test',account,
    sourceCommit:bundle.sourceCommit,
    input:{governanceMode:'single',ownerMultisig:account,operator:account,treasury:account},addresses,
    artifactDigest:keccak256(toUtf8Bytes(JSON.stringify(canonical(body)))),
    steps:steps.map((id,index)=>({id,status:'confirmed',txHash:hash(index+1),
      receipt:{status:1,blockNumber:100+index,blockHash:hash(100+index)}})),
    verification:{checks:[{passed:true}],code}};
  const activation={schemaVersion:1,kind:'fresh-authority',chainId:56,deploymentId:record.id,
    deployer:account,
    genesisArtifactDigest:record.artifactDigest,verifiedAt:new Date().toISOString(),
    authority:{address:addr(92),deploymentTxHash:hash(200),
      administratorOne:FRESH_ADMIN_ONE,
      administratorTwo:FRESH_ADMIN_TWO,gasWallet},
    steps:activationNames.map((id,index)=>({id,txHash:hash(200+index),blockNumber:200+index,
      blockHash:hash(300+index)}))};
  const manifest={schemaVersion:1,kind:'integrated-v2',chainId:56,
    artifactDigest:record.artifactDigest,sourceCommit:record.sourceCommit,
    verifiedAt:'2026-09-29T00:00:00.000Z',
    deployment:{txHash:hash(16),blockNumber:115,blockHash:hash(115)},
    verifiedBlockNumber:206,verifiedBlockHash:hash(306),
    authority:activation.authority.address,gasWallet,
    freshAuthority:{...activation.authority,codehash:hash(96)},
    codehash:Object.fromEntries(Object.entries(manifestNames).map(([key])=>[key,hash(99)])),
    ...Object.fromEntries(Object.entries(manifestNames).map(([key,name])=>[key,addresses[name]]))};
  return {record,bundle,activation,manifest,expectedGasWallet:gasWallet,
    runtimeReleaseId:'v4-test-runtime',productReleaseId:'v4-test-product',
    keeperStateRoot:'/var/lib/pinkuang-v4-signer/keeper',
    rpcUrl:'https://bsc-dataseed.bnbchain.org',logsRpcUrl:'https://bsc-dataseed.bnbchain.org'};
}
