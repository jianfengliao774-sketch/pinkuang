/** Parent-create input precision regression using a local synthetic chain; no signing or broadcast. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { PORTFOLIOS } from './portfolio-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3218/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const out = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-portfolio-create-inputs');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
const f = freshAuthorityBrowserFixture(), json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const errors = [], writes = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(f.manifest) }));
await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
  const input = route.request().postDataJSON();
  if (/sign|send|wallet_/i.test(input.method)) { writes.push(input.method); return route.abort(); }
  try { await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: input.id, result: await f.request(input) }) }); }
  catch (error) { await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
});
await page.route(/\/api\/chain-index\//, route => route.fulfill({ contentType: 'application/json', body: json(f.index(route.request().url())) }));
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
await page.exposeFunction('__auditWalletRead', async input => {
  assert(!/sign|send|wallet_/i.test(input.method)); return f.request(input);
});
await page.addInitScript(() => {
  const listeners = new Map(); let connected = false;
  window.ethereum = { isMetaMask: true, async request(input) {
    if (input.method === 'eth_requestAccounts') connected = true;
    if (input.method === 'eth_accounts' && !connected) return [];
    return window.__auditWalletRead(input);
  }, on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
  removeListener(name, fn) { listeners.get(name)?.delete(fn); } };
});
try {
  await page.goto(base + '/#home');
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: '运营工作台', exact: true }).click();
  const form = page.locator('#multi-miner-create');
  await form.getByRole('heading', { name: '创建多矿机预算项目', exact: true }).waitFor();
  const fields = [
    ['募集预算（BNB）', '48.06500499999999', '≈ 48.06500'],
    ['单机价格上限（BNB）', '43.695679475146443511', '≈ 43.69568'],
    ['日产能价上限（BNB / (BEM / 天)）', '9.123455000000000001', '≈ 9.12346'],
  ];
  for (const [label, exact, displayed] of fields) {
    const input = form.getByLabel(label, { exact: true });
    await input.fill(exact);
    assert.equal(await input.inputValue(), exact, `${label}: editing retains the exact decimal`);
    await input.blur(); assert.equal(await input.inputValue(), displayed, `${label}: blur uses five-place half-up rounding`);
    await input.focus(); assert.equal(await input.inputValue(), exact, `${label}: focus recovers the original decimal`);
    await input.blur(); assert.equal(await input.inputValue(), displayed);
  }
  await form.screenshot({ path: join(out, 'three-parent-amounts-five-decimal-display.png') });
  checks.push('Budget, absolute price cap and daily capacity price cap all round to five places only on blur');
  for (const [label, exact] of fields) {
    const input = form.getByLabel(label, { exact: true });
    await input.focus(); assert.equal(await input.inputValue(), exact); await input.blur();
  }
  checks.push('Repeated focus changes preserve the exact original decimal values for all three fields');
  const budget = form.getByLabel('募集预算（BNB）', { exact: true });
  const invalidExact = '48.065004999999990001';
  await budget.focus(); await budget.fill(invalidExact); await budget.blur();
  assert.equal(await budget.inputValue(), '≈ 48.06500');
  await page.waitForFunction(() => [...document.querySelectorAll('#multi-miner-create button')]
    .some(button => button.textContent.includes('预览创建预算项目') && !button.disabled));
  const before = f.f.simulations.length;
  await form.getByRole('button', { name: '预览创建预算项目', exact: false }).click();
  const error = page.locator('#multi-miner-projects .portfolio-error[role="alert"]');
  await error.waitFor();
  assert.match(await error.innerText(), /募集预算需能平均分为 100 份，最多保留 16 位小数/);
  assert.equal(f.f.simulations.length, before, 'invalid indivisible budget fails before contract simulation');
  assert.equal(await page.getByRole('dialog', { name: '确认预算项目操作', exact: true }).count(), 0);
  await budget.focus(); assert.equal(await budget.inputValue(), invalidExact);
  await form.screenshot({ path: join(out, 'indivisible-budget-original-input-preserved.png') });
  checks.push('A budget not divisible into 100 exact shares is rejected before simulation and does not silently change the original amount');
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  assert.equal(f.state.signatures.length, 0); assert.equal(f.state.userSends.length, 0);
  const result = { passed: true, checks, fields, errors, writes, wallet: 'synthetic read-only', externalRequestsBlocked: true };
  await writeFile(join(out, 'results.json'), json(result)); console.log(json(result));
} catch (error) {
  await writeFile(join(out, 'failure.json'), json({ error: error.stack, checks, errors, writes, text: await page.locator('body').innerText() }));
  await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }); throw error;
} finally { await page.close(); await browser.close(); }
