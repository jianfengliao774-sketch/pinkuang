import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { prepareFreshCutover } from './prepare-fresh-cutover.mjs';

const bundle=JSON.parse(readFileSync(new URL('../../public/deployment-artifacts.json',import.meta.url),'utf8'));
const addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`);
const hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
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
function fixture() {
  const {sourceCommit:_source,...body}=bundle;
  const addresses=Object.fromEntries(names.map((name,index)=>[name,addr(index+1)]));
  addresses.portfolioVaultImplementation=addresses.BudgetPortfolioVault;
  addresses.portfolioFactoryImplementation=addresses.BudgetPortfolioFactory;
  const code=Object.fromEntries(names.map(name=>[name,{address:addresses[name],codehash:hash(99)}]));
  const account=addr(90), gasWallet=addr(91);
  const record={schemaVersion:1,kind:'integrated-v2',chainId:56,status:'complete',id:'fresh-test',account,
    input:{governanceMode:'single',ownerMultisig:account,operator:account,treasury:account},addresses,
    artifactDigest:keccak256(toUtf8Bytes(JSON.stringify(canonical(body)))),
    steps:steps.map((id,index)=>({id,status:'confirmed',txHash:hash(index+1),
      receipt:{status:1,blockNumber:100+index,blockHash:hash(100+index)}})),
    verification:{checks:[{passed:true}],code}};
  const activation={schemaVersion:1,kind:'fresh-authority',chainId:56,deploymentId:record.id,
    genesisArtifactDigest:record.artifactDigest,verifiedAt:new Date().toISOString(),
    authority:{address:addr(92),deploymentTxHash:hash(200),
      administratorOne:'0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',
      administratorTwo:'0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb',gasWallet},
    steps:activationNames.map((id,index)=>({id,txHash:hash(200+index),blockNumber:200+index,
      blockHash:hash(300+index)}))};
  const manifest={schemaVersion:1,kind:'integrated-v2',chainId:56,
    artifactDigest:record.artifactDigest,
    deployment:{txHash:hash(16),blockNumber:115,blockHash:hash(115)},verifiedBlockNumber:120,
    authority:activation.authority.address,gasWallet,
    freshAuthority:{...activation.authority,codehash:hash(96)},
    codehash:Object.fromEntries(Object.entries(manifestNames).map(([key])=>[key,hash(99)])),
    ...Object.fromEntries(Object.entries(manifestNames).map(([key,name])=>[key,addresses[name]]))};
  return {record,bundle,activation,manifest,expectedGasWallet:gasWallet,
    runtimeReleaseId:'v3-test-runtime',productReleaseId:'v3-test-product',
    keeperStateRoot:'/var/lib/pinkuang-shared-keeper',
    rpcUrl:'https://bsc-dataseed.bnbchain.org',logsRpcUrl:'https://bsc-dataseed.bnbchain.org'};
}

test('offline v3 draft contains only new graph and remains disabled pending live proof',()=>{
  const result=prepareFreshCutover(fixture());
  assert.equal(result.activationAllowed,false);
  assert.deepEqual([result.oldSite,result.newSite],['/bemine-v2/','/bemine-v3/']);
  assert.equal(result.runtimeEnvironment.BEMINE_LEGACY_FACTORY,'0x2995B10d19056c8C24C57b281C22562a603C571F');
  assert.equal(result.runtimeEnvironment.PORT,'4175');
  assert.equal(result.indexEnvironment.CHAIN_INDEX_PORT,'4182');
  assert.equal(result.indexEnvironment.CHAIN_INDEX_FACTORY,fixture().record.addresses.factory);
  assert.doesNotMatch(result.runtimeUnit,/LoadCredential|KEEPER_PRIVATE_KEY|keeper-v3\.key/);
  assert.equal(result.runtimeEnvironment.AUTHORITY_RELAY_JOURNAL,
    '/var/lib/pinkuang-v3/authority/authority.json');
  assert.match(result.runtimeUnit,/StateDirectoryMode=0700/);
  assert.equal(result.runtimeEnvironment.AUTHORITY_RELAY_ENABLED,'0');
  assert.equal(result.purchaseEnvironment.FRESH_PURCHASE_ENABLED,'0');
  assert.match(result.purchaseUnit,/--fresh-graph\n/);
  assert.doesNotMatch(result.purchaseUnit,/--send|LoadCredential|KEEPER_PRIVATE_KEY|keeper-v3\.key/);
  assert.match(result.purchaseUnit,/ReadWritePaths=\/var\/lib\/pinkuang-v3 \/var\/lib\/pinkuang-shared-keeper/);
});

test('offline v3 draft rejects wrong graph, truncated Gas address and mismatched manifest',()=>{
  const f=fixture();
  assert.throws(()=>prepareFreshCutover({...f,expectedGasWallet:f.expectedGasWallet.slice(0,-1)}),/40-hex/);
  assert.throws(()=>prepareFreshCutover({...f,expectedGasWallet:addr(93)}),/seven ordered transactions/);
  assert.throws(()=>prepareFreshCutover({...f,keeperStateRoot:'/tmp/keeper'}),/shared \/var\/lib/);
  assert.throws(()=>prepareFreshCutover({...f,manifest:{...f.manifest,factory:addr(94)}}),/Manifest factory/);
  assert.throws(()=>prepareFreshCutover({...f,record:{...f.record,addresses:{...f.record.addresses,
    factory:'0x2995B10d19056c8C24C57b281C22562a603C571F'}}}),/trusted code evidence|separate/);
});
