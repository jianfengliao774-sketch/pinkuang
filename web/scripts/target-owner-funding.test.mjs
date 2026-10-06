import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, ZeroAddress } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { readTargetOwnerFundingStatus, attachTargetOwnerFundingStatus, targetOwnerViews,
  targetOwnerFundingBlocked, targetOwnerFundingText } from '../lib/target-owner-funding.mjs';
import { prepareProductAction } from '../lib/live-actions.mjs';
import { prepareAdminAction } from '../lib/live-admin.mjs';
import { canOpenFundingAction } from '../lib/live-view.mjs';
import { loadFreshDisplayConfig, loadFreshLiveConfig, freshManifestDigest,
  validateFreshProductGraph } from '../lib/fresh-product-config.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const pool = address(1), owner = address(2), account = address(3), market = address(4);
const config = { status: 'ready', chainId: 56, displayOnly: true, targetOwnerGuardVersion: 1,
  factory: address(5), lens: address(6), shareMarket: market, authority: address(7),
  freshAuthority: { administratorOne: account, administratorTwo: owner } };
const flexibleConfig = { minVerifiedWeight: 1n, referencePriceWei: 9000n, targetDailyYieldAtomic: 1n,
  extraBps: 1000n, referenceObservedAt: 1n, referenceBlock: 1n, referenceDigest: hash(9) };
function fixture({ state = 0n, flexible = false, configured = false, originalOwner = ZeroAddress,
  version = 1n, fail = false } = {}) {
  const calls = [];
  const provider = { request: async ({ method, params }) => {
    assert.equal(method, 'eth_call', 'eligibility must never send a transaction or ask for a signature');
    const target = getAddress(params[0].to);
    const view = targetOwnerViews.parseTransaction(params[0]);
    const iface = view ? targetOwnerViews : abi.PoolVault;
    const parsed = view ?? abi.PoolVault.parseTransaction(params[0]);
    calls.push({ target, name: parsed.name, tag: params[1] });
    if (fail) throw new Error('RPC unavailable');
    const values = { state: [state], flexiblePurchase: [flexible, 100n, flexibleConfig],
      targetOwnerVersion: [version], targetOwner: [originalOwner, configured, 0n], unitPriceWei: [100n] };
    assert(values[parsed.name], `Unexpected getter ${parsed.name}`);
    return iface.encodeFunctionResult(parsed.fragment, values[parsed.name]);
  } };
  return { provider, calls };
}

test('each fixed Funding/Funded pool reads its actual target lock, independently of age and historical listing proof', async () => {
  for (const state of [0n, 1n]) {
    const f = fixture({ state });
    const result = await attachTargetOwnerFundingStatus({ source: { readMode: 'display' }, items: [
      { pool, state, kind: 'single', creationBlock: 99999999, targetAvailability: { status: 'available' } },
      { pool: address(8), state, kind: 'single', creationBlock: 1, targetAvailability: { status: 'available' } },
    ] }, { provider: f.provider, config });
    assert(result.items.every(row => row.targetOwnerFunding.status === 'not_configured'));
    assert(result.items.every(row => targetOwnerFundingBlocked(row, config)));
    assert.equal(f.calls.length, 8);
    assert.equal(new Set(f.calls.map(call => call.target)).size, 2);
    assert(f.calls.every(call => call.tag === 'latest'));
    assert.match(targetOwnerFundingText(result.items[0].targetOwnerFunding.status)[0], /历史矿机归属需管理员确认/);
  }
});

