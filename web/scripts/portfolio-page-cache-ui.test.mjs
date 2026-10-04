import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';

const require = createRequire(import.meta.url);
const turn = () => new Promise(resolve => setImmediate(resolve));
const address = digit => `0x${digit.repeat(40)}`;

async function portfolioUi(readPortfolioPage, overrides = {}) {
  await loadBindings();
  const code = (await transform(await readFile(new URL('../components/LivePortfolios.jsx', import.meta.url), 'utf8'), {
    filename: 'LivePortfolios.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
      transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
  })).code;
  let active;
  const hooks = {
    useState(initial) { const instance = active, at = instance.position++;
      if (!instance.slots[at]) instance.slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [instance.slots[at].value, value => { if (!instance.disposed)
        instance.slots[at].value = typeof value === 'function' ? value(instance.slots[at].value) : value; }]; },
    useRef(initial) { const instance = active, at = instance.position++; return instance.slots[at] ??= { current: initial }; },
    useEffect(fn, deps) { const instance = active, at = instance.position++, previous = instance.slots[at];
      if (!previous || deps.some((value, index) => value !== previous.deps[index]))
        instance.effects.push(() => { previous?.cleanup?.(); instance.slots[at] = { deps, cleanup: fn() }; }); },
  };
  const modules = {
    react: hooks,
    '../lib/live-portfolios.mjs': { portfolioPageActionReady: () => false, portfolioCreateActionReady: () => false,
      portfolioSelectedActionReady: () => false, portfolioOrderActionReady: () => false,
      readPortfolioPage, readPortfolioDisplayRow: () => assert.fail('Overview must not start a detail read.'), ...overrides },
    '../lib/display-snapshot.mjs': { readDisplaySnapshot: () => null,
      displayOnlySnapshot: result => ({ ...result, source: { ...result.source, stale: true, transactionReady: false } }),
      writeDisplaySnapshot: () => true },
    './LivePortfolios.css': {},
  };
  for (const name of ['./LiveYieldChart', './ActivityOperation', './PortfolioCapacity', './BudgetPurchaseQueue'])
    modules[name] = { __esModule: true, default: () => null };
  const exported = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(name => modules[name] ?? require(name),
    exported, exported.exports, { sessionStorage: {} });
  const Component = exported.exports.default;
  const provider = { request: () => assert.fail('A displayed overview must not read wallet or RPC state.') };
  const config = { kind: 'integrated-v2', productFamily: 'fresh-v4', displayOnly: true,
    artifactDigest: 'cache-ui-fixture', stage: 'fresh-active', factory: address('a'),
    portfolioFactory: address('b'), portfolioMarket: address('c') };
  function mount({ generation = '0:0', account = address('d'), ...options } = {}) {
    const instance = { slots: [], effects: [], position: 0, disposed: false, latest: null };
    const props = { config, provider, account, locale: 'zh', mode: 'overview',
      refreshKey: 0, displayRefreshKey: generation,
      renderDirectory: value => { instance.latest = value; return null; }, ...options };
    instance.update = values => Object.assign(props, values);
    instance.render = () => { active = instance; instance.position = 0; instance.tree = Component(props); active = null;
      while (instance.effects.length) instance.effects.shift()(); };
    instance.settle = async () => { await turn(); instance.render(); await turn(); instance.render(); };
    instance.unmount = () => { for (const slot of instance.slots) slot?.cleanup?.(); instance.disposed = true; };
    instance.render(); return instance;
  }
  return { mount, provider, config };
}

