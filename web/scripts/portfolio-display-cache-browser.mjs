/** Local synthetic-chain display cache regression. No signing or transaction endpoints. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { PORTFOLIOS } from './portfolio-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3218/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const out = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-portfolio-display-cache');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const fixture = freshAuthorityBrowserFixture();
fixture.f.state.poolState = 0n;
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
const errors = [], writes = [], checks = [];
let phase = 'normal', releaseRead = null, pausedReads = 0, readGate = Promise.resolve();
const pause = () => { phase = 'pause'; pausedReads = 0; readGate = new Promise(resolve => { releaseRead = resolve; }); };
const release = next => { phase = next; releaseRead?.(); releaseRead = null; };
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(fixture.manifest) }));
await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
  const input = route.request().postDataJSON();
  if (/sign|send|wallet_/i.test(input.method)) { writes.push(input.method); return route.abort(); }
  try {
    const currentBlock = input.method === 'eth_getBlockByNumber' && input.params[0] === 'latest';
    if (currentBlock && phase === 'pause') { pausedReads++; await readGate; }
    const result = currentBlock && phase === 'fail' ? null : await fixture.request(input);
    await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: input.id, result }) });
  } catch (error) {
    await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) });
  }
});
await page.route(/\/api\/chain-index\//, route => route.fulfill({ contentType: 'application/json', body: json(fixture.index(route.request().url())) }));
await page.route(/\/api\/journal\//, async route => {
  const request = route.request();
  if (request.method() !== 'GET') { writes.push(request.url()); return route.abort(); }
  return route.fulfill({ contentType: 'application/json', body: json(request.url().endsWith('/product-graph')
    ? fixture.graph() : await fixture.journal(request.url(), request.method(), null)) });
});
await page.exposeFunction('__cacheWalletRead', async input => {
  assert(!/sign|send|wallet_/i.test(input.method)); return fixture.request(input);
});
await page.addInitScript(() => {
  const listeners = new Map(); let connected = false;
  window.ethereum = { isMetaMask: true, async request(input) {
    if (input.method === 'eth_requestAccounts') connected = true;
    if (input.method === 'eth_accounts' && !connected) return [];
    return window.__cacheWalletRead(input);
  }, on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
  removeListener(name, fn) { listeners.get(name)?.delete(fn); } };
});
const directory = page.locator('[data-asset-directory="unified"]');
const parent = () => directory.locator(`[data-project-address="${PORTFOLIOS[0]}"]`);
const details = page.locator('.portfolio-detail');
const deposit = details.getByRole('button', { name: '预览认购', exact: true });
async function waitForPausedRead() {
  for (let i = 0; i < 100 && pausedReads === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert(pausedReads > 0, 'the current head read is held before a new action proof can complete');
}
async function assertSummaryWithFrozenActions(label) {
  await details.getByRole('heading', { name: '项目详情', exact: true }).waitFor();
  assert.match(await details.innerText(), /每份 0\.00005 BNB/);
  assert.match(await details.innerText(), /我的可转份额 10/);
  assert.equal(await deposit.isDisabled(), true);
  assert.equal(await details.getByRole('button', { name: '撤回我的认购', exact: true }).isDisabled(), true);
  for (const button of await details.getByRole('button', { name: /^领取 .* (BNB|BEM)$/ }).all())
    assert.equal(await button.isDisabled(), true, 'cached entitlement must not enable a claim');
  await page.screenshot({ path: join(out, label + '.png'), fullPage: true });
}
try {
  await page.goto(base + '/#home');
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: '资产总览', exact: true }).click();
  await parent().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-asset-directory="unified"]')?.getAttribute('aria-busy') === 'false');
  assert.equal(await directory.locator('[data-project-kind="portfolio"]').count(), 2);
  pause();
  await parent().getByRole('button', { name: '查看项目', exact: true }).click();
  await waitForPausedRead();
  await assertSummaryWithFrozenActions('first-open-current-read-paused');
  checks.push('A parent selected from the overview immediately shows its verified summary while new-read actions remain disabled');
  release('normal');
  await deposit.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.portfolio-detail button')].some(el => el.textContent === '预览认购' && !el.disabled));
  checks.push('Only the completed current parent read enables the subscription action');
  await page.getByRole('button', { name: '← 返回资产总览', exact: true }).click();
  await parent().waitFor();
  assert.equal(new URL(page.url()).hash, '#overview');
  assert.equal(await directory.locator('[data-project-kind="portfolio"]').count(), 2);
  assert.equal(await directory.getByText('暂无持仓和待领取权益', { exact: true }).count(), 0);
  await page.screenshot({ path: join(out, 'overview-return-holdings-preserved.png'), fullPage: true });
  checks.push('Returning preserves the asset overview and both parent holdings without a false empty state');
  await page.waitForFunction(() => document.querySelector('[data-asset-directory="unified"]')?.getAttribute('aria-busy') === 'false');
  pause();
  await parent().getByRole('button', { name: '查看项目', exact: true }).click();
  await waitForPausedRead();
  await assertSummaryWithFrozenActions('second-open-current-read-paused');
  release('fail');
  await page.locator('.portfolio-error[role="alert"]').waitFor();
  assert.match(await page.locator('.portfolio-error[role="alert"]').innerText(), /区块数据不可用/);
  await assertSummaryWithFrozenActions('read-failed-summary-retained');
  checks.push('A failed fresh read retains the previous parent summary and blocks subscription, refund and claim actions');
  phase = 'normal';
  await page.getByRole('button', { name: '重新读取预算项目', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.portfolio-detail button')].some(el => el.textContent === '预览认购' && !el.disabled));
  assert.equal(await page.locator('.portfolio-error[role="alert"]').count(), 0);
  checks.push('A successful explicit retry clears the error and restores only currently verified actions');
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  assert.equal(fixture.state.signatures.length, 0); assert.equal(fixture.state.userSends.length, 0);
  const result = { passed: true, checks, errors, writes, wallet: 'synthetic read-only', externalRequestsBlocked: true };
  await writeFile(join(out, 'results.json'), json(result)); console.log(json(result));
} catch (error) {
  await writeFile(join(out, 'failure.json'), json({ error: error.stack, checks, errors, writes, text: await page.locator('body').innerText() }));
  await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }); throw error;
} finally { release('normal'); await page.close(); await browser.close(); }
