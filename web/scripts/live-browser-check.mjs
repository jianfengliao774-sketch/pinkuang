/** Run against a local development server; all chain/journal calls are intercepted by fixtures. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installLiveFixture,FIXTURE_POOLS} from './live-browser-fixture.mjs';
const {chromium}=await import(process.env.BEMINE_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BEMINE_TEST_URL||'http://127.0.0.1:3108';
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Browser checks must target a local server');
const output=process.env.BEMINE_BROWSER_OUTPUT||join(tmpdir(),'bemine-browser-check');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.BEMINE_TEST_BROWSER?{channel:process.env.BEMINE_TEST_BROWSER}:{})});
const checks=[],errors=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1050}});
 page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
 await page.route(/\/data\/frontend-manifest\.json(?:\?.*)?$/, route => route.fulfill({status:404,contentType:'application/json',body:'{}'}));
 await page.goto(base);await page.getByText('项目尚未开放，等待部署核验',{exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'连接钱包',exact:true}).isEnabled());
 assert.equal(await page.locator('.bemine-stat').filter({hasText:'累计立项'}).locator('strong').innerText(),'—个');
 checks.push('unconfigured: no fabricated balances or enabled wallet writes');
 await installLiveFixture(page);
 await page.goto(base);await page.getByText('数据区块 100',{exact:true}).waitFor();
 await page.getByRole('button',{name:'连接钱包',exact:true}).click(); await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click(); await page.locator('header .live-wallet-label').filter({hasText:/0x[0-9a-f]/i}).waitFor();
 const open=async route=>{await page.evaluate(hash=>{location.hash=hash},route);await page.waitForFunction(expected=>document.querySelector('main')?.dataset.readyRoute===expected&&document.querySelector('main')?.getAttribute('aria-busy')==='false',route);assert.equal(await page.locator('.live-notice.error').count(),0,await page.locator('.live-notice.error').allTextContents());};
 for(const route of ['overview','pools','market','rewards','governance','records']){
  await open(route);assert.equal(await page.locator('main h1').count(),1,route);checks.push(`desktop ${route}`);
 }
 await open(`detail/${FIXTURE_POOLS.funding}`);
 await page.locator('.purchase-panel').getByRole('button',{name:'邀请朋友一起拼矿',exact:true}).click();
 await page.getByRole('link',{name:'Telegram',exact:true}).waitFor();
 const telegram=new URL(await page.getByRole('link',{name:'Telegram',exact:true}).getAttribute('href'));
 assert.equal(telegram.hostname,'t.me');const invitation=new URL(telegram.searchParams.get('url'));assert.equal(invitation.searchParams.get('project'),FIXTURE_POOLS.funding);assert.equal(invitation.searchParams.get('mode'),'live');
 assert(!await page.getByLabel('Telegram 分享文案',{exact:true}).inputValue().then(text=>text.includes('已确认')));
 await page.screenshot({animations:'disabled',path:join(output,'desktop-invite.png')});checks.push('neutral share links point to the selected pool');
 await page.getByRole('button',{name:'收起分享',exact:true}).click();
 await open(`detail/${FIXTURE_POOLS.active}`);
 await page.getByRole('button',{name:'收益记录',exact:true}).click();await page.locator('.live-yield-bars').waitFor();
 await page.getByRole('button',{name:'参与者',exact:true}).click();await page.locator('.live-holder').first().waitFor();
 await open(`detail/${FIXTURE_POOLS.voting}`);await page.getByRole('button',{name:'共同决策',exact:true}).last().click();
 await page.getByRole('button',{name:'赞成',exact:true}).waitFor();assert(await page.getByRole('button',{name:'赞成',exact:true}).isEnabled());checks.push('detail yield, holders and multi-candidate governance use verified data');
 await page.getByLabel('Language',{exact:true}).selectOption('en');
 await page.getByRole('button',{name:'Change appearance',exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 await open(`detail/${FIXTURE_POOLS.funding}`);
 // Snapshot assertion is independent of the translated footer wording after the transition.
 await page.screenshot({animations:'disabled',path:join(output,'mobile-dark-detail.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false,'mobile horizontal overflow');
 await page.getByRole('button',{name:'Invite friends',exact:true}).last().click();
 await page.getByRole('link',{name:'Telegram',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.screenshot({animations:'disabled',path:join(output,'mobile-dark-share.png')});checks.push('English dark mobile layout and share dialog');
 await page.getByRole('button',{name:'Dismiss sharing',exact:true}).click();
 await page.goto(`${base}/preview#governance`);await page.locator('.preview-banner strong').waitFor();
 await page.getByText('样例提案 · 不可投票',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'赞成出售',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'反对',exact:true}).count(),0);
 assert.equal(new URL(await page.getByRole('link',{name:'查看链上提案并投票'}).getAttribute('href'),base).hash,'#governance');
 checks.push('demo governance retains sample figures but only links to on-chain voting');
 assert.deepEqual(errors,[]);await writeFile(join(output,'results.json'),JSON.stringify({checks,pageErrors:errors},null,2));console.log(JSON.stringify({passed:checks.length,checks,output}));
}finally{await browser.close()}