test('configured fixed locks and explicit flexible consent permit funding; Active/Listed/Closed/Refunding and portfolio rows retain behavior', async () => {
  for (const options of [{ configured: true, originalOwner: owner }, { flexible: true }]) {
    const read = await readTargetOwnerFundingStatus({ ...fixture(options), pool, blockTag: '0x100' });
    assert.equal(targetOwnerFundingBlocked({ pool, state: 0n, targetOwnerFunding: read }, config), false);
  }
  const f = fixture();
  const rows = [2n, 3n, 4n, 5n].map(state => ({ pool, state }));
  rows.push({ pool, state: 0n, kind: 'portfolio' });
  const result = await attachTargetOwnerFundingStatus({ items: rows }, { ...f, config });
  assert.equal(f.calls.length, 0);
  assert(result.items.every(row => !targetOwnerFundingBlocked(row, config)));
  assert.equal(await attachTargetOwnerFundingStatus(rows, { ...f, config: {} }), rows);
});

test('unknown, stale, changed-state and substituted-pool reads never open a Funding wallet action', async () => {
  const read = await readTargetOwnerFundingStatus({ ...fixture({ configured: true, originalOwner: owner }), pool });
  const now = Date.now();
  const detail = { pool, state: 0n, trusted: true, depositPaused: false, remaining: 20,
    targetOwnerFunding: read };
  const context = { client: {}, config, source: {}, cachedPage: false, loading: false, busy: false,
    loadedRoute: `detail/${pool}`, routePool: pool, detailPool: pool, loadedAccount: account, account, detail };
  assert.equal(canOpenFundingAction(context), true);
  for (const invalid of [null, { ...read, pool: owner }, { ...read, status: 'unknown' },
    { ...read, checkedAt: now - 60001 }, { ...read, checkedAt: now + 60001 }, { ...read, chainState: '1' }]) {
    assert.equal(canOpenFundingAction({ ...context, detail: { ...detail, targetOwnerFunding: invalid } }), false);
  }
  for (const options of [{ fail: true }, { version: 2n }, { configured: true, originalOwner: ZeroAddress },
    { configured: true, originalOwner: pool }]) {
    const unknown = await readTargetOwnerFundingStatus({ ...fixture(options), pool });
    assert.equal(unknown.status, 'unknown');
    assert.doesNotMatch(targetOwnerFundingText(unknown.status)[0], /卖走|已下架|已转移/);
  }
});

test('one page has a bounded deadline and at most four concurrent pools, even with stalled RPC', async () => {
  const calls = [];
  const provider = { request: ({ method, params }) => {
    assert.equal(method, 'eth_call'); calls.push(params[0].to); return new Promise(() => {});
  } };
  const rows = Array.from({ length: 20 }, (_, index) => ({ pool: address(100 + index), state: 0n }));
  const before = Date.now();
  const result = await attachTargetOwnerFundingStatus({ items: rows }, { provider, config, timeoutMs: 25 });
  assert(Date.now() - before < 500);
  assert.equal(new Set(calls).size, 4);
  assert.equal(calls.length, 16);
  assert(result.items.every(row => row.targetOwnerFunding.status === 'unknown'));
});

test('fixed unconfigured deposits and procurement stop before any payable calldata or wallet submission', async () => {
  const f = fixture();
  await assert.rejects(prepareProductAction({ ...f, config, account, pool, kind: 'deposit', quantity: '1' }),
    { code: 'targetOwnerNotConfigured', beforeWalletSubmission: true });
  assert(!f.calls.some(call => call.name === 'unitPriceWei'));
  for (const kind of ['autoPurchase', 'buyFromFirsto', 'buyFromMarket', 'buyAlternativeFromMarket'])
    await assert.rejects(prepareAdminAction({ ...fixture({ state: 1n }), config, account, pool, kind }),
      { code: 'targetOwnerNotConfigured', beforeWalletSubmission: true });
  await assert.rejects(prepareProductAction({ ...fixture({ fail: true }), config, account, pool,
    kind: 'deposit', quantity: '1' }), { code: 'targetOwnerUnknown' });
});

