import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Interface, ZeroHash } from 'ethers';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';
import * as upgrade from '../lib/sale-policy-upgrade.mjs';
import { FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR, FRESH_BALANCE_ENFORCER } from '../../deploy/shared/fresh-activation-execution.mjs';

const require=createRequire(import.meta.url);
await loadBindings();
const code=(await transform(await readFile(new URL('../components/FreshSaleUpgradePanel.jsx',import.meta.url),'utf8'),{
  filename:'FreshSaleUpgradePanel.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},target:'es2022',
    transform:{react:{runtime:'automatic'}}},module:{type:'commonjs'},
})).code;
const address=n=>'0x'+n.toString(16).padStart(40,'0');
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const actual=JSON.parse(await readFile(new URL('./fixtures/sale-upgrade-wrapped-schedule.json',import.meta.url),'utf8'));
const runtimes=JSON.parse(await readFile(new URL('../../deploy/fixtures/fresh-activation-envelope.json',import.meta.url),'utf8')).runtimeProof;
const manager=new Interface(['function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)']);
const permissionContext=manager.decodeFunctionData('redeemDelegations',actual.tx.input)[0][0];
const names=['SaleGovernance','PoolVault','BudgetPortfolioVault','ShareMarket'];
const iface=new Interface(['function getMinDelay() view returns(uint256)','function PROPOSER_ROLE() view returns(bytes32)',
  'function hasRole(bytes32,address) view returns(bool)','function getTimestamp(bytes32) view returns(uint256)',
  'function implementation() view returns(address)','function OFFICIAL_FACTORY() view returns(address)',
  'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  'function executeBatch(address[],uint256[],bytes[],bytes32,bytes32) payable',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)']);
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const catalog={schemaVersion:1,kind:'fresh-sale-policy-upgrade-v1',profile:'full-test',chainId:56,
  genesisArtifactDigest:hash(1),candidateArtifactDigest:hash(2),minimumDelaySeconds:0,
  bindings:Object.fromEntries(['factory','portfolioFactory','beacon','portfolioBeacon','shareMarket','timelock','authority','gasWallet','proposer']
    .map((name,index)=>[name,address(index+1)])),
  expectedImplementations:{PoolVault:address(20),BudgetPortfolioVault:address(21),ShareMarket:address(22)},
  libraries:{},artifacts:Object.fromEntries(names.map((name,index)=>[name,{abi:[],bytecode:'0x0'+(index+1),
    deployedBytecode:name==='SaleGovernance'?'0x73'+'00'.repeat(20)+'00':'0x6000',
    linkReferences:{},deployedLinkReferences:{},immutableReferences:{}}]))};
catalog.bindings.proposer=actual.tx.from;

