import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress } from 'ethers';
import { clearPortfolioDisplays, readPortfolioDisplay, rememberPortfolioDisplay } from '../lib/portfolio-display-cache.mjs';
import { portfolioSelectedActionReady, readPortfolio, readPortfolioContext } from '../lib/live-portfolios.mjs';
import { address, PORTFOLIOS, portfolioFixture } from './portfolio-fixture.mjs';

const savedAt = 1_800_000_000_000;
const hash = digit => `0x${digit.repeat(64)}`;
async function completedRead(account) {
  const fixture = portfolioFixture();
  const context = await readPortfolioContext(fixture.config, fixture.provider);
  const owner = account === undefined ? fixture.account : account;
  const row = await readPortfolio(context, PORTFOLIOS[0], owner || ZeroAddress);
  return { config: fixture.config, row, account: owner };
}
test.beforeEach(clearPortfolioDisplays);

test('a pushed revision prevents reuse of a project remembered on another page before that update', async () => {
  const { config, row, account } = await completedRead();
  assert.equal(rememberPortfolioDisplay(config, row, account, savedAt, 1), true);
  assert.equal(readPortfolioDisplay(config, row.pool, account, savedAt + 1, 1), row);
  assert.equal(readPortfolioDisplay(config, row.pool, account, savedAt + 1, 2), null);
  const updated = { ...row, claimableBem: row.claimableBem + 1n };
  assert.equal(rememberPortfolioDisplay(config, updated, account, savedAt + 2, 2), true);
  assert.equal(readPortfolioDisplay(config, row.pool, account, savedAt + 3, 2), updated);
});

test('a completed parent read remains exact display data until the two-minute expiry boundary', async () => {
  const { config, row, account } = await completedRead();
  assert.equal(rememberPortfolioDisplay(config, row, account, savedAt), true);
  const cached = readPortfolioDisplay(config, row.pool, account, savedAt + 119_999);
  assert.equal(cached.budgetWei, row.budgetWei);
  assert.equal(cached.shares, row.shares);
  assert.equal(cached.claimableBem, row.claimableBem);
  assert.equal(cached.blockHash, row.blockHash);
  assert.equal(readPortfolioDisplay(config, row.pool, account, savedAt + 120_000), null);
  assert.equal(readPortfolioDisplay(config, row.pool, account, savedAt + 10), null,
    'an expired row must have been discarded, not resurrected by an earlier clock');
});

test('clock rollback and explicit wallet-cache clearing discard remembered rows', async () => {
  const { config, row, account } = await completedRead();
  rememberPortfolioDisplay(config, row, account, savedAt);
  assert.equal(readPortfolioDisplay(config, row.pool, account, savedAt - 1), null);
  rememberPortfolioDisplay(config, row, account, savedAt);
  clearPortfolioDisplays();
  assert.equal(readPortfolioDisplay(config, row.pool, account, savedAt + 1), null);
});

test('parent, account and anonymous views cannot reuse another wallet entitlement', async () => {
  const { config, row, account } = await completedRead();
  rememberPortfolioDisplay(config, row, account, savedAt);
  assert.equal(readPortfolioDisplay(config, row.pool.toLowerCase(), account.toLowerCase(), savedAt + 1), row);
  assert.equal(readPortfolioDisplay(config, row.pool, address(0xaaa), savedAt + 1), null);
  assert.equal(readPortfolioDisplay(config, row.pool, null, savedAt + 1), null);
  assert.equal(readPortfolioDisplay(config, PORTFOLIOS[1], account, savedAt + 1), null);
  assert.equal(rememberPortfolioDisplay(config, row, address(0xaaa), savedAt), false);
  assert.equal(rememberPortfolioDisplay(config, row, null, savedAt), false);
  const anonymous = await completedRead(null);
  assert.equal(rememberPortfolioDisplay(anonymous.config, anonymous.row, null, savedAt), true);
  assert.equal(readPortfolioDisplay(config, row.pool, null, savedAt + 1).shares, 0n);
  assert.equal(readPortfolioDisplay(config, row.pool, account, savedAt + 1).shares, row.shares);
});

