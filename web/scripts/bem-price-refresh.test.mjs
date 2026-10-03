import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';
import * as price from '../lib/bem-price.mjs';

await loadBindings();
const code=(await transform(await readFile(new URL('../components/BemPriceStat.jsx',import.meta.url),'utf8'),{
 filename:'BemPriceStat.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},target:'es2022',transform:{react:{runtime:'automatic'}}},
 module:{type:'commonjs'},
})).code;
const require=createRequire(import.meta.url);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('actual price component retains a fresh quote through failed refreshes, expires it and recovers',async()=>{
 const saved={document:globalThis.document,fetch:globalThis.fetch,setInterval:globalThis.setInterval,
  clearInterval:globalThis.clearInterval,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,now:Date.now};
 let cursor=0,clock=saved.now(),response,interval,mounted=false,cleanup,requests=0;
 const states=[],effects=[];
 const hooks={
  useState(initial){const index=cursor++;if(!(index in states))states[index]=initial;
   return[states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},
  useEffect(callback){if(!mounted)effects.push(callback);},
 };
 const module={exports:{}};
 new Function('require','module','exports',code)(name=>name==='react'?hooks
  :name==='../lib/i18n'?{useI18n:()=>({locale:'zh',t:value=>value})}
   :name==='../lib/bem-price.mjs'?price:name.endsWith('.css')?{}:require(name),module,module.exports);
 const quote=()=>({status:'ok',chainId:56,tokenAddress:price.BEM_ADDRESS,poolAddress:price.BEM_POOL,
  conversionPoolAddress:price.WBNB_USDT_POOL,source:'PancakeSwap V3',quoteCurrency:'USDT',
  priceUsdt:34.89896,updatedAt:new Date(clock).toISOString()});
 const render=(variant='metric')=>{cursor=0;return renderToStaticMarkup(module.exports.default({variant}));};
 const refresh=async(ms,result)=>{clock+=ms;response=result;interval();await tick();return render();};
 try{
  globalThis.document={hidden:false,addEventListener(){},removeEventListener(){}};
  Date.now=()=>clock;
  globalThis.fetch=async()=>{requests++;if(response instanceof Error)throw response;return response;};
  globalThis.setInterval=callback=>{interval=callback;return 1;};globalThis.clearInterval=()=>{};
  globalThis.setTimeout=()=>2;globalThis.clearTimeout=()=>{};
  const initial=quote();response={ok:true,json:async()=>initial};
  assert.match(render(),/正在获取行情/);mounted=true;cleanup=effects[0]();await tick();
  assert.match(render(),/34\.90/);assert.match(render('home'),/34\.90/);
  assert.doesNotMatch(render(),/34\.89896|≈/);
  assert.match(await refresh(15_000,{ok:false}),/34\.90/,'one HTTP failure does not discard a fresh price');
  assert.match(await refresh(15_000,new Error('temporary timeout')),/34\.90/,'one network failure does not discard a fresh price');
  assert.match(await refresh(15_000,{ok:true,json:async()=>({...initial,tokenAddress:'0xwrong'})}),/34\.90/,
   'an invalid refreshed quote cannot replace or erase the still-valid prior quote');
  const expired=await refresh(15_001,new Error('still unavailable'));
  assert.match(expired,/行情暂不可用/);assert.doesNotMatch(expired,/34\.90/,
   'failures never extend the original quote timestamp beyond its 60 second validity');
  const recovered=await refresh(0,{ok:true,json:async()=>({...quote(),priceUsdt:35.126})});
  assert.match(recovered,/35\.13/);assert.doesNotMatch(recovered,/行情暂不可用/);
  assert.equal(requests,6);
 }finally{
  cleanup?.();Date.now=saved.now;
  for(const name of ['document','fetch','setInterval','clearInterval','setTimeout','clearTimeout']){
   if(saved[name]===undefined)delete globalThis[name];else globalThis[name]=saved[name];
  }
 }
});
