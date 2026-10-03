/** Local fresh-v4 fixture only. Wallet methods and RPC stay in this process;
 * no real account permissions, signatures, relay posts or chain sends. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3218/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const out = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-wallet-session-browser');
await mkdir(out, { recursive: true });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const checks = [], errors = [], unexpected = [];
const deployer = '0x042B23288E2316DFb6503488292FD0Ad2F811Ae7';
let page, context;
function deferred() { let release, started; const began = new Promise(resolve => started = resolve);
  return { began, wait: () => { started(); return new Promise(resolve => release = resolve); }, release: () => release() }; }
async function began(hold, label) { let timeout; try { await Promise.race([hold.began,
  new Promise((_, reject) => timeout = setTimeout(() => reject(Error('No expected fixture read: ' + label)), 20000))]); }
  finally { clearTimeout(timeout); } }
const checked = message => { checks.push(message); console.log('PASS ' + message); };

async function setup() {
  await context?.close(); context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(25000); await page.clock.install();
  const f = freshAuthorityBrowserFixture();
  const state = { chain: '0x38', walletRequests: [], graphCalls: 0, graphHolds: [], walletHold: null, readHolds: [] };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(f.manifest) }));
  const rpc = async p => {
    const anchor = f.manifest.deployment;
    if (p.method === 'eth_getTransactionByHash' && p.params[0] === anchor.txHash) return { hash: anchor.txHash, from: deployer, chainId: '0x38', blockNumber: '0x5a', blockHash: anchor.blockHash };
    if (p.method === 'eth_getTransactionReceipt' && p.params[0] === anchor.txHash) return { transactionHash: anchor.txHash, from: deployer, status: '0x1', blockNumber: '0x5a', blockHash: anchor.blockHash };
    if (p.method === 'eth_getBlockByNumber' && p.params[0] === '0x5a') return { number: '0x5a', hash: anchor.blockHash, timestamp: '0x6b49d200' };
    if (p.method === 'eth_blockNumber') return '0x70';
    if (p.method === 'eth_call') {
      const row = f.f.base.rows.find(row => row.pool.toLowerCase() === p.params[0].to.toLowerCase());
      // Optional display quotes are out of scope here. Synthetic pools use a
      // nonofficial NFT so quote discovery stops without fixture RPC failures.
      if (row && abi.PoolVault.parseTransaction(p.params[0])?.name === 'params')
        return abi.PoolVault.encodeFunctionResult('params', [{ ...row.params,
          circuits: '0x000000000000000000000000000000000000CAFE' }]);
    }
    if (p.method === 'eth_call' && p.params[0].to.toLowerCase() === f.manifest.factory.toLowerCase()) {
      const name = abi.PoolFactory.parseTransaction(p.params[0])?.name;
      const index = state.readHolds.findIndex(item => item.name === name);
      if (index >= 0) { const [hold] = state.readHolds.splice(index, 1); await hold.wait(); }
    }
    return f.request(p);
  };
  await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
    try { const p = route.request().postDataJSON(); await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: p.id, result: await rpc(p) }) }); }
    catch (error) { unexpected.push(error.message); await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
  });
  await page.route(/\/api\/chain-index\//, route => route.fulfill({ contentType: 'application/json', body: json(f.index(route.request().url())) }));
  await page.route(/\/firsto-api\/v1\//, route => { const path = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: 'application/json', body: json(path.endsWith('/circuits') ? f.data.page : path.endsWith('/circuit-holders') ? f.data.referenceRaw : f.data.detail) }); });
  await page.route(/\/api\/journal\//, async route => {
    try {
      const request = route.request(); let body;
      if (request.url().endsWith('/product-graph')) { state.graphCalls++; body = f.graph(); await state.graphHolds.shift()?.wait(); }
      else { assert.equal(request.method(), 'GET', 'This browser regression cannot submit a journal operation'); body = await f.journal(request.url(), request.method(), null); }
      await route.fulfill({ contentType: 'application/json', body: json(body) });
    } catch (error) { unexpected.push(error.message); await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
  });
  await page.exposeFunction('__wallet', async p => {
    state.walletRequests.push(p.method);
    assert(!/sign|send|wallet_/i.test(p.method), 'Wallet regression cannot sign, send or switch chains');
    if (p.method === 'eth_accounts' && state.walletHold) { const hold = state.walletHold; state.walletHold = null; await hold.wait(); }
    if (p.method === 'eth_chainId') return state.chain;
    return rpc(p);
  });
  await page.addInitScript(() => {
    const listeners = new Map(); window.ethereum = { isMetaMask: true, request: p => window.__wallet(p),
      on(e, fn) { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e).add(fn); },
      removeListener(e, fn) { listeners.get(e)?.delete(fn); },
      __emit(e, value) { for (const fn of listeners.get(e) || []) fn(value); } };
  });
  await page.goto(base + '/#home');
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  return { f, state };
}
const walletLabel = () => page.locator('header .live-wallet-label').filter({ hasText: /0x[0-9a-f]/i });
const operatorNav = () => page.locator('nav').getByRole('button', { name: '运营工作台', exact: true });
async function connect() { await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click(); await walletLabel().waitFor(); }
async function overview() { await page.locator('nav').getByRole('button', { name: '资产总览', exact: true }).click();
  await page.locator('[data-asset-directory="unified"] tr').filter({ hasText: '多矿机项目' }).first().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-asset-directory]')?.getAttribute('aria-busy') === 'false'); }
async function noFalseDisconnect() { assert.equal(await walletLabel().count(), 1);
  assert(!/预算项目合约尚未完成部署验收|即将开放|项目尚未开放，等待部署核验/.test(await page.locator('body').innerText())); }
async function watchDisplay() {
  await page.evaluate(() => { window.__lostDisplays = []; window.__displayObserver?.disconnect();
    window.__displayObserver = new MutationObserver(() => {
      const text = document.body.innerText;
      if (/预算项目合约尚未完成部署验收|即将开放|项目尚未开放，等待部署核验/.test(text)) window.__lostDisplays.push('unverified deployment');
      if (!document.querySelector('header .live-wallet-label')?.textContent.match(/0x[0-9a-f]/i)) window.__lostDisplays.push('wallet label');
      if (location.hash === '#overview' && !document.querySelector('[data-asset-directory] tr[data-project-kind="portfolio"]')) {
        const rows = document.querySelectorAll('[data-asset-directory] tbody tr');
        if (![...rows].some(row => row.textContent.includes('多矿机项目'))) window.__lostDisplays.push('parent holdings');
      }
    }); window.__displayObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); });
}
async function noDisplayLoss() { assert.deepEqual(await page.evaluate(() => window.__lostDisplays), []); }
async function assertNoSigning(f, state) { assert.deepEqual(f.state.signatures, []); assert.deepEqual(f.state.posts, []);
  assert.deepEqual(f.state.userSends, []); assert(!state.walletRequests.some(method => /sign|send|wallet_/i.test(method))); }

try {
  let { f, state } = await setup(); await connect(); await operatorNav().waitFor(); await overview();
  const label = await walletLabel().innerText(); const initialRows = await page.locator('[data-asset-directory] tbody tr').count();
  await watchDisplay();
  await page.evaluate(account => { window.ethereum.__emit('accountsChanged', [account.toUpperCase()]);
    window.ethereum.__emit('chainChanged', '0x0038'); window.ethereum.__emit('chainChanged', '56');
    window.ethereum.__emit('connect', { chainId: '0x38' }); }, f.state.account);
  await page.clock.fastForward(1000); await noFalseDisconnect(); await noDisplayLoss();
  assert.equal(await walletLabel().innerText(), label); assert.equal(state.walletRequests.filter(v => v === 'eth_requestAccounts').length, 1);
  checked('same-account, equivalent chain and connect announcements retain wallet identity and visible unified holdings');

  const probe = deferred(); state.walletHold = probe;
  await page.evaluate(() => window.ethereum.__emit('disconnect', { code: 4900, message: 'temporary transport' })); await began(probe, 'transport accounts');
  await page.locator('[data-service-readiness="waiting"]').waitFor(); await noFalseDisconnect();
  const listingButtons = page.locator('[data-asset-directory]').getByRole('button', { name: /挂单 / });
  for (const button of await listingButtons.all()) assert.equal(await button.isDisabled(), true);
  assert.equal(await page.locator('[data-asset-directory] tbody tr').count(), initialRows);
  probe.release(); await operatorNav().waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-service-readiness="waiting"]'));
  await noFalseDisconnect(); await noDisplayLoss();
  assert.equal(state.walletRequests.filter(v => v === 'eth_requestAccounts').length, 1); await assertNoSigning(f, state);
  checked('transport recheck immediately blocks actions but preserves holdings, then restores the same identity using only eth_accounts/eth_chainId');

  f.state.operationalReady = false;
  const refresh = page.locator('.page-heading').getByRole('button', { name: '刷新', exact: true });
  await refresh.click(); await page.locator('[data-service-readiness="waiting"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-asset-directory]')?.getAttribute('aria-busy') === 'false');
  await noFalseDisconnect(); await noDisplayLoss(); assert.equal(await page.locator('[data-asset-directory] tbody tr').count(), initialRows);
  assert.equal(await walletLabel().innerText(), label); f.state.operationalReady = true;
  await page.clock.fastForward(16000); await page.waitForFunction(() => !document.querySelector('[data-service-readiness="waiting"]'));
  await noDisplayLoss(); await assertNoSigning(f, state);
  checked('manual graph-readiness change and automatic recovery preserve validated deployment, wallet and parent holdings without a false undeployed screen');
  await page.screenshot({ path: join(out, 'unified-holdings-recovered.png'), fullPage: true });
  await page.evaluate(() => window.__displayObserver.disconnect());

  await operatorNav().click(); const create = page.getByRole('button', { name: '预览创建矿池', exact: true });
  await create.waitFor(); await page.getByLabel('矿机编号', { exact: true }).fill('4460');
  await page.getByLabel('募集总额（BNB）', { exact: true }).fill('48.065');
  await page.getByLabel('购机价格上限（BNB）', { exact: true }).fill('43.695679475146443511');
  await create.click(); const confirmation = page.getByRole('dialog', { name: '确认运营操作', exact: true }); await confirmation.waitFor();
  const modalProbe = deferred(); state.walletHold = modalProbe;
  await page.evaluate(() => window.ethereum.__emit('disconnect', { code: 4900 })); await began(modalProbe, 'open preview transport accounts');
  await confirmation.waitFor({ state: 'detached' }); assert.equal(await walletLabel().count(), 1);
  modalProbe.release(); await create.waitFor(); await page.waitForFunction(() => !document.querySelector('[data-service-readiness="waiting"]'));
  assert.equal(await confirmation.count(), 0); await assertNoSigning(f, state);
  checked('a transport interruption revokes an already-open administrator preview; recovery cannot restore the old confirmation or sign it');

  await page.getByLabel('矿机编号', { exact: true }).fill('4460');
  await page.getByLabel('募集总额（BNB）', { exact: true }).fill('48.065');
  await page.getByLabel('购机价格上限（BNB）', { exact: true }).fill('43.695679475146443511');
  const lateRead = deferred(); state.readHolds.push({ name: 'creationPaused', ...lateRead });
  await create.click(); await began(lateRead, 'creationPaused');
  const lateProbe = deferred(); state.walletHold = lateProbe;
  await page.evaluate(() => window.ethereum.__emit('disconnect', { code: 4900 })); await began(lateProbe, 'pending preview transport accounts');
  lateRead.release(); lateProbe.release(); await create.waitFor(); await page.clock.fastForward(1500);
  assert.equal(await confirmation.count(), 0); await assertNoSigning(f, state);
  checked('a preview read resolving after transport invalidation cannot resurrect the previous wallet revision');

  f.state.account = f.ordinary;
  await page.evaluate(account => window.ethereum.__emit('accountsChanged', [account]), f.ordinary);
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).waitFor(); await page.waitForURL(/#home$/);
  assert.equal(await operatorNav().count(), 0); assert.equal(await confirmation.count(), 0); await assertNoSigning(f, state);
  checked('a real selected-account change clears former administrator identity and all confirmation state');

  ({ f, state } = await setup()); await connect(); state.chain = '0x1';
  await page.evaluate(() => window.ethereum.__emit('chainChanged', '0x1'));
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).waitFor(); await assertNoSigning(f, state);
  checked('a real chain change requires an explicit new connection and never switches network or sends automatically');

  ({ f, state } = await setup()); await connect();
  await page.evaluate(() => window.ethereum.__emit('accountsChanged', []));
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).waitFor(); await assertNoSigning(f, state);
  checked('wallet permission revocation/lock with an empty account list clears identity immediately');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  await writeFile(join(out, 'results.json'), json({ passed: true, checks, errors, unexpected })); console.log(json({ passed: true, checks, out }));
} catch (error) {
  await writeFile(join(out, 'failure.json'), json({ error: error.stack, checks, errors, unexpected, body: await page?.locator('body').innerText().catch(() => null) }));
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally { await context?.close(); await browser.close(); }
