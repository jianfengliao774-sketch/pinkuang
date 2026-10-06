#!/usr/bin/env node
// Node 18+. A server-side worker writes an atomic, public JSON cache for the static UI.
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {BEM_ADDRESS,WBNB_ADDRESS,USDT_ADDRESS,BEM_POOL,WBNB_USDT_POOL,PANCAKE_V3_FACTORY,PRICE_REFRESH_MS,calculateBnbUsdt,calculateBemUsdt} from '../lib/bem-price.mjs';
const outputArg=process.argv.indexOf('--output');
if(outputArg<0||!process.argv[outputArg+1]||process.argv[outputArg+1].startsWith('--'))throw new Error('Usage: node update-bem-price.mjs --output /absolute/path/bem-price.json [--once]');
const output=resolve(process.argv[outputArg+1]);
const rpcUrl=process.env.BEM_PRICE_RPC||'https://bsc-dataseed.binance.org';
const nowIso=()=>new Date().toISOString();
async function json(url,options={}){
 const response=await fetch(url,{...options,signal:AbortSignal.timeout(7000),headers:{...options.headers,'User-Agent':'BEMine-price-cache/1.0'}});
 if(!response.ok)throw new Error('UPSTREAM_HTTP');
 return response.json();
}
async function rpc(method,params){
 const result=await json(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 if(result.error||result.result==null)throw new Error('RPC_ERROR');
 return result.result;
}
function uint(value,index=0){
 if(!/^0x[\da-f]+$/i.test(value)||value.length<2+64*(index+1))throw new Error('INVALID_RPC_DATA');
 return BigInt('0x'+value.slice(2+64*index,2+64*(index+1)));
}
function address(value){return '0x'+uint(value).toString(16).padStart(40,'0');}
// Factory.getPool(address,address,uint24); independently verifies factory membership.
function getPoolData(token0,token1,fee){return '0x1698ee82'+token0.slice(2).padStart(64,'0')+token1.slice(2).padStart(64,'0')+BigInt(fee).toString(16).padStart(64,'0');}
async function quote(){
 const [chain,block]=await Promise.all([rpc('eth_chainId',[]),rpc('eth_getBlockByNumber',['latest',false])]);
 const blockTime=Number(BigInt(block.timestamp))*1000;
 const isRecent=time=>Number.isFinite(time)&&Date.now()-time>=-5000&&Date.now()-time<=60_000;
 if(chain!=='0x38'||!isRecent(blockTime))throw new Error('STALE_OR_INVALID_SOURCE');
 const call=(to,data)=>rpc('eth_call',[{to,data},block.number]);
 async function verifiedPool(pool,expected0,expected1,expectedFee){
  const [token0,token1,factory,registeredPool,slot0,liquidity,fee]=await Promise.all([
   call(pool,'0x0dfe1681'),call(pool,'0xd21220a7'),call(pool,'0xc45a0155'),
   call(PANCAKE_V3_FACTORY,getPoolData(expected0,expected1,expectedFee)),
   call(pool,'0x3850c7bd'),call(pool,'0x1a686502'),call(pool,'0xddca3f43')
  ]);
  if(address(token0)!==expected0||address(token1)!==expected1||address(factory)!==PANCAKE_V3_FACTORY||address(registeredPool)!==pool||uint(liquidity)<=0n||uint(fee)!==BigInt(expectedFee))throw new Error('POOL_IDENTITY_MISMATCH');
  return uint(slot0);
 }
 const [bemSqrt,bnbSqrt,bemDecimals,bnbDecimals,usdtDecimals]=await Promise.all([
  verifiedPool(BEM_POOL,BEM_ADDRESS,WBNB_ADDRESS,10000),
  verifiedPool(WBNB_USDT_POOL,USDT_ADDRESS,WBNB_ADDRESS,100),
  call(BEM_ADDRESS,'0x313ce567'),call(WBNB_ADDRESS,'0x313ce567'),call(USDT_ADDRESS,'0x313ce567')
 ]);
 if(uint(bemDecimals)!==8n||uint(bnbDecimals)!==18n||uint(usdtDecimals)!==18n)throw new Error('TOKEN_DECIMALS_MISMATCH');
 if(!isRecent(blockTime))throw new Error('STALE_OR_INVALID_SOURCE');
 const bnbUsdt=calculateBnbUsdt(bnbSqrt);
 return {status:'ok',chainId:56,tokenAddress:BEM_ADDRESS,poolAddress:BEM_POOL,conversionPoolAddress:WBNB_USDT_POOL,quoteCurrency:'USDT',source:'PancakeSwap V3',
  priceUsdt:calculateBemUsdt(bemSqrt,bnbUsdt),updatedAt:nowIso(),blockNumber:Number(BigInt(block.number)),
  blockTimestamp:new Date(blockTime).toISOString(),bnbUsdt,bnbQuoteAt:new Date(blockTime).toISOString(),
  sources:[{name:'PancakeSwap V3',url:`https://bscscan.com/address/${BEM_POOL}`}],refreshSeconds:15};
}
let running=false,lastSuccessAt=null;
async function tick(){
 if(running)return;
 running=true;
 try{
  let data;
  try{data=await quote();lastSuccessAt=data.updatedAt;}
  catch(error){data={status:'unavailable',priceUsdt:null,quoteCurrency:'USDT',updatedAt:null,checkedAt:nowIso(),lastSuccessAt,refreshSeconds:15};console.error(`${nowIso()} price unavailable: ${error.message}`);}
  await mkdir(dirname(output),{recursive:true});
  const temp=`${output}.${process.pid}.tmp`;
  await writeFile(temp,JSON.stringify(data)+'\n',{mode:0o644});
  await rename(temp,output);
  if(data.status==='ok')console.log(`${data.updatedAt} BEM/USDT ${data.priceUsdt.toFixed(6)} block ${data.blockNumber}`);
  if(process.argv.includes('--once')&&data.status!=='ok')process.exitCode=1;
 }finally{running=false;}
}
if(process.argv.includes('--once'))await tick();
else {setInterval(()=>tick().catch(()=>{console.error(`${nowIso()} price cache write failed`);process.exit(1);}),PRICE_REFRESH_MS);await tick();}
