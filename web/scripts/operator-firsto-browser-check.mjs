/** Offline browser regression. Every HTTP/RPC request is intercepted; no real wallet or broadcast. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { operatorFirstoFixture } from './operator-firsto-fixture.mjs';
import { FIXTURE_OTHER_ACCOUNT } from './live-browser-fixture.mjs';
import { ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3109/bemine/';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-firsto-check');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const errors = [], checks = [], forbidden = [], officialCandidateRequests = [];
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
  const f = await operatorFirstoFixture();
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    let result;
    if (url.pathname.endsWith('/data/frontend-manifest.json')) result = f.manifest;
    else if (url.pathname.includes('/firsto-api/')) {
      const response = await f.api.fetcher(request.url(), { method: request.method(), credentials: 'omit' });
      return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    } else if (url.pathname.endsWith('/api/journal/official-candidates')) {
      officialCandidateRequests.push(url.pathname);
      result = { complete: true, chainId: 56, factory: f.config.factory, artifactDigest: ARTIFACT_DIGEST,
        pool: f.pool, blockNumber: '100', blockHash: `0x${'12'.repeat(32)}`, flexible: true,
        model: { circuits: f.data.quote.collection, taskId: '220', minVerifiedWeight: '50',
          referenceVerifiedWeight: '61', referencePriceWei: '10000000000000000', priceCap: f.rows[0].params.priceCap.toString() },
        candidates: [{ listingId: '46', collection: f.data.quote.collection, tokenId: '8',
          seller: f.source.account, priceWei: '4000000000000000', verifiedWeight: '61' }] };
    } else if (url.pathname.endsWith('/api/rpc')) {
      const payload = request.postDataJSON();
      try { result = { jsonrpc: '2.0', id: payload.id, result: await f.provider.request(payload) }; }
      catch (error) { result = { jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: error.message } }; }
    } else if (url.pathname.includes('/api/chain-index/')) {
      result = f.index(request.url()); result.source.indexedBlockHash = `0x${'12'.repeat(32)}`;
    } else return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: json(result) });
  });
  await page.exposeFunction('__firstoRead', payload => {
    if (/sign|send|wallet_/i.test(payload.method)) { forbidden.push(payload.method); throw new Error('Fixture refuses wallet writes'); }
    return f.provider.request(payload);
  });
  await page.addInitScript(account => {
    const events = new Map(); let connected = false;
    const wallet = { isMetaMask: true, async request(input) {
      if (input.method === 'eth_requestAccounts') { connected = true; return [account]; }
      if (input.method === 'eth_accounts') return connected ? [account] : [];
      return window.__firstoRead(input);
    }, on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeListener(name, fn) { events.get(name)?.delete(fn); },
    __emit(name, value) { for (const fn of events.get(name) ?? []) fn(value); } };
    Object.defineProperty(window, 'ethereum', { configurable: true, value: wallet });
  }, f.account);
  await page.goto(base);
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: '运营工作台', exact: true }).click();
  await page.getByRole('button', { name: '浏览 Firsto 候选', exact: true }).click();
  await page.getByRole('button', { name: '先查官网并选择', exact: true }).click();
  await page.getByText('矿池总支出 0.005050000000000001 BNB', { exact: true }).waitFor();
  await page.getByRole('button', { name: '填入建池表单', exact: true }).click();
  assert.equal(await page.getByLabel('购机价格上限（BNB）', { exact: true }).inputValue(), '0.005050000000000001');
  checks.push('Firsto selected quote fills fee-inclusive cap');
  f.state.registryPool = f.pool;
  await page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: f.pool }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: '确认运营操作' }).count(), 0);
  checks.push('duplicate appearing after quote selection blocks create preview with exact existing pool');
  await page.getByLabel('矿池合约', { exact: true }).fill(f.pool);
  await page.getByRole('button', { name: '先查官网并预览购机', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '确认运营操作' }); await modal.waitFor();
  const text = await modal.innerText();
  assert.match(text, /TapeOut #7/); assert.match(text, /0.005050000000000001 BNB（由矿池余额支付）/);
  assert.match(text, /仅 Gas，不从运营钱包转入购机款/); assert.match(text, /0.00005 BNB/);
  assert.equal(f.simulations.length, 1); assert.deepEqual(forbidden, []);
  await page.screenshot({ path: join(output, 'firsto-pool-funded-preview.png'), fullPage: true, animations: 'disabled' });
  checks.push('one click reads original target and previews exact seller price, source fee, pool gross and wallet Gas only');
  await modal.getByRole('button', { name: '返回修改', exact: true }).click();
  f.state.flexible = true; f.state.alternativeListing = { valid: true, price: 4000000000000000n };
  await page.getByRole('button', { name: '先查官网并预览购机', exact: true }).click();
  await modal.getByText('从官网市场购入同任务替代矿机', { exact: true }).waitFor();
  const alternativeText = await modal.innerText();
  assert.match(alternativeText, /TapeOut #8/); assert.match(alternativeText, /验证产能权重\s*61/);
  assert.match(alternativeText, /官网预览价未锁定/); assert.match(alternativeText, /仅 Gas/);
  assert(officialCandidateRequests.includes(`${new URL(base).pathname.replace(/\/$/, '')}/api/journal/official-candidates`));
  await page.screenshot({ path: join(output, 'official-alternative-preview.png'), fullPage: true, animations: 'disabled' });
  checks.push('flexible pool discovers and simulates an official same-task replacement before Firsto, with miner identity and price warning');
  await modal.getByRole('button', { name: '返回修改', exact: true }).click();
  f.state.flexible = false; f.state.alternativeListing = null;
  f.state.old = true;
  await page.getByRole('button', { name: '刷新权限', exact: true }).click();
  await page.getByText('当前工厂尚未支持矿机唯一性登记。请等待合约升级后创建新项目；已有项目的读取、退款与提现不受影响。', { exact: true }).waitFor();
  await page.getByLabel('矿池合约', { exact: true }).fill(f.pool);
  assert(await page.getByRole('button', { name: '预览创建矿池', exact: true }).isDisabled());
  assert(await page.getByRole('button', { name: '先查官网并预览购机', exact: true }).isEnabled());
  await page.getByRole('button', { name: '先查官网并预览购机', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '尚未开放 Firsto 采购' }).waitFor();
  assert(await page.getByRole('button', { name: '浏览 Firsto 候选', exact: true }).isEnabled());
  await page.getByRole('button', { name: '浏览 Firsto 候选', exact: true }).click();
  await page.getByRole('button', { name: '先查官网并选择', exact: true }).click();
  await page.getByText('当前工厂版本尚未开放 Firsto 合约采购。', { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: '填入建池表单', exact: true }).isDisabled());
  await page.getByRole('button', { name: '灵活购机报价建池', exact: true }).click();
  assert(await page.getByRole('button', { name: '预览创建矿池', exact: true }).isDisabled());
  await page.screenshot({ path: join(output, 'old-factory-creation-blocked.png'), fullPage: true, animations: 'disabled' });
  checks.push('old factory allows read-only quote checks but blocks applying the quote, fixed/flexible creation and Firsto purchase');
  f.state.old = false; f.state.ready = false;
  await page.getByRole('button', { name: '刷新权限', exact: true }).click();
  await page.getByText('矿机唯一性登记尚未完成，暂不能创建新项目或从 Firsto 采购。', { exact: true }).waitFor();
  await page.getByLabel('矿池合约', { exact: true }).fill(f.pool);
  assert(await page.getByRole('button', { name: '预览创建矿池', exact: true }).isDisabled());
  await page.getByRole('button', { name: '先查官网并预览购机', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '登记未完成' }).waitFor();
  checks.push('unfinished registry migration keeps creation and Firsto disabled');
  f.state.ready = true;
  await page.getByRole('button', { name: '刷新权限', exact: true }).click();
  await page.getByLabel('矿池合约', { exact: true }).fill(f.pool);
  await page.getByRole('button', { name: '先查官网并预览购机', exact: true }).click();
  await modal.waitFor();
  await page.evaluate(account => window.ethereum.__emit('accountsChanged', [account]), FIXTURE_OTHER_ACCOUNT);
  await page.getByText('此页面仅限授权运营人员', { exact: true }).waitFor();
  assert.equal(await modal.count(), 0); assert.deepEqual(forbidden, []);
  checks.push('account switch invalidates Firsto procurement preview without signing');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), json({ passed: checks.length, checks, forbidden, errors, output }));
  console.log(json({ passed: checks.length, checks, output }));
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }); await writeFile(join(output, 'failure.html'), await page.content()); }
  await writeFile(join(output, 'failure.json'), json({ message: error.message, errors, forbidden, checks }));
  throw error;
} finally { await browser.close(); }
