/** Mobile viewport/touch regression checks. Emulation does not replace iPhone Safari testing. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installLiveFixture, FIXTURE_POOLS } from './live-browser-fixture.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Use a local server; live calls are intercepted');
const output = process.env.BEMINE_BROWSER_OUTPUT || '/tmp/bemine-iphone-check';
const phase = process.env.BEMINE_IPHONE_PHASE || 'preview';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const checks = [], errors = [];
const stop = setTimeout(() => { browser.close(); }, 29000);
const page = await browser.newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
page.setDefaultTimeout(4000);
page.on('pageerror', error => errors.push(error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function inspect(label) {
  const result = await page.evaluate(() => {
    const visible = element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden';
    const fields = [...document.querySelectorAll('input,select,textarea')].filter(visible);
    const topButtons = [...document.querySelectorAll('.topbar button,.topbar select')].filter(visible);
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      smallFields: fields.filter(element => parseFloat(getComputedStyle(element).fontSize) < 16).map(element => element.className),
      smallTopControls: topButtons.filter(element => element.getBoundingClientRect().height < 44).map(element => element.className),
      viewport: document.querySelector('meta[name=viewport]')?.content,
    };
  });
  assert(result.overflow <= 1, `${label}: horizontal overflow ${result.overflow}`);
  assert.deepEqual(result.smallFields, [], `${label}: inputs below 16px`);
  assert.deepEqual(result.smallTopControls, [], `${label}: top controls below 44px`);
  assert(result.viewport.includes('viewport-fit=cover'));
  assert(!result.viewport.includes('maximum-scale') && !result.viewport.includes('user-scalable=no'));
  checks.push(label);
}
try {
  if (phase === 'preview') {
    await page.goto(`${base}/preview`);
    await page.locator('.preview-banner strong').waitFor();
    const routes = ['home', 'overview', 'pools', 'detail/16928', 'market', 'rewards', 'governance', 'records'];
    for (const [width, height] of [[375, 667], [390, 844], [393, 852], [402, 874], [430, 932], [440, 956], [852, 393]]) {
      await page.setViewportSize({ width, height });
      await page.reload(); await page.locator('.preview-banner strong').waitFor();
      for (const route of routes) {
        await page.evaluate(hash => { location.hash = hash; }, route);
        await settle();
        await inspect(`preview zh/light ${width}x${height} ${route}`);
      }
      if (width === 375 || width === 852) {
        await page.evaluate(() => { location.hash = 'detail/16928'; }); await settle();
        await page.screenshot({ animations: 'disabled', path: join(output, `preview-detail-${width}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 375, height: 667 });
    await page.getByLabel('Language', { exact: true }).selectOption('en');
    await page.locator('.appearance-toggle').click();
    for (const route of routes) {
      await page.evaluate(hash => { location.hash = hash; }, route); await settle();
      await inspect(`preview en/dark 375x667 ${route}`);
    }
    await page.locator('.mobile-menu').click();
    assert(await page.locator('.sidebar.open').isVisible());
    await page.locator('.sidebar.open .rules-link').click();
    await page.getByRole('dialog').waitFor();
    await inspect('preview en/dark rules dialog');
    const modal = await page.getByRole('dialog').boundingBox();
    assert(modal.y >= 0 && modal.y + modal.height <= 668, 'dialog must fit visible viewport');
    await page.screenshot({ animations: 'disabled', path: join(output, 'preview-rules-375.png') });
  } else if (phase === 'demo-share') {
    for (const [width, height, language] of [[375, 667, 'zh'], [390, 844, 'zh'], [393, 852, 'zh'], [402, 874, 'zh'], [430, 932, 'zh'], [440, 956, 'zh'], [375, 667, 'en'], [852, 393, 'en']]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/preview#share/16928`);
      await page.reload();
      await page.getByRole('link', { name: 'Telegram', exact: true }).waitFor();
      if (language === 'en') {
        await page.getByRole('button', { name: '关闭分享', exact: true }).click();
        await page.getByLabel('Language', { exact: true }).selectOption('en');
        await page.locator('.appearance-toggle').click();
        await page.locator('.preview-banner button').click();
        await page.getByRole('link', { name: 'Telegram', exact: true }).waitFor();
      }
      await inspect(`demo share ${language} ${width}x${height}`);
      const dialog = page.getByRole('dialog');
      const box = await dialog.boundingBox();
      assert(box.y >= 0 && box.y + box.height <= height + 1, 'demo share dialog must fit viewport');
      const telegram = page.getByRole('link', { name: 'Telegram', exact: true });
      await telegram.scrollIntoViewIfNeeded();
      const action = await telegram.boundingBox();
      assert(action.y >= 0 && action.y + action.height <= height, 'demo share actions must scroll into view');
      const url = new URL(await telegram.getAttribute('href'));
      assert.equal(url.hostname, 't.me');
      const invitation = new URL(url.searchParams.get('url'));
      assert(invitation.pathname.startsWith('/bemine/share/'));
      assert.equal(invitation.searchParams.get('mode'), 'demo');
      assert.equal(invitation.searchParams.get('project'), '16928');
      if (width === 375 || width === 852) await page.screenshot({ animations: 'disabled', path: join(output, `demo-share-${language}-${width}.png`) });
      await page.getByRole('button', { name: language === 'en' ? 'Close sharing' : '关闭分享', exact: true }).click();
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const footer = await page.locator('.page-footer').boundingBox();
      const banner = await page.locator('.preview-banner').boundingBox();
      const contentEnd = await page.locator('.page-footer').evaluate(element => element.getBoundingClientRect().bottom - parseFloat(getComputedStyle(element).paddingBottom));
      assert(contentEnd <= banner.y, 'preview banner must not cover footer content at page end');
      if (language === 'en') {
        await page.getByLabel('Language', { exact: true }).selectOption('zh');
        await page.locator('.appearance-toggle').click();
      }
    }
  } else {
    await installLiveFixture(page);
    await page.goto(base);
    await page.getByText('数据区块 100', { exact: true }).waitFor();
    await page.getByRole('button', { name: '连接钱包', exact: true }).click();
    const open = async route => {
      await page.evaluate(hash => { location.hash = hash; }, route);
      await page.waitForFunction(route => document.querySelector('main')?.dataset.readyRoute === route && document.querySelector('main')?.getAttribute('aria-busy') === 'false', route);
      await settle();
    };
    for (const width of [375, 390, 393, 402, 430, 440]) {
      await page.setViewportSize({ width, height: width === 375 ? 667 : 852 });
      for (const route of ['home', 'overview', 'pools', 'market', 'rewards', 'governance', 'records', `detail/${FIXTURE_POOLS.funding}`]) {
        await open(route); await inspect(`live zh/light ${width} ${route}`);
      }
    }
    for (const [width, height, language] of [[375, 667, 'zh'], [393, 852, 'en'], [852, 393, 'en']]) {
      await page.setViewportSize({ width, height });
      await page.getByLabel('Language', { exact: true }).selectOption(language);
      if (language === 'en' && width === 393) await page.locator('.appearance-toggle').click();
      await open(`detail/${FIXTURE_POOLS.funding}`);
      await page.getByRole('button', { name: language === 'zh' ? '邀请朋友一起拼矿' : 'Invite friends', exact: true }).last().click();
      await page.getByRole('link', { name: 'Telegram', exact: true }).waitFor();
      await inspect(`live ${language} ${width}x${height} share dialog`);
      const modal = await page.getByRole('dialog').boundingBox();
      assert(modal.y >= 0 && modal.y + modal.height <= height + 1, 'share dialog must fit visible viewport');
      await page.getByRole('link', { name: 'Telegram', exact: true }).scrollIntoViewIfNeeded();
      const telegram = await page.getByRole('link', { name: 'Telegram', exact: true }).boundingBox();
      assert(telegram.y >= 0 && telegram.y + telegram.height <= height, 'share actions must be scrollable into view');
      await page.screenshot({ animations: 'disabled', path: join(output, `live-share-${width}.png`) });
      await page.getByRole('button', { name: language === 'zh' ? '收起分享' : 'Dismiss sharing', exact: true }).click();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, `${phase}-results.json`), JSON.stringify({ browser: 'Chrome mobile/touch emulation; not physical iPhone or Safari', checks, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ phase, passed: checks.length, output }));
} finally {
  clearTimeout(stop);
  await browser.close();
}
