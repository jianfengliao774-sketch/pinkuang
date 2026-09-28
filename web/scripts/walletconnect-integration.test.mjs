import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {getAddress} from 'ethers';
import {createWalletConnectConnector, standardWalletConnectProvider} from '../../deploy/shared/walletconnect.mjs';
import {connectWallet, sendProductTransaction} from '../lib/live-transactions.mjs';
import {abi} from '../lib/chain-client.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const account='0x0000000000000000000000000000000000000001';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function instance(){
 const wallet=new EventEmitter(),approval=deferred();let disconnects=0;
 wallet.session=null;
 wallet.connect=async()=>{await approval.promise;wallet.session={};};
 wallet.disconnect=async()=>{disconnects++;wallet.session=null;};
 wallet.signer={client:{core:{pairing:{disconnect:async()=>{}}}}};
 wallet.request=async({method})=>{if(method==='eth_chainId')return 56;if(['eth_accounts','eth_requestAccounts'].includes(method))return[account];throw Error('Unexpected wallet request: '+method);};
 return{wallet,approval,get disconnects(){return disconnects;}};
}
function connector(instances){let loads=0;return createWalletConnectConnector({projectId:'a'.repeat(32),origin:'https://tapeout.cc.cd/bemine-v2/',loadProvider:async()=>({init:async()=>instances[loads++].wallet}),renderQr:async()=> 'data:image/png;base64,AA=='});}
test('SDK 2.25 numeric eth_chainId is normalized before strict product wallet guards',async()=>{
 const f=instance(),c=connector([f]),pending=c.connect();await tick();f.approval.resolve();const p=await pending;
 assert.equal(await connectWallet(p),account);
 await c.disconnect();
});
function liveHandlers(c,checkWallet){
 const source=fs.readFileSync(root+'/web/components/LivePlatform.jsx','utf8');
 const functions=source.slice(source.indexOf('  function cancelWalletScan()'),source.indexOf('  function showTransactionProgress('));
 assert(functions.includes('async function selectWallet'),'Review harness must use actual current component functions');
 const state={wallet:null,account:null,busy:false,error:null},refs={connectionLock:{current:null},activeModal:{current:{type:'connect-wallet'}},walletEpoch:{current:0},connectedWallet:{current:null},qrConnector:{current:c}};
 const context={...refs,busy:false,wallet:null,account:null,locale:'en',walletConnectEnabled:true,discovery:{current:null},walletConnectForPage:()=>c,connectWallet:checkWallet,getAddress:x=>x,L:(_,en)=>en,walletConnectionError:e=>e.message};
 for(const key of ['ConnectingId','Operator','ConnectionError','WalletQr','Busy','Wallet','WalletInfo','Account','Prepared','Modal','Pending','Message','Refresh'])context['set'+key]=value=>{state[key[0].toLowerCase()+key.slice(1)]=value;if(key==='Modal')refs.activeModal.current=value;};
 return{...new Function(...Object.keys(context),functions+'\nreturn {selectWallet,cancelWalletScan};')(...Object.values(context)),state,refs};
}
test('cancel after relay approval invalidates outer chain-check; late result cannot replace retry wallet',async()=>{
 const first=instance(),second=instance(),c=connector([first,second]),oldOwner=deferred();let reads=0;
 const ui=liveHandlers(c,async()=>++reads===1?oldOwner.promise:account);
 const entry={id:'walletconnect',name:'WalletConnect'};
 const original=ui.selectWallet(entry,true);await tick();first.approval.resolve();await tick();assert.equal(reads,1);
 ui.cancelWalletScan();assert.equal(ui.refs.connectionLock.current,null);assert.equal(ui.state.busy,false);
 const retry=ui.selectWallet(entry,true);await tick();second.approval.resolve();await retry;
 assert.equal(ui.state.account,account);const adopted=ui.state.wallet;
 oldOwner.resolve(account);await original;
 assert.equal(ui.state.wallet,adopted);assert.equal(second.disconnects,0);assert(first.disconnects>=1);
 await c.disconnect();
});
test('pending original disconnect cannot clear a newly connected provider cache',async()=>{
 const first=instance(),second=instance(),c=connector([first,second]),finish=deferred();
 first.wallet.disconnect=async()=>{await finish.promise;first.wallet.session=null;};
 const a=c.connect();await tick();first.approval.resolve();await a;
 const leaving=c.disconnect(),b=c.connect();await tick();second.approval.resolve();const adopted=await b;
 finish.resolve();await leaving;
 assert.equal(await c.connect(),adopted);assert.equal(second.disconnects,0);await c.disconnect();
});
function actualTransactionFixture(options){
 const source=fs.readFileSync(root+'/web/scripts/live-transactions.test.mjs','utf8');
 const body=source.slice(source.indexOf('const transaction='),source.indexOf("test('connect and journal authentication"));
 assert(body.includes('function fixture(options={})'),'Harness uses current existing server-journal fixture');
 const addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`),hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
 const config={status:'ready',chainId:56,factory:addr(2),shareMarket:addr(4),journalBase:'/api/journal',origin:'https://bemine.example'};
 return new Function('account','factory','pool','market','config','hash','assert','abi','sendProductTransaction',body+'\nreturn fixture;')(addr(1),addr(2),addr(3),addr(4),config,hash,assert,abi,sendProductTransaction)(options);
}
test('WC response loss preserves journal pending and retry cannot send a second transaction',async()=>{
 const f=actualTransactionFixture({chain:56,sendTimeout:true}),provider=standardWalletConnectProvider(f.provider);
 const result=await f.send('deposit',[2],'20',undefined,{provider});
 assert.equal(result.status,'pending');assert(f.state.record);
 assert.equal(f.calls.filter(item=>item.method==='eth_sendTransaction').length,1);
 await assert.rejects(f.send('deposit',[2],'20',undefined,{provider}),/待核对/);
 assert.equal(f.calls.filter(item=>item.method==='eth_sendTransaction').length,1);
});
test('provider facade preserves exact large quantities and original transaction errors without retry',async()=>{
 let sends=0;const marker=Object.assign(new Error('relay acknowledgement lost'),{code:9876});
 const raw={request:async({method})=>{if(method==='eth_chainId')return 56;if(method==='eth_getBalance')return '0x123456789abcdef123456789abcdef';if(method==='eth_sendTransaction'){sends++;throw marker;}throw Error(method);}};
 const provider=standardWalletConnectProvider(raw);
 assert.equal(await provider.request({method:'eth_getBalance'}),'0x123456789abcdef123456789abcdef');
 await assert.rejects(provider.request({method:'eth_sendTransaction',params:[{value:'0x123456789abcdef123456789abcdef'}]}),error=>error===marker);
 assert.equal(sends,1);
});
test('changing wallet context during approval prevents late adoption',async()=>{
 const f=instance(),c=connector([f]),owner=deferred(),ui=liveHandlers(c,()=>owner.promise);
 const result=ui.selectWallet({id:'walletconnect',name:'WalletConnect'},true);await tick();f.approval.resolve();await tick();
 ui.refs.walletEpoch.current++;owner.resolve(account);await result;
 assert.equal(ui.state.wallet,null);assert.equal(ui.state.account,null);assert.equal(ui.refs.connectionLock.current,null);
 assert(f.disconnects>=1);await c.disconnect();
});
