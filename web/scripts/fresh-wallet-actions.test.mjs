import test from 'node:test';
import assert from 'node:assert/strict';
import { abi } from '../lib/chain-client.mjs';
import { loadFreshLiveConfig } from '../lib/fresh-product-config.mjs';
import { freshWalletActionReady, isFreshWalletActionTransaction } from '../lib/fresh-wallet-actions.mjs';
import { canOpenFundingAction, currentDetailActionReady } from '../lib/live-view.mjs';
import { requireCurrentProductStage, validateProductTransactionStage } from '../lib/live-transactions.mjs';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';

const f = freshAuthorityBrowserFixture();
const graph = { ...f.graph(), operationalReady: false, transactionReady: false, userExitReady: false };
const fetcher = async url => new Response(JSON.stringify(url.includes('/data/') ? f.manifest : graph),
  { headers: { 'Content-Type': 'application/json' } });
const boot = await loadFreshLiveConfig({ origin: 'https://example.test', basePath: '/bemine-v4',
  manifestSha256: f.manifestSha, fetcher });
const config = { ...boot, ...boot.manifest };
const transaction = { chainId: '0x38', from: f.signer.address, to: f.f.base.pools.active,
  data: abi.PoolVault.encodeFunctionData('deposit', [1]), value: '0x123' };
const action = { kind: 'deposit', targetType: 'pool' };

test('real current fresh configuration admits exact member deposit with all worker gates false', async () => {
  assert.equal(freshWalletActionReady(config, 'pool', 'deposit'), true);
  assert.equal(isFreshWalletActionTransaction(config, transaction, action), true);
  assert.equal(validateProductTransactionStage(config, transaction, action).value, 0x123n);
  const current = await requireCurrentProductStage(config, fetcher, { transaction, action });
  assert.equal(current.operationalReady, false);
  await assert.rejects(requireCurrentProductStage(config, fetcher), /最新链上核验/,
    'ordinary operation independence must not grant worker/administrator readiness');
});

test('cached detail and background reload do not lock a registered Funding preview', () => {
  const pool = transaction.to;
  const context = { client: {}, config, source: { readMode: 'verified_snapshot', stale: true },
    cachedPage: true, loading: true, busy: false, loadedRoute: `detail/${pool}`, routePool: pool,
    detailPool: pool, loadedAccount: null, account: f.signer.address,
    detail: { trusted: true, depositPaused: false, remaining: 100 } };
  assert.equal(canOpenFundingAction(context), true);
  for (const changed of [{ detail: { ...context.detail, depositPaused: true } },
    { detail: { ...context.detail, remaining: 0 } }, { detail: { ...context.detail, trusted: false } },
    { routePool: f.other.address }, { busy: true }])
    assert.equal(canOpenFundingAction({ ...context, ...changed }), false);
  assert.equal(currentDetailActionReady({ ...context, action: 'mine' }), false);
});

test('stale deployment, tampered calldata, wrong target types and automatic calls remain separate', () => {
  for (const stale of [{ ...config, readMode: 'verified_snapshot', stale: true },
    { ...config, freshFactoryVerified: false }, { ...config, walletSessionReady: false }]) {
    assert.equal(freshWalletActionReady(stale, 'pool', 'deposit'), false);
    assert.equal(isFreshWalletActionTransaction(stale, transaction, action), false);
    assert.throws(() => validateProductTransactionStage(stale, transaction, action));
  }
  for (const modified of [{ ...transaction, value: '0' }, { ...transaction, chainId: '0x1' },
    { ...transaction, to: config.factory }, { ...transaction, data: transaction.data + '00' }])
    assert.equal(isFreshWalletActionTransaction(config, modified, action), false);
  const market = { ...transaction, to: config.shareMarket, data: abi.ShareMarket.encodeFunctionData('fill', [1, 1]) };
  assert.equal(isFreshWalletActionTransaction(config, market, { kind: 'fill', targetType: 'portfolioMarket' }), false);
  const mining = { ...transaction, data: abi.PoolVault.encodeFunctionData('mine', ['0x']), value: '0' };
  assert.equal(isFreshWalletActionTransaction(config, mining, { kind: 'mine' }), false);
  assert.throws(() => validateProductTransactionStage(config, mining, 'mine'));
});
