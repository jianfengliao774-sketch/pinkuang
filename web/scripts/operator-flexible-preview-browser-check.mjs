/** Local fresh-v4 quotation -> flexible creation preview. No wallet signatures or transaction sends. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3216/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-flexible-preview');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const checks = [], errors = [], requests = [], wallets = [];
try {
  for (const mobile of [false, true]) {
    const f = freshAuthorityBrowserFixture();
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
    await page.route(/\/data\/frontend-manifest.v4.json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(f.manifest) }));
    const rpc = async input => {
      const anchor = f.manifest.deployment, deployer = '0x042B23288E2316DFb6503488292FD0Ad2F811Ae7';
      if (input.method === 'eth_getTransactionByHash' && input.params[0] === anchor.txHash)
        return { hash: anchor.txHash, from: deployer, chainId: '0x38', blockNumber: '0x5a', blockHash: anchor.blockHash };
      if (input.method === 'eth_getTransactionReceipt' && input.params[0] === anchor.txHash)
        return { transactionHash: anchor.txHash, from: deployer, status: '0x1', blockNumber: '0x5a', blockHash: anchor.blockHash };
      if (input.method === 'eth_getBlockByNumber' && input.params[0] === '0x5a')
        return { number: '0x5a', hash: anchor.blockHash, timestamp: '0x6b49d200' };
      if (input.method === 'eth_blockNumber') return '0x70';
      return f.request(input);
    };
    await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
      try {
        const input = route.request().postDataJSON();
        assert(!/sign|send|wallet_/i.test(input.method));
        await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: input.id, result: await rpc(input) }) });
      } catch (error) { requests.push(error.message); await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
    });
    await page.route(/\/api\/chain-index\//, route => route.fulfill({ contentType: 'application/json', body: json(f.index(route.request().url())) }));
    await page.route(/\/firsto-api\/v1\//, route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: 'application/json', body: json(path.endsWith('/circuits') ? f.data.page : path.endsWith('/circuit-holders') ? f.data.referenceRaw : f.data.detail) });
    });
    await page.route(/\/api\/journal\//, async route => {
      const request = route.request(); assert.equal(request.method(), 'GET', 'preview cannot mutate a journal or request a relay');
      await route.fulfill({ contentType: 'application/json', body: json(await f.journal(request.url(), request.method(), null)) });
    });
    await page.exposeFunction('__previewWallet', async input => {
      wallets.push(input.method); assert(!/sign|send|wallet_/i.test(input.method));
      assert(!['eth_call', 'eth_getCode', 'eth_getBlockByNumber'].includes(input.method), 'pure preview reads must use the public RPC');
      return rpc(input);
    });
    await page.addInitScript(() => { const listeners = new Map(); window.ethereum = { isMetaMask: true, request: p => window.__previewWallet(p),
      on(e, fn) { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e).add(fn); }, removeListener(e, fn) { listeners.get(e)?.delete(fn); } }; });
    await page.goto(base + '/#home');
    await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
    await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
    await page.locator('header .live-wallet-label').filter({ hasText: /0x[0-9a-f]/i }).waitFor();
    // Route navigation is read-only and avoids relying on the mobile drawer layout.
    await page.evaluate(() => { location.hash = 'operator'; });
    await page.getByRole('button', { name: '单台矿机灵活替代', exact: true }).click();
    await page.locator('.operator-quote-table').getByRole('button', { name: '链上核对并选择', exact: true }).click();
    await page.getByRole('button', { name: '填入建池表单', exact: true }).click();
    await page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认运营操作', exact: true }); await dialog.waitFor();
    assert.match(await dialog.innerText(), /16480/);
    assert.match(await dialog.innerText(), /createFlexiblePoolChecked/);
    assert(!/Use an exact bigint/.test(await page.locator('body').innerText()));
    assert.equal(f.state.signatures.length, 0); assert.equal(f.state.posts.length, 0); assert.equal(f.state.userSends.length, 0);
    assert(await dialog.getByRole('button', { name: '发送到钱包确认', exact: true }).isEnabled());
    await page.screenshot({ path: join(output, mobile ? 'mobile-flexible-preview.png' : 'desktop-flexible-preview.png'), fullPage: true });
    checks.push(`${mobile ? 'mobile' : 'desktop'}: select flexible mode, verify NFT/quote, fill exact plan, open unsigned review without wallet reads/signatures`);
    await dialog.getByRole('button', { name: '返回修改', exact: true }).click();
    await page.locator('.operator-import summary').click();
    const input = page.locator('.operator-import textarea');
    const draft = JSON.parse(await input.inputValue());
    assert.equal(typeof draft.flexible.extraBps, 'string'); assert.equal(typeof draft.flexible.referenceObservedAt, 'string');
    draft.flexible.extraBps = Number(draft.flexible.extraBps); draft.flexible.referenceObservedAt = Number(draft.flexible.referenceObservedAt);
    await input.fill(json(draft));
    await page.getByRole('button', { name: '预览创建矿池', exact: true }).click(); await dialog.waitFor();
    assert.equal(f.state.signatures.length, 0); assert.equal(f.state.posts.length, 0);
    checks.push(`${mobile ? 'mobile' : 'desktop'}: existing exported numeric metadata imports without converting exact Wei or sending any transaction`);
    await page.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  await writeFile(join(output, 'results.json'), json({ passed: true, checks, pageErrors: errors, fixtureErrors: requests, walletMethods: wallets, signatures: 0, sends: 0 }));
  console.log(json({ passed: true, checks, output }));
} catch (error) {
  await writeFile(join(output, 'failure.json'), json({ error: error.message, stack: error.stack, checks, pageErrors: errors, fixtureErrors: requests }));
  throw error;
} finally { await browser.close(); }
