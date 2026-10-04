import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const endpoint=process.argv[2], output=process.argv[3], start=Date.now();
const hash='0x3832f45fefd27e791881664999cff1d76b6561bd604f7bd5e75e88ae94be332a';
const blockNumber=125476240n;
const blockHash='0xa65cef31894ec2339a52e9e43452e72b647a46a4c0a0cdab8f08ddce7b08767e';
const sender='0x042b23288e2316dfb6503488292fd0ad2f811ae7';
let id=0;
const methods={};
async function rpc(method,params){
  const request={jsonrpc:'2.0',id:++id,method,params};
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,`${method}: HTTP ${response.status}`);
  const body=await response.json();
  assert.equal(body.jsonrpc,'2.0');assert.equal(body.id,request.id);assert(!body.error);assert(Object.hasOwn(body,'result'));
  methods[method]=(methods[method]??0)+1;
  return body.result;
}
let result;
try {
  assert.equal(await rpc('eth_chainId',[]),'0x38');
  const tx=await rpc('eth_getTransactionByHash',[hash]);
  const receipt=await rpc('eth_getTransactionReceipt',[hash]);
  const block=await rpc('eth_getBlockByNumber',['0x'+blockNumber.toString(16),false]);
  const finalized=await rpc('eth_getBlockByNumber',['finalized',false]);
  assert(tx&&receipt&&block&&finalized);
  assert.equal(tx.hash.toLowerCase(),hash);assert.equal(receipt.transactionHash.toLowerCase(),hash);
  assert.equal(tx.from.toLowerCase(),sender);assert.equal(receipt.from.toLowerCase(),sender);
  assert.equal(BigInt(tx.blockNumber),blockNumber);assert.equal(BigInt(receipt.blockNumber),blockNumber);assert.equal(BigInt(block.number),blockNumber);
  assert.equal(tx.blockHash.toLowerCase(),blockHash);assert.equal(receipt.blockHash.toLowerCase(),blockHash);assert.equal(block.hash.toLowerCase(),blockHash);
  assert.equal(BigInt(receipt.status),1n);assert(BigInt(finalized.number)>=blockNumber);
  const index=Number(BigInt(receipt.transactionIndex));
  assert.equal(BigInt(tx.transactionIndex),BigInt(receipt.transactionIndex));assert.equal(block.transactions[index].toLowerCase(),hash);
  result={ok:true,transactionHash:hash,blockNumber:Number(blockNumber),canonicalTransactionIndex:index,finalizedBlockNumber:Number(BigInt(finalized.number)),receiptStatus:1};
}catch(e){result={ok:false,error:e.message};process.exitCode=1;}
result={...result,methods,elapsedMs:Date.now()-start,chainActionsPerformed:false,generatedAt:new Date().toISOString()};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
