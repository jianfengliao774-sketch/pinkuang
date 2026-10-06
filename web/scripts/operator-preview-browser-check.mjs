/** Offline operator creation check: local RPC fixture, no signature or transaction. */
import assert from 'node:assert/strict';
import { installLiveFixture } from './live-browser-fixture.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3113/';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(12000);
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.fallback() : route.abort());
  const fixture = await installLiveFixture(page, { isOperator: true });
  await page.goto(base);
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: '运营工作台', exact: true }).click();
  await page.getByLabel('矿机编号', { exact: true }).fill('5500');
  await page.getByLabel('募集总额（BNB）', { exact: true }).fill('1.667');
  await page.getByLabel('购机价格上限（BNB）', { exact: true }).fill('1.515');
  await page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认运营操作' });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /5500/);
  assert.match(await dialog.innerText(), /1\.51500 BNB/);
  assert.match(await dialog.innerText(), /1\.66700 BNB/);
  assert.equal(await page.locator('.operator-preview-overlay').count(), 1);
  assert(await dialog.getByRole('button', { name: '发送到钱包确认' }).isVisible());
  assert.equal(fixture.controls.sentTransactions.length, 0);
  await dialog.getByRole('button', { name: '返回修改' }).click();
  assert.equal(await dialog.count(), 0);
  assert.equal(fixture.controls.sentTransactions.length, 0);
  console.log(JSON.stringify({ passed: true, checks: ['one visible create-pool review', 'miner and exact price shown', 'return without wallet send'] }));
} finally { await browser.close(); }
