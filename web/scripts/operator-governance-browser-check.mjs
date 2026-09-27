/** Local fixtures only: operator access, exact creation preview and governance request isolation. */
import assert from 'node:assert/strict';
import { installLiveFixture, FIXTURE_POOLS } from './live-browser-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const errors = [], checks = [];
try {
  const page = await browser.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  const ordinary = await installLiveFixture(page);
  await page.goto(base); await page.getByRole('button', { name: '连接钱包', exact: true }).click(); await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click(); await page.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  await page.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  assert.equal(await page.locator('nav').getByRole('button', { name: '运营工作台' }).count(), 0);
  await page.evaluate(() => { location.hash = 'operator'; });
  await page.getByText('此页面仅限授权运营人员', { exact: true }).waitFor();
  assert.equal(ordinary.controls.sentTransactions.length, 0); checks.push('non-operator cannot access creation even with a direct route');
  await page.close();

  const owner = await browser.newPage(); owner.setDefaultTimeout(8000); owner.on('pageerror', error => errors.push(error.message));
  const fixture = await installLiveFixture(owner, { isOperator: true });
  await owner.goto(base); await owner.getByRole('button', { name: '连接钱包', exact: true }).click(); await owner.getByRole('button', { name: '连接 MetaMask', exact: true }).click(); await owner.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  await owner.locator('nav').getByRole('button', { name: '运营工作台', exact: true }).click();
  await owner.getByLabel('矿机编号', { exact: true }).fill('7');
  await owner.getByLabel('募集总额（BNB）', { exact: true }).fill('0.0011');
  await owner.getByLabel('购机价格上限（BNB）', { exact: true }).fill('0.001');
  await owner.getByRole('button', { name: '预览创建矿池', exact: true }).click();
  await owner.getByRole('dialog', { name: '确认运营操作' }).waitFor();
  assert((await owner.getByRole('dialog').innerText()).includes('0.0 BNB + Gas'));
  assert.equal(fixture.controls.sentTransactions.length, 0);
  const previews = fixture.walletRequests.filter(p => p.method === 'eth_call' && p.params[0].data.startsWith(abi.PoolFactory.getFunction('createPool').selector));
  assert.equal(previews.length, 1);
  const params = abi.PoolFactory.parseTransaction(previews[0].params[0]).args[0];
  assert.equal(params.targetRaise, 1000000000000000n); assert.equal(params.priceCap, 1000000000000000n);
  await owner.evaluate(() => window.ethereum.__emit('accountsChanged', ['0x0000000000000000000000000000000000000009']));
  await owner.getByText('此页面仅限授权运营人员', { exact: true }).waitFor();
  assert.equal(await owner.getByRole('dialog', { name: '确认运营操作' }).count(), 0);
  checks.push('operator creation shows exact zero-value unsigned preview; wallet switch invalidates it');
  await owner.close();

  const race = await browser.newPage(); race.setDefaultTimeout(8000); race.on('pageerror', error => errors.push(error.message));
  let release, entered; const delayed = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  await installLiveFixture(race, { beforeRpc: async payload => {
    if (payload.method === 'eth_call' && payload.params[0].to.toLowerCase() === FIXTURE_POOLS.voting.toLowerCase()
      && payload.params[0].data.startsWith(abi.PoolVault.getFunction('activeProposalId').selector)) { entered(); await delayed; }
  } });
  const open = async pool => { await race.evaluate(value => { location.hash = `detail/${value}`; }, pool);
    await race.waitForFunction(expected => document.querySelector('main')?.dataset.readyRoute === `detail/${expected}`, pool);
    await race.getByRole('button', { name: '共同决策', exact: true }).last().click(); };
  await race.goto(base); await race.getByRole('button', { name: '连接钱包', exact: true }).click(); await race.getByRole('button', { name: '连接 MetaMask', exact: true }).click(); await race.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  await open(FIXTURE_POOLS.voting); await started;
  await open(FIXTURE_POOLS.active);
  await race.getByText('发起新一轮出售提案', { exact: true }).waitFor();
  release();
  await race.waitForFunction(() => document.querySelector('.live-gov-selector input')?.value.endsWith('0102'));
  assert.equal(await race.getByText('提案 #1', { exact: true }).count(), 0);
  assert.equal(await race.locator('.live-gov-grid article').count(), 0);
  checks.push('delayed governance result for pool A cannot overwrite selected pool B');
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: checks.length, checks }));
} finally { await browser.close(); }
