import test from 'node:test';
import assert from 'node:assert/strict';
import {AbiCoder,Interface,ZeroHash,keccak256,toUtf8Bytes} from 'ethers';
import {createTargetOwnerFixture} from '../shared/target-owner-upgrade-test-fixture.mjs';
import {evidenceDigest} from '../shared/firsto-upgrade-proof.mjs';
import {productGraphConfiguration,verifyProductGraph} from './product-graph.mjs';

const hash=value=>keccak256(toUtf8Bytes(value));
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();

function fixture(phase='done',splitMarkets=false){
  const f=createTargetOwnerFixture({phase,splitMarkets}),input=f.input,record=input.genesisRecord,bundle=input.genesisBundle;
  const a=record.addresses,authority=input.reviewCatalog.authority;
  // Actual artifact shape is sufficient here; pinned views below bind every
  // constructor immutable independently, as the real verifier requires.
  const authorityCode=bundle.artifacts.PlatformAuthority.deployedBytecode;
  f.codes.set(authority.address.toLowerCase(),authorityCode);
  authority.codehash=keccak256(authorityCode);
  input.trustedGenesisManifest.freshAuthority.codehash=authority.codehash;
  input.trustedGenesisManifestDigest=evidenceDigest(input.trustedGenesisManifest);
  input.reviewCatalog.genesisManifestDigest=input.trustedGenesisManifestDigest;
  input.trustedReviewCatalogDigest=evidenceDigest(input.reviewCatalog);
  f.finalCatalog.reviewCatalogDigest=input.trustedReviewCatalogDigest;
  const authorityAbi=new Interface(bundle.artifacts.PlatformAuthority.abi),core=new Interface(bundle.artifacts.FreshPoolFactory.abi),budget=new Interface(bundle.artifacts.BudgetPortfolioFactory.abi);
  const data=[bundle.artifacts.PlatformAuthority.bytecode+AbiCoder.defaultAbiCoder().encode(
    ['address','address','address','address','address'],[a.factory,a.portfolioFactory,authority.administratorOne,authority.administratorTwo,authority.gasWallet]).slice(2),
    core.encodeFunctionData('setOperator',[authority.address]),core.encodeFunctionData('setTreasury',[authority.address]),
    budget.encodeFunctionData('setOperator',[authority.address]),budget.encodeFunctionData('setTreasury',[authority.address]),
    core.encodeFunctionData('transferOwnership',[a.timelock]),budget.encodeFunctionData('transferOwnership',[a.timelock])];
  const ids=['deployAuthority','coreOperator','coreTreasury','budgetOperator','budgetTreasury','coreOwner','budgetOwner'];
  const to=[null,a.factory,a.factory,a.portfolioFactory,a.portfolioFactory,a.factory,a.portfolioFactory];
  const steps=ids.map((id,index)=>{
    const txHash=hash('activation-'+id),blockNumber=100+index,blockHash=hash('activation-block-'+index);
    f.blocks.set(blockNumber,{number:blockNumber,hash:blockHash,timestamp:1000+index,transactions:[txHash]});
    f.transactions.set(txHash,{hash:txHash,from:record.account,to:to[index],data:data[index],value:0n,nonce:index,index:0,chainId:56n});
    f.receipts.set(txHash,{hash:txHash,status:1,blockNumber,blockHash,contractAddress:index===0?authority.address:null});
    return {id,txHash,blockNumber,blockHash};
  });
  authority.deploymentTxHash=steps[0].txHash;
  input.trustedGenesisManifest.freshAuthority.deploymentTxHash=steps[0].txHash;
  input.trustedGenesisManifestDigest=evidenceDigest(input.trustedGenesisManifest);
  input.reviewCatalog.genesisManifestDigest=input.trustedGenesisManifestDigest;
  input.trustedReviewCatalogDigest=evidenceDigest(input.reviewCatalog);
  f.finalCatalog.reviewCatalogDigest=input.trustedReviewCatalogDigest;
  const activation={schemaVersion:1,kind:'fresh-authority',chainId:56,deploymentId:record.id,
    genesisArtifactDigest:record.artifactDigest,verifiedAt:new Date(0).toISOString(),authority:{...authority},steps};
  const originalSend=f.provider.send;
  f.provider.send=async(method,args)=>{
    if(method!=='eth_call')return originalSend(method,args);
    const tx=args[0],name=Object.keys(input.reviewCatalog.nodes).find(key=>same(input.reviewCatalog.nodes[key].address,tx.to));
    const artifact= same(tx.to,authority.address)?bundle.artifacts.PlatformAuthority
      :same(tx.to,f.replacements.PoolVault)?input.upgradeBundle.artifacts.PoolVault
        :input.reviewCatalog.nodes[({factory:'FreshPoolFactory',shareMarket:'ShareMarket',portfolioFactory:'BudgetPortfolioFactory',portfolioShareMarket:'ShareMarket'})[name]??name]?.artifact;
    const iface=new Interface(artifact.abi),parsed=iface.parseTransaction({data:tx.data});
    const methodName=parsed.name;
    if(methodName==='eip712Domain')return authorityAbi.encodeFunctionResult(methodName,['0x0f','BEMine Platform Authority','1',56n,authority.address,ZeroHash,[]]);
    const values={deployed:true,deployer:record.account,predictedFactory:a.factory,predictedPortfolioFactory:a.portfolioFactory,
      VERSION:1n,feeBps:100n,buyerFeeBps:100n,MINIMUM_DELAY:172800n,legacyFactory:a.factory,
      beacon:name==='portfolioFactory'?a.portfolioBeacon:a.beacon,shareMarket:name==='portfolioFactory'?a.portfolioShareMarket:a.shareMarket,
      PROPOSER_ROLE:hash('PROPOSER_ROLE'),CANCELLER_ROLE:hash('CANCELLER_ROLE'),EXECUTOR_ROLE:hash('EXECUTOR_ROLE'),DEFAULT_ADMIN_ROLE:ZeroHash};
    if(methodName==='hasRole'){
      const [role,account]=parsed.args;
      const value=role===hash('PROPOSER_ROLE')||role===hash('CANCELLER_ROLE')?same(account,record.input.ownerMultisig)
        :role===hash('EXECUTOR_ROLE')?same(account,'0x'+'0'.repeat(40)):same(account,a.timelock);
      return iface.encodeFunctionResult(methodName,[value]);
    }
    if(methodName==='OFFICIAL_FACTORY'&&name==='BudgetPortfolioVault')return iface.encodeFunctionResult(methodName,[a.portfolioFactory]);
    if(methodName==='factory'&&name==='portfolioShareMarket')return iface.encodeFunctionResult(methodName,[a.portfolioFactory]);
    if(Object.hasOwn(values,methodName))return iface.encodeFunctionResult(methodName,[values[methodName]]);
    return originalSend(method,args);
  };
  const config={record,bundle,productActivation:activation,expectedGasWallet:authority.gasWallet,
    genesisManifest:input.trustedGenesisManifest,targetOwnerCatalog:f.finalCatalog,targetOwnerArtifact:input.upgradeBundle,
    trustedTargetOwnerCatalogDigest:evidenceDigest(f.finalCatalog),trustedTargetOwnerArtifactDigest:input.trustedUpgradeArtifactDigest};
  return {...f,config,trusted:productGraphConfiguration(config)};
}

