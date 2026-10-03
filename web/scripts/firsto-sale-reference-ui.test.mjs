import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';
const require=createRequire(import.meta.url);await loadBindings();
const code=(await transform(await readFile(new URL('../components/FirstoSaleReferenceAction.jsx',import.meta.url),'utf8'),{
  filename:'FirstoSaleReferenceAction.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},target:'es2022',transform:{react:{runtime:'automatic'}}},module:{type:'commonjs'}})).code;
const turn=()=>new Promise(resolve=>setImmediate(resolve)),address=n=>`0x${n.toString(16).padStart(40,'0')}`;
const result=(status='pending',extra={})=>({enabled:true,stale:false,item:{pool:address(1),status,proposalId:'1',
  priceWei:'34436343241727426',observedAt:1790904900,hash:`0x${'ab'.repeat(32)}`,...extra}});
function harness({statuses=[result()],disabled=false,wait,reject}={}) {
  const slots=[],effects=[],timers=[];let cursor=0,tree,reads=0,updates=0,actions=0;
  const hooks={useState(initial){const n=cursor++;if(!slots[n])slots[n]={value:typeof initial==='function'?initial():initial};
    return [slots[n].value,value=>{slots[n].value=typeof value==='function'?value(slots[n].value):value;}];},
    useRef(initial){const n=cursor++;return slots[n]??={current:initial};},
    useEffect(fn,deps){const n=cursor++,old=slots[n];if(!old||deps.some((value,index)=>value!==old.deps[index]))
      effects.push(()=>{old?.cleanup?.();slots[n]={deps,fn,cleanup:fn()};});}};
  let props={config:{artifactDigest:'sample',factory:address(2),shareMarket:address(3)},pool:address(1),disabled,
    onAction:()=>{actions++;throw Error('A status read must never request a signature');},onUpdated:()=>{updates++;}};
  const modules={react:hooks,'../lib/sale-reference-status.mjs':{async fetchSaleReferenceStatus(config,pool,{signal}){
    const n=reads++;assert.equal(config.factory,address(2));if(wait)await wait(n,signal);if(reject)throw Error('status source unavailable');
    return statuses[Math.min(n,statuses.length-1)];}}};
  let listener;const visibility={hidden:false,addEventListener(_name,fn){listener=fn;},removeEventListener(){listener=null;}};
  const setTimer=(fn,ms)=>{assert([10000,30000].includes(ms));const timer={fn,ms,active:true};timers.push(timer);return timer;},clearTimer=timer=>{if(timer)timer.active=false;};
  const module={exports:{}};new Function('require','module','exports','setTimeout','clearTimeout','document',code)(name=>modules[name]??require(name),module,module.exports,setTimer,clearTimer,visibility);
  const Component=module.exports.default,render=()=>{cursor=0;tree=Component(props);while(effects.length)effects.shift()();};
  const settle=async()=>{for(let n=0;n<5;n++){await turn();render();}};
  const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)];
  const button=()=>nodes(tree).find(node=>node.type==='button'&&node.props.children==='刷新参考价状态');render();
  return {settle,render,get reads(){return reads;},get updates(){return updates;},get actions(){return actions;},text:()=>JSON.stringify(tree),button,
    click(){assert(!button().props.disabled);button().props.onClick();render();},
    tick(){const timer=timers.find(value=>value.active);if(timer){timer.active=false;timer.fn();render();return true;}return false;},
    changePool(pool){props={...props,pool};render();},changeDisabled(disabled){props={...props,disabled};render();},
    visibility(hidden){visibility.hidden=hidden;listener?.();render();},
    get nextDelay(){return timers.find(value=>value.active)?.ms;},
    replay(){for(const slot of slots)if(slot?.fn)slot.cleanup?.();for(const slot of slots)if(slot?.fn)slot.cleanup=slot.fn();render();},
    dispose(){for(const slot of slots)slot?.cleanup?.();}};
}

test('all wallets see only backend status; visible polling never requests a signature and pauses while hidden',async()=>{
  const ui=harness();try{await ui.settle();assert.equal(ui.reads,1);assert.equal(ui.actions,0);assert.match(ui.text(),/正在确认/);
    for(let n=0;n<15;n++){ui.tick();await ui.settle();}assert.equal(ui.reads,16);assert.equal(ui.nextDelay,10000);
    ui.visibility(true);assert.equal(ui.tick(),false);assert.equal(ui.reads,16);
    ui.visibility(false);await ui.settle();assert.equal(ui.reads,17);
    ui.click();await ui.settle();assert.equal(ui.reads,18);assert.equal(ui.actions,0);assert.doesNotMatch(ui.text(),/签名更新/);
  }finally{ui.dispose();}
});
test('only a fresh confirmed result refreshes governance, once per exact quote',async()=>{
  const ui=harness({statuses:[result('pending'),result('confirmed'),result('confirmed'),result('confirmed',{observedAt:1790905000})]});
  try{await ui.settle();assert.equal(ui.updates,0);ui.tick();await ui.settle();assert.equal(ui.updates,1);
    ui.tick();await ui.settle();assert.equal(ui.updates,1);ui.tick();await ui.settle();assert.equal(ui.updates,2);assert.match(ui.text(),/0.03444/);
  }finally{ui.dispose();}
});
test('stale or unavailable status retains displayed quote but cannot report confirmation',async()=>{
  const stale=result('confirmed');stale.stale=true;const ui=harness({statuses:[stale]});try{
    await ui.settle();assert.equal(ui.updates,0);assert.match(ui.text(),/保留最近参考价/);assert.match(ui.text(),/0.03444/);
  }finally{ui.dispose();}
  const failed=harness({reject:true});try{await failed.settle();assert.equal(failed.updates,0);assert.match(failed.text(),/暂不可用/);
    assert.equal(failed.nextDelay,30000);failed.tick();await failed.settle();assert.equal(failed.reads,2);
  }finally{failed.dispose();}
});
test('old contracts clearly require activation and expose no administrator price signing control',async()=>{
  const value=result('disabled');value.enabled=false;const ui=harness({statuses:[value]});try{
    await ui.settle();assert.match(ui.text(),/一次合约升级/);assert.equal(ui.actions,0);assert.equal(ui.updates,0);
  }finally{ui.dispose();}
});
test('pool navigation aborts a pending status result before it can refresh the new project',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const ui=harness({statuses:[result('confirmed'),result('pending')],wait:n=>n===0?pending:Promise.resolve()});
  try{ui.changePool(address(8));finish();await ui.settle();assert.equal(ui.updates,0);assert.match(ui.text(),/正在确认/);}finally{finish();ui.dispose();}
});
test('StrictMode effect replay cannot revive the cancelled read or duplicate a confirmed update',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const ui=harness({statuses:[result('confirmed')],wait:n=>n===0?pending:Promise.resolve()});
  try{ui.replay();await ui.settle();assert.equal(ui.reads,2);assert.equal(ui.updates,1);finish();await ui.settle();assert.equal(ui.updates,1);}finally{finish();ui.dispose();}
});
test('disabled activation reads when enabled and preserves completed quote deduplication through busy toggles',async()=>{
  const ui=harness({statuses:[result('confirmed')],disabled:true});try{await ui.settle();assert.equal(ui.reads,0);
    ui.changeDisabled(false);await ui.settle();assert.equal(ui.reads,1);assert.equal(ui.updates,1);
    ui.changeDisabled(true);await ui.settle();ui.changeDisabled(false);await ui.settle();assert.equal(ui.updates,1);
  }finally{ui.dispose();}
});
