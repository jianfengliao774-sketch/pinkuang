/** A verified displayed order remains actionable while its list refresh is slow. */
import assert from 'node:assert/strict';
import { installLiveFixture } from './live-browser-fixture.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108').replace(/\/+$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true,
  ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
let releaseOrders = () => {};
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = await installLiveFixture(page);
  await page.goto(`${base}/#market`);
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('header .live-wallet-label').filter({hasText:/0x[0-9a-f]/i}).waitFor();
  const buy = page.getByRole('button', { name: '买入份额', exact: true });
  const cancel = page.getByRole('button', { name: '撤单', exact: true });
  await buy.waitFor();
  await cancel.waitFor();
  assert.equal(await page.getByText('这是你的挂单；购买请切换买家钱包', { exact: true }).count(), 1);

  let orderRequestStarted;
  const started = new Promise(resolve => { orderRequestStarted = resolve; });
  const blocked = new Promise(resolve => { releaseOrders = resolve; });
  await page.route(/\/api\/chain-index\/v1\/orders(?:\?.*)?$/, async route => {
    orderRequestStarted();
    await blocked;
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(fixture.index(route.request().url())) });
  });
  await page.getByRole('button', { name: '刷新', exact: true }).first().click();
  await started;
  assert.equal(await buy.isEnabled(), true, 'a cached verified buyer order must remain available');
  assert.equal(await cancel.isEnabled(), true, 'the seller must still be able to cancel during a list refresh');

  await buy.click();
  await page.getByRole('button', { name: '核对交易金额', exact: true }).click();
  await page.getByRole('button', { name: '确认并前往钱包', exact: true }).waitFor();
  assert.equal(fixture.controls.sentTransactions.length, 0, 'preview must not send a wallet transaction');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, buyerCanPreviewDuringOrderRefresh: true,
    sellerCanCancelDuringOrderRefresh: true, walletTransactions: 0 }));
} finally {
  releaseOrders();
  await browser.close();
}