test('activated target-owner graph accepts exact new three while old FirstoSale retains original Funds',async()=>{
  const f=fixture();
  const proof=await verifyProductGraph(f.provider,f.input.genesisRecord.addresses.factory,f.trusted,f.blocks.get(400));
  assert.equal(proof.targetOwnerUpgrade.version,1);
  assert.equal(proof.targetOwnerUpgrade.catalogDigest,f.config.trustedTargetOwnerCatalogDigest);
  assert.equal(proof.addresses.PoolVault,f.replacements.PoolVault);
  assert.equal(proof.addresses.PoolFunds,f.replacements.PoolFunds);
  assert.equal(proof.addresses.FirstoSale,f.input.reviewCatalog.nodes.FirstoSale.address);
  assert.equal(f.input.reviewCatalog.nodes.FirstoSale.links.PoolFunds,f.input.genesisRecord.addresses.PoolFunds);
  assert.equal(proof.addresses.BudgetPortfolioVault,f.input.genesisRecord.addresses.BudgetPortfolioVault);
  assert.equal(proof.artifactDigest,f.input.genesisRecord.artifactDigest,'original asset graph identity is preserved');
  const budget=await verifyProductGraph(f.provider,f.input.genesisRecord.addresses.portfolioFactory,f.trusted,f.blocks.get(400));
  assert.equal(budget.productKind,'budget');assert.equal(budget.targetOwnerUpgrade.catalogDigest,proof.targetOwnerUpgrade.catalogDigest);
});
test('configured successor catalog does not claim capability before its Beacon operation is complete',async()=>{
  const f=fixture('unscheduled');
  const proof=await verifyProductGraph(f.provider,f.input.genesisRecord.addresses.factory,f.trusted,f.blocks.get(400));
  assert.equal(proof.targetOwnerUpgrade,undefined);
  assert.equal(proof.addresses.PoolVault,f.input.reviewCatalog.nodes.PoolVault.address);
});
test('runtime graph fails closed on old FirstoSale library contamination and independent pin mismatch',async()=>{
  const f=fixture();
  assert.throws(()=>productGraphConfiguration({...f.config,trustedTargetOwnerCatalogDigest:hash('wrongpin')}),/independent operator pin/);
  const old=f.input.reviewCatalog.nodes.FirstoSale;
  f.codes.set(old.address.toLowerCase(),f.codes.get(old.address.toLowerCase())+'00');
  await assert.rejects(verifyProductGraph(f.provider,f.input.genesisRecord.addresses.factory,f.trusted,f.blocks.get(400)),/FirstoSale/);
});
test('current graph preserves separate portfolio market implementation during a core-only successor upgrade',async()=>{
  const f=fixture('done',true);
  const graph=await verifyProductGraph(f.provider,f.input.genesisRecord.addresses.factory,f.trusted,f.blocks.get(400));
  assert.notEqual(graph.addresses.ShareMarket,graph.addresses.PortfolioShareMarketImplementation);
  assert.equal(graph.codehash.PortfolioShareMarketImplementation,f.input.reviewCatalog.nodes.PortfolioShareMarketImplementation.codehash);
  assert.equal(graph.addresses.portfolioShareMarket,f.input.genesisRecord.addresses.portfolioShareMarket);
});
test('historical upgrade proof uses finalized state and also binds every runtime at a newer signing block',async()=>{
  const f=fixture(),latest={number:401,hash:hash('block401'),timestamp:300001,transactions:[]};
  f.blocks.set(401,latest);
  const proof=await verifyProductGraph(f.provider,f.input.genesisRecord.addresses.factory,f.trusted,latest);
  assert.equal(proof.blockNumber,401);assert.equal(proof.targetOwnerUpgrade.verifiedBlockNumber,400);
  const actualGetCode=f.provider.getCode;
  f.provider.getCode=async(address,block)=>same(address,f.replacements.PoolVault)&&block===401
    ? (await actualGetCode(address,block))+'00':actualGetCode(address,block);
  await assert.rejects(verifyProductGraph(f.provider,f.input.genesisRecord.addresses.factory,f.trusted,latest),/Reviewed runtime changed: PoolVault/);
});
