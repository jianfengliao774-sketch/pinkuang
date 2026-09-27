/** Offline bootstrap recovery and route-identity checks. Never signs or sends a transaction. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installLiveFixture } from './live-browser-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3113/bemine/';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-bootstrap-retry-check');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const checks = [], errors = [], fixtures = [];
const ready = (page, route) => page.waitForFunction(expected => document.querySelector('main')?.dataset.readyRoute === expected
  && document.querySelector('main')?.getAttribute('aria-busy') === 'false', route);
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
  const fixture = await installLiveFixture(page); fixtures.push(fixture); return { page, fixture };
}
try {
  for (const failure of ['503', '403', 'digest']) {
    const { page, fixture } = await openPage();
    let manifests = 0, phase = 'failure', release, retryStarted;
    const retryGate = new Promise(resolve => { release = resolve; });
    const retryEntered = new Promise(resolve => { retryStarted = resolve; });
    await page.route(/\/data\/frontend-manifest\.json(?:\?.*)?$/, async route => {
      manifests++;
      if (phase === 'failure') return route.fulfill({ status: failure === 'digest' ? 200 : Number(failure), contentType: 'application/json',
        body: JSON.stringify(failure === 'digest' ? { ...fixture.manifest, artifactDigest: `0x${'a'.repeat(64)}` } : {}) });
      retryStarted(); await retryGate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture.manifest) });
    });
    try {
      const route = failure === '403' ? 'pools' : 'home';
      await page.goto(`${base.replace(/\/$/, '')}/#${route}`);
      await page.locator('.live-notice.error').waitFor();
      const originalError = await page.locator('.live-notice.error').innerText();
      assert.match(originalError, failure === 'digest' ? /合约版本不一致/ : new RegExp(`HTTP ${failure}`));
      // Observe longer than the ordinary read retrier's 1s interval: bootstrap errors require an explicit retry.
      await page.waitForTimeout(1300);
      assert.equal(manifests, 1); assert.equal(fixture.requests.length, 0);
      assert.equal(await page.locator('main').getAttribute('data-ready-route'), '');
      assert.equal(await page.getByText('数据区块 100', { exact: true }).count(), 0);
      const wallet = page.locator('header').getByRole('button', { name: '连接钱包', exact: true });
      assert(await wallet.isEnabled()); await wallet.click();
      await page.getByRole('dialog', { name: '连接你的钱包' }).waitFor();
      await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      phase = 'recover';
      const retry = page.getByRole('button', { name: failure === '403' ? '刷新' : '重新加载', exact: true });
      await retry.evaluate(button => { button.click(); button.click(); });
      await retryEntered;
      await page.locator('.live-service-note').getByText('正在核对链上数据…', { exact: true }).waitFor();
      assert.equal(await page.locator('.live-notice.error').count(), 0);
      assert.equal(await page.getByRole('button', { name: '重新加载', exact: true }).count(), 0);
      if (route === 'pools') assert(await page.getByRole('button', { name: '刷新', exact: true }).isDisabled());
      assert.equal(manifests, 2); assert.equal(fixture.requests.length, 0);
      release(); await ready(page, route);
      assert.equal(manifests, 2); assert.equal(await page.locator('.live-service-note').count(), 0);
      assert.equal(await page.locator('.live-notice.error').count(), 0);
      await page.getByText('数据区块 100', { exact: true }).waitFor();
      assert(fixture.requests.length > 0);
      await page.screenshot({ path: join(output, `bootstrap-${failure}-recovered.png`), animations: 'disabled' });
      checks.push(`${failure}: no automatic bootstrap retry or false data, wallet chooser available, explicit ${route === 'pools' ? 'page refresh' : 'reload'} rebuilds config/client once and recovers`);
    } finally { release(); await page.close(); }
  }

  for (const change of ['equivalent', 'different']) {
    const { page, fixture } = await openPage();
    let release, started, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    await page.route(/\/api\/chain-index\/v1\/stats$/, async route => {
      calls++; started(); await gate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture.index(route.request().url())) });
    });
    try {
      await page.goto(`${base.replace(/\/$/, '')}/#home`); await entered;
      assert.equal(await page.locator('main').getAttribute('aria-busy'), 'true');
      await page.evaluate(hash => { location.hash = hash; }, change === 'equivalent' ? 'home/ignored' : 'pools');
      await frames(page);
      if (change === 'different') await ready(page, 'pools');
      release();
      if (change === 'equivalent') {
        await ready(page, 'home'); assert.equal(calls, 1);
        await page.getByText('数据区块 100', { exact: true }).waitFor();
        assert.equal(await page.locator('.live-notice.error').count(), 0);
        checks.push('equivalent #home -> #home/ignored while stats is pending completes the same read round without permanent loading');
      } else {
        // Give the released old home result time to pass through its verification and continuation.
        await page.waitForTimeout(500); await frames(page);
        assert.equal(await page.locator('main').getAttribute('data-ready-route'), 'pools');
        assert.equal(await page.locator('main').getAttribute('aria-busy'), 'false');
        assert.equal(await page.locator('.live-notice.error').count(), 0);
        assert.equal(await page.locator('.live-home').count(), 0);
        checks.push('a real change to pools remains ready after the older home stats result is released');
      }
      await page.screenshot({ path: join(output, `route-${change}.png`), animations: 'disabled' });
    } finally { release(); await page.close(); }
  }
  for (const fixture of fixtures) {
    assert.equal(fixture.controls.sentTransactions.length, 0);
    assert(!fixture.walletRequests.some(request => /sign|send/i.test(request.method)));
  }
  assert.deepEqual(errors, []);
  const result = { passed: checks.length, checks, errors, output, noRealWallet: true, noSignaturesOrTransactions: true };
  await writeFile(join(output, 'bootstrap-retry-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser.close(); }