function fixture(mode='') {
  const store=new Map(),transactions=new Map(),codes=new Map(),contracts=new Map(),listeners=new Map();
  let account=catalog.bindings.proposer,chain='0x38',scheduled=0n,next=100,usedMode=false;
  let implementations={...catalog.expectedImplementations};
  const deployed={},requests=[],broadcasts=[];
  const runtimeReads=[];
  const putTransaction=(name,{input,status='0x1'}={})=>{
    const id=next++,transactionHash=hash(id),contractAddress=address(id+1000);
    const data=input??upgrade.upgradeDeployment(catalog,name,deployed);
    const tx={hash:transactionHash,from:catalog.bindings.proposer,to:null,input:data,value:'0x0',chainId:'0x38'};
    const receipt={transactionHash,status,contractAddress:status==='0x1'?contractAddress:null,blockNumber:'0x64'};
    transactions.set(transactionHash,{tx,receipt});
    if(status==='0x1'){
      deployed[name]=contractAddress;contracts.set(contractAddress,name);
      codes.set(contractAddress,name==='SaleGovernance'?'0x73'+contractAddress.slice(2)+'00':'0x6000');
    }
    return {hash:transactionHash,address:contractAddress,data};
  };
  const provider={on(name,fn){listeners.set(name,fn);},removeListener(name){listeners.delete(name);},
    async request({method,params=[]}){
      requests.push(method);
      if(method==='eth_chainId')return chain;
      if(method==='eth_accounts'||method==='eth_requestAccounts')return [account];
      if(method==='eth_getTransactionReceipt')return transactions.get(params[0])?.receipt??null;
      if(method==='eth_getTransactionByHash')return transactions.get(params[0])?.tx??null;
      if(method==='eth_getCode'){
        const fixed=[[FRESH_DELEGATION_MANAGER,'managerCode'],[FRESH_DELEGATOR,'delegatorCode'],[FRESH_BALANCE_ENFORCER,'enforcerCode']]
          .find(([contract])=>contract.address.toLowerCase()===params[0].toLowerCase());
        if(fixed){runtimeReads.push(fixed[1]);return mode==='wrapped-bad-runtime'?'0x6001':runtimes[fixed[1]];}
        return mode==='bad-runtime'?'0x6001':codes.get(params[0].toLowerCase())??'0x';
      }
      if(method==='eth_getStorageAt')return '0x'+implementations.ShareMarket.slice(2).padStart(64,'0');
      if(method==='eth_getBlockByNumber')return {timestamp:'0x64'};
      if(method==='eth_call'){
        const {to,data}=params[0],fn=iface.getFunction(data.slice(0,10));let value;
        if(fn.name==='getMinDelay')value=0n;
        if(fn.name==='PROPOSER_ROLE')value=ZeroHash;
        if(fn.name==='hasRole')value=true;
        if(fn.name==='getTimestamp')value=scheduled;
        if(fn.name==='implementation')value=to===catalog.bindings.beacon?implementations.PoolVault:implementations.BudgetPortfolioVault;
        if(fn.name==='OFFICIAL_FACTORY')value=contracts.get(to.toLowerCase())==='PoolVault'?catalog.bindings.factory:catalog.bindings.portfolioFactory;
        return iface.encodeFunctionResult(fn,[value]);
      }
      if(method==='eth_sendTransaction'){
        const tx=params[0];
        const name=tx.to?iface.getFunction(tx.data.slice(0,10)).name:names[Number.parseInt(tx.data.slice(2,4),16)-1];
        broadcasts.push({name,tx});
        if(mode==='reject-schedule'&&name==='scheduleBatch'&&!usedMode){usedMode=true;throw {code:4001,message:'cancelled'};}
        let item;
        if(!tx.to)item=putTransaction(name,{input:tx.data,status:mode==='failed-first'&&!usedMode?'0x0':'0x1'});
        else{
          const transactionHash=hash(next++),batch=upgrade.upgradeBatch(catalog,deployed),blockHash=hash(8000);
          const wrapped=mode.startsWith('wrapped');
          const inner=`0x${catalog.bindings.timelock.slice(2)}${'00'.repeat(32)}${tx.data.slice(2)}`;
          const input=wrapped?manager.encodeFunctionData('redeemDelegations',[[permissionContext],[ZeroHash],
            [mode==='wrapped-bad-inner'?'0x'+address(777).slice(2)+inner.slice(42):inner]]):tx.data;
          const outer={...tx,to:wrapped?FRESH_DELEGATION_MANAGER.address:tx.to,input,
            hash:transactionHash,nonce:'0x10',type:'0x2',blockNumber:'0x64',blockHash};
          const eventName=name==='scheduleBatch'?'CallScheduled':'CallExecuted';
          const logs=batch.targets.map((target,index)=>({address:catalog.bindings.timelock,transactionHash,
            blockHash,blockNumber:'0x64',removed:false,...iface.encodeEventLog(iface.getEvent(eventName),
              name==='scheduleBatch'?[batch.operationId,index,target,batch.values[index],
                mode==='wrapped-wrong-batch'&&index===1?batch.payloads[index]+'00':batch.payloads[index],batch.predecessor,0n]
                :[batch.operationId,index,target,batch.values[index],batch.payloads[index]])}));
          if(name==='scheduleBatch')logs.push({address:catalog.bindings.timelock,transactionHash,blockHash,blockNumber:'0x64',removed:false,
            ...iface.encodeEventLog(iface.getEvent('CallSalt'),[batch.operationId,batch.salt])});
          transactions.set(transactionHash,{tx:outer,receipt:{status:'0x1',transactionHash,from:outer.from,to:outer.to,
            blockNumber:'0x64',blockHash,logs}});
          item={hash:transactionHash};
          if(name==='scheduleBatch')scheduled=100n;
          if(name==='executeBatch'){implementations={PoolVault:deployed.PoolVault,BudgetPortfolioVault:deployed.BudgetPortfolioVault,ShareMarket:deployed.ShareMarket};scheduled=1n;}
        }
        if(mode==='failed-first'&&!usedMode)usedMode=true;
        if(mode==='ambiguous-first'&&!usedMode){usedMode=true;throw new Error('transport unavailable');}
        if(mode==='account-change'&&!usedMode){usedMode=true;account=address(900);listeners.get('accountsChanged')?.([account]);}
        return item.hash;
      }
      throw new Error('Unexpected wallet method '+method);
    }};
  const key=`bemine.sale-upgrade.v1:full-test:${catalog.bindings.factory.toLowerCase()}:${catalog.candidateArtifactDigest}:${catalog.bindings.proposer}`;
  const save=record=>store.set(key,JSON.stringify({candidateArtifactDigest:catalog.candidateArtifactDigest,
    account:catalog.bindings.proposer,steps:{},deployed:{},...record}));
  return {provider,store,requests,broadcasts,key,transactions,codes,putTransaction,save,runtimeReads,
    get record(){return JSON.parse(store.get(key)||'null');},
    switchAccount(value){account=value;listeners.get('accountsChanged')?.([value]);},
    switchChain(value){chain=value;listeners.get('chainChanged')?.(value);},
    forgeActivated(){implementations={PoolVault:address(500),BudgetPortfolioVault:address(501),ShareMarket:address(502)};scheduled=1n;return {...implementations};}};
}

