/** Local browser regression for exact miner lookup; all wallet and quote responses are fixtures. */
import assert from 'node:assert/strict';
import { installLiveFixture } from './live-browser-fixture.mjs';
import { dataFixture } from './operator-quotes-fixture.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3114/bemine-v2/';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    ? route.fallback() : route.abort());
  const fixture = await installLiveFixture(page, { isOperator: true });
  const data = dataFixture();
  const exactRow = structuredClone(data.row);
  exactRow.tokenId = '13043';
  exactRow.bestAsk.execution.tokenId = '13043';
  const requests = [];
  await page.route(/\/firsto-api\//, route => {
    const url = new URL(route.request().url());
    requests.push(url);
    const result = url.pathname.endsWith('/circuits')
      ? { ...data.page, rows: url.searchParams.get('query') === '13043' ? [exactRow] : url.searchParams.get('query') ? [] : [data.row],
        total: 1, totalPages: 1 }
      : data.referenceRaw;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(base);
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: '运营工作台', exact: true }).click();
  const table = page.locator('.operator-quote-table');
  await table.getByText('TapeOut #16480').waitFor();
  await page.getByLabel('搜索报价矿机编号').fill('13043');
  await page.getByLabel('报价矿机系列').selectOption('TapeOut');
  await page.getByRole('button', { name: '查询矿机', exact: true }).click();
  await table.getByText('TapeOut #13043').waitFor();
  assert.equal(await table.getByText('TapeOut #16480').count(), 0);
  assert(requests.some(url => url.searchParams.get('query') === '13043'
    && url.searchParams.get('processorName') === 'TapeOut'
    && url.searchParams.get('miningStatus') === 'verified'));
  assert.equal(fixture.controls.sentTransactions.length, 0);
  await page.getByLabel('搜索报价矿机编号').fill('99999');
  await page.getByRole('button', { name: '查询矿机', exact: true }).click();
  await page.getByRole('button', { name: '直查官网链上矿机', exact: true }).waitFor();
  assert.equal(await table.getByText('TapeOut #13043').count(), 0);
  console.log(JSON.stringify({ passed: true, checks: ['exact API lookup replaces stale rows', 'official on-chain fallback remains available', 'no wallet transaction'] }));
} finally { await browser.close(); }
