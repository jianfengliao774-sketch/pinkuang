/** Local-only interaction fixtures. No real signatures, bot messages or chain writes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installLiveFixture, FIXTURE_POOLS } from './live-browser-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3127/bemine/';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const output = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-notification-browser');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const checks = [], errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
  const fixture = await installLiveFixture(page, { confirmDeposit: true });
  let status = { enabled: true, connected: false, language: 'zh', notificationsEnabled: false, binding: null };
  await page.route(/\/api\/journal\/notifications\//, async route => {
    const request = route.request(), path = new URL(request.url()).pathname.split('/notifications/')[1];
    let body = status;
    if (path === 'capabilities') body = { enabled: true, botUsername: 'BEMineNotifyBot' };
    else if (path === 'binding') {
      status = { ...status, binding: { id: 'fixture-binding', status: 'pending', expiresAt: Date.now() + 600000 } };
      body = { id: status.binding.id, url: 'https://t.me/BEMineNotifyBot?start=fixture-one-use-nonce', expiresAt: status.binding.expiresAt };
    } else if (path === 'binding/confirm') { status = { ...status, connected: true, notificationsEnabled: true, telegramLabel: '@review_account', binding: null }; body = status; }
    else if (path === 'preferences') { status = { ...status, ...request.postDataJSON() }; body = status; }
    else if (path === 'disconnect') { status = { ...status, connected: false, notificationsEnabled: false, telegramLabel: null, binding: null }; body = status; }
    else if (path === 'inbox') body = { items: [{ id: 'fixture-event', kind: 'proposal', createdAt: Date.now(), readAt: null,
      payload: { pool: FIXTURE_POOLS.voting, circuitId: '9052', proposalId: '1', priceWei: '11000000000000000000', endsAt: Math.floor(Date.now() / 1000) + 3600 } }] };
    else if (path === 'inbox/read') body = { ok: true };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${base}#detail/${FIXTURE_POOLS.funding}`);
  await page.getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  assert.equal(await page.getByRole('dialog', { name: '矿机已购入，开启重要提醒', exact: true }).count(), 0);
  checks.push('funding ownership does not interrupt subscription with a notification prompt');
  await page.evaluate(() => { location.hash = 'overview'; });
  await page.getByRole('dialog', { name: '矿机已购入，开启重要提醒', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'desktop-purchase-prompt.png') });
  await page.getByRole('button', { name: '稍后设置', exact: true }).last().click();
  await page.getByRole('button', { name: '通知中心', exact: true }).click();
  await page.getByRole('heading', { name: '通知中心', exact: true }).waitFor();
  assert.equal(await page.locator('main').getAttribute('aria-busy'), 'false');
  await page.getByRole('button', { name: '绑定 Telegram', exact: true }).click();
  const bot = page.getByRole('link', { name: '@BEMineNotifyBot', exact: true });
  await bot.waitFor(); assert.equal(new URL(await bot.getAttribute('href')).hostname, 't.me');
  assert.equal(status.connected, false);
  status.binding = { ...status.binding, status: 'paired', telegramLabel: '@review_account' };
  await page.getByRole('button', { name: '检查绑定', exact: true }).click();
  await page.getByText('@review_account', { exact: true }).waitFor();
  assert.equal(status.connected, false);
  await page.getByRole('button', { name: '确认绑定', exact: true }).click();
  await page.getByText('Telegram 已绑定', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '我的通知', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'desktop-notifications.png'), fullPage: true });
  checks.push('explicit bind -> private bot link -> visible account -> final wallet confirmation');
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth, topbar: document.querySelector('.topbar').getBoundingClientRect().height }));
    assert(size.scroll <= size.viewport + 1, `mobile horizontal overflow ${width}: ${JSON.stringify(size)}`);
    await page.screenshot({ path: join(output, `iphone-${width}-notifications.png`), fullPage: true });
    checks.push(`iPhone ${width}px: no horizontal overflow`);
  }
  await page.getByLabel('Language', { exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Change appearance', exact: true }).click();
  await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'iphone-english-dark.png'), fullPage: true });
  await page.reload();
  await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  checks.push('English and dark appearance, persisted prompt skip, notification route reload');
  assert.deepEqual(errors, []);
  assert(!fixture.walletRequests.some(x => /sign|sendTransaction/i.test(x.method)));
  checks.push('no automatic signatures, wallet writes or external messages');
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally { await browser.close(); }
