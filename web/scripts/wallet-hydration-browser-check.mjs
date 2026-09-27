/** SSR and first-click regression; wallet interaction stays available while read-only RPC is delayed. */
import assert from 'node:assert/strict';
import { installLiveFixture } from './live-browser-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const checks = [];
try {
  for (const mobile of [false, true]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const fixture = await installLiveFixture(page, { beforeRpc: () => gate });
    try {
      const response = await page.goto(base, { waitUntil: 'domcontentloaded' });
      const started = Date.now();
      // No wait for API data, page load, appearance changes or other hydration signals.
      await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
      await page.getByRole('dialog', { name: '连接你的钱包' }).waitFor();
      const openedMs = Date.now() - started;
      const html = await response.text(), header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
      assert(header, 'SSR header must exist');
      const button = [...header.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[2].includes('连接钱包'));
      assert(button && /\bdisabled(?:=|\s|$)/.test(button[1]), 'SSR connect button must be disabled until local initialization');
      assert.equal(await page.getByText('数据区块 100', { exact: true }).count(), 0, 'RPC is still delayed');
      assert.equal(fixture.walletRequests.length, 0, 'opening discovery must not request wallet access');
      assert.equal(fixture.controls.sentTransactions.length, 0);
      assert.deepEqual(errors, []);
      checks.push({ mobile, openedMs, firstClick: true, rpcStillPending: true, ssrDisabled: true });
    } finally { release(); await page.close(); }
  }
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally { await browser.close(); }
