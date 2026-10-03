/** Local fresh-v4 public records only. Never connect a wallet or send a transaction. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { PORTFOLIOS } from './portfolio-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3216/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const out = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-activity-descriptions');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(30000);
const f = freshAuthorityBrowserFixture(), json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const hash = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const errors = [], writes = [], checks = [], account = f.ordinary;
const rows = [
  ['PortfolioCreated', { portfolio: PORTFOLIOS[0], budgetWei: '123456789123456789', absoluteCapWei: '50000000000000000', unitCapWei: '10000000000' }],
  ['Deposited', { member: account, shares: '7', amount: '123456789123456789' }],
  ['DepositWithdrawn', { user: account, shares: '7', amount: '123456789123456789' }],
  ['Purchased', { cost: '120000000000000000', path: '0', listingId: '5' }],
  ['BemClaimed', { member: account, amount: '123450000' }],
  ['OrderFilled', { buyer: account, orderId: '9', amount: '3', gross: '2000000000000000000', fee: '20000000000000000' }],
  ['SaleProceedsSettled', { user: account, shares: '7', amount: '123456789123456789' }],
  ['BnbWithdrawn', { member: account, amount: '123456789123456789' }],
  ['FutureUnknown', {}],
].map(([event, fields], i) => ({ event, fields, contract: f.manifest.portfolioFactory, pool: PORTFOLIOS[0],
  blockNumber: 100 - i, blockHash: hash(100 - i), transactionHash: hash(1000 + i), transactionIndex: 0, logIndex: 0,
  timestamp: f.f.source().indexedTimestamp - i * 3, source: 'portfolio' }));
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(f.manifest) }));
await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
  const input = route.request().postDataJSON();
  if (/sign|send|wallet_|requestAccounts/i.test(input.method)) { writes.push(input.method); return route.abort(); }
  try { await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: input.id, result: await f.request(input) }) }); }
  catch (error) { await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
});
await page.route(/\/api\/chain-index\//, route => {
  const url = new URL(route.request().url()), reply = url.pathname.endsWith('/v1/activity')
    ? { source: f.f.source(), data: { items: rows, nextCursor: null } } : f.index(url.href);
  return route.fulfill({ contentType: 'application/json', body: json(reply) });
});
await page.route(/\/firsto-api\/v1\//, route => {
  const path = new URL(route.request().url()).pathname;
  return route.fulfill({ contentType: 'application/json', body: json(path.endsWith('/circuits') ? f.data.page : path.endsWith('/circuit-holders') ? f.data.referenceRaw : f.data.detail) });
});
await page.route(/\/api\/journal\//, async route => {
  const request = route.request();
  if (request.method() !== 'GET') { writes.push(request.url()); return route.abort(); }
  const body = request.url().endsWith('/product-graph') ? f.graph() : await f.journal(request.url(), request.method(), null);
  return route.fulfill({ contentType: 'application/json', body: json(body) });
});
const event = name => page.locator(`[data-activity-event="${name}"]`);
try {
  await page.goto(base + '/#records');
  await event('PortfolioCreated').getByText('创建多矿机项目', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-activity-event]').count(), rows.length);
  assert.match(await event('PortfolioCreated').innerText(), /募集预算：0.12346 BNB/);
  assert.match(await event('PortfolioCreated').innerText(), /此记录不是认购付款/);
  assert.match(await event('DepositWithdrawn').innerText(), /尚不代表钱包收到款项/);
  assert.match(await event('BemClaimed').innerText(), /1.23450 BEM/);
  assert.match(await event('OrderFilled').innerText(), /成交份数：3/);
  assert.match(await event('FutureUnknown').innerText(), /其他链上记录/);
  assert.equal(await event('PortfolioCreated').locator('code').innerText(), 'PortfolioCreated');
  const first = event('PortfolioCreated').locator('xpath=ancestor::tr');
  assert.equal(await first.getByRole('link').filter({ hasText: '0x' }).count(), 2);
  assert.equal(await first.locator('td').first().innerText(), '100');
  checks.push('Chinese records explain project creation, subscription, refund credits, purchase, claims and trades; unknown empty-field events remain readable with raw names and chain links');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出已加载记录', exact: true }).click();
  const download = await pending, file = join(out, 'records.csv'); await download.saveAs(file);
  const csv = await readFile(file, 'utf8');
  for (const value of ['PortfolioCreated', 'FutureUnknown', '123456789123456789', hash(1000), f.manifest.portfolioFactory]) assert(csv.includes(value));
  assert.equal(csv.trimEnd().split('\n').length, rows.length + 1);
  checks.push('Downloaded CSV retains every original event, transaction and exact unsimplified uint value');
  await page.screenshot({ path: join(out, 'records-desktop-zh.png'), fullPage: true });
  await page.locator('.topbar select').selectOption('en');
  await event('PortfolioCreated').getByText('Multi-miner project created', { exact: true }).waitFor();
  assert.match(await event('PortfolioCreated').innerText(), /Funding budget: 0.12346 BNB/);
  assert.match(await event('DepositWithdrawn').innerText(), /does not itself pay the wallet/);
  assert.match(await event('BemClaimed').innerText(), /1.23450 BEM/);
  checks.push('Language switch translates operation names, explanations and facts without changing raw event names or values');
  await page.screenshot({ path: join(out, 'records-desktop-en.png'), fullPage: true });
  await page.locator('.topbar select').selectOption('zh');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.equal(await event('PortfolioCreated').isVisible(), true);
  await page.screenshot({ path: join(out, 'records-mobile-zh.png'), fullPage: true });
  checks.push('Mobile contains wide records in its scrollable table and keeps readable descriptions');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/#portfolio/' + PORTFOLIOS[0]);
  await page.getByText('项目收益与公开记录', { exact: true }).click();
  await page.getByRole('button', { name: '读取项目收益与记录', exact: true }).click();
  await event('PortfolioCreated').getByText('创建多矿机项目', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-activity-event]').count(), rows.length);
  assert.match(await event('SaleProceedsSettled').innerText(), /尚不代表钱包收到款项/);
  checks.push('Multi-miner detail history uses the same descriptions while retaining its existing verified reader and transaction links');
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  assert.equal(f.state.signatures.length, 0); assert.equal(f.state.userSends.length, 0);
  await writeFile(join(out, 'results.json'), json({ passed: true, checks, errors, writes, walletConnected: false, realNetworkBlocked: true }));
  console.log(json({ passed: true, checks, out }));
} catch (error) {
  await writeFile(join(out, 'failure.json'), json({ error: error.stack, checks, errors, writes, text: await page.locator('body').innerText() }));
  await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }); throw error;
} finally { await page.close(); await browser.close(); }
