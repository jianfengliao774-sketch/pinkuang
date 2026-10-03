/** End-to-end UI tests with a fake wallet and in-process journals. Never a real chain or signature. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installLiveFixture,FIXTURE_POOLS} from './live-browser-fixture.mjs';
const {chromium}=await import(process.env.BEMINE_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BEMINE_TEST_URL||'http://127.0.0.1:3108';
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname));
const output=process.env.BEMINE_BROWSER_OUTPUT||join(tmpdir(),'bemine-browser-check');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.BEMINE_TEST_BROWSER?{channel:process.env.BEMINE_TEST_BROWSER}:{})});
const checks=[];
try{
 for(const pendingDeposit of [false,true]){
  const page=await browser.newPage({viewport:pendingDeposit?{width:390,height:844}:{width:1440,height:1000}});
  page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const fixture=await installLiveFixture(page,{confirmDeposit:true,pendingDeposit});
  try{
   await page.goto(`${base}/#detail/${FIXTURE_POOLS.funding}`);
   await page.getByRole('button',{name:'连接钱包',exact:true}).click(); await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click(); await page.locator('header .live-wallet-label').filter({hasText:/0x[0-9a-f]/i}).waitFor();
   await page.locator('.purchase-panel').getByRole('button',{name:'参与拼矿',exact:true}).click();
   await page.getByLabel('份额数量',{exact:true}).fill('2');
   await page.getByRole('button',{name:'核对交易金额',exact:true}).click();
   await page.getByRole('button',{name:'确认并前往钱包',exact:true}).waitFor();
   assert((await page.locator('.confirm-lines').innerText()).includes('0.14300 BNB'));
   assert.equal(fixture.controls.sentTransactions.length,0,'preview must never broadcast');
   await page.getByRole('button',{name:'确认并前往钱包',exact:true}).click();
   if(pendingDeposit){
    await page.getByText('有一笔交易等待核对',{exact:true}).waitFor();
    assert.equal(await page.getByText('认购已确认',{exact:true}).count(),0);
    assert.match(await page.getByLabel('交易哈希',{exact:true}).inputValue(),/^0x[\da-f]{64}$/i);
    fixture.controls.confirm();await page.getByRole('button',{name:'核对最终结果',exact:true}).click();
   }
   await page.getByText('认购已确认',{exact:true}).waitFor();
   const text=await page.getByLabel('Telegram 分享文案',{exact:true}).inputValue();
   assert(text.includes('33'));assert(!text.includes(fixture.account));assert(!text.includes('0.143'));
   assert.equal(fixture.controls.sentTransactions.length,1);assert.equal(fixture.controls.journalState().record,null);
   assert(fixture.controls.trace.indexOf('journal:ack')<fixture.controls.trace.indexOf('wallet:fake-send'));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   assert.deepEqual(errors,[]);
   await page.screenshot({animations:'disabled',path:join(output,pendingDeposit?'mobile-confirmed-share.png':'desktop-confirmed-share.png')});
   checks.push(pendingDeposit?'pending receipt → manual recovery → verified mobile share, no resend':'exact payment → ACK → one fake wallet send → verified share');
  }catch(error){await page.screenshot({animations:'disabled',path:join(output,'payment-failure.png')});console.error(await page.locator('main,.live-modal').allTextContents());throw error}finally{await page.close()}
 }
 await writeFile(join(output,'payment-results.json'),JSON.stringify({checks},null,2));console.log(JSON.stringify({passed:checks.length,checks,output}));
}finally{await browser.close()}
