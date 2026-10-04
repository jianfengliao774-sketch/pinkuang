import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Interface,keccak256} from '/private/tmp/bemine-upgrade-null-id-throttle-20261004/deploy/node_modules/ethers/lib.esm/ethers.js';
const root='/private/tmp/bemine-upgrade-null-id-throttle-20261004/deploy/release-target-owner';
const manifest=JSON.parse(readFileSync(root+'/static-release-manifest.json'));
const genesis=JSON.parse(readFileSync(root+'/data/genesisRecord.json'));
const origin='https://bemine.cc.cd/pinkuang-target-owner-upgrade/';
const steps=[],start=Date.now();let seq=100;
async function rpc(method,params){
 const id=++seq;const t=Date.now();const r=await fetch(origin+'api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(16000)});
 const v=await r.json();assert.equal(r.status,200);assert.equal(v.jsonrpc,'2.0');assert.equal(v.id,id);assert.ok('result' in v && !('error' in v));steps.push({method,status:r.status,matchedId:true,elapsedMs:Date.now()-t});return v.result;
}
const chain=await rpc('eth_chainId',[]);assert.equal(BigInt(chain),56n);
const block=await rpc('eth_getBlockByNumber',['latest',false]);assert.ok(block?.hash);const tag=block.number;
const factory=genesis.addresses.factory;
const code=await rpc('eth_getCode',[factory,tag]);assert.ok(code.length>2);
const slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const implementation=await rpc('eth_getStorageAt',[factory,slot,tag]);assert.match(implementation,/^0x[0-9a-fA-F]{64}$/);
const iface=new Interface(['function getMinDelay() view returns (uint256)']);
const delay=await rpc('eth_call',[{to:genesis.addresses.timelock,data:iface.encodeFunctionData('getMinDelay')},tag]);assert.equal(iface.decodeFunctionResult('getMinDelay',delay)[0],172800n);
const oldStep=genesis.steps.find(s=>s.id==='PoolFunds' && s.status==='confirmed');assert.ok(oldStep);
const tx=await rpc('eth_getTransactionByHash',[oldStep.txHash]);assert.equal(tx.hash.toLowerCase(),oldStep.txHash.toLowerCase());
const receipt=await rpc('eth_getTransactionReceipt',[oldStep.txHash]);assert.equal(BigInt(receipt.status),1n);assert.equal(receipt.blockHash.toLowerCase(),oldStep.receipt.blockHash.toLowerCase());assert.equal(receipt.contractAddress.toLowerCase(),oldStep.address.toLowerCase());
const confirmedBlock=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);assert.equal(confirmedBlock.hash.toLowerCase(),receipt.blockHash.toLowerCase());assert.ok(BigInt(block.number)-BigInt(receipt.blockNumber)>10n);
const staticFiles=[];
for(const path of ['static-release-manifest.json','index.html',...Object.keys(manifest.files).filter(p=>p.endsWith('.js'))]){
 const r=await fetch(new URL(path,origin),{signal:AbortSignal.timeout(16000)});assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());const sha=createHash('sha256').update(bytes).digest('hex');const expected=path==='static-release-manifest.json'?createHash('sha256').update(readFileSync(root+'/'+path)).digest('hex'):manifest.files[path].sha256;assert.equal(sha,expected);staticFiles.push({path,status:200,sha256:sha,bytes:bytes.length});
}
const proof={ok:true,sourceCommit:manifest.sourceCommit,endpoint:origin+'api/rpc',chainId:56,blockNumber:Number(BigInt(tag)),factoryCodehash:keccak256(code),implementationSlot:implementation,minDelaySeconds:172800,receiptProbe:{kind:'historical confirmed genesis PoolFunds deployment, not user pending upgrade',txHash:oldStep.txHash,canonical:true},requests:steps,staticFiles,elapsedMs:Date.now()-start,chainActionsPerformed:false,generatedAt:new Date().toISOString()};
writeFileSync('public-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({ok:proof.ok,sourceCommit:proof.sourceCommit,rpcRequests:steps.length,staticFiles:staticFiles.length,elapsedMs:proof.elapsedMs,chainActionsPerformed:false}));
