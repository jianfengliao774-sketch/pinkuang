/** Local read-only UX audit. Synthetic account, no signatures, broadcasts or external endpoints. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { PORTFOLIOS } from './portfolio-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3218/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const out = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-product-flow-audit');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
const f = freshAuthorityBrowserFixture(), json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const errors = [], writes = [], checks = [], views = [];
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
const settled = () => page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false'
  && ![...document.querySelectorAll('[data-project-directory],[data-asset-directory]')].some(el => el.getAttribute('aria-busy') === 'true'));
async function capture(name, title) {
  if (title) await page.locator('.breadcrumb').getByText(title, { exact: true }).waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await settled();
  await page.waitForFunction(() => !/正在读取|正在核对预算项目|正在更新持仓/.test(document.querySelector('main')?.textContent || ''));
  const text = await page.locator('main').innerText();
  const metrics = await page.locator('main .metrics').allInnerTexts();
  const buttons = await page.locator('main button').evaluateAll(elements => elements.map(el => ({ text: el.textContent.trim(), disabled: el.disabled })));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  const result = { name, url: page.url(), metrics, buttons, overflow, text };
  views.push(result); await writeFile(join(out, name + '.json'), json(result));
  await page.screenshot({ path: join(out, name + '.png'), fullPage: true });
}
try {
  await page.goto(base + '/#home');
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.waitForFunction(() => /0x/.test(document.querySelector('header')?.textContent || ''));
  await page.locator('.sidebar').getByRole('button', { name: '资产总览', exact: true }).click();
  await page.locator('[data-asset-directory="unified"]').waitFor(); await capture('overview-connected', '资产总览');
  assert.equal(await page.locator('[data-asset-directory="unified"] [data-project-kind="portfolio"]').count(), 2);
  assert.equal(await page.getByRole('heading', { name: '多矿机预算项目', exact: true }).count(), 0);
  checks.push('The overview contains both parent projects in its single holdings table without a separate parent panel');
  for (const [route, title] of [['rewards', '收益中心'], ['pools', '参与拼矿'], ['market', '矿机转让'], ['governance', '共同决策'], ['records', '公开记录'], ['home', '拼矿总览']]) {
    await page.locator('.sidebar').getByRole('button', { name: title, exact: true }).click(); await capture(route + '-connected', title);
  }
  await page.locator('.sidebar').getByRole('button', { name: '资产总览', exact: true }).click(); await settled();
  await page.locator(`[data-asset-directory="unified"] [data-project-address="${PORTFOLIOS[0]}"]`).getByRole('button', { name: '查看项目', exact: true }).click();
  await page.getByText('项目收益与公开记录', { exact: true }).waitFor(); await capture('parent-from-overview');
  await page.getByText('项目收益与公开记录', { exact: true }).click();
  await page.getByRole('button', { name: '读取项目收益与记录', exact: true }).click();
  await page.getByRole('heading', { name: '项目收益归集', exact: true }).waitFor();
  await capture('parent-income-connected');
  assert.equal(await page.locator('.chart-summary strong').first().innerText(), '7.00000 BEM');
  assert.equal(await page.locator('.chart-summary strong').nth(1).innerText(), '3.50000 BEM');
  checks.push('Connected parent history accepts real portfolio scope and separately displays actual wallet claims');
  await page.getByRole('button', { name: '← 返回资产总览', exact: true }).click(); await settled();
  assert.equal(new URL(page.url()).hash, '#overview');
  checks.push('Parent back destination: ' + new URL(page.url()).hash);
  await page.locator('.sidebar').getByRole('button', { name: '运营工作台', exact: true }).click();
  const funding = page.getByLabel('募集总额（BNB）', { exact: true }); await funding.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('预览创建矿池') && !button.disabled));
  const exactBudget = '48.065004999999999900', exactCap = '43.695679475146443511';
  await page.getByLabel('矿机编号', { exact: true }).fill('4460');
  await funding.fill(exactBudget); await funding.blur();
  assert.equal(await funding.inputValue(), '≈ 48.06500');
  await funding.focus(); assert.equal(await funding.inputValue(), exactBudget);
  const cap = page.getByLabel('购机价格上限（BNB）', { exact: true });
  await cap.fill(exactCap); await cap.blur(); assert.equal(await cap.inputValue(), '≈ 43.69568');
  await cap.focus(); assert.equal(await cap.inputValue(), exactCap); await cap.blur();
  await page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认运营操作', exact: true }); await confirmation.waitFor();
  assert.match(await confirmation.innerText(), /≈ 48\.06500 BNB/);
  await confirmation.getByText('查看精确金额', { exact: true }).click();
  assert.match(await confirmation.innerText(), /48\.0650049999999999 BNB/);
  await page.screenshot({ path: join(out, 'manual-exact-five-decimal-preview.png'), fullPage: true });
  await confirmation.getByRole('button', { name: '返回修改', exact: true }).click();
  await funding.focus(); assert.equal(await funding.inputValue(), exactBudget);
  checks.push('Five-place manual funding and price-cap displays preserve exact original values through focus, blur and unsigned preview');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, title] of [['overview', '资产总览'], ['rewards', '收益中心']]) {
    await page.evaluate(next => { location.hash = next; }, route); await capture(route + '-mobile', title);
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.equal(f.state.signatures.length, 0); assert.equal(f.state.userSends.length, 0);
  const result = { passed: true, checks, views: views.map(({ text, buttons, ...view }) => view), errors, writes, wallet: 'synthetic read-only' };
  await writeFile(join(out, 'results.json'), json(result)); console.log(json(result));
} catch (error) {
  await writeFile(join(out, 'failure.json'), json({ error: error.stack, checks, errors, writes, text: await page.locator('body').innerText() }));
  await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }); throw error;
} finally { await page.close(); await browser.close(); }
