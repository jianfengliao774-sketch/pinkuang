/** Public maintenance-page navigation only: isolated browser, no wallet/RPC. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const output = process.env.BEMINE_LEGACY_BROWSER_OUTPUT || '/private/tmp/bemine-legacy-entry-browser-20261004';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const checks = [], errors = [], allowed = [], blocked = [];
await mkdir(output, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1120, height: 760 } });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.isNavigationRequest() && ['tapeout.cc.cd', 'bemine.cc.cd'].includes(url.hostname)
        && ['/bemine/', '/bemine-v4/', '/bemine-full-test/'].includes(url.pathname)
        && request.method() === 'GET') {
      allowed.push(request.url());
      return route.continue();
    }
    blocked.push(request.url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  for (const [url, expected] of [
    ['https://tapeout.cc.cd/bemine/?lang=zh#market', 'https://bemine.cc.cd/?lang=zh#market'],
    ['https://bemine.cc.cd/bemine-v4/?lang=en#rewards', 'https://bemine.cc.cd/?lang=en#rewards'],
    ['https://tapeout.cc.cd/bemine-full-test/?lang=zh#detail/0x' + 'a'.repeat(40), 'https://bemine.cc.cd/?lang=zh'],
  ]) {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 503, 'Retired site stays paused');
    const link = page.getByRole('link', { name: '前往 BEMine 正式网站' });
    assert.equal(await link.getAttribute('href'), expected);
    assert.equal(await page.getByRole('link').count(), 1, 'No public console shortcut');
    assert.equal(await page.evaluate(() => 'ethereum' in window), false, 'No injected wallet');
    checks.push({ url, status: response.status(), destination: expected });
  }
  await page.goto('https://tapeout.cc.cd/bemine/?lang=zh#market', { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: join(output, 'maintenance-market-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page has no horizontal overflow');
  await page.screenshot({ path: join(output, 'maintenance-market-mobile.png') });
  checks.push({ check: '390px mobile maintenance page has no horizontal overflow', passed: true });
  await context.close();
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  await noScript.route('**/*', route => {
    const request = route.request();
    return request.isNavigationRequest() && request.url() === 'https://tapeout.cc.cd/bemine/'
      ? route.continue() : route.abort();
  });
  const fallback = await noScript.newPage();
  assert.equal((await fallback.goto('https://tapeout.cc.cd/bemine/', { waitUntil: 'domcontentloaded' })).status(), 503);
  assert.equal(await fallback.getByRole('link', { name: '前往 BEMine 正式网站' }).getAttribute('href'), 'https://bemine.cc.cd/');
  checks.push({ check: 'JavaScript-disabled fallback goes to the formal product root', passed: true });
  await noScript.close();
  assert.deepEqual(errors, []);
  const result = { checkedAt: new Date().toISOString(), dataKind: 'public-live-maintenance-page',
    checks, pageErrors: errors, allowedNavigationRequests: allowed, blockedRequests: blocked,
    walletOrRpcRequestsSent: 0, transactionRequestsSent: 0,
    screenshots: ['maintenance-market-desktop.png', 'maintenance-market-mobile.png'] };
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
