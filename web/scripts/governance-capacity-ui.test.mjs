import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';
import * as capacity from '../lib/capacity-input.mjs';

const require = createRequire(import.meta.url);
await loadBindings();
const code = (await transform(await readFile(new URL('../components/LiveGovernance.jsx', import.meta.url), 'utf8'), {
  filename: 'LiveGovernance.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
    transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
})).code;
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness({prepareWait,actionWait,snapshotOverride={}}={}) {
  const slots = [], effects = [], snapshotReads=[], acceptedSnapshots=[]; let position = 0, tree, preparedAction, sends=0;
  let nextReadFails = false, nextActionProblem;
  const ReferenceAction=()=>null;
  const hooks = {
    useState(initial) { const at = position++; if (!slots[at]) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[at].value, value => { slots[at].value = typeof value === 'function' ? value(slots[at].value) : value; }]; },
    useRef(initial) { const at = position++; return slots[at] ??= { current: initial }; },
    useEffect(fn, deps) { const at = position++, previous = slots[at];
      if (!previous || deps.some((dep, index) => dep !== previous.deps[index]))
        effects.push(() => { previous?.cleanup?.(); slots[at] = { deps, cleanup: fn() }; }); },
  };
  const pool = '0x' + 'aa'.repeat(20), account = '0x' + 'bb'.repeat(20), factory = '0x' + 'cc'.repeat(20);
  const config = {factory, stage:'fresh-active', displayOnly:true, testProfile:true};
  const snapshot = {pool, account, factory, stage:config.stage, displayOnly:true, state:2n, timestamp:1700000000n,
    activatedAt:1600000000n, shares:100n, snapshotShares:0n, purchaseCost:40400000000000000n,
    candidates:[], activeProposalId:0n, listedProposalId:0n, saleReference:{available:false},...snapshotOverride};
  const modules = {
    react: hooks,
    '../lib/capacity-input.mjs': capacity,
    '../app/live-governance.css': {},
    './FirstoSaleReferenceAction': {__esModule:true,default:ReferenceAction},
    '../lib/live-governance.mjs': {
      readGovernanceSnapshot:async (_provider,options) => {snapshotReads.push(options);
        if(nextReadFails){nextReadFails=false;throw new Error('HTTP 502');}return snapshot;},
      proposalReferenceRecord:() => ({refPriceWei:snapshot.purchaseCost.toString(),refAt:snapshot.activatedAt.toString()}),
      prepareGovernanceAction:async (_provider,{action}) => { preparedAction=action;
        if(prepareWait)await prepareWait;
        return {snapshot,quote:{priceWei:BigInt(action.priceWei),paymentWei:0n}}; },
    },
  };
  const exported={exports:{}};
  new Function('require','module','exports',code)(name=>modules[name]??require(name),exported,exported.exports);
  const Component=exported.exports.default;
  let props={config,account,selectedPool:pool,wallet:{request:()=>assert.fail('No transaction is sent by price entry')},
    readProvider:{request:()=>assert.fail('Cached fixture handles this read')},
    poolParams:{circuits:'0x'+'dd'.repeat(20),circuitId:16736n},
    onReferenceAction:async()=>assert.fail('The shared component is mocked; no reference signature or transaction is requested'),
    onAction:async()=>{sends++;if(actionWait)await actionWait;
      if(nextActionProblem){const problem=nextActionProblem;nextActionProblem=undefined;throw problem;}},
    onSnapshot:next=>acceptedSnapshots.push(next),
    capacityQuote:{available:true,pool,estimated24hAtomic:432000n,observedAt:Date.now()-1000,validUntil:Date.now()+120000}};
  const render=()=>{position=0;tree=Component(props);while(effects.length)effects.shift()();};
  const settle=async()=>{for(let i=0;i<4;i++){await turn();render();}};
  const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(child=>nodes(child))
    :[node,...nodes(node.props?.children)];
  const input=field=>nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']===(field==='sale'
    ?'拟出售整机价（BNB）':'日产能价（BNB / (BEM/天)）'));
  const edit=(field,value)=>{input(field).props.onFocus();render();input(field).props.onChange({target:{value}});render();
    input(field).props.onBlur();render();};
  const preview=async()=>{const button=nodes(tree).find(node=>node.type==='button'&&Array.isArray(node.props.children)
    &&node.props.children[0]==='预览提案');assert(button&&!button.props.disabled);button.props.onClick();await settle();return preparedAction;};
  render();
  return {settle,edit,preview,input,render,updateCapacity(quote){props={...props,capacityQuote:quote};render();},
    allNodes(){return nodes(tree);},failNextRead(){nextReadFails=true;},failNextAction(problem){nextActionProblem=problem;},
    hasPreview(){return nodes(tree).some(node=>node.props?.role==='dialog');},
    reference(){return nodes(tree).find(node=>node.type===ReferenceAction);},
    get props(){return props;},get snapshotReads(){return snapshotReads;},get acceptedSnapshots(){return acceptedSnapshots;},
    executeButton(){return nodes(tree).find(node=>node.type==='button'&&node.props.children==='执行挂牌');},
    async submit(){const button=nodes(tree).find(node=>node.type==='button'&&node.props.children==='发送到钱包确认');
      assert(button&&!button.props.disabled);await button.props.onClick();await settle();},
    get sends(){return sends;},
    quote:props.capacityQuote,dispose(){for(const slot of slots)slot?.cleanup?.();}};
}

