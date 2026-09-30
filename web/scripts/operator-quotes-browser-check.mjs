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
  await page.locator('header .live-wallet-label').filter({hasText:/0x[0-9a-f]/i}).waitFor();
  await page.locator('nav').getByRole('button', { name: '运营工作台', exact: true }).click();
  await page.locator('.operator-quote-table').getByRole('button', { name: '链上核对并选择', exact: true }).waitFor();
  const select = async () => {
    await page.locator('.operator-quote-table').getByRole('button', { name: '链上核对并选择', exact: true }).click();
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
    assert.equal(await page.getByLabel('购机价格上限（BNB）', { exact: true }).inputValue(), '≈ 2.00000');
    const funding = page.getByLabel('募集总额（BNB）', { exact: true });
    assert.equal(await funding.inputValue(), '≈ 2.20000');
    await funding.focus(); assert.equal(await funding.inputValue(), '2.2000000000000001');
    await funding.blur(); assert.equal(await funding.inputValue(), '≈ 2.20000');
    await page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
    await page.getByRole('dialog', { name: '确认运营操作' }).waitFor();
    const previews = fixture.walletRequests.filter(item => item.method === 'eth_call' && item.params[0].data.startsWith(abi.PoolFactory.getFunction('createPool').selector));
    assert.equal(previews.length, 1);
    const [params] = abi.PoolFactory.parseTransaction(previews[0].params[0]).args;
    assert.equal(params.circuitId, 16480n); assert.equal(params.priceCap, 2000000000000000001n); assert.equal(params.targetRaise, 2200000000000000100n);
    assert.equal(BigInt(previews[0].params[0].value), 0n); assert.equal(fixture.controls.sentTransactions.length, 0);
    const modal = page.getByRole('dialog', { name: '确认运营操作' });
    assert.match(await modal.innerText(), /≈ 2\.20000 BNB/);
    await modal.getByText('查看精确金额', { exact: true }).click();
    assert.match(await modal.innerText(), /2\.2000000000000001 BNB/);
    await page.screenshot({ path: join(output, 'automatic-quote-preview.png'), animations: 'disabled' });
    checks.push('verified quote -> exact official price and 100-share target -> zero-value unsigned createPool preview');
    checks.push('automatic fundraising total displays five decimals, focus/blur preserves raw Wei, and preview reveals exact amount');
    await modal.getByRole('button', { name: '返回修改', exact: true }).click();
    await page.getByLabel('矿机编号', { exact: true }).fill('16481'); // Clears automatic mode, not the saved exact fundraising amount.
    await page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
    await modal.waitFor();
    const latest = fixture.walletRequests.filter(item => item.method === 'eth_call' && item.params[0].data.startsWith(abi.PoolFactory.getFunction('createPool').selector)).at(-1);
    assert.equal(abi.PoolFactory.parseTransaction(latest.params[0]).args[0].targetRaise, 2200000000000000100n);
    checks.push('editing another field clears auto mode without rounding the retained exact fundraising value');
    await page.evaluate(account => window.ethereum.__emit('accountsChanged', [account]), FIXTURE_OTHER_ACCOUNT);
    await page.waitForURL(/#home$/);
    assert.equal(await page.getByRole('dialog', { name: '确认运营操作' }).count(), 0);
    assert.equal(fixture.controls.sentTransactions.length, 0);
    checks.push('account switch invalidates auto-filled creation preview without signing');
  } finally { await page.close(); }

  const manual = await preparePage();
  try {
    const funding = manual.page.getByLabel('募集总额（BNB）', { exact: true });
    assert.equal(await funding.getAttribute('placeholder'), '例如 0.005');
    await funding.fill('0.005494999999999900'); await funding.blur(); assert.equal(await funding.inputValue(), '≈ 0.00549');
    await funding.focus(); await manual.page.waitForFunction(() => document.activeElement?.value === '0.005494999999999900');
    await funding.fill('0.005495000000000100'); await funding.blur(); assert.equal(await funding.inputValue(), '≈ 0.00550');
    await manual.page.getByLabel('矿机编号', { exact: true }).fill('7');
    await manual.page.getByLabel('购机价格上限（BNB）', { exact: true }).fill('0.001234567890123456');
    await manual.page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
    await manual.page.getByRole('dialog', { name: '确认运营操作' }).waitFor();
    const latest = manual.fixture.walletRequests.filter(item => item.method === 'eth_call' && item.params[0].data.startsWith(abi.PoolFactory.getFunction('createPool').selector)).at(-1);
    const [params] = abi.PoolFactory.parseTransaction(latest.params[0]).args;
    assert.equal(params.targetRaise, 5495000000000100n); assert.equal(params.priceCap, 1234567890123456n);
    assert.equal(manual.fixture.controls.sentTransactions.length, 0);
    await manual.page.screenshot({ path: join(output, 'fundraising-five-decimals-manual.png'), animations: 'disabled' });
    checks.push('manual total displays five rounded decimals on blur but focus and unsigned calldata retain all 18 input decimals');
  } finally { await manual.page.close(); }

  const stale = await preparePage();
  try {
    await stale.select();
    stale.chain.listing.price += 1n;
    await stale.page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
    await stale.page.getByRole('alert').filter({ hasText: '最新报价或矿机条件已变化' }).waitFor();
    assert.equal(await stale.page.getByRole('dialog', { name: '确认运营操作' }).count(), 0);
    assert(!stale.fixture.walletRequests.some(item => item.method === 'eth_call' && item.params[0].data.startsWith(abi.PoolFactory.getFunction('createPool').selector)));
    assert.equal(stale.fixture.controls.sentTransactions.length, 0);
    checks.push('official listing repricing during preparation blocks unsigned preview and any send');
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
