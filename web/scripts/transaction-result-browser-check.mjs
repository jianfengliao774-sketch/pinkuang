/** Synthetic localhost-only wallet/receipt regression. Never sends to a chain. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3230/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Fixture must remain localhost only');
const out = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-transaction-result-browser');
await mkdir(out, { recursive: true });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const hash = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const checks = [], errors = [], unexpected = [];
const checked = message => { checks.push(message); console.log('PASS ' + message); };
let context, page;

async function setup(sequence) {
  await context?.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(25000);
  const f = freshAuthorityBrowserFixture();
  const state = { receipt: 'pending', hash: hash(7000 + sequence), sends: [], walletRequests: [], receiptReads: 0, reject: false };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(f.manifest) }));
  const rpc = async p => {
    assert(!/send|sign|wallet_/i.test(p.method), 'Public fixture RPC cannot write or sign');
    const anchor = f.manifest.deployment;
    if (p.method === 'eth_getTransactionByHash' && p.params[0] === anchor.txHash)
      return { hash: anchor.txHash, from: '0x042B23288E2316DFb6503488292FD0Ad2F811Ae7', chainId: '0x38', blockNumber: '0x5a', blockHash: anchor.blockHash };
    if (p.method === 'eth_getTransactionReceipt' && p.params[0] === anchor.txHash)
      return { transactionHash: anchor.txHash, from: '0x042B23288E2316DFb6503488292FD0Ad2F811Ae7', status: '0x1', blockNumber: '0x5a', blockHash: anchor.blockHash };
    if (p.method === 'eth_getTransactionReceipt' && p.params[0] === state.hash) {
      state.receiptReads++;
      if (state.receipt === 'pending') return null;
      if (state.receipt === 'network-error') throw Object.assign(Error('Fixture temporary RPC read error'), { code: -32005, expected: true });
      return { transactionHash: state.hash, from: state.receipt === 'mismatch' ? f.ordinary : f.state.account,
        to: f.manifest.shareMarket, status: state.receipt === 'failed' ? '0x0' : '0x1', blockNumber: '0x64',
        blockHash: state.receipt === 'noncanonical' ? hash(99999) : hash(100) };
    }
    if (p.method === 'eth_getBlockByNumber' && p.params[0] === '0x5a')
      return { number: '0x5a', hash: anchor.blockHash, timestamp: '0x6b49d200' };
    if (p.method === 'eth_blockNumber') return '0x70';
    if (p.method === 'eth_call') {
      const row = f.f.base.rows.find(row => same(row.pool, p.params[0].to));
      if (row && abi.PoolVault.parseTransaction(p.params[0])?.name === 'params')
        return abi.PoolVault.encodeFunctionResult('params', [{ ...row.params, circuits: '0x000000000000000000000000000000000000CAFE' }]);
    }
    return f.request(p);
  };
  await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
    const p = route.request().postDataJSON();
    try { await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: p.id, result: await rpc(p) }) }); }
    catch (error) {
      if (!error.expected) unexpected.push(error.message);
      await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: p.id, error: { code: error.code || -32603, message: error.message } }) });
    }
  });
  await page.route(/\/api\/chain-index\//, async route => {
    if (new URL(route.request().url()).pathname.includes('/v1/display/'))
      return route.fulfill({ status: 404, contentType: 'application/json', body: json({ error: 'Fixture uses raw indexed display fallback' }) });
    try { await route.fulfill({ contentType: 'application/json', body: json(f.index(route.request().url())) }); }
    catch (error) { unexpected.push(error.message); await route.fulfill({ status: 400, body: json({ error: error.message }) }); }
  });
  await page.route(/\/firsto-api\/v1\//, route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: 'application/json', body: json(path.endsWith('/circuits') ? f.data.page : path.endsWith('/circuit-holders') ? f.data.referenceRaw : f.data.detail) });
  });
  await page.route(/\/api\/journal\//, async route => {
    try { const request = route.request(); assert.equal(request.method(), 'GET', 'Fixture forbids journal mutations');
      await route.fulfill({ contentType: 'application/json', body: json(await f.journal(request.url(), request.method(), null)) }); }
    catch (error) { unexpected.push(error.message); await route.fulfill({ status: 400, body: json({ error: error.message }) }); }
  });
  await page.exposeFunction('__resultWallet', async p => {
    state.walletRequests.push(p.method);
    if (p.method === 'eth_sendTransaction') {
      const tx = p.params[0], call = abi.ShareMarket.parseTransaction(tx);
      assert(same(tx.from, f.signer.address) && same(tx.to, f.manifest.shareMarket), 'Only the synthetic fixture account/market may be used');
      assert.equal(call.name, 'cancel'); assert.equal(call.args[0], 2n); assert.equal(BigInt(tx.value), 0n);
      assert.equal(tx.chainId, '0x38'); assert(BigInt(tx.gas) > 0n);
      if (state.reject) return { error: { code: 4001, message: 'User rejected synthetic wallet request' } };
      state.sends.push(tx); return { result: state.hash };
    }
    assert(!/send|sign|wallet_/i.test(p.method), 'All other wallet writes and signatures are forbidden');
    return { result: await rpc(p) };
  });
  await page.addInitScript(() => {
    const listeners = new Map();
    window.ethereum = { isMetaMask: true,
      async request(p) { const reply = await window.__resultWallet(p);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
        return reply.result; },
      on(e, fn) { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e).add(fn); },
      removeListener(e, fn) { listeners.get(e)?.delete(fn); },
    };
    window.__resultsSeen = []; let previous = null;
    const watch = () => {
      const current = document.querySelector('.transaction-result-dialog h2')?.textContent || null;
      if (current && current !== previous) window.__resultsSeen.push(current);
      previous = current;
    };
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(watch)
      .observe(document.body, { subtree: true, childList: true, characterData: true }));
  });
  await page.goto(base + '/#home');
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  await connect();
  await page.locator('nav').getByRole('button', { name: '矿机转让', exact: true }).click();
  await page.getByRole('button', { name: '撤单', exact: true }).waitFor();
  return { f, state };
}

const results = () => page.locator('.transaction-result-dialog');
const walletLabel = () => page.locator('header .live-wallet-label').filter({ hasText: /0x[0-9a-f]/i });
async function connect() {
  if (await walletLabel().count()) return;
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click(); await walletLabel().waitFor();
}
async function sendCancellation() {
  await page.getByRole('button', { name: '撤单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '撤销挂单', exact: true }); await dialog.waitFor();
  await dialog.getByRole('button', { name: '核对交易金额', exact: true }).click();
  await dialog.getByRole('button', { name: '确认并前往钱包', exact: true }).click();
}
async function receiptTick(state) {
  const before = state.receiptReads;
  const deadline = Date.now() + 12000;
  while (state.receiptReads <= before && Date.now() < deadline) await page.waitForTimeout(80);
  assert(state.receiptReads > before, 'Expected a background receipt read');
  await page.waitForTimeout(300);
}
async function noPopup() { assert.equal(await results().count(), 0); }
async function noWrites(f, state) {
  assert.deepEqual(f.state.signatures, []); assert.deepEqual(f.state.posts, []); assert.deepEqual(f.state.userSends, []);
  assert(!state.walletRequests.some(method => /sign|wallet_/i.test(method)));
}

try {
  let { f, state } = await setup(1); await sendCancellation();
  const pendingButton = page.getByRole('button', { name: '撤单处理中…', exact: true }); await pendingButton.waitFor();
  assert.equal(await pendingButton.isDisabled(), true); await noPopup(); assert.equal(state.sends.length, 1);
  const saved = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('bemine-member-transactions:')).flatMap(([, value]) => JSON.parse(value)));
  assert.equal(saved[0].data, abi.ShareMarket.encodeFunctionData('cancel', [2n]));
  checked('broadcast retains calldata and displays a disabled pending order without a success popup');
  for (const mode of ['network-error', 'mismatch', 'noncanonical']) {
    state.receipt = mode; await receiptTick(state); await noPopup(); assert.equal(state.sends.length, 1);
    assert.equal(await pendingButton.isDisabled(), true);
  }
  checked('RPC read failure, wrong account receipt and noncanonical block never report failure/success or resend');
  state.receipt = 'confirmed'; await results().filter({ hasText: '交易成功' }).waitFor();
  assert.equal(await results().getByRole('link', { name: '查看链上交易' }).getAttribute('href'), `https://bscscan.com/tx/${state.hash}`);
  await page.getByRole('button', { name: '知道了', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '知道了');
  await page.screenshot({ path: join(out, 'cancel-confirmed.png'), fullPage: true });
  await results().getByRole('button', { name: '知道了', exact: true }).click(); await noPopup();
  assert.equal(await page.getByRole('button', { name: '撤单', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '买入份额', exact: true }).count(), 1);
  assert.deepEqual(await page.evaluate(() => window.__resultsSeen), ['交易成功']);
  await page.locator('.page-heading').getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForTimeout(2400); await noPopup(); assert.equal(state.sends.length, 1);
  await page.reload(); await connect();
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  await page.waitForTimeout(2400); await noPopup(); assert.deepEqual(await page.evaluate(() => window.__resultsSeen), []);
  await noWrites(f, state);
  checked('a matched success opens one exact-hash popup, hides only the cancelled order and never reopens on refresh/history restoration');

  ({ f, state } = await setup(2)); await sendCancellation(); state.receipt = 'failed';
  await results().filter({ hasText: '交易失败' }).waitFor();
  assert.equal(await results().getByRole('link', { name: '查看链上交易' }).getAttribute('href'), `https://bscscan.com/tx/${state.hash}`);
  assert((await results().innerText()).includes('合约执行已回滚'));
  await page.screenshot({ path: join(out, 'cancel-reverted.png'), fullPage: true });
  await page.keyboard.press('Escape'); await noPopup();
  const retry = page.getByRole('button', { name: '撤单', exact: true }); await retry.waitFor();
  assert.equal(await retry.isDisabled(), false); assert.equal(state.sends.length, 1);
  await page.waitForTimeout(2400); await noPopup(); await noWrites(f, state);
  checked('a matched reverted receipt reports a failure with its hash, preserves the order and restores the manual cancellation action');

  ({ f, state } = await setup(3)); state.reject = true; await sendCancellation();
  await results().filter({ hasText: '交易已取消' }).waitFor(); assert.equal(await results().getByRole('link').count(), 0);
  assert.equal(state.sends.length, 0); assert.equal(await page.getByRole('dialog').count(), 1);
  await page.screenshot({ path: join(out, 'cancel-wallet-rejected.png'), fullPage: true });
  await results().getByRole('button', { name: '知道了', exact: true }).click(); await noPopup();
  await page.getByRole('dialog', { name: '撤销挂单', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '撤单处理中…', exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__resultsSeen), ['交易已取消']);
  await noWrites(f, state);
  checked('wallet 4001 opens one cancellation result without a hash link or pending order and returns to the review after acknowledgement');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  await writeFile(join(out, 'results.json'), json({ passed: true, checks, errors, unexpected }));
  console.log(json({ passed: true, checks, out }));
} catch (error) {
  await writeFile(join(out, 'failure.json'), json({ error: error.stack, checks, errors, unexpected,
    body: await page?.locator('body').innerText().catch(() => null) }));
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally { await context?.close(); await browser.close(); }
