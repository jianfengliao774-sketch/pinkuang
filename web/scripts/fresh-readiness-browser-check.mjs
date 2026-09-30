/** Local fixture only: actual fresh loader, browser effects and wallet UI. No mainnet or external signing. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';
const {chromium}=await import(process.env.BEMINE_PLAYWRIGHT_MODULE||'playwright');
const base=(process.env.BEMINE_TEST_URL||'http://127.0.0.1:3216/bemine-v4').replace(/\/$/,'');
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const out=process.env.BEMINE_BROWSER_OUTPUT||join(tmpdir(),'fresh-readiness-browser');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.BEMINE_TEST_BROWSER||'chrome'});
const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const oldWallet='0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E';
const deployer='0x042B23288E2316DFb6503488292FD0Ad2F811Ae7';
const checks=[],errors=[],unexpected=[];let context,page;
async function setup({history=false,operationalReady=true,account}={}){
 await context?.close();context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();
 page.setDefaultTimeout(20000);await page.clock.install();
 const f=freshAuthorityBrowserFixture();f.state.operationalReady=operationalReady;if(account)f.state.account=account;
 const state={history,graphCalls:0,walletRequests:[],graphHold:null,roleHold:null,readHolds:[]};
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
 await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/,route=>route.fulfill({contentType:'application/json',body:json(f.manifest)}));
 const rpc=async p=>{
  const anchor=f.manifest.deployment;
  if(p.method==='eth_getTransactionByHash'&&p.params[0]===anchor.txHash)return{hash:anchor.txHash,from:deployer,chainId:'0x38',blockNumber:'0x5a',blockHash:anchor.blockHash};
  if(p.method==='eth_getTransactionReceipt'&&p.params[0]===anchor.txHash)return{transactionHash:anchor.txHash,from:deployer,status:'0x1',blockNumber:'0x5a',blockHash:anchor.blockHash};
  if(p.method==='eth_getBlockByNumber'&&p.params[0]==='0x5a')return{number:'0x5a',hash:anchor.blockHash,timestamp:'0x6b49d200'};
  if(p.method==='eth_blockNumber')return'0x70';
  if(p.method==='eth_call'&&p.params[0].to.toLowerCase()===f.manifest.factory.toLowerCase()){
   const name=abi.PoolFactory.parseTransaction(p.params[0])?.name;
   const index=state.readHolds.findIndex(item=>item.name===name);
   if(index>=0){const [hold]=state.readHolds.splice(index,1);await hold.wait();}
  }
  if(p.method==='eth_call'&&p.params[0].to.toLowerCase()===f.manifest.authority.toLowerCase()&&state.roleHold){const hold=state.roleHold;state.roleHold=null;await hold();}
  return f.request(p);
 };
 await page.route(/\/api\/rpc(?:\?.*)?$/,async route=>{try{const p=route.request().postDataJSON();await route.fulfill({contentType:'application/json',body:json({jsonrpc:'2.0',id:p.id,result:await rpc(p)})});}
  catch(error){unexpected.push(error.message);await route.fulfill({status:400,contentType:'application/json',body:json({error:error.message})});}});
 await page.route(/\/api\/chain-index\//,route=>route.fulfill({contentType:'application/json',body:json(f.index(route.request().url()))}));
 await page.route(/\/firsto-api\/v1\//,route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({contentType:'application/json',body:json(path.endsWith('/circuits')?f.data.page:path.endsWith('/circuit-holders')?f.data.referenceRaw:f.data.detail)});});
 await page.route(/\/api\/journal\//,async route=>{try{const r=route.request();let body;
  if(r.url().endsWith('/product-graph')){state.graphCalls++;body=f.graph();if(state.history)body={...body,readMode:'verified_snapshot',stale:true,snapshotAgeMs:1000,refreshing:true,operationalReady:false,transactionReady:false,userExitReady:false};if(state.graphHold){const hold=state.graphHold;state.graphHold=null;await hold();}}
  else body=await f.journal(r.url(),r.method(),r.postData()?r.postDataJSON():null);
  await route.fulfill({contentType:'application/json',body:json(body)});
 }catch(error){unexpected.push(error.message);await route.fulfill({status:400,contentType:'application/json',body:json({error:error.message})});}});
 await page.exposeFunction('__wallet',async p=>{state.walletRequests.push(p.method);if(/eth_call|eth_getBlockByNumber|eth_getCode/.test(p.method))throw Error('This extension does not provide read RPC');return rpc(p);});
 await page.addInitScript(()=>{const listeners=new Map();window.ethereum={isMetaMask:true,request:p=>window.__wallet(p),
  on(e,fn){if(!listeners.has(e))listeners.set(e,new Set());listeners.get(e).add(fn);},removeListener(e,fn){listeners.get(e)?.delete(fn);},
  __emit(e,value){for(const fn of listeners.get(e)||[])fn(value);}};});
 await page.goto(base+'/#home');
 await page.waitForFunction(()=>document.querySelector('main')?.getAttribute('aria-busy')==='false');
 return{f,state};
}
async function connect(){await page.locator('header').getByRole('button',{name:'连接钱包',exact:true}).click();await page.getByRole('button',{name:'连接 MetaMask',exact:true}).click();await page.locator('header .live-wallet-label').filter({hasText:/0x[0-9a-f]/i}).waitFor();}
const nav=()=>page.locator('nav').getByRole('button',{name:'运营工作台',exact:true});
const deployment=()=>page.locator('.deployment-console-link');
async function noTechnicalCards(){const text=await page.locator('body').innerText();assert(!/本机历史快照|服务器保存的公共历史|正在核对链上数据|钱包已连接。发送交易前会请你确认。/.test(text));assert.equal(await page.locator('.live-service-note').count(),0);}
try{
 let {f,state}=await setup({operationalReady:false});await connect();await nav().waitFor();await nav().click();
 await page.getByRole('heading',{name:'管理员审核与手续费',exact:true}).waitFor();
 assert.equal(await deployment().count(),0);assert.equal(await page.getByRole('button',{name:'签名批准',exact:true}).first().isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'预览创建矿池',exact:true}).isDisabled(),true);
 assert.match(await page.locator('[data-creation-block-reason]').innerText(),/交易服务恢复中/);
 await noTechnicalCards();assert.equal(state.walletRequests.includes('eth_call'),false);
 f.state.operationalReady=true;await page.clock.fastForward(16000);
 await page.waitForFunction(()=>!document.querySelector('[data-service-readiness="waiting"]'));
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='签名批准'&&!b.disabled));
 assert.equal(state.walletRequests.filter(m=>m==='eth_requestAccounts').length,1);assert.equal(f.state.signatures.length,0);
 const calls=state.graphCalls;await page.clock.fastForward(600000);assert.equal(state.graphCalls,calls);
 checks.push('admin one keeps an identity-verified entry while service is waiting; signatures disabled; current-ready recovery needs no wallet reconnect and stops polling');
 await page.screenshot({path:join(out,'operator-recovered.png'),fullPage:true});

 const create=page.getByRole('button',{name:'预览创建矿池',exact:true});await create.waitFor();assert.equal(await create.isDisabled(),false);
 await page.getByLabel('矿机编号',{exact:true}).fill('4460');
 const amount=page.getByLabel('募集总额（BNB）',{exact:true}),cap=page.getByLabel('购机价格上限（BNB）',{exact:true});
 await amount.fill('48.065');await cap.fill('43.695679475146443511');await page.getByLabel('募集截止（距当前小时）',{exact:true}).click();
 assert.equal(await cap.inputValue(),'≈ 43.69568');assert.match(await cap.getAttribute('title'),/43\.695679475146443511/);
 await cap.focus();assert.equal(await cap.inputValue(),'43.695679475146443511');await page.getByLabel('募集截止（距当前小时）',{exact:true}).click();
 await create.click();const confirmation=page.getByRole('dialog',{name:'确认运营操作',exact:true});await confirmation.waitFor();
 assert.equal(state.walletRequests.includes('eth_call'),false);assert.equal(f.state.signatures.length,0);
 await confirmation.getByRole('button',{name:'返回修改',exact:true}).click();
 checks.push('creation explains disabled readiness, recovers, displays five decimals while preserving exact cap, and previews via public RPC even when extension reads fail');

 function holdRead(name){let release,started;const began=new Promise(resolve=>started=resolve);
  state.readHolds.push({name,wait:()=>{started();return new Promise(resolve=>release=resolve);}});return{began,release:()=>release()};}
 const phaseOne=holdRead('creationPaused'),phaseTwo=holdRead('machinePool');await create.click();await phaseOne.began;
 await page.clock.fastForward(10000);phaseOne.release();await phaseTwo.began;await page.clock.fastForward(10001);
 await page.getByRole('alert').filter({hasText:'链上核对暂未完成'}).waitFor();assert.equal(await create.isDisabled(),false);
 phaseTwo.release();await page.clock.fastForward(2000);assert.equal(await confirmation.count(),0);
 assert.equal(f.state.signatures.length,0);assert.equal(f.state.posts.length,0);
 await create.click();await confirmation.waitFor();await confirmation.getByRole('button',{name:'返回修改',exact:true}).click();
 checks.push('the entire read-only preview has a twenty-second deadline; a late reply cannot open confirmation; only explicit retry prepares another preview');

 await create.click();await confirmation.waitFor();
 const finalOne=holdRead('creationPaused'),finalTwo=holdRead('machinePool');
 await confirmation.getByRole('button',{name:'发送到钱包确认',exact:true}).click();await finalOne.began;
 await page.clock.fastForward(10000);finalOne.release();await finalTwo.began;await page.clock.fastForward(10001);
 await page.getByRole('alert').filter({hasText:'链上核对暂未完成'}).waitFor();finalTwo.release();await page.clock.fastForward(2000);
 assert.equal(await confirmation.count(),0);assert.equal(f.state.signatures.length,0);assert.equal(f.state.posts.length,0);
 assert.equal(state.walletRequests.includes('eth_call'),false);assert.equal(await create.isDisabled(),false);
 checks.push('confirmation recheck also uses bounded public reads; timeout never proceeds to an administrator signature or relay');

 const cancelled=holdRead('creationPaused');await create.click();await cancelled.began;
 await page.getByRole('button',{name:'取消核对',exact:true}).click();cancelled.release();await page.clock.fastForward(2000);
 assert.equal(await confirmation.count(),0);assert.equal(await create.isDisabled(),false);assert.equal(f.state.signatures.length,0);
 checks.push('cancel stops a pending read-only preview without a wallet request; late replies cannot reopen it');

 const switched=holdRead('creationPaused');await create.click();await switched.began;f.state.account=oldWallet;
 await page.evaluate(a=>window.ethereum.__emit('accountsChanged',[a]),oldWallet);switched.release();await page.waitForURL(/#home$/);
 assert.equal(await confirmation.count(),0);assert.equal(await nav().count(),0);assert.equal(f.state.signatures.length,0);
 checks.push('account switching during preview invalidates the read and cannot open the former administrator confirmation');

 ({f,state}=await setup());f.state.account=f.other.address;await connect();await nav().waitFor();assert.equal(await deployment().count(),0);
 checks.push('administrator two has the same operator entry, but no deployment-console link');

 ({f,state}=await setup({account:oldWallet}));await connect();await page.evaluate(()=>location.hash='operator');
 await page.waitForURL(/#home$/);assert.equal(await nav().count(),0);assert.equal(await deployment().count(),0);
 assert.equal(await page.locator('.live-operator').count(),0);checks.push('early test wallet 0x6F4d has neither operator nor deployer access, including a direct operator hash');

 ({f,state}=await setup({account:deployer}));assert.equal(await deployment().count(),0);await connect();await deployment().waitFor();assert.equal(await nav().count(),0);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'打开导航',exact:true}).click();await deployment().waitFor({state:'visible'});
 await page.screenshot({path:join(out,'deployer-mobile.png'),fullPage:true});checks.push('only the receipt-proven deployer sees the separately authenticated deployment link on desktop/mobile');

 ({f,state}=await setup({history:true}));await connect();assert.equal(await nav().count(),0);assert.equal(await deployment().count(),0);await noTechnicalCards();
 state.history=false;await page.clock.fastForward(16000);await nav().waitFor();assert.equal(state.walletRequests.filter(m=>m==='eth_requestAccounts').length,1);
 checks.push('a historical graph grants no administrator entry; a later current proof restores it automatically without reconnecting');

 ({f,state}=await setup({history:true}));await connect();state.history=false;
 let release,started;const start=new Promise(r=>started=r);state.graphHold=()=>{started();return new Promise(r=>release=r);};
 await page.clock.fastForward(16000);await start;f.state.account=oldWallet;await page.evaluate(a=>{window.ethereum.__emit('accountsChanged',[a]);location.hash='market';},oldWallet);
 release();await page.clock.fastForward(31000);await page.waitForFunction(()=>location.hash==='#market');assert.equal(await nav().count(),0);assert.equal(await deployment().count(),0);
 assert.equal(await page.locator('.live-operator').count(),0);checks.push('late readiness proof cannot resurrect the old administrator or route after an account switch');

 ({f,state}=await setup());let releaseRole,roleStarted;const began=new Promise(r=>roleStarted=r);
 state.roleHold=()=>{roleStarted();return new Promise(r=>releaseRole=r);};await connect();await began;
 f.state.account=oldWallet;await page.evaluate(a=>window.ethereum.__emit('accountsChanged',[a]),oldWallet);releaseRole();await page.clock.fastForward(10000);
 assert.equal(await nav().count(),0);assert.equal(await deployment().count(),0);checks.push('late read-only role result is discarded after wallet account changes');
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 await writeFile(join(out,'results.json'),json({passed:true,checks,errors,unexpected}));console.log(json({passed:true,checks,out}));
}catch(error){await writeFile(join(out,'failure.json'),json({error:error.stack,checks,errors,unexpected,body:await page?.locator('body').innerText().catch(()=>null)}));await page?.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await context?.close();await browser.close();}