test('core factory, portfolio factory and portfolio market each isolate a display cache', async () => {
  const { config, row, account } = await completedRead();
  rememberPortfolioDisplay(config, row, account, savedAt);
  for (const field of ['factory', 'portfolioFactory', 'portfolioMarket']) {
    const changed = { ...config, [field]: address(0xaaa), manifest: { ...config.manifest, [field]: address(0xaaa) } };
    assert.equal(readPortfolioDisplay(changed, row.pool, account, savedAt + 1), null, field);
  }
  assert.equal(rememberPortfolioDisplay(config, { ...row, OFFICIAL_FACTORY: address(0xaaa) }, account, savedAt), false);
  assert.equal(rememberPortfolioDisplay(config, { ...row, legacyFactory: address(0xaaa) }, account, savedAt), false);
});

test('artifact, activation stage and deployment identity cannot share a remembered parent', async () => {
  const { config: original, row, account } = await completedRead();
  const config = { ...original, stageActivationBlock: 90, stageActivationHash: hash('a') };
  rememberPortfolioDisplay(config, row, account, savedAt);
  const deployment = config.manifest.deployment;
  const changedDeployment = fields => ({ ...config, deployment: { ...deployment, ...fields },
    manifest: { ...config.manifest, deployment: { ...deployment, ...fields } } });
  for (const [name, changed] of [
    ['artifact', { ...config, artifactDigest: hash('b') }],
    ['stage', { ...config, stage: 'role-wired' }],
    ['activation block', { ...config, stageActivationBlock: 91 }],
    ['activation hash', { ...config, stageActivationHash: hash('c') }],
    ['deployment transaction', changedDeployment({ txHash: hash('d') })],
    ['deployment block hash', changedDeployment({ blockHash: hash('e') })],
  ]) assert.equal(readPortfolioDisplay(changed, row.pool, account, savedAt + 1), null, name);
});

test('invalid parent and block identities never become a cached read', async () => {
  const { config, row, account } = await completedRead();
  for (const [name, changes] of [
    ['wrong row kind', { kind: 'pool' }], ['missing parent address', { pool: undefined }],
    ['zero parent address', { pool: ZeroAddress }], ['malformed parent address', { pool: '0x1234' }],
    ['negative block', { blockNumber: -1n }], ['numeric block', { blockNumber: 100 }],
    ['string block', { blockNumber: '100' }], ['missing block hash', { blockHash: undefined }],
    ['short block hash', { blockHash: '0x1234' }], ['non-hex block hash', { blockHash: hash('z') }],
  ]) assert.equal(rememberPortfolioDisplay(config, { ...row, ...changes }, account, savedAt), false, name);
  assert.equal(rememberPortfolioDisplay({ ...config, kind: undefined }, row, account, savedAt), false);
});

test('a parent identity or partial response cannot masquerade as a completed parent read', async () => {
  const { config, row, account } = await completedRead();
  for (const field of ['state', 'budgetWei', 'absoluteCapWei', 'unitCapWei', 'spentWei', 'shares',
    'totalSupply', 'availableShares', 'claimableBem', 'withdrawableBnb', 'fundingDeadline',
    'purchaseDeadline', 'timestamp', 'children', 'proposals']) {
    const partial = { ...row }; delete partial[field];
    assert.equal(rememberPortfolioDisplay(config, partial, account, savedAt), false, field);
  }
  assert.equal(rememberPortfolioDisplay(config, { ...row, budgetWei: '5000000000000000' }, account, savedAt), false,
    'serialized index metadata does not supply an exact, completed contract read');
  assert.equal(rememberPortfolioDisplay(config, { ...row, children: null }, account, savedAt), false);
});

test('remembering a valid displayed row does not grant a current action proof', async () => {
  const { config, row, account } = await completedRead();
  const readyConfig = { ...config, productFamily: 'fresh-v4', operationalReady: true, stale: false };
  rememberPortfolioDisplay(readyConfig, row, account, savedAt);
  const cached = readPortfolioDisplay(readyConfig, row.pool, account, savedAt + 1);
  assert(cached);
  assert.equal(portfolioSelectedActionReady({ config: readyConfig, selectedProofCurrent: false, selected: cached }), false);
  assert.equal(portfolioSelectedActionReady({ config: readyConfig, selected: cached }), false);
  assert.equal(portfolioSelectedActionReady({ config: readyConfig, selectedProofCurrent: true, selected: cached }), true,
    'only the caller completing an independent current proof may enable the action');
});
