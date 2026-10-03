import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { reviewedDesignatedPurchaseSupport,verifyDesignatedPurchaseCapability,verifyApplicableOriginalOfficialBaseline,FRESH_AUTHORITY_ONLY } from './fresh-product-gate.mjs';
import { OFFICIAL_MARKET,LISTING_ABI } from '../scripts/purchase-keeper.mjs';
import { DESIGNATED_NFT_ABI } from '../shared/designated-purchase-runtime.mjs';
import { DESIGNATED_CREATE,DESIGNATED_CONFIG,DESIGNATED_GETTER,DESIGNATED_FIRSTO_BUY } from '../shared/designated-purchase-abi.mjs';

const address=n=>`0x${n.toString(16).padStart(40,'0')}`,hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const version='function designatedPurchaseVersion() pure returns(uint8)',abi=new Interface([version]);
function fixture() {
  const addresses={factory:address(1),PoolVault:address(2)},authority=address(3),block={number:100,hash:hash(100)};
  const trusted={record:{addresses,artifactDigest:hash(11)},freshAuthority:{authority:{address:authority}},
    bundle:{artifacts:{FreshPoolFactory:{abi:[`${DESIGNATED_CREATE} returns(address pool)`,version]},
      PoolVault:{abi:[version,`function configureDesignatedPurchase(${DESIGNATED_CONFIG} config)`,DESIGNATED_GETTER,DESIGNATED_FIRSTO_BUY]},
      PlatformAuthority:{abi:[version,'function executeApprovedOperation(address target,bytes data,uint256 nonce,uint256 deadline,bytes signature) returns(bytes result)']}}}};
  const graph={freshFactoryVerified:true,freshAuthority:{address:authority},addresses,artifactDigest:hash(11),blockNumber:100};
  const calls=[],state={version:1,result:null,blockHash:block.hash};
  const provider={send:async(method,[tx,tag])=>{
    calls.push({method,to:tx.to,tag});assert.equal(method,'eth_call');assert.equal(tx.data,abi.encodeFunctionData('designatedPurchaseVersion'));
    return state.result??abi.encodeFunctionResult('designatedPurchaseVersion',[state.version]);
  },getBlock:async height=>{assert.equal(height,100);return {hash:state.blockHash};}};
  return {trusted,graph,block,provider,calls,state};
}

test('designated creation and fallback are excluded from ordinary fresh wallet intents',()=>{
  assert(FRESH_AUTHORITY_ONLY.has('createDesignatedPoolChecked'));
  assert(FRESH_AUTHORITY_ONLY.has('buyAlternativeFromFirsto'));
});

test('legacy, partial and wrong-field candidate bundles fail before capability RPC',async()=>{
  for(const mutate of [
    f=>{delete f.trusted.bundle.artifacts.PoolVault;},
    f=>{f.trusted.bundle.artifacts.PlatformAuthority.abi.shift();},
    f=>{f.trusted.bundle.artifacts.FreshPoolFactory.abi[0]=DESIGNATED_CREATE.replace('uint128 expectedReferenceWeight','uint256 expectedReferenceWeight')+' returns(address pool)';},
    f=>{f.trusted.bundle.artifacts.PoolVault.abi[2]=DESIGNATED_GETTER.replace('uint64 referenceBlock','uint256 referenceBlock');},
    f=>{f.trusted.bundle.artifacts.PoolVault.abi[0]='function designatedPurchaseVersion() pure returns(uint256)';},
    f=>{f.trusted.bundle.artifacts.PlatformAuthority.abi[0]='function designatedPurchaseVersion() view returns(uint8)';},
  ]) {
    const f=fixture();mutate(f);assert.equal(reviewedDesignatedPurchaseSupport(f.trusted),false);
    await assert.rejects(verifyDesignatedPurchaseCapability(f.provider,f.trusted,f.graph,f.block),/does not support/);
    assert.equal(f.calls.length,0);
  }
});

