/** Parent-income regression against the real index response shape. Local synthetic reads only. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { PORTFOLIOS, address } from './portfolio-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3218/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const out = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-portfolio-yield');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
const f = freshAuthorityBrowserFixture(), json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const errors = [], writes = [], checks = [], requests = [];
let mode = 'normal';
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
  const url = new URL(route.request().url()), reply = f.index(url.href);
  if (url.pathname.endsWith('/v1/yield')) {
    requests.push({ pool: url.searchParams.get('pool'), account: url.searchParams.get('account'), days: url.searchParams.get('days') });
    assert.equal(reply.data.scope, 'portfolio', 'fixture must represent the server parent ledger');
    if (mode === 'wrong-scope') reply.data.scope = 'pool';
    if (mode === 'wrong-source') reply.source.portfolioFactory = address(0xffff);
    if (mode === 'zero') for (const bucket of reply.data.buckets) bucket.poolHarvestNetAtomic = '0';
  }
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
try {
  await page.goto(base + '/#portfolio/' + PORTFOLIOS[0]);
  await page.getByText('项目收益与公开记录', { exact: true }).click();
  const load = page.getByRole('button', { name: '读取项目收益与记录', exact: true });
  await load.click();
  await page.getByRole('heading', { name: '项目收益归集', exact: true }).waitFor();
  await page.getByText('暂无该项目已确认记录。', { exact: true }).waitFor();
  assert.equal(await page.locator('.chart-summary strong').first().innerText(), '7.00000 BEM');
  assert.equal(await page.getByText('本人实际领取', { exact: true }).count(), 0);
  assert.equal(await page.getByText('收益数据口径无效。', { exact: true }).count(), 0);
  assert.match(await page.locator('.live-yield').innerText(), /不重复累加子矿池归集/);
  checks.push('Real portfolio scope loads parent-only receipts without a wallet or fabricated personal claims');
  await page.screenshot({ path: join(out, 'portfolio-yield-desktop.png'), fullPage: true });
  await page.locator('.live-yield').getByRole('button', { name: '30D', exact: true }).click();
  await page.getByRole('img', { name: '本期项目归集 30.00000 BEM，30 天', exact: true }).waitFor();
  checks.push('Seven- and thirty-day windows use the selected parent address and exact BEM decimals');
  for (const badMode of ['wrong-scope', 'wrong-source']) {
    mode = badMode; await load.click();
    await page.getByRole('alert').filter({ hasText: badMode === 'wrong-scope' ? '收益数据口径无效。' : '预算历史记录来源不一致。' }).waitFor();
    assert.equal(await page.locator('.live-yield').count(), 0, 'unverified results must not leave an apparently current chart');
  }
  checks.push('Child-pool scope and a different portfolio factory remain rejected with no trusted-looking chart');
  mode = 'zero'; await load.click();
  await page.getByRole('img', { name: '本期项目归集 0.00000 BEM，30 天', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: /收益数据口径无效|预算历史记录来源不一致/ }).count(), 0);
  assert.equal(await page.locator('.live-yield-column').count(), 30);
  checks.push('A verified zero-income parent recovers correctly and displays real zero buckets');
  await page.locator('.topbar select').selectOption('en');
  await page.getByRole('heading', { name: 'Output collected into the portfolio', exact: true }).waitFor();
  assert(!/\p{Script=Han}/u.test(await page.locator('.live-yield').innerText()));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: join(out, 'portfolio-yield-mobile-en.png'), fullPage: true });
  checks.push('English and mobile views retain portfolio-specific accounting labels without overflow');
  assert(requests.every(request => request.pool.toLowerCase() === PORTFOLIOS[0].toLowerCase() && request.account === null));
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  assert.equal(f.state.signatures.length, 0); assert.equal(f.state.userSends.length, 0);
  const result = { passed: true, checks, requests, errors, writes, walletConnected: false, realNetworkBlocked: true };
  await writeFile(join(out, 'results.json'), json(result)); console.log(json(result));
} catch (error) {
  await writeFile(join(out, 'failure.json'), json({ error: error.stack, checks, requests, errors, writes, text: await page.locator('body').innerText() }));
  await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }); throw error;
} finally { await page.close(); await browser.close(); }