test('refund opening, subscription withdrawal and already-booked claims never depend on the new owner RPC', async () => {
  const provider = { request: () => assert.fail('No target RPC before an exit wallet request') };
  for (const kind of ['withdrawDeposit', 'finalizeFailure', 'withdrawBnb', 'claim']) {
    const action = await prepareProductAction({ provider, config, account, pool, kind });
    assert.equal(abi.PoolVault.parseTransaction(action.transaction).name, kind);
  }
});

const keys = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock', 'portfolioFactory',
  'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation', 'portfolioFactoryImplementation'];
const authority = { address: address(30), administratorOne: address(31), administratorTwo: address(32),
  gasWallet: address(33), codehash: hash(99), deploymentTxHash: hash(98) };
const manifest = { schemaVersion: 1, kind: 'integrated-v2', chainId: 56,
  ...Object.fromEntries(keys.map((key, index) => [key, address(10 + index)])),
  codehash: Object.fromEntries(keys.map(key => [key, hash(50)])), authority: authority.address,
  gasWallet: authority.gasWallet, freshAuthority: authority,
  deployment: { txHash: hash(40), blockNumber: 90, blockHash: hash(41) }, artifactDigest: ARTIFACT_DIGEST,
  sourceCommit: 'a'.repeat(40), verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBlockNumber: 100 };
const upgrade = { version: 1, candidateArtifactDigest: hash(201), catalogDigest: hash(202), operationId: hash(203),
  replacements: { PoolFunds: address(201), FlexiblePurchase: address(202), PoolVault: address(203) },
  codehash: { PoolFunds: hash(204), FlexiblePurchase: hash(205), PoolVault: hash(206) },
  verifiedBlockNumber: 102, verifiedBlockHash: hash(207) };
const graph = { status: 'verified', chainId: 56, stage: 'fresh-active', artifactDigest: ARTIFACT_DIGEST,
  genesisArtifactDigest: ARTIFACT_DIGEST, operationId: null, upgradeArtifactDigest: null,
  freshFactoryVerified: true, factory: manifest.factory, portfolioFactory: manifest.portfolioFactory,
  verifiedBlockNumber: 102, verifiedBlockHash: hash(43), stageActivationBlock: 101, stageActivationHash: hash(42),
  freshAuthority: { ...authority, activationBlock: 101, activationHash: hash(42) }, operationalReady: false,
  readMode: 'current', stale: false, manifest: { ...manifest, verifiedBlockNumber: 101 }, targetOwnerUpgrade: upgrade };
test('the compiled guard has no boot requests or new action permissions; validated graph metadata survives configuration loading', async () => {
  const opts = { origin: 'https://example.test', basePath: '/bemine-v5', pinnedManifest: manifest,
    manifestSha256: freshManifestDigest(manifest), targetOwnerGuardVersion: '1' };
  const display = await loadFreshDisplayConfig({ ...opts, fetcher: () => assert.fail('No guard boot requests') });
  assert.equal(display.targetOwnerGuardVersion, 1);
  for (const key of ['operationalReady', 'transactionReady', 'userExitReady', 'freshFactoryVerified'])
    assert.equal(display[key], false);
  const live = await loadFreshLiveConfig({ ...opts, fetcher: url => new Response(JSON.stringify(
    url.endsWith('.v5.json') ? manifest : graph), { headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual(live.targetOwnerUpgrade, upgrade);
  assert.equal(live.operationalReady, false);
  for (const broken of [{ candidateArtifactDigest: 'unsafe' }, { catalogDigest: 'unsafe' },
    { operationId: 'unsafe' }, { verifiedBlockHash: 'unsafe' }, { verifiedBlockNumber: 103 },
    { codehash: { ...upgrade.codehash, PoolFunds: 'unsafe' } }, { replacements: { ...upgrade.replacements, PoolFunds: ZeroAddress } },
    { replacements: { ...upgrade.replacements, PoolFunds: upgrade.replacements.PoolVault } }])
    assert.throws(() => validateFreshProductGraph({ ...graph, targetOwnerUpgrade: { ...upgrade, ...broken } }, manifest));
});
