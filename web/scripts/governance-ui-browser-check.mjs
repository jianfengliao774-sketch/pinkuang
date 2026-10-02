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
        estimated24hAtomic: row.pool === FIXTURE_POOLS.active ? '95000000' : '0' } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: encode({ asset }) });
  });
  await page.goto(base);
  await page.getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('header .live-wallet-label').filter({hasText:/0x[0-9a-f]/i}).waitFor();
  async function open(pool) {
    await page.evaluate(pool => { location.hash = `detail/${pool}`; }, pool);
    await page.waitForFunction(pool => document.querySelector('main')?.dataset.readyRoute === `detail/${pool}`, pool);
    await page.getByRole('button', { name: '共同决策', exact: true }).last().click();
    await page.locator('.live-gov-metrics').waitFor();
  }
  await open(FIXTURE_POOLS.active);
  const section = page.locator('.live-governance');
  const sale = section.getByLabel('拟出售整机价（BNB）', { exact: true });
  const capacity = section.getByLabel('日产能价（BNB / (BEM/天)）', { exact: true });
  assert.equal(await section.getByLabel('提案记录参考价（BNB）', { exact: true }).count(), 0);
  await page.waitForFunction(() => document.querySelector('[aria-label="日产能价（BNB / (BEM/天)）"]')?.disabled === false);
  assert.deepEqual(await section.locator('.live-gov-metrics > div > span').allTextContents(),
    ['我当前的份额', '投票快照份额', '历史实际购机价', 'Firsto 市场参考价', '当前24H日产', '交易状态']);
  assert.match(await section.locator('.live-gov-metrics').innerText(), /0\.95000 BEM/);
  await sale.fill('1.9'); await sale.blur();
  assert.equal(await sale.inputValue(), '1.90000'); assert.equal(await capacity.inputValue(), '2.00000');
  await sale.fill('1.900001234567890123'); await sale.blur();
  assert.equal(await sale.inputValue(), '1.90000');
  await sale.focus(); assert.equal(await sale.inputValue(), '1.900001234567890123'); await sale.blur();
  // Focus/blur is presentation only; the next capacity edit deliberately chooses a new exact source.
  await capacity.fill('3'); await capacity.blur();
  assert.equal(await capacity.inputValue(), '3.00000'); assert.equal(await sale.inputValue(), '2.85000');
  await capacity.fill('2'); await capacity.blur();
  await section.getByRole('button', { name: '预览提案', exact: true }).click();
  await page.getByRole('dialog', { name: '确认整机出售操作' }).waitFor();
  // Inspect the prepared (unsigned) action without invoking any wallet write.
  const previewAction = await section.evaluate(element => {
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
    while (fiber) {
      for (const branch of [fiber, fiber.alternate]) {
        for (let hook = branch?.memoizedState; hook; hook = hook.next) {
          if (hook.memoizedState?.action?.kind === 'propose') return hook.memoizedState.action;
        }
      }
      fiber = fiber.return;
    }
    return null;
  });
  assert.equal(previewAction?.priceWei, '1900000000000000000');
  assert.equal(previewAction?.refPriceWei, '8000000000000000000');
  checks.push('two-way 0.95 BEM/day calculation, explicit capacity unit, five-place display and eighteen-decimal raw input');
  const measurements = await section.evaluate(element => ({
    sizes: [...element.querySelectorAll('.live-gov-propose label,.live-gov-propose input,.live-gov-metrics span,.live-gov-selector span')].map(node => parseFloat(getComputedStyle(node).fontSize)),
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  assert(measurements.sizes.every(value => value >= 16)); assert.equal(measurements.overflow, false);
  await fs.mkdir('/tmp/bemine-ui-review', { recursive: true });
  await page.screenshot({ path: `/tmp/bemine-ui-review/governance-${width}.png`, fullPage: true });
  checks.push(`${width}px viewport: readable body labels and no page overflow`);
  await open(FIXTURE_POOLS.voting);
  assert.equal(await sale.inputValue(), ''); assert.equal(await capacity.inputValue(), '');
  assert.equal(await page.getByRole('dialog', { name: '确认整机出售操作' }).count(), 0);
  assert.equal(await capacity.isDisabled(), true); assert.equal(await sale.isDisabled(), false);
  await sale.fill('1.9'); await sale.blur();
  await section.getByRole('button', { name: '预览提案', exact: true }).click();
  await page.getByRole('dialog', { name: '确认整机出售操作' }).waitFor();
  checks.push('pool switch clears inputs and preview; unknown output permits whole-miner proposal only');
  assert.equal(fixture.controls.sentTransactions.length, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ width, passed: checks.length, checks }));
} finally { clearTimeout(deadline); await browser.close(); }
