import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { authenticate, connectWallet, readPending, sendProductTransaction, recoverPending, cancelPendingNonce, productGasLimit } from '../lib/live-transactions.mjs';
const addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`), hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const account=addr(1),factory=addr(2),pool=addr(3),market=addr(4);
const config={status:'ready',chainId:56,factory,shareMarket:market,journalBase:'/api/journal',origin:'https://bemine.example'};
test('Gas reserve covers a new timestamp checkpoint while preserving the proportional bound for larger calls',()=>{
  assert.equal(productGasLimit('156817'),256817n);
  assert(productGasLimit('156817') > 201698n);
  assert.equal(productGasLimit('1000001'),1200002n);
  for(const value of ['0','-1','1.1',NaN])assert.throws(()=>productGasLimit(value));
});
const transaction=(name='deposit',args=[2],value='20',target=pool)=>({from:account,to:target,chainId:'0x38',
  data:(target===market?abi.ShareMarket:abi.PoolVault).encodeFunctionData(name,args),value});
function fixture(options={}){
  const state={record:null,revision:0,saved:null,authenticated:true,chain:'0x38',account,nonce:7n,pendingNonce:7n,
    balance:10n**25n,price:1000000000n,gas:100000n,hash:hash(7),final:true,resolution:'confirmed',...options};
  const calls=[];
  const provider={async request({method,params}){
    calls.push({method,params});
    if(method==='eth_chainId')return state.chain;
    if(method==='eth_accounts'||method==='eth_requestAccounts')return [state.account];
    if(method==='personal_sign')return `0x${'12'.repeat(65)}`;
    if(method==='eth_call'){if(state.simulationFail)throw new Error('simulation reverted');return '0x';}
    if(method==='eth_getTransactionCount')return `0x${(params[1]==='pending'?state.pendingNonce:state.nonce).toString(16)}`;
    if(method==='eth_getBalance')return `0x${state.balance.toString(16)}`;
    if(method==='eth_getCode')return state.accountCode??'0x';
    if(method==='eth_gasPrice')return `0x${state.price.toString(16)}`;
    if(method==='eth_estimateGas')return `0x${state.gas.toString(16)}`;
    if(method==='eth_sendTransaction'){
      assert(state.record,'Server intent ACK must precede wallet send');
      if(state.rejectWallet)throw Object.assign(new Error('rejected'),{code:4001});
      if(state.sendTimeout)throw new Error('wallet response lost');
      if(state.afterSend)state.afterSend(state);
      return state.hash;
    }
    assert.fail(`Unexpected wallet method ${method}`);
  }};
  const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});
  const fetcher=async(url,init={})=>{
    const method=init.method||'GET',body=init.body?JSON.parse(init.body):undefined;
    calls.push({url,method,body});
    assert.equal(init.credentials,'same-origin');
    const path=url.replace('/api/journal/','');
    if(path==='session'&&method==='GET')return state.authenticated?response(200,{account:state.sessionAccount??account}):response(401,{error:'login required'});
    if(path==='challenge'){
      const nonce='A'.repeat(32);
      const message=`Pinkuang deployment journal login\nOrigin: ${state.challengeOrigin??config.origin}\nChain ID: 56\nAccount: ${account.toLowerCase()}\nNonce: ${nonce}\nExpires At: ${new Date(Date.now()+300000).toISOString()}`;
      return response(200,{nonce,message});
    }
    if(path==='session'&&method==='POST'){state.authenticated=true;return response(200,{account});}
    if(path==='market'&&method==='GET')return response(200,{record:state.record,revision:state.revision});
    if(path==='market/arm'&&method==='POST'){
      if(state.armFail)return response(409,{error:'Signature permission already consumed'});
      if(!state.record||body.expectedRevision!==state.revision)return response(409,{error:'Revision changed'});
      const r=state.record;state.revision++;
      const transaction={from:r.account,to:r.target,chainId:'0x38',nonce:`0x${BigInt(r.nonce).toString(16)}`,
        data:r.data,value:`0x${BigInt(r.value).toString(16)}`,gas:`0x${BigInt(r.gas).toString(16)}`,
        gasPrice:`0x${BigInt(r.gasPrice).toString(16)}`,type:'0x0',...state.permitTransaction};
      if(state.armAckLost)throw new Error('Signature permission ACK lost');
      return response(200,{revision:state.revision,record:structuredClone(r),transaction});
    }
    if(path==='market/cancel-intent'&&method==='POST'){
      if(state.cancelAckFail)return response(503,{error:'Cancellation ACK unavailable'});
      if(!state.record||body.expectedRevision!==state.revision)return response(409,{error:'Revision changed'});
      const transaction={from:account,to:account,chainId:'0x38',nonce:`0x${state.record.nonce.toString(16)}`,data:'0x',value:'0x0',
        gas:'0x5208',gasPrice:`0x${(state.price*120n/100n).toString(16)}`,type:'0x0',...state.cancelTransaction};
      state.record={...state.record,cancellationRequests:[...(state.record.cancellationRequests??[]),{...transaction,createdAt:new Date().toISOString()}]};
      state.revision++;
      const result={record:structuredClone(state.record),revision:state.revision,transaction};
      if(state.afterCancelAck)state.afterCancelAck(state);
      if(state.cancelAckLost)throw new Error('Cancellation ACK lost');
      return response(200,result);
    }
    if(path==='market'&&method==='PUT'){
      if(body.expectedRevision!==state.revision)return response(409,{error:'Revision changed'});
      if(!state.record&&state.ackFail)return response(503,{error:'Store unavailable'});
      if(state.record&&state.hashAckFail)throw new Error('Hash ACK lost');
      state.record=structuredClone(body.record);state.revision++;
      if(state.afterAck)state.afterAck(state);
      if(state.initialAckLost&&state.revision===1)throw new Error('Initial ACK lost');
      return response(200,{revision:state.revision});
    }
    if(path==='market'&&method==='DELETE'){
      if(!state.final)return response(409,{error:'Not finalized'});
      const r=state.record;
      const result={action:r.action.kind,status:state.resolution,account,nonce:r.nonce,factory:r.factory,target:r.target??r.market,
        finalized:true,transactionHash:body.hash,receipt:{status:state.resolution==='reverted'?0:1,transactionHash:body.hash,
          to:state.resolution==='cancelled'?account:r.target??r.market,blockNumber:100,blockHash:hash(100)}};
      if(result.status==='confirmed'&&r.action.kind==='deposit'&&!state.missingDeposit){
        const args=abi.PoolVault.decodeFunctionData('deposit',r.data);
        Object.assign(result,{poolAddress:pool,shares:args[0].toString(),amountWei:r.value});
      }
      state.saved=result;state.record=null;state.revision++;
      if(state.deleteAckLost)throw new Error('Delete ACK lost');
      return response(200,{revision:state.revision,result});
    }
    if(path.startsWith('market/result?'))return response(200,{result:state.saved});
    assert.fail(`Unexpected request ${method} ${url}`);
  };
  const send=(name='deposit',args=[2],value='20',target=pool,extra={})=>sendProductTransaction({provider,config,transaction:transaction(name,args,value,target),action:name,fetcher,...extra});
  return {state,provider,fetcher,calls,send};
}

test('connect and journal authentication are explicit; existing sessions do not prompt signatures',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);
  assert.equal(await connectWallet(f.provider),account);
  assert.equal((await authenticate({provider:f.provider,account,config,fetcher:f.fetcher})).account,account);
  assert(!f.calls.some(x=>x.method==='personal_sign'));
  f.state.authenticated=false;
  await authenticate({provider:f.provider,account,config,fetcher:f.fetcher});
  assert.equal(f.calls.filter(x=>x.method==='personal_sign').length,1);
  assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
});

test('authentication refuses a foreign challenge before personal_sign',async()=>{
  const f=fixture({authenticated:false,challengeOrigin:'https://attacker.example'});
  await assert.rejects(authenticate({provider:f.provider,account,config,fetcher:f.fetcher}),/挑战/);
  assert(!f.calls.some(x=>x.method==='personal_sign'));
});

test('deposit uses exact integer payment, ACK before one wallet send, and verified event result only',async()=>{
  const f=fixture();const value='900719925474099312345';
  const result=await f.send('deposit',[2],value,pool,{onState(){throw new Error('Broken UI callback');}});
  assert.equal(result.status,'confirmed');assert.equal(result.finalized,true);
  assert.equal(result.poolAddress,pool);assert.equal(result.shares,'2');assert.equal(result.amountWei,value);
  assert.equal(result.transactionHash,hash(7));assert.equal(f.state.record,null);
  const sends=f.calls.filter(x=>x.method==='eth_sendTransaction');assert.equal(sends.length,1);
  assert.equal(BigInt(sends[0].params[0].value),BigInt(value));assert.equal(sends[0].params[0].nonce,'0x7');
  const ack=f.calls.findIndex(x=>x.url?.endsWith('/market')&&x.method==='PUT');
  assert(ack<f.calls.findIndex(x=>x.method==='eth_sendTransaction'));
  assert(!f.calls.some(x=>['personal_sign','eth_requestAccounts'].includes(x.method)));
});

test('without durable ACK, session, simulation, nonce, funds or gas checks no wallet send occurs',async()=>{
  for(const options of [{ackFail:true},{initialAckLost:true},{authenticated:false},{simulationFail:true},{chain:'0x1'},
    {pendingNonce:8n},{balance:1n},{price:4000000000n},{gas:6000000n}]){
    const f=fixture(options);await assert.rejects(f.send());
    assert(!f.calls.some(x=>x.method==='eth_sendTransaction'),JSON.stringify(options,(_k,v)=>typeof v==='bigint'?v.toString():v));
    if(options.initialAckLost)assert(f.state.record,'Lost ACK still leaves a durable intent');
  }
});

test('switching wallet or nonce after ACK retains intent and prevents signing',async()=>{
  for(const afterAck of [state=>{state.account=addr(9);},state=>{state.nonce=8n;state.pendingNonce=8n;}]){
    const f=fixture({afterAck});const result=await f.send();
    assert.equal(result.status,'pending');assert(f.state.record);assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
  }
});

test('wallet rejection, send timeout and hash ACK loss keep pending and never resend',async()=>{
  for(const options of [{rejectWallet:true},{sendTimeout:true},{hashAckFail:true}]){
    const f=fixture(options);const result=await f.send();assert.equal(result.status,'pending');assert(f.state.record);
    assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
    if(options.hashAckFail)assert.equal(result.hash,hash(7));
    await assert.rejects(f.send(),/待核对/);
    assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
  }
});

test('pending finality, replacement and revert do not produce share confirmations',async()=>{
  for(const options of [{final:false},{resolution:'reverted'},{resolution:'cancelled'},{resolution:'replaced'},{missingDeposit:true}]){
    const f=fixture(options);const result=await f.send();
    assert.notEqual(result.status,'confirmed');assert.equal(result.poolAddress,undefined);
    assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
  }
});

test('recovery reads saved finalized result after lost DELETE ACK, never signing again',async()=>{
  const f=fixture({deleteAckLost:true});
  const result=await f.send();assert.equal(result.status,'confirmed');
  const before=f.calls.length;
  const recovered=await recoverPending({provider:f.provider,account,config,hash:hash(7),fetcher:f.fetcher});
  assert.equal(recovered.status,'confirmed');assert.equal(recovered.shares,'2');
  assert(!f.calls.slice(before).some(x=>['eth_sendTransaction','personal_sign','eth_requestAccounts'].includes(x.method)));
});

test('all product actions and market actions use the same intent slot; arbitrary approvals are rejected',async()=>{
  for(const [name,args,value,target] of [['harvest',[],'0',pool],['claim',[],'0',pool],['withdrawBnb',[],'0',pool],
    ['withdrawDeposit',[],'0',pool],['finalizeFailure',[],'0',pool],['propose',[200,200,1],'0',pool],['vote',[1,true],'0',pool],
    ['executeSale',[1],'0',pool],['cancelExpired',[],'0',pool],['completeSale',[],'200',pool],
    ['list',[pool,2,5],'0',market],['fill',[1,2],'10',market],['cancel',[1],'0',market],['expire',[1],'0',market],['withdrawBnb',[],'0',market]]){
    const f=fixture();const result=await f.send(name,args,value,target);assert.equal(result.status,'confirmed',name);
    const initial=f.calls.find(x=>x.method==='PUT').body.record;
    assert.equal(initial.targetType,target===pool?'pool':'market');assert.equal(initial.action.kind,name);
  }
  const f=fixture();await assert.rejects(f.send('approve',[addr(9),1],'0'),/允许/);
  assert.equal(f.calls.length,0);
  await assert.rejects(f.send('deposit',[2],20),/精确整数/);
});

test('readPending is side-effect-free and an existing legacy journal blocks new product signatures',async()=>{
  const f=fixture({record:{version:1,chainId:56,account,factory,market,nonce:7,action:{kind:'withdraw'},data:'0x12345678',value:'0'}});
  assert.equal((await readPending({account,config,fetcher:f.fetcher})).record.version,1);
  await assert.rejects(f.send(),/待核对/);
  assert(!f.calls.some(x=>['eth_sendTransaction','personal_sign','eth_requestAccounts'].includes(x.method)));
});

const pendingRecord=(version=2)=>version===2?{version:2,chainId:56,account,factory,target:pool,targetType:'pool',nonce:7,
  action:{kind:'deposit'},data:transaction().data,value:'20',submittedAt:'2026-09-27T00:00:00Z',hash:hash(6)}
  :{version:1,chainId:56,account,factory,market,nonce:7,action:{kind:'withdraw'},
    data:abi.ShareMarket.encodeFunctionData('withdrawBnb'),value:'0',submittedAt:'2026-09-27T00:00:00Z',hash:hash(6)};
test('explicit nonce cancellation persists server ACK then sends one zero-value self-transfer for v1 and v2',async()=>{
  for(const version of [1,2]){
    const f=fixture({record:pendingRecord(version),resolution:'cancelled',pendingNonce:8n});
    const states=[];
    const result=await cancelPendingNonce({provider:f.provider,account,config,fetcher:f.fetcher,onState:state=>states.push(state)});
    assert.equal(result.status,'cancelled');assert.equal(result.finalized,true);assert.equal(result.poolAddress,undefined);
    assert(!states.some(state=>state.status==='confirmed'));
    assert.equal(f.state.record,null);
    const sends=f.calls.filter(x=>x.method==='eth_sendTransaction');assert.equal(sends.length,1);
    assert.deepEqual(sends[0].params[0],{from:account,to:account,chainId:'0x38',nonce:'0x7',data:'0x',value:'0x0',
      gas:'0x5208',gasPrice:`0x${1_200_000_000n.toString(16)}`,type:'0x0'});
    assert(f.calls.findIndex(x=>x.url?.endsWith('/cancel-intent'))<f.calls.findIndex(x=>x.method==='eth_sendTransaction'));
    const saved=f.calls.find(x=>x.method==='PUT').body.record;
    assert.equal(saved.hash,hash(6));assert.deepEqual(saved.recoveryHashes,[hash(7)]);
    assert(!f.calls.some(x=>['personal_sign','eth_requestAccounts'].includes(x.method)));
  }
});

test('cancellation never signs without an ACK, exact own nonce, unchanged identity and journal, EOA or safe fee',async()=>{
  for(const options of [{cancelAckFail:true},{cancelAckLost:true},{cancelTransaction:{to:addr(9)}},{cancelTransaction:{value:'0x1'}},
    {cancelTransaction:{nonce:'0x8'}},{afterCancelAck:state=>{state.nonce=8n;}},{afterCancelAck:state=>{state.pendingNonce=9n;}},
    {afterCancelAck:state=>{state.account=addr(9);}},{afterCancelAck:state=>{state.chain='0x1';}},
    {afterCancelAck:state=>{state.revision++;}},{accountCode:'0xef0100'},{balance:1n},{price:3_000_000_000n}]){
    const f=fixture({record:pendingRecord(),...options});
    const result=await cancelPendingNonce({provider:f.provider,account,config,fetcher:f.fetcher});
    assert.equal(result.status,'pending');assert(f.state.record);assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
  }
  const absent=fixture();
  await assert.rejects(cancelPendingNonce({provider:absent.provider,account,config,fetcher:absent.fetcher}),/没有/);
  assert(!absent.calls.some(x=>x.method==='eth_sendTransaction'));
});

test('cancel rejection and ambiguous outcome preserve the intent; recovery never resends or confirms a deposit',async()=>{
  for(const options of [{rejectWallet:true},{sendTimeout:true},{hashAckFail:true},{final:false},{resolution:'confirmed'},
    {afterSend:state=>{state.account=addr(9);}}]){
    const f=fixture({record:pendingRecord(),resolution:'cancelled',...options}),states=[];
    const result=await cancelPendingNonce({provider:f.provider,account,config,fetcher:f.fetcher,onState:state=>states.push(state)});
    assert.equal(result.status,'pending');assert.equal(result.poolAddress,undefined);assert(!states.some(state=>state.status==='confirmed'));
    assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
    if(!options.resolution)assert(f.state.record);
    if(options.afterSend)assert.deepEqual(f.state.record.recoveryHashes,[hash(7)]);
    const before=f.calls.length;
    await readPending({account,config,fetcher:f.fetcher});
    assert(!f.calls.slice(before).some(x=>x.method==='eth_sendTransaction'));
  }
});

test('missing, lost or modified single-use signing permission never opens the wallet', async()=>{
  for(const options of [{armFail:true},{armAckLost:true},{permitTransaction:{value:'0x100'}},{permitTransaction:{to:addr(90)}},{permitTransaction:{gas:'0x1'}}]){
    const f=fixture(options);const result=await f.send();assert.equal(result.status,'pending');
    assert(f.state.record);assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
  }
});

test('independent preflight reads overlap while intent ACK and signing permission stay sequential', async () => {
  const f=fixture(), original=f.provider.request.bind(f.provider), states=[];
  const groups=[new Set(),new Set()], release=[], gates=groups.map((_,i)=>new Promise(resolve=>{release[i]=resolve;}));
  const timers=groups.map((_,i)=>setTimeout(()=>release[i](),1500));
  const enter=async(i,name)=>{groups[i].add(name);if(groups[i].size===[4,6][i])release[i]();await gates[i];};
  let phase=0;
  f.provider.request=async payload=>{
    const {method,params}=payload;
    if(phase===0&&['eth_chainId','eth_accounts'].includes(method))await enter(0,method);
    if(phase===1&&['eth_call','eth_estimateGas','eth_gasPrice','eth_getBalance','eth_getTransactionCount'].includes(method))
      await enter(1,method==='eth_getTransactionCount'?method+params[1]:method);
    return original(payload);
  };
  const fetcher=async(url,init)=>{
    if(phase===0&&(!init.method||init.method==='GET')){
      await enter(0,url.endsWith('/session')?'session':'journal');
      if(groups[0].size===4)phase=1;
    }
    if(init.method==='PUT'){
      assert.equal(groups[0].size,4,'initial reads must overlap');
      assert.equal(groups[1].size,6,'simulation, Gas, balance and both nonces must overlap');phase=2;
    }
    return f.fetcher(url,init);
  };
  try{
    const result=await sendProductTransaction({provider:f.provider,config,transaction:transaction(),action:'deposit',fetcher,onState:s=>states.push(s.status)});
    assert.equal(result.status,'confirmed');
    assert.deepEqual(states.slice(0,4),['preparing','recording-intent','authorizing','awaiting-signature']);
    assert(f.calls.findIndex(x=>x.url?.endsWith('/market')&&x.method==='PUT')<f.calls.findIndex(x=>x.url?.endsWith('/market/arm')));
    assert(f.calls.findIndex(x=>x.url?.endsWith('/market/arm'))<f.calls.findIndex(x=>x.method==='eth_sendTransaction'));
    assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
  }finally{timers.forEach(clearTimeout);release.forEach(resolve=>resolve());}
});

test('failed parallel simulation drains reads and retains the wallet lane without signing',async()=>{
  const f=fixture({simulationFail:true}), original=f.provider.request.bind(f.provider);
  let release, balanceStarted;
  const waiting=new Promise(resolve=>{release=resolve;}), started=new Promise(resolve=>{balanceStarted=resolve;});
  f.provider.request=async payload=>{
    if(payload.method==='eth_getBalance'){balanceStarted();await waiting;}
    return original(payload);
  };
  let settled=false;
  const send=f.send().then(()=>assert.fail('simulation must fail'),error=>{assert.match(error.message,/simulation/);settled=true;});
  const timer=setTimeout(release,1500);
  try{
    await started;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'failure must wait for already-started reads');
    await assert.rejects(f.send(),/另一笔交易/);
    assert(!f.calls.some(x=>x.method==='PUT'||x.method==='eth_sendTransaction'));
  }finally{release();clearTimeout(timer);await send;}
});

test('a rejected chain read drains its concurrent account read before releasing the send lane',async()=>{
  const f=fixture();let release, accountsStarted;
  const waiting=new Promise(resolve=>{release=resolve;}), started=new Promise(resolve=>{accountsStarted=resolve;});
  f.provider.request=async({method})=>{
    if(method==='eth_chainId')throw new Error('chain unavailable');
    if(method==='eth_accounts'){accountsStarted();await waiting;return [account];}
    assert.fail(`Unexpected request after identity failure: ${method}`);
  };
  let settled=false;
  const send=f.send().then(()=>assert.fail('identity failure must reject'),error=>{assert.match(error.message,/chain unavailable/);settled=true;});
  const timer=setTimeout(release,1500);
  try{
    await started;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);
    await assert.rejects(f.send(),/另一笔交易/);
    assert(!f.calls.some(x=>x.method==='PUT'));
  }finally{release();clearTimeout(timer);await send;}
});
