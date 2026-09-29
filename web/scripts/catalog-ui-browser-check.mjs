/** Local-only UI regression. Every wallet write/signature is rejected by the fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Interface } from 'ethers';
import { installLiveFixture, FIXTURE_POOLS } from './live-browser-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3116';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const width = Number(process.env.BEMINE_TEST_WIDTH || 1440), checks = [], errors = [];
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const deadline = setTimeout(() => browser.close(), 28000);
const encode = value => JSON.stringify(value, (_, x) => typeof x === 'bigint' ? x.toString() : x);
try {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
  const fixture = await installLiveFixture(page);
  const nft = new Interface(['function ownerOf(uint256) view returns(address)']);
  await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
    const body = route.request().postDataJSON(), tx = body.params?.[0];
    if (body.method !== 'eth_call') return route.fallback();
    let result;
    if (tx.data.startsWith(nft.getFunction('ownerOf').selector)) {
      const id = nft.decodeFunctionData('ownerOf', tx.data)[0];
      const row = fixture.rows.find(row => row.params.circuitId === id && row.params.circuits.toLowerCase() === tx.to.toLowerCase());
      result = nft.encodeFunctionResult('ownerOf', [row.pool]);
    } else if (tx.data.startsWith(abi.PoolVault.getFunction('params').selector)) {
      const row = fixture.rows.find(row => row.pool.toLowerCase() === tx.to.toLowerCase());
      result = abi.PoolVault.encodeFunctionResult('params', [row.params]);
    } else return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: encode({ jsonrpc: '2.0', id: body.id, result }) });
  });
  await page.route(/\/firsto-api\/v1\/circuit\//, async route => {
    const tokenId = new URL(route.request().url()).pathname.split('/').at(-1);
    const row = fixture.rows.find(row => row.params.circuitId.toString() === tokenId);
    // A second pool intentionally has no verified output.
    const asset = { collection: row.params.circuits, tokenId, owner: row.pool,
      category: 'official_mining', classification: 'official_mining',
      mining: { tokenSymbol: 'BEM', tokenDecimals: 8, status: 'verified', sourceBlock: '100',
        estimated24hAtomic: row.pool === FIXTURE_POOLS.voting ? '0' : '95000000' },
      listingReference: { dailyCapacityPriceWei: String(({ '16210': 10n, '8204': 2n, '15832': 3n, '9052': 4n })[tokenId] * 10n ** 18n) } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: encode({ asset }) });
  });
  await page.goto(base);
  await page.getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  await page.evaluate(() => { location.hash = 'pools'; });
  await page.waitForFunction(() => document.querySelector('main')?.dataset.readyRoute === 'pools');
  const main = page.locator('main'), tabs = main.locator('.live-toolbar .tabs');
  assert.deepEqual(await tabs.locator('button').allTextContents(), ['募集中', '挖矿中', '整机出售中', '项目总览']);
  assert.equal(await tabs.locator('.selected').innerText(), '募集中');
  assert.equal(await main.locator('table th').getByText('状态', { exact: true }).count(), 0);
  await main.getByText('10.00000', { exact: true }).waitFor();
  assert.match(await main.locator('table tbody').innerText(), /0\.95000 BEM/);
  checks.push('funding default, overview fourth, no redundant status, verified daily output and reference render');
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  assert.equal(await noOverflow(), true);
  await fs.mkdir('/tmp/bemine-ui-review', { recursive: true });
  await page.screenshot({ path: `/tmp/bemine-ui-review/catalog-funding-${width}.png`, fullPage: true });
  await tabs.getByRole('button', { name: '项目总览', exact: true }).click();
  assert.equal(await main.locator('table th').getByText('状态', { exact: true }).count(), 1);
  await main.getByRole('button', { name: '筛选排序', exact: true }).click();
  await main.getByRole('combobox').selectOption('capacity');
  await main.getByText('2.00000', { exact: true }).waitFor();
  await main.getByText('3.00000', { exact: true }).waitFor();
  assert.deepEqual(await main.locator('table tbody .asset-cell strong').allTextContents(), ['Behemoth #8204', 'TapeOut #15832', 'TapeOut #16210', 'Behemoth #9052']);
  assert.equal(await noOverflow(), true);
  await page.screenshot({ path: `/tmp/bemine-ui-review/catalog-overview-${width}.png`, fullPage: true });
  checks.push('capacity sort is numeric ascending, unknown last, status preserved in overview');
  await page.evaluate(pool => { location.hash = `detail/${pool}`; }, FIXTURE_POOLS.active);
  await page.waitForFunction(pool => document.querySelector('main')?.dataset.readyRoute === `detail/${pool}`, FIXTURE_POOLS.active);
  const panel = page.locator('.purchase-panel');
  await panel.getByRole('button', { name: '领取 0.12000 BNB', exact: true }).waitFor();
  assert.match(await panel.locator('.unit-price').innerText(), /0\.08800/);
  await panel.getByText(/日产能参考价：2\.00000/).waitFor();
  assert.equal(await noOverflow(), true);
  await page.screenshot({ path: `/tmp/bemine-ui-review/catalog-position-${width}.png`, fullPage: true });
  checks.push(`${width}px: five-decimal BNB sidebar and no horizontal page overflow`);
  assert.equal(fixture.controls.sentTransactions.length, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ width, passed: checks.length, checks }));
} finally { clearTimeout(deadline); await browser.close(); }
