/** Local synthetic read fixture only. No real wallet, upstream RPC, signing, or sends. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAddress, toQuantity } from 'ethers';
import { freshManifestDigest } from '../lib/fresh-product-config.mjs';
import { createLiveBrowserFixture } from './live-browser-fixture.mjs';
import { fundingRefundView, participantFundingNotices } from '../lib/funding-refund.mjs';
import { viewPool } from '../lib/live-view.mjs';
import { abi } from '../lib/chain-client.mjs';

const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $bemineBigInt: item.toString() } : item);
const plain = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const hash = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3138/bemine-v5/').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Local HTTP origin required');
const output = process.env.BEMINE_BROWSER_OUTPUT || '/private/tmp/bemine-delisted-participants-browser-20261004';
const manifest = JSON.parse(await readFile(new URL('../../deploy/ops/v5/latest-20261003/frontend-manifest.json', import.meta.url)));
const expectedManifestDigest = '0xc1e46426f96b858013c4485461f265021bf5e4c483be8a1591ad7563dcea112d';
assert.equal(freshManifestDigest(manifest), expectedManifestDigest, 'Fixture must bind to the reviewed formal manifest');
const account = address(0xa11ce), otherAccount = address(0xb0b), now = Math.floor(Date.now() / 1000);
const block = manifest.verifiedBlockNumber + 100;
const baseRows = createLiveBrowserFixture({ account, timestamp: now }).rows;
const rows = ['funding', 'funded', 'credit', 'available', 'refunding'].map((kind, i) => {
  const row = structuredClone(baseRows[0]), state = kind === 'funded' ? 1n : kind === 'refunding' ? 5n : 0n;
  Object.assign(row, { pool: address(0x710 + i), state, trusted: true,
    shares: ['credit', 'refunding'].includes(kind) ? 0n : 20n,
    bnbOwed: ['credit', 'refunding'].includes(kind) ? 150000000000000000n : 0n,
    claimableBEM: 0n, purchaseCost: 0n, totalSupply: state === 1n ? 100n : 20n,
    shareTradingAllowed: false, availableShares: ['credit', 'refunding'].includes(kind) ? 0n : 20n,
    lockedShares: 0n, initialContributedWei: ['credit', 'refunding'].includes(kind) ? 0n : 20n * row.unitPriceWei });
  row.totalRaised = row.state === 1n ? row.params.targetRaise : row.totalSupply * row.unitPriceWei;
  row.params.circuitId = BigInt(88000 + i);
  row.params.purchaseDeadline = BigInt(now + 86400);
  row.params.fundingDeadline = BigInt(now + 3600);
  row.targetAvailability = { status: kind === 'available' ? 'available' : 'unavailable', purchaseMode: 'fixed',
    chainState: state, creationBlock: manifest.deployment.blockNumber + 1,
    creationBlockHash: hash(2001), observedBlock: block, observedBlockHash: hash(block),
    originalOwner: address(0x9001), currentOwner: address(kind === 'available' ? 0x9001 : 0x9002) };
  return row;
});
const pools = Object.fromEntries(['funding', 'funded', 'credit', 'available', 'refunding'].map((key, i) => [key, rows[i].pool]));
let selectedAccount = account;
const source = () => ({ chainId: 56, factory: manifest.factory, market: manifest.shareMarket,
  portfolioFactory: manifest.portfolioFactory, portfolioMarket: manifest.portfolioMarket,
  startBlock: manifest.deployment.blockNumber, confirmations: 12, indexedThrough: block,
  indexedBlockHash: hash(block), indexedTimestamp: now, observedSafeHead: block, complete: true,
  unknownReason: null, checkedAt: new Date().toISOString(), cacheOrigin: 'server', displayOnly: true,
  transactionReady: false, readMode: 'verified_snapshot', stale: true, refreshing: false, snapshotAgeMs: 0 });
const ownerRow = (row, owner) => same(owner, account) ? row : { ...row, shares: 0n, availableShares: 0n,
  bnbOwed: 0n, claimableBEM: 0n, initialContributedWei: 0n };
const checks = [], pageErrors = [], denied = [], reads = [], walletReads = [], screenshots = [];
const section = (page, pool) => page.locator(`[data-refund-pool="${pool}"]:visible`);
const views = rows.map(viewPool);
assert.equal(participantFundingNotices(views, { account, positionsAccount: otherAccount, source: source() }).length, 0);
assert.equal(fundingRefundView(views[1], source()).actions.find(a => a.kind === 'finalizeFailure').ready, false);
assert.equal(fundingRefundView(views[2], source()).actions.find(a => a.kind === 'withdrawBnb').ready, true);
checks.push('Pure checks: account mismatch removes notices; Funded before deadline cannot finalize; zero shares retain booked BNB');

async function index(input) {
  const url = new URL(input), path = url.pathname.replace(/^.*\/api\/chain-index/, ''), owner = url.searchParams.get('account');
  const page = items => ({ items, nextCursor: null });
  if (path === '/health') return { source: source() };
  if (path === '/v1/display/pools') return { source: source(), data: page(rows.map(row => ownerRow(row, owner))) };
  if (/^\/v1\/display\/pools\/0x/i.test(path)) {
    const row = rows.find(row => same(row.pool, path.split('/').at(-1)));
    assert(row, 'Unknown fixture detail'); return { source: source(), data: { item: ownerRow(row, owner) } };
  }
  if (/^\/v1\/display\/positions\/0x/i.test(path)) return { source: source(), data: {
    ...page(same(path.split('/').at(-1), account) ? rows : []), marketBnbOwed: 0n } };
  if (path === '/v1/display/portfolios' || path === '/v1/display/orders') return { source: source(), data: page([]) };
  if (path === '/v1/display/stats') return { source: source(), data: { scope: 'confirmed_indexed_history',
    registeredPoolCount: '5', standalonePoolCount: '5', portfolioCount: '0', topLevelProjectCount: '5',
    childPoolCount: '0', reservedChildPoolCount: '0', reservedChildPoolAddresses: [], reservedChildPoolAddressesComplete: true,
    everParticipantAddressCount: '1', purchasedCostWei: '0', shareMarketFilledGrossWei: '0', harvestedToMembersBemAtomic: '0' } };
  if (path === '/v1/activity') return { source: source(), data: { ...page([]), totalCount: 0, overviewTotalCount: 0 } };
  if (path === '/v1/yield') return { source: source(), data: { scope: 'pool', pool: url.searchParams.get('pool'),
    account: owner, timezone: 'Asia/Shanghai', token: 'BEM', tokenDecimals: 8, buckets: [], accountUnclaimedDailyAccrual: null } };
  if (path.startsWith('/v1/display/firsto-ask/') || path.startsWith('/v1/display/sale-reference/')) return {
    schemaVersion: 1, chainId: 56, factory: manifest.factory, market: manifest.shareMarket, enabled: false,
    stale: false, updatedAt: null, item: { pool: path.split('/').at(-1), status: 'disabled' } };
  throw Error('Unsupported local index read: ' + path);
}
async function rpc(input) {
  const { method, params = [] } = input;
  if (method === 'eth_chainId') return '0x38';
  if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
  if (method === 'eth_getBlockByNumber') return { number: toQuantity(block), timestamp: toQuantity(now), hash: hash(block) };
  if (method === 'eth_blockNumber') return toQuantity(block);
  if (method === 'eth_call') {
    const row = rows.find(row => same(row.pool, params[0].to));
    const parsed = row && abi.PoolVault.parseTransaction(params[0]);
    const result = parsed && ({ state: row.state, balanceOf: ownerRow(row, parsed.args[0]).shares,
      claimable: 0n, bnbOwed: ownerRow(row, parsed.args[0]).bnbOwed, params: row.params })[parsed.name];
    if (result !== undefined && parsed.fragment.stateMutability === 'view') return abi.PoolVault.encodeFunctionResult(parsed.fragment, [result]);
  }
  throw Error('Local fixture refuses RPC ' + method);
}
await mkdir(output, { recursive: true });
if (process.argv.includes('--fixture-check')) {
  assert.equal((await index(new URL('/bemine-v5/api/chain-index/v1/display/positions/' + account, base))).data.items.length, 5);
  assert.equal((await index(new URL('/bemine-v5/api/chain-index/v1/display/positions/' + otherAccount, base))).data.items.length, 0);
  console.log(plain({ fixtureReady: true, manifestDigest: expectedManifestDigest, checks, pools }));
  process.exit(0);
}
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => pageErrors.push(error.message));
await page.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  if (url.origin !== new URL(base).origin) { denied.push('external:' + url.origin); return route.abort(); }
  const answer = body => route.fulfill({ contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: json(body) });
  try {
    if (path.endsWith('/api/rpc')) { reads.push(path + ':' + request.postDataJSON().method); return await answer({ jsonrpc: '2.0', id: request.postDataJSON().id, result: await rpc(request.postDataJSON()) }); }
    if (request.method() !== 'GET') { denied.push(request.method() + ':' + path); return route.abort(); }
    if (/\/data\/frontend-manifest(?:\.v5)?\.json$/.test(path)) return await answer(manifest);
    if (path.endsWith('/api/chain-index/v1/display/events')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.includes('/api/chain-index/')) { reads.push(path); return await answer(await index(url)); }
    if (path.includes('/api/journal/')) {
      reads.push(path); const kind = path.split('/journal/')[1];
      if (kind === 'notifications/capabilities') return await answer({ enabled: false });
      if (kind === 'session') return await answer({ account: selectedAccount });
      if (['market', 'budget-queue', 'governance', 'portfolio'].includes(kind)) return await answer({ revision: 0, record: null });
      throw Error('Unexpected journal request: ' + kind);
    }
    if (path.includes('/firsto-api/')) return await answer({ rows: [], total: 0, sourceFreshness: {} });
    if (path.includes('/api/')) throw Error('Unexpected local API: ' + path);
    return route.continue();
  } catch (error) { reads.push('REFUSED:' + error.message); return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: error.message }) }); }
});
await page.exposeFunction('__refundWallet', input => {
  walletReads.push(input.method);
  if (input.method === 'eth_accounts' || input.method === 'eth_requestAccounts') return [selectedAccount];
  if (input.method === 'eth_chainId') return '0x38';
  if (input.method === 'eth_getBalance') return '0xde0b6b3a7640000';
  denied.push('wallet:' + input.method); throw Error('Synthetic wallet forbids signing and transactions');
});
await page.addInitScript(() => {
  const listeners = new Map();
  window.ethereum = { isMetaMask: true, request: input => window.__refundWallet(input),
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeListener(name, fn) { listeners.get(name)?.delete(fn); },
    __emit(name, value) { for (const fn of listeners.get(name) || []) fn(value); } };
});
async function settle(route) { await page.waitForFunction(route => {
  const main = document.querySelector('main'); return main?.dataset.readyRoute === route && main.getAttribute('aria-busy') === 'false';
}, route); }
async function open(route) { await page.evaluate(route => { location.hash = route; }, route); await settle(route); }
async function capture(name) { const path = join(output, name + '.png'); await page.screenshot({ path, fullPage: true, animations: 'disabled' }); screenshots.push(path); }
async function checkNotice(pool, action, enabled) {
  const notice = section(page, pool).first(); await notice.waitFor();
  assert.match(await notice.innerText(), /下架|退款/);
  const button = notice.getByRole('button', { name: action, exact: true });
  assert.equal(await button.isEnabled(), enabled, `${pool}: ${action}`);
}
try {
  await page.goto(base + '/#pools'); await settle('pools');
  const directory = page.locator('[data-project-directory="unified"]');
  await directory.locator(`[data-project-address="${pools.available}"]:visible`).first().waitFor();
  for (const name of ['funding', 'funded', 'credit']) assert.equal(await directory.locator(`[data-project-address="${pools[name]}"]:visible`).count(), 0);
  checks.push('Public catalog omits confirmed externally transferred targets even when the fixture supplies those rows');
  await capture('catalog');
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
  await page.locator('header button[aria-label^="打开钱包信息："]').waitFor();
  await open('overview');
  await checkNotice(pools.funding, '撤回认购', true);
  await checkNotice(pools.funded, '开启到期退款', false);
  await checkNotice(pools.credit, '领取退款 / 待领取 BNB', true);
  await checkNotice(pools.refunding, '领取退款 / 待领取 BNB', true);
  assert.match(await section(page, pools.funded).first().innerText(), /尚未到退款时间/);
  for (const kind of ['funding', 'funded']) assert.match(await section(page, pools[kind]).first().innerText(), /1\.43\s*BNB/);
  checks.push('Overview preserves participant Funding/Funded/zero-share credit/Refunding rows; Funded predeadline action disabled');
  checks.push('Funding and Funded notices display the exact 1.43 BNB contributed principal separately from booked BNB');
  await capture('overview');
  await open('rewards');
  await checkNotice(pools.funding, '撤回认购', true); await checkNotice(pools.funded, '开启到期退款', false);
  await checkNotice(pools.credit, '领取退款 / 待领取 BNB', true);
  checks.push('Rewards retains the delisted withdrawal path and a zero-share booked BNB claim'); await capture('rewards');
  await open('detail/' + pools.funded); await checkNotice(pools.funded, '开启到期退款', false);
  checks.push('Funded detail explains waiting until the purchase deadline and blocks early refund'); await capture('funded-detail');
  await open('detail/' + pools.credit); await checkNotice(pools.credit, '领取退款 / 待领取 BNB', true);
  assert.match(await section(page, pools.credit).first().innerText(), /0\.15/);
  checks.push('Zero-share detail retains exact 0.15 BNB credit and enabled claim preview'); await capture('zero-share-detail');
  await open('notifications'); const notices = page.locator('[data-participant-notices]'); await notices.waitFor();
  assert.match(await notices.innerText(), /不需要绑定 Telegram/);
  for (const name of ['funding', 'funded', 'credit', 'refunding']) await notices.locator(`a[href="#detail/${pools[name]}"]`).waitFor();
  assert.equal(await page.getByRole('button', { name: '绑定 Telegram', exact: true }).count(), 0);
  checks.push('In-app notices link to all refund paths with Telegram capability disabled'); await capture('notifications');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await capture('notifications-mobile'); checks.push('390px notification page has no horizontal overflow');
  selectedAccount = otherAccount;
  await page.evaluate(account => window.ethereum.__emit('accountsChanged', [account]), otherAccount);
  await page.waitForFunction(() => document.querySelectorAll('[data-participant-notices] li').length === 0);
  checks.push('Switching to an unrelated synthetic account clears the former wallet refund notices');
  assert.deepEqual(pageErrors, []); assert.deepEqual(denied, []);
  assert(!walletReads.some(method => /sign|send|wallet_/i.test(method)));
  checks.push('No signatures, broadcasts, external HTTP/RPC, or Telegram posts');
  const result = { passed: true, synthetic: true, formalManifestDigest: expectedManifestDigest,
    checks, screenshots, pageErrors, denied, walletReads, reads, limitations: 'Read-only UI fixture: no real balances, contract execution, or production API state tested.' };
  await writeFile(join(output, 'results.json'), plain(result)); console.log(plain(result));
} catch (error) {
  await writeFile(join(output, 'failure.json'), plain({ error: error.stack, checks, pageErrors, denied, walletReads, reads, body: await page.locator('body').innerText() }));
  await capture('failure'); throw error;
} finally { await context.close(); await browser.close(); }