function harness(state=fixture()) {
  const slots=[],effects=[];let at=0,tree;
  const hooks={useState(initial){const index=at++;slots[index]??={value:typeof initial==='function'?initial():initial};
    return [slots[index].value,value=>{slots[index].value=typeof value==='function'?value(slots[index].value):value;}];},
    useRef(initial){return slots[at++]??={current:initial};},
    useEffect(fn,deps){const index=at++,previous=slots[index];
      if(!previous||deps.some((value,i)=>value!==previous.deps[i]))effects.push(()=>{previous?.cleanup?.();slots[index]={deps,cleanup:fn()};});}};
  const oldWindow=globalThis.window,oldFetch=globalThis.fetch,oldFamily=process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY;
  globalThis.window={ethereum:state.provider,localStorage:{getItem:key=>state.store.get(key)??null,setItem:(key,value)=>state.store.set(key,value)}};
  globalThis.fetch=async()=>({ok:true,json:async()=>catalog});process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY='full-test';
  const exported={exports:{}};
  new Function('require','module','exports',code)(name=>name==='react'?hooks:name==='../lib/sale-policy-upgrade.mjs'?upgrade:require(name),exported,exported.exports);
  if(oldFamily===undefined)delete process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY;else process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY=oldFamily;
  const Component=exported.exports.default;
  const render=()=>{at=0;tree=Component();while(effects.length)effects.shift()();};
  const settle=async()=>{for(let i=0;i<8;i++){await turn();render();}};
  const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)];
  const button=label=>nodes(tree).find(node=>node.type==='button'&&node.props.children===label);
  const click=async label=>{const node=button(label);assert(node&&!node.props.disabled,`Unavailable button: ${label}`);node.props.onClick();await settle();};
  render();
  return {state,settle,render,button,click,nodes:()=>nodes(tree),
    async connect(){await settle();await click('连接部署钱包');},
    async run(){await click(button('开始启用')?'开始启用':button('同步升级状态')?'同步升级状态':'继续启用');},
    error(){return nodes(tree).find(node=>node.props?.role==='alert')?.props.children||'';},
    notices(){return nodes(tree).filter(node=>node.props?.role==='status').map(node=>node.props.children);},
    dispose(){for(const slot of slots)slot?.cleanup?.();globalThis.window=oldWindow;globalThis.fetch=oldFetch;}};
}

