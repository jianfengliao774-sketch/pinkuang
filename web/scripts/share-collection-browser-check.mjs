/** Isolated UI and static-crawler checks; never opens a social composer or sends a wallet transaction. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { SHARE_ARTWORKS } from '../lib/share-artwork.mjs';
import { SHARE_MOTTO_COUNT } from '../lib/share-copy.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108';
const staticExport = process.env.BEMINE_STATIC_EXPORT === '1';
const remote = new URL(base).hostname === 'tapeout.cc.cd';
assert(remote || ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const output = process.env.BEMINE_BROWSER_OUTPUT || '/tmp/bemine-share-v11';
const phase = process.env.BEMINE_SHARE_PHASE || 'mobile';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const checks = [], errors = [], files = [];
const preview = `${base}/preview${staticExport ? '.html' : ''}`;
const suffix = staticExport ? '.html' : '';
try {
  if (phase === 'mobile') for (let index = 0; index < SHARE_ARTWORKS.length; index++) {
    const art = SHARE_ARTWORKS[index];
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: 'zh-CN' });
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    const posterRequests = [], bad = [];
    page.on('request', request => { if (/\/images\/bemine-share-/.test(request.url())) posterRequests.push(request.url()); });
    page.on('response', response => { if (/\/images\/bemine-share-/.test(response.url()) && response.status() >= 400) bad.push(response.url()); });
    await page.addInitScript(({ value }) => {
      // Cosmetic one-word draw only. Other cryptographic calls keep their native implementation.
      const native = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = array => {
        if (array instanceof Uint32Array && array.length === 1) { array[0] = value; return array; }
        return native(array);
      };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.__copied = value; } } });
      window.__walletCalls = [];
      window.ethereum = { request: async data => { window.__walletCalls.push(data.method); throw new Error('Wallet forbidden'); } };
    }, { value: Math.floor((index * SHARE_MOTTO_COUNT + 3.5) / (SHARE_ARTWORKS.length * SHARE_MOTTO_COUNT) * 0x100000000) });
    await page.goto(`${preview}#share/16928`);
    const figure = page.locator(`figure[data-share-poster="${art.id}"]`);
    const image = figure.locator('img');
    await image.waitFor(); await image.evaluate(image => image.decode());
    const source = await image.evaluate(image => ({ src: image.currentSrc, width: image.naturalWidth }));
    assert(source.src.endsWith(`${art.base}-mobile.webp`));
    assert.equal(source.width, 640);
    assert.deepEqual([...new Set(posterRequests)], [source.src], 'Only the chosen mobile image is fetched, even at iPhone DPR 3');
    const download = page.getByRole('link', { name: '保存分享图片', exact: true });
    assert((await download.getAttribute('href')).endsWith(`${art.base}.jpg`));
    const text = await page.locator('#demo-share-text').inputValue();
    const invitation = new URL(await page.locator('#demo-share-link').inputValue());
    assert.equal(invitation.pathname, `/bemine/share/${art.id}.html`);
    assert.equal(invitation.searchParams.get('mode'), 'demo');
    assert.equal(invitation.searchParams.get('project'), '16928');
    await page.getByRole('button', { name: 'X', exact: true }).click();
    const intent = new URL(await page.getByRole('link', { name: 'X', exact: true }).getAttribute('href'));
    assert.equal(intent.searchParams.get('text'), await page.locator('#demo-share-text').inputValue());
    assert.equal(new URL(intent.searchParams.get('url')).pathname, invitation.pathname);
    assert.equal(await figure.count(), 1, 'Channel change keeps the same poster');
    await page.getByRole('button', { name: 'Telegram', exact: true }).click();
    assert.equal(await page.locator('#demo-share-text').inputValue(), text);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    if (index === 1 || index === 8) {
      await figure.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/iphone-${art.id}.png`, animations: 'disabled' });
    }
    await page.getByRole('button', { name: '换一组', exact: true }).click();
    await page.waitForFunction(old => document.querySelector('figure[data-share-poster]')?.dataset.sharePoster !== old.id || document.querySelector('#demo-share-text')?.value !== old.text, { id: art.id, text });
    const changed = await page.locator('figure[data-share-poster]').getAttribute('data-share-poster');
    const changedText = await page.locator('#demo-share-text').inputValue();
    await page.getByRole('button', { name: '关闭分享', exact: true }).click();
    await page.locator('.preview-banner button').click();
    await page.waitForFunction(() => document.querySelector('figure[data-share-poster]'));
    const reopened = await page.locator('figure[data-share-poster]').getAttribute('data-share-poster');
    const reopenedText = await page.locator('#demo-share-text').inputValue();
    assert(changed !== reopened || changedText !== reopenedText, 'Reopening draws a new combination');
    await page.getByRole('link', { name: 'Telegram', exact: true }).scrollIntoViewIfNeeded();
    const button = await page.getByRole('link', { name: 'Telegram', exact: true }).boundingBox();
    assert(button.y >= 0 && button.y + button.height <= 813 && button.height >= 44);
    assert.deepEqual(await page.evaluate(() => window.__walletCalls), []);
    assert.deepEqual(bad, []);
    checks.push(`${art.id}: mobile 640px only, matching links/download, stable channel, new pair and reopen`);
    files.push(source.src);
    await page.close();
  }
  if (phase === 'landing') {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
    page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
    for (const art of SHARE_ARTWORKS) {
      const path = `${base}/share/${art.id}${suffix}?mode=demo&project=16928&source=tg`;
      const response = await page.request.get(path);
      assert.equal(response.status(), 200);
      const html = await response.text();
      assert(html.includes(`property="og:image" content="https://tapeout.cc.cd/bemine/images/${art.base}.jpg"`));
      assert(html.includes(`name="twitter:image" content="https://tapeout.cc.cd/bemine/images/${art.base}.jpg"`));
      await page.goto(path);
      await page.waitForURL(url => url.hash === '#detail/16928' && url.searchParams.get('source') === 'tg');
      assert(page.url().startsWith(preview));
      checks.push(`${art.id}: static OG/Twitter image + exact demo project redirect`);
    }
    await page.goto(`${base}/share/anime${suffix}?mode=live&project=0x${'a1'.repeat(20)}&next=https://evil.example`);
    await page.getByText('了解拼矿，遇见一起参与的矿友。', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).origin, new URL(base).origin);
    await page.goto(`${base}/posters${suffix}`);
    assert.equal(await page.locator('article').count(), 9);
    assert.equal(await page.locator('ol li').count(), 18);
    for (const image of await page.locator('article img').all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(image => image.decode());
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: `${output}/poster-gallery.png`, fullPage: true, animations: 'disabled' });
    checks.push('invalid redirect stays safe; gallery contains nine posters and eighteen bilingual lines');
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/${phase}-results.json`, JSON.stringify({ checks, files, errors, browser: 'Chrome mobile touch emulation, not iPhone hardware/Safari' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, output }));
} finally { await browser.close(); }
