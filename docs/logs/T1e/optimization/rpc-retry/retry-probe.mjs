import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=dirname(fileURLToPath(import.meta.url));
const forge=process.argv[2];
mkdirSync(join(root,'src'),{recursive:true});
writeFileSync(join(root,'foundry.toml'),'[profile.default]\nsolc_version = "0.8.24"\nsrc = "src"\n');
writeFileSync(join(root,'src/RetryProbe.t.sol'),'pragma solidity 0.8.24; contract RetryProbe { function testSmoke() external pure { require(2+2==4); } }\n');
const zero32='0x'+'00'.repeat(32);
const block={number:'0x'+(123728000).toString(16),hash:'0x18c5cda4bb465d1a9aae3d4fe66150cffbe187e2488b856a93f4376080e26306',parentHash:zero32,sha3Uncles:zero32,miner:'0x'+'00'.repeat(20),stateRoot:zero32,transactionsRoot:zero32,receiptsRoot:zero32,logsBloom:'0x'+'00'.repeat(256),difficulty:'0x1',totalDifficulty:'0x1',gasLimit:'0x1c9c380',gasUsed:'0x0',timestamp:'0x65000000',extraData:'0x',mixHash:zero32,nonce:'0x'+'00'.repeat(8),transactions:[],uncles:[],size:'0x1'};
const results=[];
for (const mode of ['recover','exhaust','not-retryable']) {
  const calls=[]; const counts={};
  const server=createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{
    const body=JSON.parse(data); const method=body.method; const key=JSON.stringify(body); const count=(counts[key]??0)+1;counts[key]=count;
    calls.push({at:Date.now(),key,method,count,id:body.id});
    if(mode==='exhaust'||(mode==='recover'&&calls.length===1)){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,error:{code:-32005,message:'rate limit exceeded'}}));return;}
    if(mode==='not-retryable'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,error:{code:-32602,message:'invalid params'}}));return;}
    const value=method==='eth_chainId'?'0x'+(13371337).toString(16):method==='eth_gasPrice'?'0x1':method==='eth_getBlockByNumber'?block:method==='eth_getBalance'||method==='eth_getTransactionCount'?'0x0':method==='eth_getCode'?'0x':method==='eth_getStorageAt'?zero32:undefined;
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value===undefined?{jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'unsupported method'}}:{jsonrpc:'2.0',id:body.id,result:value}));
  });});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  const args=['test','--root',root,'--match-contract','RetryProbe','--fork-url',url,'--fork-block-number','123728000','--no-storage-caching','--threads','1','--compute-units-per-second','50','--fork-retries','10','--fork-retry-backoff','2000','-vv'];
  const start=Date.now(); const child=spawn(forge,args,{cwd:root,env:{...process.env,FOUNDRY_PROFILE:'default',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'}});
  let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  await new Promise(r=>server.close(r));
  writeFileSync(join(root,mode+'.log'),output);
  const result={mode,exitCode,elapsedMs:Date.now()-start,args,calls,counts};results.push(result);
  console.log(JSON.stringify({mode,exitCode,elapsedMs:result.elapsedMs,requests:calls.length,counts}));
  if(mode==='recover'){assert.equal(exitCode,0,output);assert.ok(Object.values(counts).some(c=>c===2));}
  if(mode==='exhaust'){assert.notEqual(exitCode,0);assert.match(output,/Max retries exceeded/);assert.ok(Object.values(counts).some(c=>c===11));assert.ok(Object.values(counts).every(c=>c<=11));}
  if(mode==='not-retryable'){assert.notEqual(exitCode,0);assert.ok(Object.values(counts).every(c=>c===1));}
  if(mode!=='not-retryable'){const same=calls.filter(c=>c.key===calls[0].key);const limit=mode==='recover'?Math.min(2,same.length):same.length;for(let i=1;i<limit;i++){assert.ok(same[i].at-same[i-1].at>=1900,'2,000 ms backoff was not applied');}}
}
writeFileSync(join(root,'results.json'),JSON.stringify({fixture:'local synthetic JSON-RPC; not BSC chain evidence',forgeVersion:'1.7.1',syntheticChainId:13371337,noStorageCaching:true,results},null,2)+'\n');
console.log('PASS: recovery, bounded exhaustion, non-retryable failure, and 2,000 ms backoff. Evidence '+root);