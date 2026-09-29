import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { prepareFreshCutover } from './prepare-fresh-cutover.mjs';
import { ORIGINAL_GAS_WALLET } from '../../shared/original-gas-wallet.mjs';

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
    runtimeReleaseId:'v4-test-runtime',productReleaseId:'v4-test-product',
    keeperStateRoot:'/var/lib/pinkuang-v4-signer/keeper',
    rpcUrl:'https://bsc-dataseed.bnbchain.org',logsRpcUrl:'https://bsc-dataseed.bnbchain.org'};
}

test('offline v4 draft contains only new graph and remains disabled pending live proof',()=>{
  const result=prepareFreshCutover(fixture());
  assert.equal(result.activationAllowed,false);
  assert.deepEqual([result.oldSite,result.newSite],['/bemine-v2/','/bemine-v4/']);
  assert.equal(result.runtimeEnvironment.BEMINE_LEGACY_FACTORY,undefined);
  assert.equal(result.runtimeEnvironment.PORT,'4177');
  assert.equal(result.indexEnvironment.CHAIN_INDEX_PORT,'4184');
  assert.equal(result.indexEnvironment.CHAIN_INDEX_RESERVATION_MODE,'required');
  assert.equal(result.indexEnvironment.CHAIN_INDEX_FACTORY,fixture().record.addresses.factory);
  assert.doesNotMatch(result.runtimeUnit,/LoadCredential|KEEPER_PRIVATE_KEY/);
  assert.equal(result.runtimeEnvironment.AUTHORITY_RELAY_JOURNAL,undefined);
  assert.equal(result.signerEnvironment.AUTHORITY_RELAY_JOURNAL,
    '/var/lib/pinkuang-v4-signer/authority/authority.json');
  assert.match(result.runtimeUnit,/StateDirectoryMode=0700/);
  assert.equal(result.runtimeEnvironment.AUTHORITY_RELAY_ENABLED,'0');
  assert.equal(result.runtimeEnvironment.PINKUANG_KEEPER_STATE_ROOT,undefined);
  assert.match(result.runtimeRelayDropIn,/LoadCredential=authority-ipc-hmac:/);
  assert.doesNotMatch(result.runtimeRelayDropIn,/keeper-private-key/);
  assert.match(result.signerUnit,/User=pinkuang-v4-signer/);
  assert.match(result.signerUnit,/Group=pinkuang-v4-relay/);
  assert.match(result.signerUnit,/RuntimeDirectoryMode=0750/);
  assert.match(result.signerUnit,/LoadCredential=keeper-private-key:.*authority-gas\.key/);
  assert.equal(result.signerEnvironment.AUTHORITY_RELAY_ENABLED,'0');
  assert.equal(result.purchaseEnvironment.FRESH_PURCHASE_ENABLED,'0');
  assert.match(result.purchaseUnit,/--fresh-graph --send/);
  assert.match(result.purchaseUnit,/LoadCredential=keeper-private-key:.*authority-gas\.key/);
  assert.match(result.nginxSnippet,/location \^~ \/bemine-v4\/firsto-api\/ \{[^}]*proxy_set_header X-Real-IP \$remote_addr;/);
  assert.match(result.purchaseUnit,/ReadWritePaths=\/var\/lib\/pinkuang-v4-signer/);
});

test('offline v4 draft accepts the selected original Gas address but keeps both senders disabled',()=>{
  const f=fixture();
  const activation={...f.activation,authority:{...f.activation.authority,gasWallet:ORIGINAL_GAS_WALLET}};
  const manifest={...f.manifest,gasWallet:ORIGINAL_GAS_WALLET,
    freshAuthority:{...f.manifest.freshAuthority,gasWallet:ORIGINAL_GAS_WALLET}};
  const result=prepareFreshCutover({...f,activation,manifest,expectedGasWallet:ORIGINAL_GAS_WALLET});
  assert.equal(result.activationAllowed,false);
  assert.equal(result.signerEnvironment.AUTHORITY_RELAY_ENABLED,'0');
  assert.equal(result.signerEnvironment.BEMINE_V2_GAS_SENDER_DRAINED,'0');
  assert.equal(result.purchaseEnvironment.FRESH_PURCHASE_ENABLED,'0');
  assert.equal(result.purchaseEnvironment.BEMINE_V2_GAS_SENDER_DRAINED,'0');
  assert.match(result.signerUnit,/LoadCredential=keeper-private-key:\/etc\/pinkuang\/keeper\.key/);
  assert.match(result.purchaseUnit,/LoadCredential=keeper-private-key:\/etc\/pinkuang\/keeper\.key/);
  assert.ok(result.missingLiveProofs.some(proof=>proof.includes('pending nonce')));
});

test('offline v4 draft rejects wrong graph, truncated Gas address and mismatched manifest',()=>{
  const f=fixture();
  assert.throws(()=>prepareFreshCutover({...f,expectedGasWallet:f.expectedGasWallet.slice(0,-1)}),/40-hex/);
  assert.throws(()=>prepareFreshCutover({...f,expectedGasWallet:addr(93)}),/seven ordered transactions/);
  assert.throws(()=>prepareFreshCutover({...f,keeperStateRoot:'/tmp/keeper'}),/dedicated private nonce state root/);
  assert.throws(()=>prepareFreshCutover({...f,manifest:{...f.manifest,factory:addr(94)}}),/Manifest factory/);
  assert.throws(()=>prepareFreshCutover({...f,record:{...f.record,addresses:{...f.record.addresses,
    factory:f.record.addresses.portfolioFactory}}}),/trusted code evidence|separate/);
});