test('the actual upgrade panel sends four bound deployments then one atomic Timelock batch',async()=>{
  const ui=harness();try{
    await ui.connect();await ui.run();
    assert.equal(ui.error(),'');assert.deepEqual(ui.state.broadcasts.map(item=>item.name),[...names,'scheduleBatch','executeBatch']);
    for(const name of ['PoolVault','BudgetPortfolioVault']){
      const tx=ui.state.broadcasts.find(item=>item.name===name).tx;
      assert.equal(tx.data.slice(-40),catalog.bindings[name==='PoolVault'?'factory':'portfolioFactory'].slice(2));
    }
    const schedule=ui.state.broadcasts.find(item=>item.name==='scheduleBatch').tx;
    const batch=iface.decodeFunctionData('scheduleBatch',schedule.data);
    assert.deepEqual([...batch[0]].map(value=>value.toLowerCase()),[catalog.bindings.beacon,catalog.bindings.portfolioBeacon,catalog.bindings.shareMarket]);
    assert.equal(batch[4],upgrade.upgradeSalt(catalog));assert.equal(batch[5],0n);
    assert(ui.notices().some(message=>String(message).includes('链上启用')));
  }finally{ui.dispose();}
});

test('reload reconciles all saved deployment transactions and only resends the rejected schedule',async()=>{
  const state=fixture('reject-schedule');let ui=harness(state);
  try{await ui.connect();await ui.run();assert.equal(state.broadcasts.length,5);
    assert.equal(state.record.steps.PoolVault.status,'confirmed');
  }finally{ui.dispose();}
  ui=harness(state);try{await ui.connect();await ui.run();
    assert.equal(ui.error(),'');assert.deepEqual(state.broadcasts.slice(5).map(item=>item.name),['scheduleBatch','executeBatch']);
    assert(state.requests.filter(method=>method==='eth_getCode').length>=8);
  }finally{ui.dispose();}
});

test('forged local deployment addresses cannot claim completion without confirmed deployment hashes',async()=>{
  const state=fixture();state.save({deployed:{SaleGovernance:address(499),...state.forgeActivated()}});
  const ui=harness(state);try{await ui.connect();await ui.run();
    assert.match(ui.error(),/其他升级/);assert.equal(state.broadcasts.length,0);
    assert.equal(ui.notices().some(message=>String(message).includes('链上启用')),false);
  }finally{ui.dispose();}
});

test('a saved confirmed hash for different calldata is rejected before another wallet transaction',async()=>{
  const state=fixture(),tx=state.putTransaction('SaleGovernance',{input:'0xff'});
  state.save({steps:{SaleGovernance:{status:'confirmed',hash:tx.hash}},deployed:{SaleGovernance:tx.address}});
  const ui=harness(state);try{await ui.connect();await ui.run();assert.match(ui.error(),/升级不一致/);assert.equal(state.broadcasts.length,0);
  }finally{ui.dispose();}
});

test('a failed deployment is not automatically resent and can be explicitly retried',async()=>{
  const ui=harness(fixture('failed-first'));try{await ui.connect();await ui.run();
    assert.equal(ui.state.record.steps.SaleGovernance.status,'failed');const oldHash=ui.state.record.steps.SaleGovernance.hash;
    await ui.run();assert.equal(ui.state.broadcasts.length,1);
    await ui.click('重试已失败交易');assert.equal(ui.error(),'');assert.equal(ui.state.broadcasts.length,7);
    assert.deepEqual(ui.state.record.steps.SaleGovernance.previousHashes,[oldHash]);
  }finally{ui.dispose();}
});

