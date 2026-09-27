/** Local offline fixtures only; no wallet signatures or real chain requests. */
import assert from 'node:assert/strict';
import { installLiveFixture } from './live-browser-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const checks = [], errors = [];
try {
  for (const failure of ['503', 'source_reorg', '403', 'persistent_503']) {
    const page = await browser.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    const fixture = await installLiveFixture(page);
    let catalogs = 0, stats = 0;
    await page.route(/\/api\/chain-index\//, async route => {
      const url = route.request().url();
      if (url.includes('/v1/pools')) catalogs++;
      if (!url.endsWith('/v1/stats')) return route.fallback();
      stats++;
      if (failure === 'persistent_503' || (stats === 1 && failure !== 'source_reorg'))
        return route.fulfill({ status: failure === '403' ? 403 : 503, contentType: 'application/json', body: '{}' });
      const result = fixture.index(url);
      // A changed timestamp for the same block/hash fails canonical verification, not ordinary source drift.
      if (stats === 1 && failure === 'source_reorg') result.source.indexedTimestamp++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
    });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('main')?.dataset.readyRoute === 'home'
      && document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    if (failure === '503') {
      assert.equal(stats, 2); assert.equal(catalogs, 2);
      assert.equal(await page.locator('.live-notice.error').count(), 0);
      checks.push(`${failure} recovers after an entirely new catalog round`);
    } else {
      assert.equal(stats, failure === 'persistent_503' ? 3 : 1);
      assert.equal(catalogs, stats);
      assert.match(await page.locator('.live-notice.error').innerText(), failure === 'source_reorg' ? /索引区块已变化/ : failure === '403' ? /HTTP 403/ : /HTTP 503/);
      checks.push(`${failure} stops at its retry limit with the original error`);
    }
    assert.equal(fixture.controls.sentTransactions.length, 0);
    assert(!fixture.walletRequests.some(request => /sign|send/i.test(request.method)));
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, pageErrors: errors }));
} finally { await browser.close(); }
