/** Local fresh-v4 only. Public reads, no injected wallet or write requests. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { activityPaginationFixture } from './activity-pagination-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3218/bemine-v4').replace(/\/$/, '');
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const out = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-activity-pagination-browser');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const checks = [], errors = [], unexpected = [], writes = [], scenarios = [];
let context, page, f, history;
const checked = message => { checks.push(message); console.log('PASS ' + message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolveStarted, resolveWait;
  return { started: new Promise(resolve => { resolveStarted = resolve; }),
    wait: () => { resolveStarted(); return new Promise(resolve => { resolveWait = resolve; }); },
    release: () => resolveWait?.() };
}
async function started(hold) {
  let timer;
  try { await Promise.race([hold.started, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('The expected next page did not start after scrolling')), 20000);
  })]); } finally { clearTimeout(timer); }
}
const rowLocator = () => page.locator('[data-activity-event]');
const sentinel = () => page.locator('[data-auto-page]');
const retry = () => page.getByRole('button', { name: '读取失败 · 重试', exact: true });
const nextReads = () => history.state.requests.filter(item => item.cursor !== null);
async function countRows(count) { await page.waitForFunction(n => document.querySelectorAll('[data-activity-event]').length === n, count); }
async function scrollBottom() { await sentinel().scrollIntoViewIfNeeded(); }
async function assertRows(count) {
  assert.equal(await rowLocator().count(), count);
  const hashes = await page.locator('main .table-wrap tbody tr td:last-child a').evaluateAll(links => links.map(link => link.href.split('/').at(-1)));
  assert.deepEqual(hashes, history.rows.slice(0, count).map(row => row.transactionHash));
  assert.equal(new Set(hashes).size, hashes.length, 'No history row may duplicate across pages');
}
async function setup(name, viewport = { width: 1440, height: 1000 }) {
  await context?.close();
  context = await browser.newContext({ viewport }); page = await context.newPage(); page.setDefaultTimeout(25000);
  f = freshAuthorityBrowserFixture(); history = activityPaginationFixture(f);
  scenarios.push({ name, requests: history.state.requests });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(f.manifest) }));
  await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
    const input = route.request().postDataJSON();
    if (/sign|send|wallet_|requestAccounts/i.test(input.method)) { writes.push(input.method); return route.abort(); }
    try {
      let result;
      // The optional home-page quote reader is irrelevant to public history.
      // Give these synthetic NFTs a nonofficial collection without RPC errors.
      const row = input.method === 'eth_call' && f.f.base.rows.find(row => row.pool.toLowerCase() === input.params[0].to.toLowerCase());
      if (row && abi.PoolVault.parseTransaction(input.params[0])?.name === 'params')
        result = abi.PoolVault.encodeFunctionResult('params', [{ ...row.params, circuits: '0x000000000000000000000000000000000000CAFE' }]);
      else result = await f.request(input);
      await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: input.id, result }) });
    } catch (error) {
      unexpected.push(error.message); await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) });
    }
  });
  await page.route(/\/api\/chain-index\//, async route => {
    try {
      const request = route.request(); assert.equal(request.method(), 'GET');
      const reply = new URL(request.url()).pathname.endsWith('/v1/activity')
        ? await history.read(request.url()) : { status: 200, body: f.index(request.url()) };
      await route.fulfill({ status: reply.status, contentType: 'application/json', body: json(reply.body) });
    } catch (error) { unexpected.push(error.message); await route.abort(); }
  });
  await page.route(/\/firsto-api\/v1\//, route => { const path = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: 'application/json', body: json(path.endsWith('/circuits') ? f.data.page : path.endsWith('/circuit-holders') ? f.data.referenceRaw : f.data.detail) }); });
  await page.route(/\/api\/journal\//, async route => {
    const request = route.request();
    if (request.method() !== 'GET') { writes.push(request.url()); return route.abort(); }
    const body = request.url().endsWith('/product-graph') ? f.graph() : await f.journal(request.url(), request.method(), null);
    return route.fulfill({ contentType: 'application/json', body: json(body) });
  });
  await page.goto(base + '/#records'); await countRows(20);
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  await delay(300); assert.equal(nextReads().length, 0, 'Next pages must wait for scroll proximity, not a timer');
}

try {
  await setup('desktop-multiple-pages-and-delay');
  const hold = deferred(); history.state.hold = hold;
  await scrollBottom(); await started(hold);
  await page.getByRole('status').filter({ hasText: '正在加载更多记录' }).waitFor();
  await assertRows(20); assert.equal(nextReads().length, 1);
  for (let i = 0; i < 3; i++) { await page.evaluate(() => scrollTo(0, 0)); await scrollBottom(); }
  await delay(400); assert.equal(nextReads().length, 1, 'Repeated intersections cannot request the same pending cursor');
  hold.release(); await countRows(40); await assertRows(40);
  assert.equal(nextReads().length, 1);
  await scrollBottom(); await countRows(45); await assertRows(45);
  assert.deepEqual(nextReads().map(item => item.cursor), [history.cursorAt(19), history.cursorAt(39)]);
  assert.equal(await sentinel().count(), 0, 'Final page removes the load sentinel');
  await page.screenshot({ path: join(out, 'desktop-complete.png'), fullPage: true });
  checked('Desktop scrolling appends all 45 records in source order; a delayed cursor runs once and loaded rows remain visible');

  for (const mode of ['unavailable', 'source-changed', 'duplicate-order']) {
    await setup(mode); history.state.mode = mode;
    await scrollBottom(); await retry().waitFor(); await assertRows(20);
    assert.equal(nextReads().length, 1);
    for (let i = 0; i < 2; i++) { await page.evaluate(() => scrollTo(0, 0)); await scrollBottom(); }
    await delay(600); assert.equal(nextReads().length, 1, 'Failed cursors require a deliberate retry and cannot spin');
    if (mode === 'source-changed') assert.match(await page.locator('body').innerText(), /分页必须从第一页重新读取/);
    if (mode === 'duplicate-order') assert.match(await page.locator('body').innerText(), /流水排序或分页重复/);
    await page.screenshot({ path: join(out, `desktop-${mode}.png`), fullPage: true });
    history.state.mode = 'valid'; await retry().click(); await countRows(40); await assertRows(40);
    assert.equal(nextReads().length, 2); assert.equal(nextReads()[0].cursor, nextReads()[1].cursor);
    checked(`${mode}: preserves the first page, stops automatic retries, and only an explicit retry appends a valid next page`);
  }

  await setup('route-change-cancels-old-page');
  const obsolete = deferred(); history.state.hold = obsolete;
  await scrollBottom(); await started(obsolete);
  await page.evaluate(() => { location.hash = '#home'; scrollTo(0, 0); });
  await page.waitForFunction(() => location.hash === '#home' && !document.querySelector('[data-auto-page]'));
  await page.evaluate(() => { location.hash = '#records'; scrollTo(0, 0); });
  await countRows(20);
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  const firstPageReads = history.state.requests.filter(item => item.cursor === null).length;
  assert.equal(firstPageReads, 2);
  obsolete.release(); await delay(600); await assertRows(20);
  assert.equal(nextReads().length, 1, 'The stale request cannot append to the new route epoch');
  await scrollBottom(); await countRows(40); await assertRows(40);
  assert.equal(nextReads().length, 2, 'The new route can read its own next page after the stale response settles');
  checked('Leaving and reopening records cancels the old read epoch; its late response neither appends rows nor prevents the new page from loading');

  await setup('mobile-scroll', { width: 390, height: 844 });
  await scrollBottom(); await countRows(40); await assertRows(40);
  await scrollBottom(); await countRows(45); await assertRows(45);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.equal(await sentinel().count(), 0);
  assert.deepEqual(nextReads().map(item => item.cursor), [history.cursorAt(19), history.cursorAt(39)]);
  await page.screenshot({ path: join(out, 'mobile-complete.png'), fullPage: true });
  checked('Mobile scroll loads each cursor once, keeps every record in order and avoids page-wide horizontal overflow');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(writes, []);
  assert.equal(f.state.signatures.length, 0); assert.equal(f.state.userSends.length, 0);
  await writeFile(join(out, 'results.json'), json({ passed: true, checks, errors, unexpected, writes, scenarios,
    walletConnected: false, realNetworkBlocked: true }));
  console.log(json({ passed: true, checks, out }));
} catch (error) {
  await writeFile(join(out, 'failure.json'), json({ error: error.stack, checks, errors, unexpected, writes, scenarios,
    body: await page?.locator('body').innerText() }));
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }); throw error;
} finally { await context?.close(); await browser.close(); }