test('an ambiguous send is never resent and the wallet hash resumes the same transaction',async()=>{
  const ui=harness(fixture('ambiguous-first'));try{await ui.connect();await ui.run();
    assert.equal(ui.state.record.steps.SaleGovernance.status,'unknown');await ui.run();assert.equal(ui.state.broadcasts.length,1);
    const input=ui.nodes().find(node=>node.type==='input'&&node.props['aria-label']==='出售规则交易哈希');
    assert(input);const originalHash=[...ui.state.transactions.keys()][0];input.props.onChange({target:{value:originalHash}});ui.render();
    await ui.click('保存交易哈希');await ui.run();assert.equal(ui.error(),'');assert.equal(ui.state.broadcasts.length,6);
    assert.equal(ui.state.record.steps.SaleGovernance.hash,originalHash);
  }finally{ui.dispose();}
});

test('an account change while the wallet is open retains the original hash and stops subsequent sends',async()=>{
  const ui=harness(fixture('account-change'));try{await ui.connect();await ui.run();
    assert.equal(ui.state.broadcasts.length,1);assert.match(ui.state.record.steps.SaleGovernance.hash,/^0x/);
    assert.equal(ui.state.record.steps.PoolVault,undefined);
    ui.state.switchAccount(catalog.bindings.proposer);await ui.settle();await ui.run();
    assert.equal(ui.state.broadcasts.length,6);assert.equal(ui.error(),'');
  }finally{ui.dispose();}
});

test('a successful deployment with different runtime cannot proceed to the next deployment',async()=>{
  const ui=harness(fixture('bad-runtime'));try{await ui.connect();await ui.run();
    assert.match(ui.error(),/运行代码/);assert.equal(ui.state.broadcasts.length,1);
    await ui.run();assert.equal(ui.state.broadcasts.length,1);
  }finally{ui.dispose();}
});

test('a forged failed status for a successful exact deployment is reconciled without retrying it',async()=>{
  const state=fixture(),tx=state.putTransaction('SaleGovernance');
  state.save({steps:{SaleGovernance:{status:'failed',hash:tx.hash}},deployed:{SaleGovernance:address(999)}});
  const ui=harness(state);try{await ui.connect();await ui.click('重试已失败交易');
    assert.equal(ui.error(),'');assert.equal(state.broadcasts.length,5);
    assert.equal(state.record.deployed.SaleGovernance.toLowerCase(),tx.address);
  }finally{ui.dispose();}
});

test('the actual panel accepts the fixed signed wallet envelope for schedule and execute and reads runtimes once',async()=>{
  const ui=harness(fixture('wrapped'));try{await ui.connect();await ui.run();
    assert.equal(ui.error(),'');assert.equal(ui.state.broadcasts.length,6);
    assert.equal(ui.state.record.steps.schedule.status,'confirmed');assert.equal(ui.state.record.steps.execute.status,'confirmed');
    assert.deepEqual(ui.state.runtimeReads.sort(),['delegatorCode','enforcerCode','managerCode']);
    assert(ui.notices().some(message=>String(message).includes('链上启用')));
  }finally{ui.dispose();}
});

async function savedBatch(state,execute=false){
  const steps={},deployed={};
  for(const name of names){const tx=state.putTransaction(name);deployed[name]=tx.address;steps[name]={hash:tx.hash,status:'confirmed'};}
  const batch=upgrade.upgradeBatch(catalog,deployed),schedule=upgrade.scheduleUpgradeTransaction(catalog,batch,0n);
  const scheduleHash=await state.provider.request({method:'eth_sendTransaction',params:[{...schedule,from:catalog.bindings.proposer,value:'0x0',chainId:'0x38'}]});
  steps.schedule={hash:scheduleHash,status:'submitted'};
  if(execute){const transaction=upgrade.executeUpgradeTransaction(catalog,batch);
    steps.execute={hash:await state.provider.request({method:'eth_sendTransaction',params:[{...transaction,from:catalog.bindings.proposer,value:'0x0',chainId:'0x38'}]}),status:'submitted'};}
  state.save({steps,deployed});state.broadcasts.length=0;
}

