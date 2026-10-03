/** Fresh-v4 UI regression. Every read and wallet send is a local fixture. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEther } from 'ethers';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { abi, decodePoolRow } from '../lib/chain-client.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3230/bemine-v4').replace(/\/$/, '');
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const out = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-compact-share-sale');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const tagged = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $bemineBigInt: v.toString() } : v);
const f = freshAuthorityBrowserFixture(), checks = [], errors = [], unexpected = [], writes = [], sends = [], attempts = [];
const active = f.f.base.rows.find(row => row.state === 2n && row.shareTradingAllowed);
assert(active);
const exactPrice = '0.075500000000000001', quantity = '3', fakeHash = `0x${'9c'.repeat(32)}`;
const expectedData = abi.ShareMarket.encodeFunctionData('list', [active.pool, 3n, parseEther(exactPrice)]);
let mode = 'long-error', page, locale = 'zh';
const checked = message => { checks.push(message); console.log('PASS ' + message); };
const L = (zh, en) => locale === 'en' ? en : zh;
const dialog = () => page.locator('.live-sale-modal');
const confirmation = () => dialog().getByRole('button', { name: L('确认并前往钱包', 'Confirm in wallet'), exact: true });
const preview = () => dialog().getByRole('button', { name: L('预览出售', 'Preview listing'), exact: true });
async function clickable(label) {
  const probe = await confirmation().evaluate(button => {
    const rect = button.getBoundingClientRect(), parent = button.closest('[role=dialog]').getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      parent: { x: parent.x, y: parent.y, width: parent.width, height: parent.height },
      viewport: { width: innerWidth, height: innerHeight }, hits: hit === button || button.contains(hit),
      footerScrolls: getComputedStyle(button.closest('.share-sale-footer')).flexShrink,
      bodyOverflow: getComputedStyle(button.closest('[role=dialog]').querySelector('.share-sale-body')).overflowY,
    };
  });
  assert(probe.x >= -1 && probe.y >= -1 && probe.x + probe.width <= probe.viewport.width + 1
    && probe.y + probe.height <= probe.viewport.height + 1, `${label}: confirmation must fit viewport ${json(probe)}`);
  assert(probe.y >= probe.parent.y && probe.y + probe.height <= probe.parent.y + probe.parent.height + 1,
    `${label}: confirmation must fit dialog`);
  assert.equal(probe.hits, true, `${label}: no element can cover confirmation`);
  assert.equal(probe.footerScrolls, '0'); assert.equal(probe.bodyOverflow, 'auto');
  return probe;
}
async function scrollAndCheck(label) {
  const start = await clickable(label + ' start');
  await dialog().locator('.share-sale-body').evaluate(body => { body.scrollTop = body.scrollHeight; });
  const end = await clickable(label + ' bottom');
  assert(Math.abs(start.y - end.y) <= 1, 'The footer cannot move with body scroll');
  await dialog().locator('.share-sale-body').evaluate(body => { body.scrollTop = 0; });
  const top = await clickable(label + ' top');
  assert(Math.abs(start.y - top.y) <= 1);
}
async function fillAndPreview() {
  await dialog().getByLabel(L('份额数量', 'Number of shares'), { exact: true }).fill(quantity);
  await dialog().getByLabel(L('每份价格 · BNB', 'Price per share · BNB'), { exact: true }).fill(exactPrice);
  await preview().click(); await confirmation().waitFor();
  assert.match(await dialog().locator('.share-sale-summary').innerText(), /0\.22650 BNB/);
  assert.equal(await dialog().locator('input').count(), 0, 'Preview hides duplicate editable fields');
  assert.equal(await dialog().locator('.share-sale-summary > div').count(), 3);
}

try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(f.manifest) }));
  await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
    const input = route.request().postDataJSON();
    if (/sign|send|wallet_|requestAccounts/i.test(input.method)) { writes.push(input.method); return route.abort(); }
    try { const result = input.method === 'eth_getTransactionReceipt' && input.params[0] === fakeHash ? null : await f.request(input);
      return route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: input.id, result }) });
    } catch (error) { unexpected.push(error.message); return route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
  });
  await page.route(/\/api\/chain-index\//, async route => {
    const url = new URL(route.request().url()), path = url.pathname.split('/chain-index')[1];
    try {
      let body;
      if (path.startsWith('/v1/display/')) {
        const source = { ...f.f.source(), readMode: 'verified_snapshot', stale: true,
          snapshotAgeMs: 0, refreshing: false, cacheOrigin: 'server' };
        const rows = f.f.base.rows.map(row => decodePoolRow(row, f.manifest.factory));
        const data = path.startsWith('/v1/display/positions/')
          ? { items: rows, nextCursor: null, marketBnbOwed: 0n }
          : path === '/v1/display/pools' ? { items: rows, nextCursor: null }
          : path === '/v1/display/stats' ? f.index(url.href.replace('/v1/display/stats', '/v1/stats')).data
          : null;
        if (!data) return route.fulfill({ status: 503, contentType: 'application/json', body: json({ error: 'Synthetic cache not populated for this unrelated route' }) });
        body = tagged({ source, data });
      } else body = json(f.index(url.href));
      return route.fulfill({ contentType: 'application/json', body });
    } catch (error) { unexpected.push(error.message); return route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
  });
  await page.route(/\/firsto-api\/v1\//, route => { const path = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: 'application/json', body: json(path.endsWith('/circuits') ? f.data.page : path.endsWith('/circuit-holders') ? f.data.referenceRaw : f.data.detail) }); });
  await page.route(/\/api\/journal\//, async route => {
    const request = route.request(); if (request.method() !== 'GET') { writes.push(request.url()); return route.abort(); }
    try { return route.fulfill({ contentType: 'application/json', body: json(request.url().endsWith('/product-graph') ? f.graph()
      : await f.journal(request.url(), request.method(), null)) }); }
    catch (error) { unexpected.push(error.message); return route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
  });
  await page.exposeFunction('__compactSaleWallet', async input => {
    if (input.method === 'eth_sendTransaction') {
      const transaction = input.params[0]; attempts.push(transaction);
      assert.equal(transaction.to.toLowerCase(), f.manifest.shareMarket.toLowerCase());
      assert.equal(transaction.from.toLowerCase(), f.state.account.toLowerCase());
      assert.equal(transaction.data, expectedData); assert.equal(BigInt(transaction.value), 0n);
      assert.equal(transaction.chainId, '0x38');
      if (mode === 'long-error') throw Error(('模拟钱包网络错误，交易尚未广播。请稍后重试。 ').repeat(70));
      // Playwright preserves Error text across exposed functions, but strips
      // custom fields. Rebuild the EIP-1193 code inside the fake browser wallet.
      if (mode === 'cancel') return { __walletError: { message: 'Synthetic wallet cancellation', code: 4001 } };
      assert.equal(mode, 'success'); sends.push(transaction); return fakeHash;
    }
    assert(!/sign|send|wallet_/i.test(input.method), 'Only the explicit fake listing send is permitted');
    return f.request(input);
  });
  await page.addInitScript(() => {
    const listeners = new Map(); let connected = false;
    window.ethereum = { isMetaMask: true, async request(input) {
      if (input.method === 'eth_requestAccounts') connected = true;
      if (input.method === 'eth_accounts' && !connected) return [];
      const value = await window.__compactSaleWallet(input);
      if (value?.__walletError) throw Object.assign(new Error(value.__walletError.message), { code: value.__walletError.code });
      return value;
    }, on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeListener(name, fn) { listeners.get(name)?.delete(fn); } };
  });
  await page.goto(base + '/#overview');
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('header .live-wallet-label').filter({ hasText: /^0x[0-9a-f]/i }).waitFor();
  await page.getByRole('button', { name: '挂单 Behemoth #8204', exact: true }).click(); await dialog().waitFor();
  assert.equal(await dialog().getByLabel('份额数量', { exact: true }).inputValue(), active.availableShares.toString());
  assert.equal(await dialog().locator('input').count(), 2); await fillAndPreview();
  assert.equal(attempts.length, 0); assert.equal(sends.length, 0);
  await dialog().getByRole('button', { name: '返回修改', exact: true }).click();
  assert.equal(await dialog().getByLabel('份额数量', { exact: true }).inputValue(), quantity);
  assert.equal(await dialog().getByLabel('每份价格 · BNB', { exact: true }).inputValue(), exactPrice);
  await preview().click(); await confirmation().waitFor();
  checked('Preview and edit preserve the exact quantity and full Wei price without sending, showing only three summary rows');

  for (const [name, viewport, language] of [
    ['mobile390', { width: 390, height: 667 }, 'zh'], ['small320', { width: 320, height: 568 }, 'zh'],
    ['short667', { width: 667, height: 375 }, 'zh'], ['english320', { width: 320, height: 568 }, 'en'],
  ]) {
    await page.setViewportSize(viewport); locale = language;
    await page.locator('select.language-switch').selectOption(language); await confirmation().waitFor();
    await scrollAndCheck(name);
    const details = dialog().locator('details'); if (!(await details.getAttribute('open'))) await details.locator('summary').click();
    await scrollAndCheck(name + ' details open');
    assert.match(await details.innerText(), new RegExp(exactPrice.replaceAll('.', '\\.')));
    await page.screenshot({ path: join(out, name + '.png'), animations: 'disabled' });
    await details.locator('summary').click();
    checked(`${name}: confirmation is visible and uncovered before scrolling; expanded details and scrolling never move the footer`);
  }
  await confirmation().click(); await dialog().getByRole('alert').waitFor();
  assert.match(await dialog().getByRole('alert').innerText(), /模拟钱包网络错误/);
  assert.equal(sends.length, 0); await scrollAndCheck('long actual wallet error');
  assert.equal(await page.locator('.transaction-result-dialog').count(), 0, 'An unknown wallet network outcome is not a fabricated transaction result');
  await page.screenshot({ path: join(out, 'long-wallet-error.png'), animations: 'disabled' });
  checked('An actual long fake-wallet error stays in the scroll body, keeps confirmation reachable and does not claim a transaction result');

  mode = 'cancel'; await confirmation().click();
  await page.locator('.transaction-result-dialog').getByRole('heading', { name: 'Transaction cancelled', exact: true }).waitFor();
  assert.equal(await dialog().count(), 0, 'A result modal cannot leave the original modal focus trap active');
  await page.locator('.transaction-result-dialog').getByRole('button', { name: 'Got it', exact: true }).click();
  await confirmation().waitFor(); await clickable('after dismissing cancellation');
  await dialog().getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await dialog().getByLabel('Price per share · BNB', { exact: true }).inputValue(), exactPrice);
  await preview().click(); await confirmation().waitFor(); mode = 'success';
  await confirmation().evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => !document.querySelector('.live-sale-modal'));
  assert.equal(sends.length, 1, 'A double click cannot repeat the fake send');
  assert.equal(sends[0].data, expectedData); assert.equal(BigInt(sends[0].value), 0n);
  assert.equal(await page.locator('.transaction-result-dialog').count(), 0, 'A transaction hash alone is not a success confirmation');
  checked('Cancellation feedback dismisses cleanly back to editing; an exact listing sends once on double click and remains pending without a receipt');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(writes, []);
  const result = { passed: true, checks, errors, unexpected, writes, fakeSends: sends.length,
    fakeSendAttempts: attempts.length, quantity, exactPrice, expectedData, valueWei: '0', realNetworkBlocked: true };
  await writeFile(join(out, 'results.json'), json(result)); console.log(json({ ...result, out }));
} catch (error) {
  await writeFile(join(out, 'failure.json'), json({ error: error.stack, checks, errors, unexpected, writes,
    attempts, sends, body: await page?.locator('body').innerText() }));
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }); throw error;
} finally { await browser.close(); }