test('governance keeps an eighteen-decimal sale input after blur and sends the exact entered price', async () => {
  const ui=harness();try {
    await ui.settle();ui.edit('sale','0.015001234567890123');
    assert.equal(ui.input('sale').props.value,'0.01500');
    assert.equal(ui.input('capacity').props.value,'3.47251');
    ui.input('sale').props.onFocus();ui.render();
    assert.equal(ui.input('sale').props.value,'0.015001234567890123');
    ui.input('sale').props.onBlur();ui.render();
    assert.equal((await ui.preview()).priceWei,'15001234567890123');
  }finally{ui.dispose();}
});

test('passive focus of the linked sale display never changes the capacity-derived exact transaction price', async () => {
  const ui=harness();try {
    await ui.settle();ui.edit('capacity','0.01000');
    assert.equal(ui.input('sale').props.value,'0.00004');
    ui.input('sale').props.onFocus();ui.render();
    assert.equal(ui.input('sale').props.value,'0.0000432');
    ui.input('sale').props.onBlur();ui.render();
    assert.equal((await ui.preview()).priceWei,'43200000000000');
  }finally{ui.dispose();}
});

test('a positive capacity-derived sale below display precision remains visible and sends positive wei', async () => {
  const ui=harness();try {
    await ui.settle();ui.edit('capacity','0.000000001');
    assert.equal(ui.input('sale').props.value,'<0.00001');
    assert.equal((await ui.preview()).priceWei,'4320000');
  }finally{ui.dispose();}
});

test('a changed daily output recomputes from the exact capacity source before preview', async () => {
  const ui=harness();try {
    await ui.settle();ui.edit('capacity','0.01000');
    ui.updateCapacity({...ui.quote,estimated24hAtomic:497450n});await ui.settle();
    assert.equal((await ui.preview()).priceWei,'49745000000000');
  }finally{ui.dispose();}
});

test('a daily output change while an unsigned proposal preview is pending cannot revive the old price', async () => {
  let finish;const prepareWait=new Promise(resolve=>{finish=resolve;});
  const ui=harness({prepareWait});try {
    await ui.settle();ui.edit('capacity','0.01000');await ui.preview();
    ui.updateCapacity({...ui.quote,estimated24hAtomic:497450n});
    finish();await ui.settle();
    assert.equal(ui.hasPreview(),false);
    assert.equal(ui.sends,0);
    assert.equal(ui.input('sale').props.value,'0.00005','The current linked display still updates while preview was busy.');
  }finally{finish();ui.dispose();}
});

test('capacity-derived preview checks expiry at submit time even before the fifteen-second UI timer', async () => {
  const originalNow=Date.now;let now=1700000000000;Date.now=()=>now;
  const ui=harness();try {
    await ui.settle();ui.edit('capacity','0.01000');await ui.preview();assert.equal(ui.hasPreview(),true);
    now=ui.quote.validUntil+1;
    await ui.submit();assert.equal(ui.hasPreview(),false);assert.equal(ui.sends,0);
  }finally{ui.dispose();Date.now=originalNow;}
});

test('expired daily output does not add a new dependency to a directly entered whole-miner price', async () => {
  const originalNow=Date.now;let now=1700000000000;Date.now=()=>now;
  const ui=harness();try {
    await ui.settle();ui.edit('sale','0.015001234567890123');await ui.preview();
    now=ui.quote.validUntil+1;
    await ui.submit();assert.equal(ui.sends,1);
  }finally{ui.dispose();Date.now=originalNow;}
});

test('a passed sale with missing reference passes its current identity to the shared action and refreshes after update', async () => {
  const candidate={id:1n,proposer:'0x'+'bb'.repeat(20),priceWei:40000000000000000n,executed:false,passed:true,
    canExecute:false,discounted:null,yesShares:100n,yesCount:1n,requiredYesShares:51n,requiredYesCount:1n,
    hasVoted:true,endsAt:1700086400n};
  const ui=harness({snapshotOverride:{candidates:[candidate],activeProposalId:1n,snapshotShares:100n}});try {
    await ui.settle();const action=ui.reference();assert(action);
    assert.equal(action.props.config,ui.props.config);assert.equal(action.props.pool,ui.props.selectedPool);
    assert.equal(action.props.onAction,undefined,'Reference reads cannot request an administrator signature.');
    assert.equal(action.props.disabled,false);assert.equal(ui.executeButton().props.disabled,true,
      'A passed vote cannot bypass the missing-reference business gate.');
    assert.equal(ui.snapshotReads.length,1);assert.equal(ui.snapshotReads[0].force,false);
    action.props.onUpdated();await ui.settle();
    assert.equal(ui.snapshotReads.length,2);assert.equal(ui.snapshotReads[1].force,true);
    assert.equal(ui.executeButton().props.disabled,true,'The refresh fixture still has no on-chain reference.');
    assert.equal(ui.sends,0);
  }finally{ui.dispose();}
});

