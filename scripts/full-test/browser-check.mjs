import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { validBemQuote } from '../../web/lib/bem-price.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const site = resolve(process.env.BEMINE_FULL_TEST_SITE || process.argv[2] || '');
const metadata = JSON.parse(readFileSync(join(site, 'full-test-site.json'), 'utf8'));
assert.equal(metadata.profile, 'full-test');
const base = '/bemine-full-test';
const roles = { deployer: '0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E',
  administratorOne: '0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E',
  administratorTwo: '0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E',
  gasWallet: '0x0C14b1008cFFe78711d65b13C8Ce5ca9B944252C' };
const config = { schemaVersion: 1, profile: 'full-test', chainId: 56, artifactDigest: metadata.artifactDigest,
  sourceHead: metadata.sourceHead, roles, status: 'unconfigured', phase: 'deployment-pending',
  timings: { holdSeconds: 0, proposalCooldownSeconds: 0, voteSeconds: 86400, listingSeconds: 604800, upgradeDelaySeconds: 0 } };
const requests = [], pageErrors = [], external = [], failedResponses = [], checks = [];
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname; requests.push(path);
  if (path === `${base}/api/full-test/config`) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(config)); return; }
  // The local asset/navigation check has no upstream quote server. Model its
  // empty/unavailable public responses without introducing fabricated prices.
  if (path === `${base}/firsto-api/v1/circuits` || path === `${base}/firsto-api/v1/circuit-holders`) {
    const body = path.endsWith('/circuits')
      ? { rows: [], page: 1, totalPages: 0, total: 0, viewId: 'local-unconfigured', sourceBlock: '0', sourceFreshness: {} }
      : { status: 'unavailable', coverage: { holders: 'unavailable', market24h: 'unavailable' }, marketStats: { dailyCapacityPriceWei: null } };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  if (!path.startsWith(`${base}/`)) { res.writeHead(404); res.end(); return; }
  let target = resolve(site, decodeURIComponent(path.slice(base.length + 1)));
  if (target !== site && !target.startsWith(`${site}${sep}`)) { res.writeHead(403); res.end(); return; }
  try {
    if (statSync(target).isDirectory()) target = join(target, 'index.html');
    const ext = Object.keys(mime).find(ext => target.endsWith(ext));
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' }); res.end(readFileSync(target));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const output = resolve(process.env.BEMINE_BROWSER_OUTPUT || join(site, '../full-test-browser-results'));
mkdirSync(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.goto(`${origin}${base}/`);
  await page.getByText('测试合约尚未完成部署及权限激活；可先浏览各页面。', { exact: true }).waitFor();
  const price = await page.request.get(`${origin}${base}/data/bem-price.json`);
  assert.equal(price.status(), 200);
  const pricePayload = await price.json();
  assert.equal(pricePayload.status, 'unavailable');
  assert.equal(pricePayload.priceUsdt, null);
  assert.equal(validBemQuote(pricePayload), false);
  const favicon = await page.request.get(`${origin}${base}/deploy/favicon.svg`);
  assert.equal(favicon.status(), 200);
  assert((await favicon.text()).includes('<svg'));
  checks.push('neutral unavailable quote and reviewed console favicon are served without missing assets');
  const pages = [['home','拼矿总览'],['overview','资产总览'],['pools','参与拼矿'],['market','矿机转让'],
    ['rewards','收益中心'],['governance','共同决策'],['records','公开记录']];
  for (const [route, name] of pages) {
    await page.locator('.sidebar nav').getByRole('button', { name, exact: true }).click();
    await page.waitForFunction(hash => location.hash === `#${hash}`, route);
    await page.waitForFunction(name => document.querySelector('.sidebar .nav-item.active')?.textContent.trim() === name, name);
    assert.equal((await page.locator('.sidebar .nav-item.active').innerText()).trim(), name);
    await page.waitForFunction(name => document.querySelector('.topbar .breadcrumb')?.textContent?.includes(name), name);
    assert.equal(await page.locator('main').isVisible(), true);
    assert.equal(await page.locator('main').getByText('测试合约尚未完成部署及权限激活；可先浏览各页面。', { exact: true }).count(), 1);
    checks.push(`unconfigured ${route} navigation and honest empty state`);
  }
  assert.equal(await page.getByRole('link', { name: '测试合约部署', exact: true }).getAttribute('href'), 'https://tapeout.cc.cd/bemine-full-test/deploy/');
  assert(!requests.some(url => /\/bemine-v4|frontend-manifest|\/api\/(rpc|chain-index|journal)/.test(url)), 'Unconfigured pages must not read formal roots or chain state.');
  checks.push('no production manifest, RPC, journal or index boot requests');
  await page.screenshot({ path: join(output, 'full-test-records.png'), fullPage: true });
  await page.goto(`${origin}${base}/deploy/`);
  await page.locator('[data-test-profile="full-test"]').waitFor();
  await page.getByText('部署产物已校验', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: '份额市场', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '矿机报价', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '返回完整测试站', exact: true }).getAttribute('href'), '../');
  assert((await page.locator('main').innerText()).includes(roles.gasWallet));
  assert(!/48\s*(?:小时|h)/.test(await page.locator('main').innerText()), 'Full-test console must not display the production upgrade wait.');
  assert.equal(await page.locator('.governance-flow').getByText('0h', { exact: true }).count(), 1);
  assert.equal(await page.getByText('运营和金库使用同一个钱包', { exact: true }).count(), 0);
  checks.push('separate full 16+7 console roles and no legacy trading/cutover routes');
  await page.getByRole('button', { name: '升级与权限', exact: true }).click();
  await page.getByRole('heading', { name: '完整测试合约权限', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /执行.*升级/ }).count(), 0);
  checks.push('test governance explains full activation without exposing legacy upgrade signing');
  await page.setViewportSize({ width: 375, height: 560 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Short screens must not overflow horizontally.');
  assert.equal(await page.locator('.sidebar').isVisible(), false, 'Closed mobile navigation must be hidden.');
  assert.equal(await page.getByRole('button', { name: '连接钱包', exact: true }).isVisible(), true);
  const walletButton = page.getByRole('button', { name: '连接钱包', exact: true });
  assert.equal(await walletButton.evaluate(element => { const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); }), true,
    'Closed navigation must not cover the connect-wallet hit target.');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await page.getByRole('button', { name: '关闭导航', exact: true }).click();
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '合约部署', exact: true }).click();
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  checks.push('zero test upgrade wait and usable mobile header, navigation open, close and select controls');
  await page.screenshot({ path: join(output, 'full-test-console-short.png'), fullPage: true });
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  assert.equal(external.length, 0, external.join('\n'));
  assert.equal(failedResponses.length, 0, failedResponses.join('\n'));
  assert(!requests.some(path => path.endsWith('/activate')), 'No activation or transactions may run automatically.');
  checks.push('zero browser errors, external network traffic and automatic activation');
  writeFileSync(join(output, 'results.json'), JSON.stringify({ ok: true, checks, pageErrors, external, failedResponses, requests }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, output }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
