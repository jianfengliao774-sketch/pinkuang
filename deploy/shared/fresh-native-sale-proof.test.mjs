import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { buildDigest } from './firsto-upgrade-proof.mjs';
import { freshSalePolicySalt, validateFreshSalePolicyCatalog, verifyFreshSalePolicy, freshSalePolicyOperation } from './fresh-sale-policy-proof.mjs';
import { nativeSaleSalt, validateFreshNativeSaleCatalog, verifyFreshNativeSale, freshNativeSaleOperation, nativeSalePolicyBaseline } from './fresh-native-sale-proof.mjs';
const addr=n=>getAddress('0x'+n.toString(16).padStart(40,'0')), hash=n=>'0x'+n.toString(16).padStart(64,'0');
const block={number:100,hash:hash(100)};
const abi=new Interface(['function implementation() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function saleReviewThresholdBps() view returns(uint16)', 'function automaticSaleReferenceVersion() view returns(uint8)',
  'function saleReferencePublisher() view returns(address)', 'function nativeFirstoSaleVersion() view returns(uint8)',
  'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)', 'function isOperationDone(bytes32) view returns(bool)']);
function fixture() {
  const oldCatalog=JSON.parse(readFileSync(new URL('../../web/public/data/sale-policy-upgrade.full-test.json',import.meta.url)));
  const oldBundle={sourceCommit:'a'.repeat(40),artifacts:oldCatalog.artifacts};
  oldCatalog.candidateArtifactDigest=buildDigest(oldBundle);oldCatalog.salt=freshSalePolicySalt(oldCatalog.bindings.factory,oldCatalog.candidateArtifactDigest);
  const a={...oldCatalog.bindings,...oldCatalog.libraries,...oldCatalog.expectedImplementations};
  const trusted={record:{addresses:a,artifactDigest:oldCatalog.genesisArtifactDigest,input:{ownerMultisig:a.proposer}},
    bundle:{artifacts:{FreshPoolFactory:{}}},freshAuthority:{authority:{address:a.authority,gasWallet:a.gasWallet}}};
  trusted.freshSalePolicy=validateFreshSalePolicyCatalog(oldCatalog,oldBundle,trusted);
  const policy={SaleGovernance:addr(91),PoolVault:addr(92),BudgetPortfolioVault:addr(93),ShareMarket:addr(94)};
  const newAddresses={SaleSettlement:addr(191),FirstoSale:addr(192),PoolVault:addr(193)};
  const artifact=(name,links=[])=>({contractName:name,abi:[],bytecode:'0x6000',deployedBytecode:'0x'+
    (name==='PoolVault'?'60':'73'+'0'.repeat(40))+links.map(()=> '0'.repeat(40)).join('')+'6000',
    deployedLinkReferences:{'src/libraries.sol':Object.fromEntries(links.map((key,i)=>[key,[{start:(name==='PoolVault'?1:21)+i*20,length:20}]]))}});
  const bundle={artifacts:{SaleSettlement:artifact('SaleSettlement'),FirstoSale:artifact('FirstoSale',['SaleSettlement']),
    PoolVault:artifact('PoolVault',['SaleSettlement','FirstoSale','SaleGovernance'])}};
  const libraries={...oldCatalog.libraries,SaleGovernance:policy.SaleGovernance};
  const catalog={schemaVersion:1,kind:'fresh-native-firsto-sale-upgrade-v1',chainId:56,profile:'full-test',
    genesisArtifactDigest:oldCatalog.genesisArtifactDigest,candidateArtifactDigest:buildDigest(bundle),bindings:oldCatalog.bindings,
    expectedImplementations:{PoolVault:policy.PoolVault},libraries,artifacts:bundle.artifacts,
    activation:{pool:addr(900),proposalId:'1',priceWei:'40000000000000000',feeBps:'100',feeEpoch:'1'}};
  catalog.salt=nativeSaleSalt(a.factory,catalog.candidateArtifactDigest);
  trusted.freshNativeSale=validateFreshNativeSaleCatalog(catalog,bundle,trusted);
  const codes={},codeFor=(name,artifact,replacements,links)=>{
    let value=artifact.deployedBytecode.slice(2);
    for (const refs of Object.values(artifact.deployedLinkReferences ?? {})) for (const [key,slots] of Object.entries(refs))
      for (const {start,length} of slots) value=value.slice(0,start*2)+links[key].slice(2)+value.slice((start+length)*2);
    if (['SaleGovernance','SaleSettlement','FirstoSale'].includes(name)) value='73'+replacements[name].slice(2)+value.slice(42);
    codes[replacements[name].toLowerCase()]='0x'+value;
  };
  for (const [name,artifact] of Object.entries(oldCatalog.artifacts)) codeFor(name,artifact,policy,{...a,...policy});
  for (const [name,artifact] of Object.entries(bundle.artifacts)) codeFor(name,artifact,newAddresses,{...a,...libraries,...newAddresses});
  const policyOp=freshSalePolicyOperation(oldCatalog,policy),nativeOp=freshNativeSaleOperation(catalog,newAddresses);
  const state={active:true,genesis:false,done:true,version:1n,badCode:false,badFactory:false,reorg:false,codeReads:0,unrelated:false};
  const provider={getStorage:async()=>'0x'+policy.ShareMarket.slice(2).padStart(64,'0'),
    getBlock:async number=>({number,hash:state.reorg?hash(101):hash(number)}),
    getCode:async to=>{state.codeReads++;let code=codes[to.toLowerCase()] ?? '0x';
      return code+(state.badCode && to.toLowerCase()===newAddresses.PoolVault.toLowerCase()?'00':'');},
    send:async(method,[tx,tag])=>{
      assert.equal(method,'eth_call');assert.equal(tag,'0x64');const parsed=abi.parseTransaction(tx);let value;
      if (parsed.name==='implementation') value=tx.to===a.beacon?(state.unrelated?addr(999):state.genesis?a.PoolVault:state.active?newAddresses.PoolVault:policy.PoolVault):policy.BudgetPortfolioVault;
      if (parsed.name==='OFFICIAL_FACTORY') value=state.badFactory?ZeroAddress:tx.to===policy.BudgetPortfolioVault?a.portfolioFactory:a.factory;
      if (parsed.name==='saleReviewThresholdBps') value=8000n;
      if (parsed.name==='automaticSaleReferenceVersion') value=1n;
      if (parsed.name==='saleReferencePublisher') value=a.gasWallet;
      if (parsed.name==='nativeFirstoSaleVersion') value=state.version;
      if (parsed.name==='hashOperationBatch') value=parsed.args[0].length===3?policyOp.operationId:nativeOp.operationId;
      if (parsed.name==='isOperationDone') value=state.done;
      assert.notEqual(value,undefined);return abi.encodeFunctionResult(parsed.name,[value]);
    }};
  return {trusted,catalog,bundle,a,state,provider,policy,newAddresses,nativeOp};
}
test('native catalog preserves the original graph, exact candidate and separate activation',()=>{
  const f=fixture();
  for (const change of [c=>c.bindings.factory=addr(8),c=>c.artifacts.PoolVault.bytecode+='00',c=>c.libraries.RewardAccounting=addr(8),
    c=>c.salt=hash(9),c=>c.expectedImplementations.PoolVault=ZeroAddress,c=>c.activation.priceWei=0.04]) {
    const altered=structuredClone(f.catalog);change(altered);assert.throws(()=>validateFreshNativeSaleCatalog(altered,f.bundle,f.trusted));
  }
  const formal=structuredClone(f.catalog);formal.profile='formal';f.trusted.freshSalePolicy.catalog.profile='formal';
  assert.throws(()=>validateFreshNativeSaleCatalog(formal,f.bundle,f.trusted),/Formal/);
  assert.throws(()=>nativeSalePolicyBaseline({baselinePoolVault:f.policy.PoolVault}),/Unverified/);
});
test('native proof verifies fixed execution while preserving the complete old 80% policy',async()=>{
  const f=fixture(),proof=await verifyFreshNativeSale(f.provider,f.trusted,block);
  assert.deepEqual(proof.replacements,f.newAddresses);assert.equal(proof.operationId,f.nativeOp.operationId);
  const old=await verifyFreshSalePolicy(f.provider,f.trusted,block,{nativeUpgrade:proof});
  assert.equal(old.replacements.PoolVault,f.policy.PoolVault);assert.equal(old.saleReviewThresholdBps,8000);
  const count=f.state.codeReads;assert.equal(await verifyFreshNativeSale(f.provider,f.trusted,block),proof);assert.equal(f.state.codeReads,count);
  f.state.reorg=true;await assert.rejects(verifyFreshNativeSale(f.provider,f.trusted,block),/anchor/);
});
test('unactivated deployments stay on existing code; unrelated or incomplete native code is rejected',async()=>{
  const f=fixture();f.state.active=false;assert.equal(await verifyFreshNativeSale(f.provider,f.trusted,block),null);assert.equal(f.state.codeReads,0);
  f.state.genesis=true;assert.equal(await verifyFreshNativeSale(f.provider,f.trusted,block),null);
  for (const change of [s=>s.done=false,s=>s.version=0n,s=>s.badCode=true,s=>s.badFactory=true,s=>s.unrelated=true]) {
    const wrong=fixture();change(wrong.state);await assert.rejects(verifyFreshNativeSale(wrong.provider,wrong.trusted,block));
  }
});
test('a forged baseline cannot make a partial or unrelated policy trusted',async()=>{
  const f=fixture();await assert.rejects(verifyFreshSalePolicy(f.provider,f.trusted,block,{nativeUpgrade:{baselinePoolVault:f.policy.PoolVault}}),/Unverified/);
  const proof=await verifyFreshNativeSale(f.provider,f.trusted,block);
  f.provider.getStorage=async()=>'0x'+f.a.ShareMarket.slice(2).padStart(64,'0');
  await assert.rejects(verifyFreshSalePolicy(f.provider,f.trusted,block,{nativeUpgrade:proof}),/incomplete/);
});