test('confirmation is modal and cannot close or send twice while its exact action awaits the wallet', async () => {
  let finish;const actionWait=new Promise(resolve=>{finish=resolve;});
  const ui=harness({actionWait});try {
    await ui.settle();ui.edit('sale','0.015001234567890123');await ui.preview();
    const find=predicate=>ui.allNodes().find(predicate);
    const dialog=()=>find(node=>node.props?.role==='dialog');
    assert.equal(dialog().props['aria-modal'],'true');
    assert.equal((find(node=>node.type==='footer')).props.className,'live-gov-preview-footer');
    assert.equal(ui.sends,0,'Opening the overlay only prepares an unsigned action.');
    const send=find(node=>node.type==='button'&&node.props.children==='发送到钱包确认');
    send.props.onClick();ui.render();assert.equal(ui.sends,1);assert.equal(dialog().props['aria-busy'],true);
    const close=find(node=>node.props?.['aria-label']==='关闭确认弹窗');
    assert.equal(close.props.disabled,true);close.props.onClick();
    const overlay=find(node=>node.props?.className==='live-gov-preview-overlay'),backdrop={};
    overlay.props.onClick({target:backdrop,currentTarget:backdrop});send.props.onClick();ui.render();
    assert(dialog(),'Wallet confirmation stays visible while the action is pending.');assert.equal(ui.sends,1);
    finish();await ui.settle();assert.equal(dialog(),undefined);assert.equal(ui.sends,1);
  }finally{finish();ui.dispose();}
});

test('a failed refresh preserves the known deployed review rule and snapshot while blocking all wallet actions', async () => {
  const ui=harness({snapshotOverride:{saleReviewThresholdBps:8000n}});try {
    await ui.settle();ui.edit('sale','0.01500');ui.failNextRead();
    ui.allNodes().find(node=>node.props?.className==='live-gov-refresh').props.onClick();await ui.settle();
    const text=node=>!node?'':typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):
      typeof node==='object'?text(node.props?.children):'';
    assert(ui.allNodes().some(node=>node.props?.className==='live-gov-metrics'));
    const header=ui.allNodes().find(node=>node.props?.className==='live-section-head');
    assert.match(text(header),/80%/);assert.doesNotMatch(text(header),/100%/);
    assert(ui.allNodes().some(node=>node.props?.role==='alert'&&text(node).includes('HTTP 502')));
    const propose=ui.allNodes().find(node=>node.type==='button'&&Array.isArray(node.props.children)&&node.props.children[0]==='预览提案');
    assert.equal(propose.props.disabled,true);propose.props.onClick();await ui.settle();
    assert.equal(ui.hasPreview(),false);assert.equal(ui.sends,0);
    assert.equal(ui.acceptedSnapshots.length,1,'A failed read never publishes an old snapshot as a successful refresh.');
    ui.allNodes().find(node=>node.props?.className==='live-gov-refresh').props.onClick();await ui.settle();
    assert.equal(ui.acceptedSnapshots.length,2);await ui.preview();assert.equal(ui.hasPreview(),true,
      'A successful current read unlocks the next exact preview.');
  }finally{ui.dispose();}
});

test('input validation and a rejected wallet request allow a fresh exact preview without reloading the page', async () => {
  const ui=harness();try {
    await ui.settle();ui.edit('sale','0');await ui.preview();assert.equal(ui.hasPreview(),false);
    assert(ui.allNodes().some(node=>node.props?.role==='alert'));
    ui.edit('sale','0.015001234567890123');assert.equal((await ui.preview()).priceWei,'15001234567890123');
    ui.failNextAction(Object.assign(new Error('用户取消交易'),{code:'ACTION_REJECTED'}));await ui.submit();
    assert.equal(ui.hasPreview(),false);assert.equal(ui.sends,1);
    assert.equal(ui.snapshotReads.length,1,'A wallet rejection does not need a snapshot refresh to retry.');
    assert.equal((await ui.preview()).priceWei,'15001234567890123');assert.equal(ui.hasPreview(),true);
    await ui.submit();assert.equal(ui.sends,2);
  }finally{ui.dispose();}
});

test('only successful current business snapshots reach the parent and absent review policy stays unnumbered', async () => {
  const ui=harness();try {
    await ui.settle();assert.equal(ui.acceptedSnapshots.length,1);
    assert.equal(ui.acceptedSnapshots[0].pool,ui.props.selectedPool);
    const text=node=>!node?'':typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):
      typeof node==='object'?text(node.props?.children):'';
    const header=ui.allNodes().find(node=>node.props?.className==='live-section-head');
    assert.match(text(header),/规定比例/);assert.doesNotMatch(text(header),/100%|80%/);
    ui.edit('sale','0.01500');await ui.preview();assert.equal(ui.acceptedSnapshots.length,2);
    assert.equal(ui.acceptedSnapshots[1],ui.acceptedSnapshots[0],'The callback receives the actual prepared snapshot object.');
    assert.equal(ui.sends,0,'Parent display updates cannot submit a transaction.');
  }finally{ui.dispose();}
});