test('capability requires reviewed graph identities and exactly version 1 on one canonical block',async()=>{
  const f=fixture();assert.equal(reviewedDesignatedPurchaseSupport(f.trusted),true);
  const result=await verifyDesignatedPurchaseCapability(f.provider,f.trusted,f.graph,f.block);
  assert.deepEqual(result,{version:1,factory:address(1),implementation:address(2),authority:address(3),artifactDigest:hash(11),
    verifiedBlockNumber:100,verifiedBlockHash:hash(100)});
  assert.deepEqual(f.calls.map(c=>[c.to,c.tag]),[[address(1),'0x64'],[address(2),'0x64'],[address(3),'0x64']]);
  for(const mutate of [f=>{f.graph.artifactDigest=hash(12);},f=>{f.graph.freshAuthority.address=address(4);},
    f=>{f.graph.freshFactoryVerified=false;},f=>{f.graph.blockNumber=99;},f=>{f.graph.addresses={...f.graph.addresses,PoolVault:address(4)};}]) {
    const bad=fixture();mutate(bad);await assert.rejects(verifyDesignatedPurchaseCapability(bad.provider,bad.trusted,bad.graph,bad.block),/verified independent/);
    assert.equal(bad.calls.length,0);
  }
  for(const version of [0,2]) {const bad=fixture();bad.state.version=version;
    await assert.rejects(verifyDesignatedPurchaseCapability(bad.provider,bad.trusted,bad.graph,bad.block),/all prove/);}
  for(const result of ['0x01',abi.encodeFunctionResult('designatedPurchaseVersion',[1])+'00']) {const bad=fixture();bad.state.result=result;
    await assert.rejects(verifyDesignatedPurchaseCapability(bad.provider,bad.trusted,bad.graph,bad.block),/all prove/);}
  const changed=fixture();changed.state.blockHash=hash(101);
  await assert.rejects(verifyDesignatedPurchaseCapability(changed.provider,changed.trusted,changed.graph,changed.block),/chain changed/);
});

function baselineFixture() {
  const market=new Interface(LISTING_ABI),nft=new Interface(DESIGNATED_NFT_ABI),block={number:100,hash:hash(100)};
  const params={circuits:address(8),circuitId:7223n},config={referenceSeller:address(9),referencePriceWei:100n,referenceCostWei:100n};
  const state={valid:true,id:7n,seller:config.referenceSeller,price:100n,detailValid:true,detailPrice:100n,detailToken:7223n,detailCollection:params.circuits,
    owner:config.referenceSeller,approved:OFFICIAL_MARKET,approvedAll:false,blockHash:block.hash,failMethod:null,extraBytes:false},calls=[];
  const provider={send:async(method,[tx,tag])=>{
    assert.equal(method,'eth_call');assert.equal(tag,'0x64');
    const contract=tx.to===OFFICIAL_MARKET?market:nft,decoded=contract.parseTransaction(tx),name=decoded.name;calls.push(name);
    if(state.failMethod===name)throw Error('Bounded RPC failed');
    const values={listingFor:[state.id,state.seller,state.price,state.valid],
      listingView:[state.seller,state.detailCollection,state.detailToken,state.detailPrice,100,state.detailValid],
      ownerOf:[state.owner],getApproved:[state.approved],isApprovedForAll:[state.approvedAll]}[name];
    return contract.encodeFunctionResult(name,values)+(state.extraBytes?'00':'');
  },getBlock:async height=>{assert.equal(height,100);return {hash:state.blockHash};}};
  return {provider,params,config,block,state,calls,verify:()=>verifyApplicableOriginalOfficialBaseline(provider,params,config,block)};
}

test('official baseline authenticates listing details, ownership, approval and exact seller ask/gross at the capability block',async()=>{
  const f=baselineFixture(),result=await f.verify();
  assert.deepEqual(result,{venue:'official',seller:address(9),priceWei:100n,costWei:100n,listingId:7n,
    verifiedBlockNumber:100,verifiedBlockHash:hash(100)});
  assert.equal(f.calls.length,5);assert.deepEqual(f.calls.slice(0,2),['listingFor','listingView']);
  for(const mutate of [f=>{f.config.referencePriceWei=99n;},f=>{f.config.referenceCostWei=101n;},
    f=>{f.config.referenceSeller=address(10);},f=>{f.state.detailPrice=101n;},f=>{f.state.detailToken=7224n;},
    f=>{f.state.detailCollection=address(10);},f=>{f.state.detailValid=false;},f=>{f.state.id=0n;},
    f=>{f.state.extraBytes=true;},f=>{f.state.blockHash=hash(101);},f=>{f.state.failMethod='getApproved';}]) {
    const bad=baselineFixture();mutate(bad);await assert.rejects(bad.verify());
  }
});

test('no executable official original never authenticates a Firsto JSON quotation or silently hides read failures',async()=>{
  const absent=baselineFixture();absent.state.valid=false;
  assert.equal(await absent.verify(),null);assert.deepEqual(absent.calls,['listingFor']);
  for(const mutate of [f=>{f.state.owner=address(10);},f=>{f.state.approved=address(0);}]) {
    const bad=baselineFixture();mutate(bad);assert.equal(await bad.verify(),null);
  }
  const all=baselineFixture();all.state.approved=address(0);all.state.approvedAll=true;assert((await all.verify()).venue==='official');
  const reorg=baselineFixture();reorg.state.valid=false;reorg.state.blockHash=hash(101);await assert.rejects(reorg.verify(),/chain changed/);
  const error=baselineFixture();error.state.failMethod='listingFor';await assert.rejects(error.verify(),/Bounded RPC/);
});
