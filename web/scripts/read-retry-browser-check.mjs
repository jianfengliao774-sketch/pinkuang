/** Local offline fixtures only; no wallet signatures or real chain requests. */
import assert from 'node:assert/strict';
import { installLiveFixture } from './live-browser-fixture.mjs';
import { portfolioFixture } from './portfolio-fixture.mjs';
import { READ_RETRY_MAX_ATTEMPTS } from '../lib/read-retry.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const checks = [], errors = [];
try {
  for (const failure of ['503', 'source_reorg', '403', 'persistent_503']) {
    const page = await browser.newPage(); page.setDefaultTimeout(65000);
    page.on('pageerror', error => errors.push(error.message));
    const fixture = await installLiveFixture(page);
    let catalogs = 0, stats = 0;
    await page.route(/\/api\/chain-index\//, async route => {
      const url = route.request().url();
      if (url.includes('/v1/pools')) catalogs++;
      if (!url.endsWith('/v1/stats')) return route.fallback();
      stats++;
      if (failure === 'persistent_503' || (failure === '503' && stats <= 3) || (stats === 1 && failure === '403'))
        return route.fulfill({ status: failure === '403' ? 403 : 503, contentType: 'application/json', body: '{}' });
      const result = fixture.index(url);
      // A changed timestamp for the same block/hash fails canonical verification, not ordinary source drift.
      if (stats === 1 && failure === 'source_reorg') result.source.indexedTimestamp++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
    });
    await page.goto(base);
    if(failure==='503')await page.getByRole('status').filter({hasText:'正在自动重试'}).waitFor();
    await page.waitForFunction(() => document.querySelector('main')?.dataset.readyRoute === 'home'
      && document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    if (failure === '503') {
      assert.equal(stats, 4); assert.equal(catalogs, 4);
      assert.equal(await page.locator('.live-notice.error').count(), 0);
      checks.push(`${failure} recovers beyond the old three-attempt limit with visible retry progress and entirely fresh rounds`);
    } else {
      assert.equal(stats, failure === 'persistent_503' ? READ_RETRY_MAX_ATTEMPTS : 1);
      assert.equal(catalogs, stats);
      assert.match(await page.locator('.live-notice.error').innerText(), failure === 'source_reorg' ? /索引区块已变化/ : failure === '403' ? /HTTP 403/ : /HTTP 503/);
      checks.push(`${failure} stops at its retry limit with the original error`);
      await page.getByRole('button',{name:'重新读取项目',exact:true}).waitFor();
    }
    assert.equal(fixture.controls.sentTransactions.length, 0);
    assert(!fixture.walletRequests.some(request => /sign|send/i.test(request.method)));
    await page.close();
  }
  const page=await browser.newPage();page.setDefaultTimeout(65000);page.on('pageerror',e=>errors.push(e.message));
  const f=portfolioFixture(),json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
  let portfolios=0,persistent=false,recoveredManually=false;
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
  await page.route(/\/data\/frontend-manifest\.json(?:\?.*)?$/,route=>route.fulfill({contentType:'application/json',body:json(f.manifest)}));
  await page.route(/\/api\/rpc(?:\?.*)?$/,async route=>{const p=route.request().postDataJSON();try{await route.fulfill({contentType:'application/json',body:json({jsonrpc:'2.0',id:p.id,result:await f.request(p)})});}catch(e){await route.fulfill({status:400,contentType:'application/json',body:json({error:e.message})});}});
  await page.route(/\/api\/chain-index\//,async route=>{const url=route.request().url();if(new URL(url).pathname.endsWith('/portfolios')){portfolios++;if(!recoveredManually&&(persistent||portfolios<=3))return route.fulfill({status:503,contentType:'application/json',body:'{}'});}return route.fulfill({contentType:'application/json',body:json(f.index(url))});});
  await page.route(/\/api\/journal\//,route=>route.fulfill({contentType:'application/json',body:'{"enabled":false}'}));
  await page.goto(`${base.replace(/\/$/,'')}/#pools`);
  const panel=page.getByRole('region',{name:'多矿机预算项目'});
  await panel.getByRole('status').filter({hasText:'正在自动重试'}).waitFor();
  await panel.locator('.portfolio-cards > button').first().waitFor();
  assert.equal(portfolios,4);assert.equal(await panel.locator('.portfolio-cards > button').count(),2);assert.equal(await panel.getByRole('alert').count(),0);
  checks.push('budget catalog recovers on its fourth full verified round without a manual refresh');
  portfolios=0;persistent=true;await panel.getByRole('button',{name:'刷新项目',exact:true}).click();
  await panel.getByRole('button',{name:'重新读取预算项目',exact:true}).waitFor();
  assert.equal(portfolios,READ_RETRY_MAX_ATTEMPTS);assert.match(await panel.getByRole('alert').innerText(),/HTTP 503/);
  assert.equal(await panel.getByRole('status').count(),0);assert.equal(await panel.getByText('当前没有预算项目。',{exact:true}).count(),0);
  recoveredManually=true;await panel.getByRole('button',{name:'重新读取预算项目',exact:true}).click();
  await panel.locator('.portfolio-cards > button').first().waitFor();assert.equal(await panel.getByRole('alert').count(),0);
  checks.push('persistent budget 503 ends in an explicit error, never a false empty result; its manual retry restores verified data');
  portfolios=0;persistent=true;recoveredManually=false;await panel.getByRole('button',{name:'刷新项目',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'正在自动重试'}).waitFor();
  await page.locator('nav').getByRole('button',{name:'公开记录',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('main')?.dataset.readyRoute==='records'&&document.querySelector('main')?.getAttribute('aria-busy')==='false');
  const before=portfolios;await page.waitForTimeout(1500);assert.equal(portfolios,before);
  assert.equal(await page.getByText(/预算数据暂时未就绪/).count(),0);
  checks.push('leaving a budget retry cancels its next round and cannot publish into the new route');
  if(process.env.BEMINE_BROWSER_OUTPUT){await mkdir(process.env.BEMINE_BROWSER_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.BEMINE_BROWSER_OUTPUT,'read-retry-final.png'),fullPage:true});}
  await page.close();
  assert.deepEqual(errors, []);
  const result={passed:checks.length,checks,pageErrors:errors};
  if(process.env.BEMINE_BROWSER_OUTPUT)await writeFile(join(process.env.BEMINE_BROWSER_OUTPUT,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
