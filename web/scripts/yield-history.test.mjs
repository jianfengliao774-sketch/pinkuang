import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';
import { displayAmount } from '../lib/amount-display.mjs';
import { cachedYieldWindow, readYieldWindow, yieldChartModel } from '../lib/yield-history.mjs';

const pool='0x'+'aa'.repeat(20),alice='0x'+'bb'.repeat(20),bob='0x'+'cc'.repeat(20);
const dataFor=(days,value=116000n)=>({scope:'pool',pool,account:null,buckets:Array.from({length:days},(_,i)=>({
  date:`2026-10-${String(i+1).padStart(2,'0')}`,poolHarvestNetAtomic:i===days-1?value:0n,accountClaimedAtomic:null,
}))});

await loadBindings();
const code=(await transform(await readFile(new URL('../components/LiveYieldChart.jsx',import.meta.url),'utf8'),{
  filename:'LiveYieldChart.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},target:'es2022',transform:{react:{runtime:'automatic'}}},
  module:{type:'commonjs'},
})).code;
const require=createRequire(import.meta.url),module={exports:{}};
new Function('require','module','exports',code)(name=>name==='../lib/live-view.mjs'?{amount:displayAmount}
  :name==='../lib/yield-history.mjs'?{yieldChartModel}:require(name),module,module.exports);
const Chart=module.exports.default;
function elements(node) {
  if(Array.isArray(node))return node.flatMap(elements);
  if(!node||typeof node!=='object')return [];
  return [node,...elements(node.props?.children)];
}

test('actual chart marks 7/30 selection and shows the exact collected BEM bar',()=>{
  const clicks=[],tree=Chart({data:dataFor(7),locale:'zh',days:7,onDays:days=>clicks.push(days)});
  const buttons=elements(tree).filter(row=>row.type==='button');
  assert.deepEqual(buttons.map(row=>[row.props.className,row.props['aria-pressed']]),[['selected',true],['',false]]);
  buttons[1].props.onClick();assert.deepEqual(clicks,[30]);
  const html=renderToStaticMarkup(tree);
  assert.match(html,/0\.00116/);assert.match(html,/本期矿池归集 0\.00116 BEM，7 天/);
  assert.equal(elements(tree).filter(row=>row.props?.className==='live-yield-column').length,7);
  const bars=elements(tree).filter(row=>row.type==='span'&&row.props?.style?.height);
  assert.equal(bars.at(-1).props.style.height,'100%');
  const changed=Chart({data:dataFor(30),locale:'zh',days:30});
  assert.deepEqual(elements(changed).filter(row=>row.type==='button').map(row=>row.props['aria-pressed']),[false,true]);
});

test('zero income is distinct from loading/failure, and failure or range switching preserves honestly labelled history',()=>{
  const zero=renderToStaticMarkup(Chart({data:dataFor(7,0n),locale:'zh',days:7}));
  assert.match(zero,/0\.00000/);assert.match(zero,/近 7 天暂无收益归集/);
  const loading=renderToStaticMarkup(Chart({locale:'zh',days:7,loading:true}));
  assert.match(loading,/正在读取收益/);assert(!loading.includes('0.00000'));
  const failed=renderToStaticMarkup(Chart({data:dataFor(7),locale:'zh',days:7,error:'HTTP 502'}));
  assert.match(failed,/role="alert"/);assert.match(failed,/已保留上次读取的数据/);assert.match(failed,/0\.00116/);
  const switched=renderToStaticMarkup(Chart({data:dataFor(7),locale:'zh',days:30,loading:true}));
  assert.match(switched,/暂显示已加载的 7 天数据/);assert.match(switched,/本期矿池归集 0\.00116 BEM，7 天/);
  const unknown=yieldChartModel({...dataFor(7),buckets:[{date:'2026-10-01',poolHarvestNetAtomic:null}]});
  assert.equal(unknown,null,'invalid/missing amounts do not become fabricated zeros');
});

test('range loader uses its own history source, coalesces reads and retains successful data across refresh failure',async()=>{
  const calls=[];let now=1,fail=false,release;
  const client={async readYield(query){calls.push(query);if(release)await new Promise(resolve=>{release.resolve=resolve;});
    if(fail)throw new Error('HTTP 502');return {source:{indexedThrough:125251994},data:dataFor(query.days)};}};
  const query={pool,account:alice,days:7,source:{readMode:'display_direct',indexedThrough:125252005}};
  release={};
  const first=readYieldWindow(client,query,{revision:'one',now:()=>now});
  const second=readYieldWindow(client,query,{revision:'one',now:()=>now});
  assert.strictEqual(first,second);
  await new Promise(resolve=>setImmediate(resolve));release.resolve();release=null;
  const result=await first;
  assert.deepEqual(calls,[{pool,account:alice,days:7,scope:'pool'}],'do not tie ledger history to current detail source');
  assert.strictEqual(await readYieldWindow(client,query,{revision:'one',now:()=>now}),result);
  assert.strictEqual(cachedYieldWindow(client,query),result);
  fail=true;now++;
  await assert.rejects(readYieldWindow(client,query,{revision:'two',now:()=>now}),/HTTP 502/);
  assert.strictEqual(cachedYieldWindow(client,query),result);
  fail=false;
  assert.equal((await readYieldWindow(client,query,{revision:'two',now:()=>now})).source.indexedThrough,125251994);
  await readYieldWindow(client,{...query,days:30},{revision:'two',now:()=>now});
  await readYieldWindow(client,{...query,account:bob},{revision:'two',now:()=>now});
  assert.equal(calls.at(-2).days,30);assert.equal(calls.at(-1).account,bob);
  const otherClient={readYield:async query=>({data:dataFor(query.days,2n),source:{indexedThrough:5}})};
  assert.equal(cachedYieldWindow(otherClient,query),null,'deployments/clients never share a cached history');
  assert.equal((await readYieldWindow(otherClient,query)).data.buckets.at(-1).poolHarvestNetAtomic,2n);
});