test('the overview paints its previous verified rows while a new generation refreshes in the background', async () => {
  const oldNow = Date.now; let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const firstRow = { pool: address('1') }, nextRow = { pool: address('2') };
    const source = { displayOnly: true, indexedThrough: 100 };
    let release, reads = 0;
    const ui = await portfolioUi(async () => {
      reads++;
      if (reads === 1) return { items: [firstRow], nextCursor: null, source, operator: null };
      if (reads === 2) return new Promise(resolve => { release = () => resolve({ items: [nextRow], nextCursor: null,
        source: { ...source, indexedThrough: 101 }, operator: null }); });
      return { items: [nextRow], nextCursor: null, source, operator: null };
    });
    const first = ui.mount(); await first.settle();
    assert.equal(reads, 1); assert.deepEqual(first.latest.rows, [firstRow]); first.unmount();

    const refreshed = ui.mount({ generation: '0:1' }); await refreshed.settle();
    assert.equal(reads, 2); assert.deepEqual(refreshed.latest.rows, [firstRow]);
    assert.equal(refreshed.latest.loaded, true); assert.equal(refreshed.latest.loading, true);
    assert.equal(refreshed.latest.current, false, 'Cached display does not grant a current page read.');
    refreshed.render(); await turn(); assert.equal(reads, 2, 'Re-rendering cannot start a parallel copy.');
    release(); await refreshed.settle();
    assert.deepEqual(refreshed.latest.rows, [nextRow]); assert.equal(refreshed.latest.loading, false);
    refreshed.unmount();

    const sameGeneration = ui.mount({ generation: '0:1' }); await sameGeneration.settle();
    assert.equal(reads, 2, 'A just completed visible page is reused within the short GET cadence.');
    sameGeneration.unmount();

    now += 30_001;
    const older = ui.mount({ generation: '0:1' }); await older.settle();
    assert.deepEqual(older.latest.rows, [nextRow]); assert.equal(reads, 3);
    older.unmount();
  } finally { Date.now = oldNow; }
});

test('two visible mounts share one in-flight overview read for the same provider and wallet', async () => {
  let release, reads = 0;
  const ui = await portfolioUi(async () => { reads++; return new Promise(resolve => { release = () => resolve({
    items: [{ pool: address('1') }], nextCursor: null, operator: null,
    source: { displayOnly: true, indexedThrough: 100 },
  }); }); });
  const first = ui.mount(), second = ui.mount();
  await turn(); first.render(); second.render();
  assert.equal(reads, 1, 'The concurrent page mounts share the existing GET.');
  release(); await first.settle(); await second.settle();
  assert.equal(first.latest.rows.length, 1); assert.equal(second.latest.rows.length, 1);
  first.unmount(); second.unmount();
});

test('a wallet switch cannot paint or share the prior account overview', async () => {
  let release, reads = 0;
  const ui = await portfolioUi(async () => {
    reads++;
    if (reads === 1) return { items: [{ pool: address('1') }], nextCursor: null, operator: null,
      source: { displayOnly: true, indexedThrough: 100 } };
    return new Promise(resolve => { release = () => resolve({ items: [], nextCursor: null, operator: null,
      source: { displayOnly: true, indexedThrough: 101 } }); });
  });
  const owner = ui.mount({ account: address('d') }); await owner.settle(); owner.unmount();
  const other = ui.mount({ account: address('e') }); await other.settle();
  assert.equal(reads, 2); assert.deepEqual(other.latest.rows, []);
  assert.equal(other.latest.loaded, false);
  release(); await other.settle(); other.unmount();
});

test('an automatic overview refresh keeps 40 expanded rows and their cursor, while a manual first-page read remains immediate', async () => {
  const first = Array.from({ length:20 }, (_,i) => ({ pool:`0x${(i+1).toString(16).padStart(40,'0')}` }));
  const second = Array.from({ length:20 }, (_,i) => ({ pool:`0x${(i+21).toString(16).padStart(40,'0')}` }));
  let reads=0;
  const ui=await portfolioUi(async (_config,_provider,{cursor})=>{reads++;
    return {items:cursor?second:first,nextCursor:cursor?40:20,operator:null,source:{displayOnly:true,indexedThrough:100}};});
  const instance=ui.mount();await instance.settle();
  await instance.latest.load(20);await instance.settle();
  assert.equal(instance.latest.rows.length,40);assert.equal(instance.latest.cursor,40);assert.equal(reads,2);
  instance.update({displayRefreshKey:'0:1'});await instance.settle();
  assert.equal(reads,2,'A silent read never replaces an expanded old-source window with a fresh first page.');
  assert.equal(instance.latest.rows.length,40);assert.equal(instance.latest.cursor,40);assert.equal(instance.latest.loading,false);
  instance.update({refreshKey:1,displayRefreshKey:'1:1'});await instance.settle();
  assert.equal(reads,3,'A settled transaction generation refreshes expanded balances immediately.');
  await instance.latest.load();await instance.settle();
  assert.equal(reads,4);assert.equal(instance.latest.rows.length,20);assert.equal(instance.latest.cursor,20);
  instance.unmount();
});