test('reload restores the successfully wrapped schedule step and sends only the remaining execute',async()=>{
  const state=fixture('wrapped');await savedBatch(state);const ui=harness(state);
  try{await ui.connect();await ui.run();assert.equal(ui.error(),'');
    assert.deepEqual(state.broadcasts.map(item=>item.name),['executeBatch']);
    assert.equal(state.record.steps.schedule.status,'confirmed');assert.equal(state.record.steps.execute.status,'confirmed');
  }finally{ui.dispose();}
});

test('an already completed wrapped batch reconciles both saved hashes before reporting success without sending again',async()=>{
  const state=fixture('wrapped');await savedBatch(state,true);const ui=harness(state);
  try{await ui.connect();await ui.run();assert.equal(ui.error(),'');assert.equal(state.broadcasts.length,0);
    assert.equal(state.record.steps.schedule.status,'confirmed');assert.equal(state.record.steps.execute.status,'confirmed');
    assert(ui.notices().some(message=>String(message).includes('链上启用')));
    assert(ui.button('已启用').props.disabled);
  }finally{ui.dispose();}
  const reloaded=harness(state);try{await reloaded.connect();
    assert(reloaded.notices().some(message=>String(message).includes('6笔交易已确认')));
    assert.equal(reloaded.notices().some(message=>String(message).includes('链上启用')),false);
    assert(reloaded.button('同步升级状态')&&!reloaded.button('同步升级状态').props.disabled);
    assert(reloaded.nodes().some(node=>node.type==='a'&&node.props.children==='返回测试网站'));
    assert.equal(state.broadcasts.length,0);
    await reloaded.run();assert.equal(reloaded.error(),'');assert.equal(state.broadcasts.length,0);
    assert(reloaded.notices().some(message=>String(message).includes('链上启用')));
  }finally{reloaded.dispose();}
});

for(const mode of ['wrapped-wrong-batch','wrapped-bad-inner','wrapped-bad-runtime'])
test('the actual panel rejects '+mode+' without another batch transaction',async()=>{
  const ui=harness(fixture(mode));try{await ui.connect();await ui.run();
    assert(ui.error());assert.equal(ui.state.broadcasts.length,5);
    assert.equal(ui.state.record.steps.schedule.status,'submitted');
    await ui.run();assert.equal(ui.state.broadcasts.length,5);
    assert.equal(ui.notices().some(message=>String(message).includes('链上启用')),false);
  }finally{ui.dispose();}
});

test('completed state with an incorrect execute event cannot claim success or resend an executed batch',async()=>{
  const state=fixture('wrapped');await savedBatch(state,true);
  state.transactions.get(state.record.steps.execute.hash).receipt.logs[1].topics[1]=hash(999);
  const ui=harness(state);try{await ui.connect();await ui.run();
    assert.match(ui.error(),/批次事件/);assert.equal(state.broadcasts.length,0);
    assert.equal(state.record.steps.schedule.status,'confirmed');assert.equal(state.record.steps.execute.status,'submitted');
    assert.equal(ui.notices().some(message=>String(message).includes('链上启用')),false);
    assert(!ui.button('继续启用').props.disabled);
  }finally{ui.dispose();}
});

test('operation done and matching implementations require the execute hash before completion is reported',async()=>{
  const state=fixture('wrapped');await savedBatch(state,true);const record=state.record;delete record.steps.execute;state.save(record);
  const ui=harness(state);try{await ui.connect();await ui.run();assert.match(ui.error(),/填写启用升级/);
    assert.equal(state.broadcasts.length,0);assert.equal(state.record.steps.execute.status,'unknown');
    assert(ui.nodes().some(node=>node.type==='input'&&node.props['aria-label']==='启用升级交易哈希'));
    assert.equal(ui.notices().some(message=>String(message).includes('链上启用')),false);
  }finally{ui.dispose();}
});
