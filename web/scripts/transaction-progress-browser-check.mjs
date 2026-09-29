/** Offline transaction progress/ordering tests with delayed journal acknowledgements. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installLiveFixture, FIXTURE_POOLS } from './live-browser-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const output = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-transaction-progress');
await mkdir(output, { recursive: true });
const checks = [], errors = [], gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function preparedPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const fixture = await installLiveFixture(page, { confirmDeposit: true });
  await page.goto(`${base}/#detail/${FIXTURE_POOLS.funding}`);
  await page.getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  await page.locator('.purchase-panel').getByRole('button', { name: '参与拼矿', exact: true }).click();
  await page.getByLabel('份额数量', { exact: true }).fill('2');
  await page.getByRole('button', { name: '核对交易金额', exact: true }).click();
  await page.getByRole('button', { name: '确认并前往钱包', exact: true }).waitFor();
  return { page, fixture };
}
try {
  const { page, fixture } = await preparedPage();
  const session = gate(), ack = gate(), arm = gate(); let initialPuts = 0, permits = 0;
  await page.route(/\/api\/journal\//, async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path.endsWith('/session') && method === 'GET') await session.promise;
    if (path.endsWith('/market') && method === 'PUT' && !request.postDataJSON()?.record?.hash) { initialPuts++; await ack.promise; }
    if (path.endsWith('/market/arm') && method === 'POST') { permits++; await arm.promise; }
    return route.fallback();
  });
  await page.evaluate(() => {
    window.__transactionProgress = [];
    const observe = () => {
      const text = document.querySelector('.live-modal [role="status"]')?.textContent?.trim();
      if (text && window.__transactionProgress.at(-1) !== text) window.__transactionProgress.push(text);
    };
    new MutationObserver(observe).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole('button', { name: '确认并前往钱包', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByRole('dialog').getByText('正在核对钱包登录…', { exact: true }).waitFor();
  assert.equal(fixture.controls.sentTransactions.length, 0);
  assert.equal(initialPuts, 0); session.release();
  await page.getByRole('dialog').getByText('正在确认订单信息…', { exact: true }).waitFor().catch(async error => { await page.screenshot({path:join(output,'duplicate-click-failure.png')}); console.log(JSON.stringify({initialPuts,permits,sends:fixture.controls.sentTransactions.length,trace:fixture.controls.trace,body:await page.locator('main,.live-modal').allTextContents(),stages:await page.evaluate(()=>window.__transactionProgress)})); throw error; });
  assert.equal(fixture.controls.sentTransactions.length, 0, 'no wallet send before intent ACK');
  assert.equal(initialPuts, 1); assert.equal(permits, 0);
  assert(await page.getByRole('button', { name: '等待确认…', exact: true }).isDisabled());
  await page.screenshot({ path: join(output, 'intent-ack-wait.png'), animations: 'disabled' });
  ack.release();
  await page.getByRole('dialog').getByText('正在完成发送前检查…', { exact: true }).waitFor();
  assert.equal(fixture.controls.sentTransactions.length, 0, 'no wallet send before single-use permission ACK');
  assert.equal(permits, 1);
  await page.screenshot({ path: join(output, 'signature-permission-wait.png'), animations: 'disabled' });
  arm.release();
  await page.getByText('认购已确认', { exact: true }).waitFor();
  assert.equal(fixture.controls.sentTransactions.length, 1, 'double click never duplicates send');
  const stages = await page.evaluate(() => window.__transactionProgress);
  assert(stages.includes('正在核对钱包登录…')); assert(stages.includes('正在确认订单信息…'));
  assert(stages.includes('正在完成发送前检查…')); assert(stages.includes('请在钱包弹窗中确认交易'));
  checks.push({ name: 'immediate progress, delayed intent ACK and permission ACK, double click sends once', stages });
  await page.close();

  const rejected = await preparedPage();
  await rejected.page.evaluate(() => {
    const request = window.ethereum.request.bind(window.ethereum);
    window.ethereum.request = async payload => {
      if (payload.method === 'eth_sendTransaction') { const error = new Error('User cancelled fake wallet'); error.code = 4001; throw error; }
      return request(payload);
    };
  });
  await rejected.page.getByRole('button', { name: '确认并前往钱包', exact: true }).click();
  await rejected.page.getByText('有一笔交易等待核对', { exact: true }).waitFor();
  assert.equal(rejected.fixture.controls.sentTransactions.length, 0);
  assert.equal(await rejected.page.getByText(/交易已提交/).count(), 0);
  assert.equal(await rejected.page.getByText('认购已确认', { exact: true }).count(), 0);
  await rejected.page.screenshot({ path: join(output, 'unknown-outcome-no-submitted-claim.png'), animations: 'disabled' });
  checks.push({ name: 'wallet rejection without a hash retains pending intent and never claims submitted or confirmed' });
  await rejected.page.close();
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, output }));
} finally { await browser.close(); }
