/** Local wallet fixtures only. Never authorizes a real account, signs, or sends. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { WALLET_PREFERENCE_KEY } from '../lib/wallet-reload.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3219/bemine-v4').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = process.env.BEMINE_BROWSER_OUTPUT || '/tmp/bemine-wallet-reload-browser';
// A production manifest supplies public addresses only. All providers/API replies
// remain local fakes, so the built export can be tested without a real wallet.
const publicManifest = process.env.BEMINE_TEST_MANIFEST
  ? JSON.parse(await readFile(process.env.BEMINE_TEST_MANIFEST, 'utf8')) : null;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const checks = [], unexpected = [];
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
let context, page;
async function setup({ preference, late = false, mobile = false } = {}) {
  await context?.close();
  context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  const fixture = freshAuthorityBrowserFixture();
  if (publicManifest) fixture.manifest = publicManifest;
  const state = { account: publicManifest?.freshAuthority?.administratorOne || fixture.state.account, chain: '0x38', requests: [] };
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  await page.route(/\/data\/frontend-manifest.v[45].json(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/json', body: json(fixture.manifest) }));
  await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
    try { const request = route.request().postDataJSON(); await route.fulfill({ contentType: 'application/json', body: json({ jsonrpc: '2.0', id: request.id, result: await fixture.request(request) }) }); }
    catch { await route.fulfill({ status: 503, contentType: 'application/json', body: json({ error: 'Offline fixture read unavailable' }) }); }
  });
  await page.route(/\/api\/chain-index\//, route => {
    try {
      const result = fixture.index(route.request().url().replace('/v1/display/', '/v1/'));
      result.source = { ...result.source, displayOnly: true, transactionReady: false };
      return route.fulfill({ contentType: 'application/json', body: json(result) });
    } catch { return route.fulfill({ status: 503, contentType: 'application/json', body: json({ error: 'Offline fixture read unavailable' }) }); }
  });
  await page.route(/\/firsto-api\/v1\//, route => route.fulfill({ contentType: 'application/json', body: json(fixture.data.detail) }));
  await page.route(/\/api\/journal\//, async route => {
    assert.equal(route.request().method(), 'GET', 'No journal mutations in reload tests');
    try { await route.fulfill({ contentType: 'application/json', body: json(await fixture.journal(route.request().url(), 'GET', null)) }); }
    catch { await route.fulfill({ status: 503, contentType: 'application/json', body: json({ error: 'Offline fixture read unavailable' }) }); }
  });
  await page.exposeFunction('__walletRead', ({ wallet, method }) => {
    state.requests.push({ wallet, method });
    assert(['eth_accounts', 'eth_chainId', 'eth_requestAccounts'].includes(method), 'Unexpected wallet action: ' + method);
    return method === 'eth_chainId' ? state.chain : state.account ? [state.account] : [];
  });
  await page.addInitScript(({ key, preference, late }) => {
    // Seed selection intent once, leaving real page writes intact across F5.
    if (preference && !sessionStorage.getItem('fixture-seeded')) {
      localStorage.setItem(key, JSON.stringify(preference)); sessionStorage.setItem('fixture-seeded', '1');
    }
    const make = (wallet, flags) => {
      const listeners = new Map();
      return { ...flags, request: ({ method }) => window.__walletRead({ wallet, method }),
        on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
        removeListener(event, fn) { listeners.get(event)?.delete(fn); } };
    };
    const metamask = make('metamask', { isMetaMask: true });
    const other = make('rabby', { isRabby: true });
    window.ethereum = other; // The default provider is deliberately not the saved wallet.
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'MetaMask', rdns: 'io.metamask', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' }, provider: metamask,
    } }));
    let ready = !late;
    window.addEventListener('eip6963:requestProvider', () => { if (ready) announce(); });
    if (late) setTimeout(() => { ready = true; announce(); }, 750);
  }, { key: WALLET_PREFERENCE_KEY, preference, late });
  page.on('pageerror', error => unexpected.push(error.message));
  await page.goto(base + '/#home');
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).waitFor();
  return state;
}
const connected = () => page.locator('header .live-wallet-label').filter({ hasText: /0x[0-9a-f]/i });
const record = message => { checks.push(message); console.log('PASS ' + message); };
const saved = { version: 1, source: 'eip6963', rdns: 'io.metamask', brandId: 'metamask' };
try {
  let state = await setup();
  assert.equal(state.requests.length, 0, 'First visit must not guess a wallet');
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click(); await connected().waitFor({ state: 'attached' });
  assert.equal(state.requests.filter(r => r.method === 'eth_requestAccounts').length, 1);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), WALLET_PREFERENCE_KEY), saved);
  const operator = page.locator('nav').getByRole('button', { name: '运营工作台', exact: true });
  await operator.waitFor(); await operator.click();
  const before = state.requests.length;
  await page.reload(); await connected().waitFor({ state: 'attached' }); await operator.waitFor();
  assert.equal(new URL(page.url()).hash, '#operator', 'Reload must retain the operator route');
  assert(state.requests.slice(before).length > 0);
  assert(state.requests.slice(before).every(r => r.wallet === 'metamask' && ['eth_accounts', 'eth_chainId'].includes(r.method)));
  record('F5 restores the selected MetaMask and operator page with read-only wallet methods, despite another default wallet');
  await page.locator('header').getByRole('button', { name: /打开钱包信息/ }).click();
  await page.getByRole('button', { name: '断开本页连接', exact: true }).click();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), WALLET_PREFERENCE_KEY), null);
  const afterDisconnect = state.requests.length;
  await page.reload(); await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).waitFor();
  await page.waitForTimeout(600);
  assert.equal(await connected().count(), 0); assert.equal(state.requests.length, afterDisconnect);
  record('Explicit disconnect persists across F5 and makes no wallet reads');

  state = await setup({ preference: saved, late: true, mobile: true });
  await connected().waitFor({ state: 'attached' }); assert(state.requests.every(r => r.wallet === 'metamask' && ['eth_accounts', 'eth_chainId'].includes(r.method)));
  await page.reload(); await connected().waitFor({ state: 'attached' });
  await page.screenshot({ path: output + '/mobile-reload.png', fullPage: true });
  record('Late EIP-6963 injection restores on initial load and F5 at mobile width');
  state.account = '0x0000000000000000000000000000000000000b0b';
  await page.reload(); await connected().waitFor({ state: 'attached' }); assert.match(await connected().innerText(), /0b0b/i);
  record('F5 uses the live authorized account rather than a stored address');
  state.chain = '0x1'; const changed = state.requests.length;
  await page.reload(); await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).waitFor();
  await page.waitForTimeout(1200); assert.equal(await connected().count(), 0);
  assert(state.requests.slice(changed).every(r => ['eth_accounts', 'eth_chainId'].includes(r.method)));
  record('Wrong chain stays disconnected without a wallet switch or permission prompt');
  state.chain = '0x38'; state.account = null;
  await page.reload(); await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).waitFor();
  await page.waitForTimeout(1200); assert.equal(await connected().count(), 0);
  record('Revoked or locked accounts stay disconnected without requesting permission');
  assert.deepEqual(unexpected, []);
  await writeFile(output + '/result.json', json({ ok: true, checks, unexpected, scope: 'Local fixture only; no real accounts, signatures, sends, or paid API calls.' }) + '\n');
} finally { await browser.close(); }
