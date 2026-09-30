/** Local synthetic chain only. Exercises the shipped list and its existing detail reader. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { PORTFOLIOS } from './portfolio-fixture.mjs';
const {chromium}=await import(process.env.BEMINE_PLAYWRIGHT_MODULE||'playwright');
const base=(process.env.BEMINE_TEST_URL||'http://127.0.0.1:3216/bemine-v4').replace(/\/$/,'');
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const out=process.env.BEMINE_BROWSER_OUTPUT||join(tmpdir(),'project-directory-browser');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.BEMINE_TEST_BROWSER||'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
page.setDefaultTimeout(30000);
const f=freshAuthorityBrowserFixture();f.f.state.poolState=undefined;
const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const errors=[],writes=[],checks=[],indexReads=[];let failPortfolio=false;
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/,route=>route.fulfill({contentType:'application/json',body:json(f.manifest)}));
await page.route(/\/api\/rpc(?:\?.*)?$/,async route=>{
 const p=route.request().postDataJSON();
 if(/sign|send|wallet_/i.test(p.method)){writes.push(p.method);return route.abort();}
 try{await route.fulfill({contentType:'application/json',body:json({jsonrpc:'2.0',id:p.id,result:await f.request(p)})});}
 catch(error){await route.fulfill({status:400,contentType:'application/json',body:json({error:error.message})});}
});
await page.route(/\/api\/chain-index\//,route=>{
 const url=new URL(route.request().url()),portfolio=url.pathname.endsWith('/portfolios'),single=url.pathname.endsWith('/v1/pools');
 if(portfolio&&failPortfolio)return route.fulfill({status:403,contentType:'application/json',body:json({error:'directory_unavailable'})});
 let reply;
 if(portfolio||single){const cursor=Number(url.searchParams.get('cursor')||0),size=portfolio?1:2;url.searchParams.set('cursor','0');
   reply=f.index(url.href);const all=reply.data.items;reply.data={...reply.data,items:all.slice(cursor,cursor+size),nextCursor:cursor+size<all.length?cursor+size:null};
   indexReads.push({kind:portfolio?'portfolio':'single',cursor});
 }else reply=f.index(url.href);
 return route.fulfill({contentType:'application/json',body:json(reply)});
});
await page.route(/\/firsto-api\/v1\//,route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({contentType:'application/json',body:json(path.endsWith('/circuits')?f.data.page:path.endsWith('/circuit-holders')?f.data.referenceRaw:f.data.detail)});});
await page.route(/\/api\/journal\//,async route=>{
 const r=route.request();if(r.method()!=='GET'){writes.push(r.url());return route.abort();}
 const body=r.url().endsWith('/product-graph')?f.graph():await f.journal(r.url(),r.method(),null);
 return route.fulfill({contentType:'application/json',body:json(body)});
});
const list=()=>page.locator('[data-project-directory="unified"]');
const rows=()=>list().locator('tbody tr');
const settled=()=>page.waitForFunction(()=>document.querySelector('[data-project-directory="unified"]')?.getAttribute('aria-busy')==='false'&&document.querySelector('main')?.getAttribute('aria-busy')==='false');
try{
 await page.goto(base+'/#pools');await settled();await rows().filter({hasText:'多矿机项目'}).first().waitFor();
 assert.equal(await list().count(),1);assert.equal(await page.getByRole('heading',{name:'多矿机预算项目',exact:true}).count(),0);
 assert.equal(await rows().count(),2);assert(!/尚未创建拼矿项目/.test(await page.locator('body').innerText()));
 assert.equal(await page.locator('.live-project-summary button').filter({hasText:'募集中'}).locator('strong').innerText(),'2');
 checks.push('Single-miner and parent funding projects share one table and a consistent count; no separate panel or false empty state');
 await list().getByRole('button',{name:'项目总览',exact:true}).click();assert.equal(await rows().count(),3);
 await page.getByRole('button',{name:'加载更多',exact:true}).click();await settled();assert.equal(await rows().count(),6);
 assert(indexReads.some(r=>r.kind==='single'&&r.cursor===2));assert(indexReads.some(r=>r.kind==='portfolio'&&r.cursor===1));
 assert.equal(new Set(await rows().evaluateAll(es=>es.map(e=>e.dataset.projectAddress))).size,6);
 assert.equal(await page.getByRole('button',{name:'加载更多',exact:true}).count(),0);
 checks.push('One pagination control advances both independent readers, adds each parent once and stops when both are exhausted');
 await list().getByRole('button',{name:'筛选排序',exact:true}).click();await page.getByRole('menuitemradio',{name:'每份金额从低到高',exact:true}).click();
 assert.equal(await rows().first().getAttribute('data-project-kind'),'portfolio');
 const search=page.getByRole('textbox',{name:'搜索矿机或地址',exact:true});await search.fill(PORTFOLIOS[0]);assert.equal(await rows().count(),1);
 await search.fill('多矿机');assert.equal(await rows().count(),2);await search.fill('');
 await list().getByRole('button',{name:'挖矿中',exact:true}).click();assert.equal(await rows().count(),3);
 checks.push('Shared price sorting, address/type search and operating filter include parent projects');
 await list().getByRole('button',{name:'募集中',exact:true}).click();await rows().filter({hasText:'多矿机项目'}).getByRole('button',{name:'查看项目',exact:true}).click();
 await page.waitForURL(new RegExp('#portfolio/'+PORTFOLIOS[0]+'$','i'));await page.getByRole('button',{name:'预览认购',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'预览认购',exact:true}).isDisabled(),false);
 assert.equal(writes.length,0);await page.getByRole('button',{name:'← 返回参与拼矿',exact:true}).click();await settled();
 checks.push('Parent row opens its existing identity-checked detail and subscription control; back returns to the shared directory without any signature');
 failPortfolio=true;await page.getByRole('button',{name:'刷新',exact:true}).first().click();
 await list().getByRole('alert').waitFor();await settled();
 assert((await list().locator('tr[data-project-kind="single"]').count())>0);
 assert(!/尚未创建拼矿项目/.test(await list().innerText()));
 assert.equal(await page.locator('.live-project-summary button').first().locator('strong').innerText(),'—');
 failPortfolio=false;await list().getByRole('alert').getByRole('button',{name:'重新读取',exact:true}).click();await settled();
 assert.equal(await list().getByRole('alert').count(),0);assert.equal(await rows().filter({hasText:'多矿机项目'}).count(),1);
 checks.push('A failed parent reader leaves available singles visible, reports incomplete totals and recovers through explicit retry');
 await page.screenshot({path:join(out,'desktop-unified.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(out,'mobile-unified.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 assert.equal(await list().count(),1);assert.equal(await page.locator('#multi-miner-projects').count(),0);
 checks.push('Mobile keeps the same single directory and contained horizontal table scroll');
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 await writeFile(join(out,'results.json'),json({passed:true,checks,indexReads,errors,writes}));console.log(json({passed:true,checks,out}));
}catch(error){await writeFile(join(out,'failure.json'),json({error:error.stack,checks,errors,writes,indexReads,text:await page.locator('body').innerText()}));await page.screenshot({path:join(out,'failure.png'),fullPage:true});throw error;}
finally{await context.close();await browser.close();}
