/** Actual local workbench, synthetic read-only transport and a held fake wallet.
 * No signature is produced, relay POST made, external RPC used, or chain send issued. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3224/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = process.env.BEMINE_BROWSER_OUTPUT || '/tmp/bemine-operator-speed-browser';
const suppliedManifest = process.env.BEMINE_TEST_MANIFEST
  ? JSON.parse(await readFile(process.env.BEMINE_TEST_MANIFEST, 'utf8')) : null;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
const checks = [], errors = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20000);
  const fixture = freshAuthorityBrowserFixture(), manifest = suppliedManifest || fixture.manifest;
  const state = { nonceReads: 0, holdRpc: false, rpc: [], wallet: [], prompts: [] };
  // A public administrator address is only a fake local provider identity; the
  // wallet request is held forever and never produces any signature.
  if (suppliedManifest) fixture.state.account = suppliedManifest.freshAuthority.administratorOne;
  const manifestAddressMap = new Map(Object.entries(fixture.manifest)
    .filter(([key, value]) => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value)
      && /^0x[\da-f]{40}$/i.test(manifest[key] ?? ''))
    .map(([key, value]) => [value.toLowerCase(), manifest[key]]));
  const remapFixture = value => JSON.parse(JSON.stringify(value, (_, item) =>
    typeof item === 'string' ? manifestAddressMap.get(item.toLowerCase()) || item : item));
  page.on('pageerror', problem => errors.push(problem.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  await page.route(/\/data\/frontend-manifest(?:\.v[45])?\.json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(manifest) }));
  await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
    const request = route.request().postDataJSON();
    state.rpc.push(request);
    if (state.holdRpc) return; // After warming, every new read deliberately hangs.
    if (request.method === 'eth_call' && request.params[0].to.toLowerCase() === manifest.authority.toLowerCase()
      && abi.PlatformAuthority.parseTransaction(request.params[0])?.name === 'nonces') {
      state.nonceReads++;
      return route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: request.id,
        result: abi.PlatformAuthority.encodeFunctionResult('nonces', [0n]) }) });
    }
    try { await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: request.id, result: await fixture.request(request) }) }); }
    catch { await route.fulfill({ status: 503, contentType: 'application/json', body: json({ error: 'Offline optional display read unavailable' }) }); }
  });
  await page.route(/\/api\/chain-index\//, route => {
    try {
      const result = remapFixture(fixture.index(route.request().url().replace('/v1/display/', '/v1/')));
      result.source = { ...result.source, displayOnly: true, transactionReady: false };
      return route.fulfill({ contentType: 'application/json', body: json(result) });
    } catch { return route.fulfill({ status: 503, contentType: 'application/json', body: json({ error: 'Offline optional index unavailable' }) }); }
  });
  await page.route(/\/firsto-api\/v1\//, route => route.fulfill({ contentType: 'application/json', body: json(fixture.data.detail) }));
  await page.route(/\/api\/journal\//, async route => {
    assert.equal(route.request().method(), 'GET', 'The held fake wallet must prevent every journal mutation.');
    try {
      let result = await fixture.journal(route.request().url(), 'GET', null);
      if (route.request().url().endsWith('/product-graph') && suppliedManifest)
        result = { ...remapFixture(result), manifest, freshAuthority: { ...result.freshAuthority, ...manifest.freshAuthority } };
      await route.fulfill({ contentType: 'application/json', body: json(result) });
    }
    catch { await route.fulfill({ status: 503, contentType: 'application/json', body: json({ error: 'Offline optional journal read unavailable' }) }); }
  });
  await page.exposeFunction('__operatorWallet', async request => {
    state.wallet.push(request.method);
    assert(!/send|estimate|wallet_/i.test(request.method), 'No wallet simulation, switching or send may happen.');
    if (request.method === 'eth_signTypedData_v4') {
      state.prompts.push(request); return new Promise(() => {}); // No real or fixture signature is generated.
    }
    assert(['eth_accounts', 'eth_requestAccounts', 'eth_chainId'].includes(request.method));
    return request.method === 'eth_chainId' ? '0x38' : [fixture.state.account];
  });
  await page.addInitScript(() => {
    const listeners = new Map(); window.__operatorTiming = {};
    window.ethereum = { isMetaMask: true,
      request(request) {
        if (request.method === 'eth_signTypedData_v4') window.__operatorTiming.promptAt = performance.now();
        return window.__operatorWallet(request);
      },
      on(event, callback) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); },
      removeListener(event, callback) { listeners.get(event)?.delete(callback); } };
    document.addEventListener('click', event => {
      if (event.target.closest('button')?.textContent.includes('发送到钱包确认'))
        window.__operatorTiming.clickedAt = performance.now();
    }, true);
  });
  await page.goto(base + '/#home');
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: '运营工作台', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.operator-grid'));
  await assertEventually(() => state.nonceReads === 1, 'Workbench nonce prefetch');
  state.holdRpc = true;
  const readCount = state.rpc.length;
  await page.locator('.operator-grid label').filter({ hasText: /^矿机编号/ }).locator('input').fill('7223');
  await page.locator('.operator-grid label').filter({ hasText: /^募集总额（BNB）/ }).locator('input').fill('0.005');
  await page.locator('.operator-grid label').filter({ hasText: /^购机价格上限（BNB）/ }).locator('input').fill('0.004');
  await page.getByRole('button', { name: '预览创建矿池', exact: true }).click();
  const review = page.getByRole('dialog', { name: '核对后前往钱包', exact: true }); await review.waitFor();
  assert.equal(state.nonceReads, 1, 'Preview reuses workbench prefetch even with a hung new-read transport.');
  assert.equal(state.rpc.length, readCount, 'Preview performs no new RPC after the workbench warmup.');
  checks.push('Entering the workbench prefetches one nonce; preview performs zero new nonce or reservation reads.');
  const before = state.wallet.length;
  await review.getByRole('button', { name: '发送到钱包确认', exact: true }).click();
  await assertEventually(() => state.prompts.length === 1, 'Immediate fake wallet prompt');
  const timing = await page.evaluate(() => window.__operatorTiming);
  const promptMs = timing.promptAt - timing.clickedAt;
  assert(promptMs >= 0 && promptMs < 100, `Local click-to-wallet dispatch: ${promptMs} ms`);
  assert.deepEqual(state.wallet.slice(before), ['eth_signTypedData_v4']); assert.equal(state.nonceReads, 1);
  assert.equal(state.rpc.length, readCount, 'Confirmation dispatches the wallet before every read RPC.');
  const typed = JSON.parse(state.prompts[0].params[1]);
  assert.equal(typed.message.params.circuitId, '7223'); assert.equal(typed.message.params.targetRaise, '5000000000000000');
  assert.equal(typed.message.params.priceCap, '4000000000000000');
  assert.equal(typed.domain.verifyingContract.toLowerCase(), manifest.authority.toLowerCase());
  checks.push(`Actual confirmation dispatches one exact EIP-712 wallet request in ${promptMs.toFixed(2)} ms despite a hung RPC.`);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: output + '/immediate-wallet-request.png', fullPage: true });
  await writeFile(output + '/result.json', json({ ok: true, promptMs, checks, errors, nonceReads: state.nonceReads,
    warmupRpcCount: readCount, previewAndConfirmationRpcCount: state.rpc.length - readCount,
    scope: 'Local synthetic fixture only; no signature generated, relay POST, paid API request or chain send.' }) + '\n');
  console.log(json({ ok: true, promptMs, checks, output }));
} catch (problem) {
  await writeFile(output + '/failure.json', json({ error: problem.stack, checks, errors, body: await page?.locator('body').innerText().catch(() => '') }));
  throw problem;
} finally { await browser.close(); }

async function assertEventually(check, label) {
  const deadline = Date.now() + 15000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(check(), label);
}