test('an in-place automatic portfolio refresh keeps rows and controls while its one GET is pending', async () => {
  const row={pool:address('1')};let release,reads=0;
  const ui=await portfolioUi(async()=>{reads++;if(reads===1)return {items:[row],nextCursor:null,source:{displayOnly:true,indexedThrough:100}};
    return new Promise(resolve=>{release=()=>resolve({items:[row],nextCursor:null,source:{displayOnly:true,indexedThrough:101}});});});
  const instance=ui.mount();await instance.settle();
  instance.update({displayRefreshKey:'0:1'});await instance.settle();
  assert.equal(reads,2);assert.deepEqual(instance.latest.rows,[row]);assert.equal(instance.latest.loading,false);
  await instance.latest.load();assert.equal(reads,2,'Manual refresh cannot overlap the slow automatic request.');
  instance.update({displayRefreshKey:'0:2'});await instance.settle();assert.equal(reads,2);
  release();await instance.settle();await instance.settle();
  // A newer invalidation waits for the current read to finish, then starts one successor.
  assert.equal(reads,3);release();await instance.settle();instance.unmount();
});

const walk = node => node && typeof node==='object'
  ? [node,...[node.props?.children].flat(Infinity).flatMap(walk)] : [];
const element = (instance,predicate) => walk(instance.tree).find(predicate);
const text = node => [node?.props?.children].flat(Infinity).map(value=>typeof value==='string'?value:'').join('');
function portfolioRow(account,children) {
  return {pool:address('1'),account,state:2n,activeChildCount:BigInt(children.length),childCount:200n,
    budgetWei:1n,totalSupply:100n,shares:10n,withdrawableBnb:0n,claimableBem:0n,
    unitPriceWei:1n,spentWei:1n,availableShares:10n,lockedShares:0n,shareTradingAllowed:true,
    children,timestamp:100n,nextRoundAt:0n,proposal:null};
}

test('normal 100-child detail refresh preserves chosen child and input, and explicitly expanded children remain pinned until manual refresh', async () => {
  const account=address('d'), children=Array.from({length:100},(_,i)=>({pool:`0x${(i+1).toString(16).padStart(40,'0')}`,
    tokenId:BigInt(i+1),state:2n,sold:false,official:true,costWei:1n}));
  let reads=0;const row=portfolioRow(account,children);
  const ui=await portfolioUi(()=>assert.fail('A selected initial pool needs only its detail GET.'),{
    readPortfolioDisplayRow:async()=>{reads++;return {item:row,source:{displayOnly:true,indexedThrough:100}};},
    readPortfolioDisplayChildren:async()=>[{...children[0],pool:address('e'),tokenId:101n}],
  });
  // Market credit is a separate user-visible reader; omit it in this display-only fixture.
  ui.config.portfolioMarket=null;
  const instance=ui.mount({mode:'portfolio',initialPool:row.pool,renderDirectory:undefined});await instance.settle();
  const chosen=children[74].pool;
  const choose=()=>element(instance,node=>node.type==='select');
  const price=()=>element(instance,node=>node.type==='input'&&node.props.inputMode==='decimal'&&!node.props.placeholder);
  choose().props.onChange({target:{value:chosen}});price().props.onChange({target:{value:'0.042'}});instance.render();
  const capacityKey=element(instance,node=>node.props?.portfolio===row)?.key;
  instance.update({displayRefreshKey:'0:1'});await instance.settle();
  assert.equal(reads,2,'The first 100 children are normal first-page data and still refresh.');
  assert.equal(choose().props.value,chosen);assert.equal(price().props.value,'0.042');
  assert.equal(element(instance,node=>node.props?.portfolio===row)?.key,capacityKey,'A block refresh does not remount the capacity details.');
  const more=element(instance,node=>node.type==='button'&&text(node)==='加载更多子矿机');
  more.props.onClick();await instance.settle();
  assert.equal(walk(instance.tree).filter(node=>node.type==='tr').length,102);
  instance.update({displayRefreshKey:'0:2'});await instance.settle();
  assert.equal(reads,2);assert.equal(choose().props.value,chosen);assert.equal(price().props.value,'0.042');
  instance.update({refreshKey:1,displayRefreshKey:'1:2'});await instance.settle();
  assert.equal(reads,3,'A settled transaction refreshes balances even after children were expanded.');
  const manual=element(instance,node=>node.type==='button'&&text(node)==='刷新项目');
  manual.props.onClick();await instance.settle();assert.equal(reads,4);
  instance.unmount();
});
