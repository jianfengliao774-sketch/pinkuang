/** Offline wallet selection tests. No real wallet, signature or chain transaction. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installLiveFixture, FIXTURE_OTHER_ACCOUNT } from './live-browser-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const output = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-wallet-check');
await mkdir(output, { recursive: true });
const checks = [], errors = [];
async function twoWallets(page) {
  await page.evaluate(other => {
    window.__walletCalls = []; window.__walletMode = 'normal';
    const meta = window.ethereum, request = meta.request.bind(meta), events = new Map();
    meta.request = async payload => { window.__walletCalls.push({ wallet: 'MetaMask', method: payload.method }); return request(payload); };
    const okx = { isOkxWallet: true, isMetaMask: true,
      async request(payload) {
        window.__walletCalls.push({ wallet: 'OKX', method: payload.method });
        if (payload.method === 'eth_requestAccounts') {
          if (window.__walletMode === 'reject' || window.__walletMode === 'already-pending') {
            const error = new Error('Test wallet response'); error.code = window.__walletMode === 'reject' ? 4001 : -32002; throw error;
          }
          if (window.__walletMode === 'deferred') await new Promise(resolve => { window.__releaseWallet = resolve; });
          return [other];
        }
        if (payload.method === 'eth_accounts') return [other];
        if (payload.method === 'eth_chainId') return '0x38';
        if (/sign|send|wallet_/i.test(payload.method)) throw new Error('No writes in wallet selection fixture');
        return request(payload);
      },
      on(event, listener) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(listener); return okx; },
      removeListener(event, listener) { events.get(event)?.delete(listener); },
      __emit(event, value) { for (const listener of events.get(event) || []) listener(value); },
    };
    window.okxwallet = okx;
    const announce = () => {
      for (const [provider, uuid, name, rdns] of [[meta, '639134c8-01bc-43e7-8003-887da433a6cb', 'MetaMask', 'io.metamask'],
        [okx, 'd8309d1f-cb04-4832-92e6-88adf0b5a22c', 'OKX Wallet', 'com.okex.wallet']])
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { provider, info: {
          uuid, name, rdns, icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E',
        } } }));
    };
    window.addEventListener('eip6963:requestProvider', announce); announce();
  }, FIXTURE_OTHER_ACCOUNT);
}
async function newPage(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  const fixture = await installLiveFixture(page, options);
  await page.goto(base); await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).waitFor();
  await twoWallets(page);
  return { page, fixture };
}
try {
  const { page, fixture } = await newPage();
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 OKX Wallet', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '连接 MetaMask', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => window.__walletCalls.filter(x => x.method === 'eth_requestAccounts').length), 0);
  await page.screenshot({ path: join(output, 'wallet-desktop.png'), animations: 'disabled' });
  await page.evaluate(() => { window.__walletMode = 'deferred'; });
  await page.getByRole('button', { name: '连接 OKX Wallet', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByText('请打开所选钱包，确认连接或网络切换请求。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__walletCalls.filter(x => x.method === 'eth_requestAccounts').length), 1);
  assert(await page.getByRole('button', { name: '连接 MetaMask', exact: true }).isDisabled());
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByText('请打开所选钱包，确认连接或网络切换请求。', { exact: true }).waitFor();
  await page.evaluate(() => window.__releaseWallet());
  await page.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  const permissions = await page.evaluate(() => window.__walletCalls.filter(x => x.method === 'eth_requestAccounts'));
  assert.deepEqual(permissions, [{ wallet: 'OKX', method: 'eth_requestAccounts' }]);
  await page.evaluate(() => window.ethereum.__emit('accountsChanged', []));
  assert.equal(await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).count(), 0);
  await page.evaluate(() => window.okxwallet.__emit('accountsChanged', []));
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).waitFor();
  assert.equal(fixture.controls.sentTransactions.length, 0);
  checks.push('two wallets are listed; chosen provider only, one request, pending reopen and exact provider event binding');
  await page.close();

  for (const mode of ['reject', 'already-pending', 'cancelled']) {
    const { page } = await newPage();
    await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
    await page.evaluate(mode => { window.__walletMode = mode === 'cancelled' ? 'deferred' : mode; }, mode);
    await page.getByRole('button', { name: '连接 OKX Wallet', exact: true }).click();
    if (mode === 'cancelled') {
      await page.getByText('请打开所选钱包，确认连接或网络切换请求。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      await page.evaluate(() => window.__releaseWallet());
      await page.waitForFunction(() => !document.querySelector('header .btn')?.disabled);
      assert.equal(await page.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).count(), 0);
    } else {
      await page.getByRole('alert').filter({ hasText: mode === 'reject' ? '取消了钱包授权' : '已有一个请求' }).waitFor();
      assert(await page.getByRole('button', { name: '连接 OKX Wallet', exact: true }).isEnabled());
    }
    assert.equal(await page.evaluate(() => window.__walletCalls.filter(x => x.method === 'eth_requestAccounts').length), 1);
    checks.push(`${mode}: no automatic second permission request or stale connection`); await page.close();
  }

  let releaseBoot;
  const bootGate = new Promise(resolve => { releaseBoot = resolve; });
  const duringBoot = await newPage({ beforeRpc: () => bootGate });
  await duringBoot.page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await duringBoot.page.getByRole('button', { name: '连接 OKX Wallet', exact: true }).click();
  await duringBoot.page.getByText('钱包已连接。发送交易前会请你确认。', { exact: true }).waitFor();
  releaseBoot();
  await duringBoot.page.getByText('数据区块 100', { exact: true }).waitFor();
  assert.equal(await duringBoot.page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).count(), 0);
  checks.push('connecting during deployment verification remains bound when the read-only load starts');
  await duringBoot.page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.route(/\/data\/frontend-manifest\.json(?:\?.*)?$/, route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await mobile.goto(base);
  await mobile.locator('.live-service-note strong').getByText('项目尚未开放，等待部署核验', { exact: true }).waitFor();
  await mobile.getByRole('button', { name: '连接钱包', exact: true }).click();
  await mobile.getByText('尚未检测到钱包', { exact: true }).waitFor();
  // Local HTTP URLs must not be put into mobile dapp links. HTTPS formats are verified in the unit test.
  await mobile.getByRole('link', { name: 'MetaMask · 官方网站', exact: true }).waitFor();
  assert.equal(await mobile.locator('.wallet-catalog a').count(), 7);
  await mobile.getByRole('button', { name: '复制当前网址', exact: true }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await mobile.screenshot({ path: join(output, 'wallet-mobile.png'), animations: 'disabled' });
  checks.push('mobile browser without injection shows seven wallet icons and copy URL, no fake QR connection');
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, output }));
} finally { await browser.close(); }
