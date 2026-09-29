/** Local, read-only fixtures. No real wallet, signatures or transactions are used. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installLiveFixture, FIXTURE_ACCOUNT, FIXTURE_OTHER_ACCOUNT, FIXTURE_CONTRACTS } from './live-browser-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3109';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-operator-access-check');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const checks = [], errors = [], fixtures = [];
const selector = abi.PoolFactory.getFunction('operator').selector;
async function open({ isOperator = false, deferred = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const fixture = await installLiveFixture(page, { isOperator }); fixtures.push(fixture);
  await page.goto(`${base.replace(/\/$/, '')}/#operator`);
  await page.waitForURL(/#home$/);
  await page.evaluate(({ selector, account, deferred }) => {
    const original = window.ethereum.request.bind(window.ethereum);
    window.__operatorMode = deferred ? 'defer' : 'normal';
    window.__operatorReads = 0;
    window.__operatorRelease = null;
    window.ethereum.request = async input => {
      if (input.method === 'eth_call' && input.params[0].data.startsWith(selector)) {
        window.__operatorReads++;
        if (window.__operatorMode === 'reject') throw new Error('Read-only fixture permission lookup failed');
        if (window.__operatorMode === 'defer') await new Promise(resolve => { window.__operatorRelease = resolve; });
      }
      return original(input);
    };
    const events = new Map();
    const other = { isOkxWallet: true,
      async request(input) {
        if (input.method === 'eth_requestAccounts' || input.method === 'eth_accounts') return [account];
        if (input.method === 'eth_call' && input.params[0].data.startsWith(selector)) {
          window.__otherOperatorStarted = true;
          await new Promise(resolve => { window.__otherOperatorRelease = resolve; });
        }
        if (/sign|send|wallet_/i.test(input.method)) throw new Error('No writes in operator access fixture');
        return original(input);
      },
      on(event, listener) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(listener); },
      removeListener(event, listener) { events.get(event)?.delete(listener); },
    };
    window.okxwallet = other;
  }, { selector, account: FIXTURE_ACCOUNT, deferred });
  return { page, fixture };
}
async function connect(page) {
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  await page.evaluate(() => { location.hash = 'operator'; });
}
async function hidden(page, state) {
  if (['disconnected', 'denied'].includes(state)) await page.waitForURL(/#home$/);
  else await page.locator(`[data-operator-access="${state}"]`).waitFor();
  assert.equal(await page.locator('nav').getByRole('button', { name: '运营工作台', exact: true }).count(), 0);
  assert.equal(await page.locator('.live-operator, .operator-identity, .operator-grid, .operator-import, .operator-confirm').count(), 0);
  assert.equal(await page.locator('.deployment-console-link').count(), 0);
  assert.equal(await page.getByRole('button', { name: '创建首个项目', exact: true }).count(), 0);
  const text = await page.locator('main').innerText();
  assert(!text.includes(FIXTURE_CONTRACTS.factory) && !text.includes(FIXTURE_OTHER_ACCOUNT) && !text.includes('Factory'));
}
async function verified(page) {
  await page.locator('nav').getByRole('button', { name: '运营工作台', exact: true }).waitFor();
  await page.getByLabel('矿机编号', { exact: true }).waitFor();
  assert((await page.locator('.operator-identity').innerText()).includes(FIXTURE_ACCOUNT));
}

try {
  const guest = await open();
  await hidden(guest.page, 'disconnected');
  assert.equal(await guest.page.getByText('此页面仅限授权运营人员', { exact: true }).count(), 0);
  assert.equal(guest.fixture.walletRequests.filter(row => row.method === 'eth_requestAccounts').length, 0);
  await guest.page.screenshot({ path: join(output, 'operator-disconnected.png'), animations: 'disabled' });
  checks.push('unconnected direct #operator route returns home without a false access-denied message');
  await connect(guest.page); await hidden(guest.page, 'denied');
  assert.equal(await guest.page.getByText('此页面仅限授权运营人员', { exact: true }).count(), 0);
  assert.equal(await guest.page.locator('.live-operator').count(), 0);
  checks.push('a connected non-operator is returned to the home page after on-chain permission lookup');
  await guest.page.close();

  const owner = await open({ isOperator: true, deferred: true });
  await connect(owner.page);
  await owner.page.waitForFunction(() => !!window.__operatorRelease);
  await hidden(owner.page, 'checking');
  await owner.page.evaluate(() => { window.__operatorMode = 'normal'; window.__operatorRelease(); });
  await verified(owner.page);
  checks.push('operator menu and form appear only after the current provider/account verification completes');
  await owner.page.evaluate(() => { window.__operatorMode = 'defer'; window.__operatorRelease = null; });
  await owner.page.getByRole('button', { name: '刷新权限', exact: true }).click();
  await owner.page.waitForFunction(() => !!window.__operatorRelease);
  await hidden(owner.page, 'checking');
  await owner.page.evaluate(() => { window.__operatorMode = 'normal'; window.__operatorRelease(); });
  await verified(owner.page);
  checks.push('refresh invalidates verified permissions while the new read is pending');
  await owner.page.evaluate(() => { window.__operatorMode = 'reject'; });
  await owner.page.getByRole('button', { name: '刷新权限', exact: true }).click();
  await hidden(owner.page, 'unavailable');
  await owner.page.screenshot({ path: join(output, 'operator-permission-failed.png'), animations: 'disabled' });
  checks.push('permission RPC failure removes all operator content and does not reuse the prior successful result');
  await owner.page.evaluate(() => { window.__operatorMode = 'normal'; });
  await owner.page.getByRole('button', { name: '重新核对权限', exact: true }).click();
  await verified(owner.page);
  await owner.page.evaluate(other => window.ethereum.__emit('accountsChanged', [other]), FIXTURE_OTHER_ACCOUNT);
  await hidden(owner.page, 'disconnected');
  checks.push('account changes immediately remove the verified operator form and navigation');
  await owner.page.close();

  const late = await open({ isOperator: true, deferred: true });
  await connect(late.page); await late.page.waitForFunction(() => !!window.__operatorRelease);
  await late.page.evaluate(() => window.ethereum.__emit('disconnect', { code: 4900 }));
  await hidden(late.page, 'disconnected');
  await late.page.evaluate(() => { window.__operatorMode = 'normal'; window.__operatorRelease(); });
  await late.page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  await hidden(late.page, 'disconnected');
  checks.push('a delayed successful operator lookup cannot restore access after the wallet disconnects');
  await late.page.close();

  const switched = await open({ isOperator: true });
  await connect(switched.page); await verified(switched.page);
  await switched.page.locator('header button').filter({ hasText: /0x/ }).click();
  await switched.page.getByRole('button', { name: '切换钱包', exact: true }).click();
  await switched.page.getByRole('button', { name: '连接 OKX Wallet', exact: true }).click();
  await switched.page.waitForFunction(() => window.__otherOperatorStarted === true);
  await hidden(switched.page, 'checking');
  await switched.page.evaluate(() => window.__otherOperatorRelease());
  await verified(switched.page);
  checks.push('switching provider with the same account still requires a new permission verification');
  await switched.page.close();

  for (const fixture of fixtures) {
    assert.equal(fixture.controls.sentTransactions.length, 0);
    assert(!fixture.walletRequests.some(row => /sign|send/i.test(row.method)));
  }
  assert.deepEqual(errors, []);
  const report = { passed: checks.length, checks, errors, output, scope: 'local read-only wallet fixtures; no real wallet or chain writes' };
  await writeFile(join(output, 'operator-access-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
