/** Offline UI check: a delayed order response cannot hide verified wallet shares. */
import assert from 'node:assert/strict';
import { installLiveFixture } from './live-browser-fixture.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108').replace(/\/+$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
let releaseOrders;
const ordersGate = new Promise(resolve => { releaseOrders = resolve; });
let releaseActivity, releaseStats;
const activityGate = new Promise(resolve => { releaseActivity = resolve; });
const statsGate = new Promise(resolve => { releaseStats = resolve; });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = await installLiveFixture(page);
  let orderRequests = 0;
  await page.route(/\/api\/chain-index\/v1\/orders(?:\?.*)?$/, async route => {
    orderRequests++;
    await ordersGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture.index(route.request().url())) });
  });
  await page.route(/\/api\/chain-index\/v1\/activity(?:\?.*)?$/, async route => {
    await activityGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture.index(route.request().url())) });
  });
  await page.route(/\/api\/chain-index\/v1\/stats(?:\?.*)?$/, async route => {
    await statsGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture.index(route.request().url())) });
  });
  await page.goto(`${base}/#market`);
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  const holdings = page.getByRole('button', { name: '挂单 Behemoth #8204', exact: true });
  await holdings.waitFor();
  await page.getByText('正在读取订单…', { exact: true }).waitFor();
  assert(orderRequests > 0);
  assert.match(await holdings.locator('xpath=ancestor::tr').innerText(), /35\s*\/\s*100/);
  assert.equal(await holdings.isDisabled(), false);
  releaseOrders();
  await page.getByRole('button', { name: '买入份额', exact: true }).first().waitFor();
  await page.locator('nav').getByRole('button', { name: '资产总览', exact: true }).click();
  await page.getByText('正在读取记录…', { exact: true }).waitFor();
  await page.getByRole('button', { name: '挂单 Behemoth #8204', exact: true }).waitFor();
  releaseActivity();
  await page.locator('nav').getByRole('button', { name: '拼矿总览', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('main')?.dataset.readyRoute === 'home'
    && document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  releaseStats();
  assert.deepEqual(errors, []);
  assert.equal(fixture.controls.sentTransactions.length, 0);
  console.log(JSON.stringify({ passed: true, holdingsVisibleBeforeOrders: true,
    holdingsVisibleBeforeActivity: true, homeReadyBeforeStats: true, shares: 35, orderRequests }));
} finally { releaseOrders(); releaseActivity(); releaseStats(); await browser.close(); }
