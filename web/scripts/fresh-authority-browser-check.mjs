/** Run against a LOCAL Next build with fresh-v4 and the fixture's manifest hash.
 * No mainnet requests: cross-origin traffic is rejected; all RPC/HTTP/signatures are local fixtures. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { PORTFOLIOS } from './portfolio-fixture.mjs';
const { chromium }=await import(process.env.BEMINE_PLAYWRIGHT_MODULE||'playwright');
const base=(process.env.BEMINE_TEST_URL||'http://127.0.0.1:3214/bemine-v4').replace(/\/$/,'');
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const output=process.env.BEMINE_BROWSER_OUTPUT||join(tmpdir(),'bemine-fresh-authority-browser');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.BEMINE_TEST_BROWSER?{channel:process.env.BEMINE_TEST_BROWSER}:{})});
const checks=[],errors=[],requests=[];const f=freshAuthorityBrowserFixture();
const json=v=>JSON.stringify(v,(_,value)=>typeof value==='bigint'?value.toString():value);
let page;
try{
  page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
  await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/,route=>route.fulfill({contentType:'application/json',body:json(f.manifest)}));
  await page.route(/\/api\/rpc(?:\?.*)?$/,async route=>{
    try{const p=route.request().postDataJSON();const result=await f.request(p);await route.fulfill({contentType:'application/json',body:json({jsonrpc:'2.0',id:p.id,result})});}
    catch(e){requests.push(e.message);await route.fulfill({status:400,contentType:'application/json',body:json({error:e.message})});}
  });
  await page.route(/\/api\/chain-index\//,async route=>{
    try{await route.fulfill({contentType:'application/json',body:json(f.index(route.request().url()))});}
    catch(e){requests.push(e.message);await route.fulfill({status:400,contentType:'application/json',body:json({error:e.message})});}
  });
  await page.route(/\/firsto-api\/v1\//,async route=>{
    const path=new URL(route.request().url()).pathname;
    await route.fulfill({contentType:'application/json',body:json(path.endsWith('/circuits')?f.data.page:path.endsWith('/circuit-holders')?f.data.referenceRaw:f.data.detail)});
  });
  await page.route(/\/api\/journal\//,async route=>{
    try{const r=route.request();await route.fulfill({contentType:'application/json',body:json(await f.journal(r.url(),r.method(),r.postData()?r.postDataJSON():null))});}
    catch(e){requests.push(e.message);await route.fulfill({status:400,contentType:'application/json',body:json({error:e.message})});}
  });
  await page.exposeFunction('__freshFixtureWallet',async p=>f.request(p));
  await page.exposeFunction('__freshFixtureStats',()=>({signatures:f.state.signatures.length,posts:f.state.posts.length,status:f.state.queue?.items[0]?.status}));
  await page.addInitScript(()=>{
    const listeners=new Map();let connected=localStorage.getItem('fresh-fixture-connected')==='yes';
    window.ethereum={isMetaMask:true,async request(p){
      if(p.method==='eth_requestAccounts'){connected=true;localStorage.setItem('fresh-fixture-connected','yes');}
      if(p.method==='eth_accounts'&&!connected)return [];
      return window.__freshFixtureWallet(p);
    },on(e,fn){if(!listeners.has(e))listeners.set(e,new Set());listeners.get(e).add(fn);},
    removeListener(e,fn){listeners.get(e)?.delete(fn);},__emit(e,v){for(const fn of listeners.get(e)||[])fn(v);}};
  });
  await page.goto(base+'/#home');
  await page.locator('header').getByRole('button',{name:'连接钱包',exact:true}).click();
  await page.getByRole('button',{name:'连接 MetaMask',exact:true}).click();
  await page.locator('header .live-wallet-label').filter({hasText:/^0x[0-9a-f]/i}).waitFor();
  await page.locator('nav').getByRole('button',{name:'运营工作台',exact:true}).click();

  await page.locator('.portfolio-card').first().click();
  await page.getByRole('heading',{name:'按预算连续采购',exact:true}).waitFor();
  await page.getByRole('button',{name:'自动寻找并预览',exact:true}).click();
  await page.getByRole('button',{name:'批准本批限额与矿机清单',exact:true}).click();
  checks.push('fresh manifest boot and Authority-admin-only queue discovery');
  await page.getByRole('button',{name:'预览创建下一台子矿池',exact:true}).click();
  await page.getByRole('button',{name:'发送这一笔到钱包',exact:true}).click();
  await page.getByRole('button',{name:'只读核对并恢复',exact:true}).waitFor();
  for(let n=0;n<200&&(f.state.posts.length!==1||f.state.queue?.items[0]?.status!=='pending');n++)await new Promise(r=>setTimeout(r,100));
  assert.equal(f.state.signatures.length,1);assert.equal(f.state.posts.length,1);
  assert.equal(f.state.posts[0].kind,'executeApprovedOperation');
  assert.equal(f.state.queue.items[0].status,'pending');
  checks.push('first admin signature creates exactly one child and does not authorize purchase');
  await page.reload();
  await page.locator('header').getByRole('button',{name:'连接钱包',exact:true}).click();
  await page.getByRole('button',{name:'连接 MetaMask',exact:true}).click();
  await page.locator('header .live-wallet-label').filter({hasText:/^0x[0-9a-f]/i}).waitFor();
  await page.locator('nav').getByRole('button',{name:'运营工作台',exact:true}).click();
  await page.locator('.portfolio-card').first().click();
  await page.getByRole('button',{name:'只读核对并恢复',exact:true}).waitFor();
  assert.equal(f.state.signatures.length,1);assert.equal(f.state.posts.length,1);
  f.state.pendingReceipt=false;
  await page.getByRole('button',{name:'只读核对并恢复',exact:true}).click();
  await page.getByText('子池已建成',{exact:true}).waitFor();
  checks.push('refresh preserves unresolved intent; finalized receipt recovers child without another signature');
  await page.getByRole('button',{name:'预览由项目购买这台矿机',exact:true}).click();
  await page.getByRole('button',{name:'发送这一笔到钱包',exact:true}).click();
  for(let n=0;n<200&&f.state.queue?.items[0]?.status!=='completed';n++)await new Promise(r=>setTimeout(r,100));
  await page.locator('.portfolio-card').first().click();
  await page.getByText('已购入',{exact:true}).waitFor();
  assert.equal(f.state.signatures.length,2);assert.equal(f.state.posts.length,2);
  assert.equal(f.state.posts[1].kind,'buyBudgetOfficial');assert.equal(f.state.posts[1].args.child,f.child);
  assert.equal(f.state.posts[1].args.maxCost,'1000000000000');
  assert.equal(f.state.queue.items[0].status,'completed');
  checks.push('second independent signature binds confirmed child and exact current Wei; successful receipt completes queue');
  f.state.account=f.ordinary;
  await page.evaluate(a=>window.ethereum.__emit('accountsChanged',[a]),f.ordinary);
  await page.waitForURL(/#home$/);
  assert.equal(await page.locator('nav').getByRole('button',{name:'运营工作台',exact:true}).count(),0);
  assert.equal(await page.locator('.budget-queue').count(),0);
  checks.push('account switch removes admin forms and cannot retain the purchase confirmation');
  await page.locator('header').getByRole('button',{name:'连接钱包',exact:true}).click();
  await page.getByRole('button',{name:'连接 MetaMask',exact:true}).click();
  await page.locator('header .live-wallet-label').filter({hasText:/^0x[0-9a-f]/i}).waitFor();
  await page.evaluate(a=>{location.hash='portfolio/'+a;},PORTFOLIOS[0]);
  await page.getByRole('heading',{name:'出售我的项目份额',exact:true}).waitFor();
  await page.getByLabel('每份价格（BNB）',{exact:true}).fill('0.005');
  await page.getByRole('button',{name:'预览挂卖份额',exact:true}).click();
  const listing=page.getByRole('dialog',{name:'确认预算项目操作',exact:true});
  await listing.waitFor();assert((await listing.innerText()).includes('挂卖 10 份，每份 0.00500 BNB'));
  assert.equal(f.state.posts.length,2);assert.equal(f.state.signatures.length,2);
  await listing.getByRole('button',{name:'返回',exact:true}).click();
  checks.push('ordinary holder lists their selected project without administrator access or manually entering its address');
  f.state.operationalReady=false;
  await page.reload();
  await page.locator('header').getByRole('button',{name:'连接钱包',exact:true}).click();
  await page.getByRole('button',{name:'连接 MetaMask',exact:true}).click();
  await page.locator('header .live-wallet-label').filter({hasText:/^0x[0-9a-f]/i}).waitFor();
  await page.evaluate(a=>{location.hash='portfolio/'+a;},PORTFOLIOS[0]);
  await page.getByRole('heading',{name:'出售我的项目份额',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'预览挂卖份额',exact:true}).isDisabled(),true);
  const claim=page.locator('.portfolio-detail').getByRole('button',{name:/^领取 .* BNB$/});
  await claim.click();
  const withdrawal=page.getByRole('dialog',{name:'确认预算项目操作',exact:true});
  await withdrawal.getByRole('button',{name:'发送到钱包确认',exact:true}).click();
  for(let n=0;n<200&&f.state.userSends.length!==1;n++)await new Promise(r=>setTimeout(r,100));
  assert.equal(f.state.userSends.length,1);assert.equal(f.state.posts.length,2);assert.equal(f.state.signatures.length,2);
  assert.equal(f.state.userSends[0].from,f.ordinary);assert.equal(f.state.userSends[0].to,PORTFOLIOS[0]);
  assert(BigInt(f.state.userSends[0].gas)>0n);assert.equal(BigInt(f.state.userSends[0].value),0n);
  checks.push('with platform services offline, the current verified user exit prompts a direct user-paid Gas transaction, never Authority relay; listing remains blocked');
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  await page.screenshot({path:join(output,'fresh-account-switch.png'),fullPage:true});
  await writeFile(join(output,'results.json'),json({passed:true,checks,errors,requests,
    syntheticSignatures:f.state.signatures.length,syntheticRelays:f.state.posts.length,userGasTransactions:f.state.userSends.length,manifestSha:f.manifestSha}));
  console.log(json({passed:true,checks,output}));
}catch(error){
  await writeFile(join(output,'failure.json'),json({error:error.stack,checks,errors,requests,signatures:f.state.signatures.length,
    posts:f.state.posts,queue:f.state.queue,body:await page?.locator('body').innerText().catch(()=>null)}));
  await page?.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;
}finally{await browser.close();}
