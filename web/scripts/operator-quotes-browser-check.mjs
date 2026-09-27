/** Offline quotation UI checks: intercepted API/RPC plus a fake wallet; never a real signature or transaction. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { installLiveFixture, FIXTURE_OTHER_ACCOUNT } from './live-browser-fixture.mjs';
import { dataFixture, chainFixture, apiFixture, MARKET, MINING } from './operator-quotes-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3113/bemine/';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-quote-check');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const checks = [], errors = [], forbidden = [];
async function preparePage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  // Abort external requests, including third-party price calls. Quotes and all chain reads are local fixtures.
  await page.route('**/*', route => {
    const input = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(input.hostname) ? route.fallback() : route.abort();
  });
  const fixture = await installLiveFixture(page, { isOperator: true });
  const data = dataFixture(), chain = chainFixture(data.quote);
  const api = apiFixture(data);
  await page.route(/\/firsto-api\//, async route => {
    const response = await api.fetcher(route.request().url(), { method: route.request().method(), credentials: 'omit' });
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
    const payload = route.request().postDataJSON();
    if (/sign|send|wallet_/i.test(payload.method)) { forbidden.push(payload.method); return route.abort(); }
    if (payload.method !== 'eth_call' || ![MARKET, MINING, getAddress(data.quote.collection)].includes(getAddress(payload.params[0].to))) return route.fallback();
    const result = await chain.provider.request(payload);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }) });
  });
  await page.goto(base);
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  await page.locator('nav').getByRole('button', { name: '运营工作台', exact: true }).click();
  await page.locator('.operator-quote-table').getByRole('button', { name: '核对并选择', exact: true }).waitFor();
  const select = async () => {
    await page.locator('.operator-quote-table').getByRole('button', { name: '核对并选择', exact: true }).click();
    await page.getByRole('button', { name: '填入建池表单', exact: true }).waitFor();
    await page.getByRole('button', { name: '填入建池表单', exact: true }).click();
  };
  return { page, fixture, data, api, chain, select };
}
try {
  const first = await preparePage(), { page, fixture } = first;
  try {
    await first.select();
    assert.equal(await page.getByLabel('矿机编号', { exact: true }).inputValue(), '16480');
    assert.equal(await page.getByLabel('购机价格上限（BNB）', { exact: true }).inputValue(), '2.000000000000000001');
    assert.equal(await page.getByLabel('募集总额（BNB）', { exact: true }).inputValue(), '2.2000000000000001');
    await page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
    await page.getByRole('dialog', { name: '确认运营操作' }).waitFor();
    const previews = fixture.walletRequests.filter(item => item.method === 'eth_call' && item.params[0].data.startsWith(abi.PoolFactory.getFunction('createPool').selector));
    assert.equal(previews.length, 1);
    const [params] = abi.PoolFactory.parseTransaction(previews[0].params[0]).args;
    assert.equal(params.circuitId, 16480n); assert.equal(params.priceCap, 2000000000000000001n); assert.equal(params.targetRaise, 2200000000000000100n);
    assert.equal(BigInt(previews[0].params[0].value), 0n); assert.equal(fixture.controls.sentTransactions.length, 0);
    await page.screenshot({ path: join(output, 'automatic-quote-preview.png'), animations: 'disabled' });
    checks.push('verified quote -> exact official price and 100-share target -> zero-value unsigned createPool preview');
    await page.evaluate(account => window.ethereum.__emit('accountsChanged', [account]), FIXTURE_OTHER_ACCOUNT);
    await page.getByText('此页面仅限授权运营人员', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: '确认运营操作' }).count(), 0);
    assert.equal(fixture.controls.sentTransactions.length, 0);
    checks.push('account switch invalidates auto-filled creation preview without signing');
  } finally { await page.close(); }

  const stale = await preparePage();
  try {
    await stale.select();
    for (const key of Object.keys(stale.data.page.sourceFreshness)) stale.data.page.sourceFreshness[key] = Date.now() - 300001;
    await stale.page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
    await stale.page.getByRole('alert').filter({ hasText: '超过 5 分钟' }).waitFor();
    assert.equal(await stale.page.getByRole('dialog', { name: '确认运营操作' }).count(), 0);
    assert(!stale.fixture.walletRequests.some(item => item.method === 'eth_call' && item.params[0].data.startsWith(abi.PoolFactory.getFunction('createPool').selector)));
    assert.equal(stale.fixture.controls.sentTransactions.length, 0);
    checks.push('source expiration during preparation blocks unsigned preview and any send');
  } finally { await stale.page.close(); }

  const imported = await preparePage();
  try {
    await imported.page.getByRole('button', { name: '灵活购机报价建池', exact: true }).click();
    await imported.page.locator('.operator-import summary').click();
    await imported.page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
    await imported.page.getByRole('alert').filter({ hasText: '完整报价' }).waitFor();
    await imported.page.getByLabel('已核验矿机报价 JSON').fill('{"params":');
    await imported.page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
    await imported.page.getByRole('alert').filter({ hasText: 'JSON 不完整或格式错误' }).waitFor();
    assert.equal(imported.fixture.controls.sentTransactions.length, 0);
    checks.push('empty and truncated advanced imports show actionable Chinese errors without wallet requests');
  } finally { await imported.page.close(); }
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  const result = { passed: checks.length, checks, output, noRealWallet: true, noExternalApi: true };
  await writeFile(join(output, 'operator-quotes-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
