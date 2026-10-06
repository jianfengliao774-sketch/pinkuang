import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserProvider, type Eip1193Provider } from 'ethers';
import { freshActivationReadWallet, readFreshActivationAnchors } from './fresh-activation-reader';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const block = (number: number) => ({number, hash: hash(number)});
const rpcBlock = (number: number) => ({number:`0x${number.toString(16)}`,hash:hash(number),parentHash:hash(number-1),
  timestamp:'0x1',nonce:'0x0000000000000000',difficulty:'0x1',gasLimit:'0x1c9c380',gasUsed:'0x0',
  miner:'0x1111111111111111111111111111111111111111',extraData:'0x',transactions:[],baseFeePerGas:'0x0'});
const respond = (id: number, result: unknown) => new Response(JSON.stringify({jsonrpc:'2.0',id,result}),
  {status:200,headers:{'content-type':'application/json'}});

test('real BrowserProvider reads only block headers through the same-origin proxy and retains wallet chain identity',async()=>{
  const walletCalls: string[]=[];const readCalls:string[]=[];
  const wallet:Eip1193Provider={request:async({method})=>{walletCalls.push(method);if(method==='eth_chainId')return '0x38';throw new Error('wallet header reader unavailable');}};
  const reader=freshActivationReadWallet(wallet,{pageUrl:'https://tapeout.cc.cd/pinkuang-deploy-v4/?x=1',fetcher:async(input,init)=>{
    assert.equal(String(input),'https://tapeout.cc.cd/pinkuang-deploy-v4/api/rpc');
    assert.equal(init?.credentials,'same-origin');assert.equal(init?.cache,'no-store');assert(init?.signal);
    const payload=JSON.parse(String(init?.body));assert.equal(payload.method,'eth_getBlockByNumber');
    readCalls.push(payload.params[0]);return respond(payload.id,rpcBlock(payload.params[0]==='finalized'?100:102));
  }});
  const provider=new BrowserProvider(reader,'any',{cacheTimeout:-1});
  try{
    const result=await readFreshActivationAnchors(provider);
    assert.equal(result.finalized.number,100);assert.equal(result.head.number,102);
    assert.deepEqual(readCalls,['finalized','latest']);assert(walletCalls.every(name=>name==='eth_chainId'));
    assert.equal((await provider.getNetwork()).chainId,56n);
  }finally{provider.destroy();}
});

test('accounts, signing, calls, storage, fee and nonce requests retain the original wallet arguments and result',async()=>{
  const seen:unknown[]=[];const result={original:true};
  const wallet:Eip1193Provider={request:async request=>{seen.push(request);return result;}};
  const reader=freshActivationReadWallet(wallet,{pageUrl:'https://tapeout.cc.cd/pinkuang-deploy-v4/',fetcher:async()=>{throw new Error('not a header');}});
  for(const method of ['eth_accounts','eth_requestAccounts','eth_chainId','eth_sendTransaction','personal_sign',
    'eth_call','eth_getCode','eth_getStorageAt','eth_getTransactionCount','eth_gasPrice','eth_getBalance','eth_getTransactionReceipt','eth_getTransactionByHash']){
    const request={method,params:[{unchanged:method}]};assert.equal(await reader.request(request),result);assert.equal(seen.at(-1),request);
  }
  assert.equal(seen.length,13);
});

test('a wallet rejection is never retried and a failed proxy never falls back to the wallet node',async()=>{
  let count=0;const rejection=Object.assign(new Error('rejected'),{code:4001});
  const wallet:Eip1193Provider={request:async()=>{count++;throw rejection;}};
  const reader=freshActivationReadWallet(wallet,{pageUrl:'https://tapeout.cc.cd/pinkuang-deploy-v4/',fetcher:async()=>new Response('{}',{status:503})});
  await assert.rejects(reader.request({method:'eth_sendTransaction',params:[{}]}),error=>error===rejection);assert.equal(count,1);
  await assert.rejects(reader.request({method:'eth_getBlockByNumber',params:['finalized',false]}),/HTTP 503/);assert.equal(count,1);
});

test('proxy response ID, protocol, error and missing result mismatches fail closed',async()=>{
  const wallet:Eip1193Provider={request:async()=>{throw new Error('must not fallback');}};
  for(const reply of [{jsonrpc:'2.0',id:99,result:null},{jsonrpc:'1.0',id:1,result:null},
    {jsonrpc:'2.0',id:1,error:{code:-1}}, {jsonrpc:'2.0',id:1},null]){
    const reader=freshActivationReadWallet(wallet,{pageUrl:'https://tapeout.cc.cd/pinkuang-deploy-v4/',fetcher:async()=>new Response(JSON.stringify(reply))});
    await assert.rejects(reader.request({method:'eth_getBlockByNumber',params:['finalized',false]}),/未能确认请求/);
  }
});

test('short-lived lag is reread in finalized-then-latest order with a bounded delay',async()=>{
  const calls:string[]=[];const waits:number[]=[];let pair=0;
  const provider={getBlock:async(tag:'finalized'|'latest')=>{
    calls.push(tag);if(tag==='finalized')return block(pair?102:100);
    return block(pair++?103:99);
  }};
  const result=await readFreshActivationAnchors(provider,async ms=>{waits.push(ms);});
  assert.equal(result.finalized.number,102);assert.equal(result.head.number,103);
  assert.deepEqual(calls,['finalized','latest','finalized','latest']);assert.deepEqual(waits,[250]);
});

test('persistent absent finalized tag stops after three attempts; latest is never promoted',async()=>{
  const calls:string[]=[];let waits=0;
  await assert.rejects(readFreshActivationAnchors({getBlock:async tag=>{calls.push(tag);return tag==='finalized'?null:block(500);}},async()=>{waits++;}),/最终确认区块/);
  assert.deepEqual(calls,['finalized','latest','finalized','latest','finalized','latest']);assert.equal(waits,2);
});

test('real RPC failures are preserved and conflicting hashes are left for the existing ancestry proof',async()=>{
  const error=new Error('RPC authorization expired');let calls=0;
  await assert.rejects(readFreshActivationAnchors({getBlock:async()=>{calls++;throw error;}},async()=>{assert.fail('no retry');}),value=>value===error);
  assert.equal(calls,1);
  const result=await readFreshActivationAnchors({getBlock:async tag=>({number:100,hash:hash(tag==='finalized'?100:200)})});
  assert.notEqual(result.finalized.hash,result.head.hash,'no rewrite or fabrication of a canonical hash');
});
