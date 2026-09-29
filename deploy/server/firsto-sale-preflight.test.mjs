import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { verifyControlledFirstoSale } from './firsto-sale-preflight.mjs';
import { firstoProvider,now } from '../scripts/fixtures/firsto-order.mjs';
const target=`0x${'33'.repeat(20)}`;
const abi=new Interface(['function listedProposalId() view returns(uint256)','function salePrice() view returns(uint256)','function expiresAt() view returns(uint64)']);
function fixture(options={}) {
  const fixture=firstoProvider({account:target},options),request=fixture.provider.request;
  const values={listedProposalId:3n,salePrice:1001n,expiresAt:BigInt(now/1000+60),...options.pool};
  const provider={send:async(method,params)=>{
    assert.equal(params[1],'0x64');
    if(params[0].to.toLowerCase()===target){const decoded=abi.parseTransaction(params[0]);return abi.encodeFunctionResult(decoded.name,[values[decoded.name]]);}
    return request({method,params});
  },getCode:async(address,block)=>{assert.equal(block,100);return request({method:'eth_getCode',params:[address,'0x64']});},
  getStorage:async(address,slot,block)=>{assert.equal(block,100);return request({method:'eth_getStorageAt',params:[address,slot,'0x64']});}};
  return {provider,record:{target,value:'1011'},decoded:{args:[3n,1001n,100n,1n]},block:{number:100,timestamp:now/1000}};
}
test('controlled Firsto preview binds exact proposal, integer payment and current fee epoch at one block',async()=>{
  const f=fixture();const quote=await verifyControlledFirstoSale(f.provider,f.record,f.decoded,f.block);
  assert.equal(quote.totalWei,'1011');assert.equal(quote.buyerFeeWei,'10');
  for(let index=0;index<4;index++){const g=fixture();g.decoded.args[index]++;await assert.rejects(verifyControlledFirstoSale(g.provider,g.record,g.decoded,g.block),/changed after/);}
  f.record.value='1010';await assert.rejects(verifyControlledFirstoSale(f.provider,f.record,f.decoded,f.block),/payment differs/);
});
test('paused, expired, replaced implementation and incoherent fee epochs fail closed',async()=>{
  for(const options of [{values:{paused:true}},{pool:{expiresAt:BigInt(now/1000)}},{implementationCode:'0x6000'},
    {proxy:'0x6000'},{values:{feeBpsAtEpoch:99n}},{pool:{listedProposalId:0n}}]){
    const f=fixture(options);await assert.rejects(verifyControlledFirstoSale(f.provider,f.record,f.decoded,f.block));
  }
});
