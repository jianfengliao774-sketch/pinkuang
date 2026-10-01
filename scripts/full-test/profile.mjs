import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const FULL_TEST_TIMINGS = Object.freeze({
  holdSeconds: 0, proposalCooldownSeconds: 0, voteSeconds: 86_400,
  listingSeconds: 604_800, upgradeDelaySeconds: 0,
});

// These exact substitutions are the complete difference from the formal sources.
// Vote/listing expiry, accounting days, purchase deadlines and review rules stay intact.
export const TIMING_TRANSFORMS = Object.freeze([
  ['src/libraries/SaleGovernance.sol', 'PROPOSE_INTERVAL = 7 days;', 'PROPOSE_INTERVAL = 0;'],
  ['src/BudgetPortfolioVault.sol', 'g.nextRoundAt = uint64(block.timestamp + 7 days);', 'g.nextRoundAt = uint64(block.timestamp + 0);'],
  ['src/BudgetPortfolioVault.sol', 'block.timestamp < uint256(g.lastProposed[msg.sender]) + 7 days', 'block.timestamp < uint256(g.lastProposed[msg.sender]) + 0'],
  ['src/BudgetPortfolioVault.sol', 'block.timestamp < uint256(IBudgetChild(child).activatedAt()) + 7 days', 'block.timestamp < uint256(IBudgetChild(child).activatedAt()) + 0'],
  ['src/PoolTimelock.sol', 'MINIMUM_DELAY = 48 hours;', 'MINIMUM_DELAY = 0;'],
  ['src/PoolFactory.sol', 'MINIMUM_UPGRADE_DELAY = 48 hours;', 'MINIMUM_UPGRADE_DELAY = 0;'],
  ['src/BudgetPortfolioFactory.sol', 'MINIMUM_UPGRADE_DELAY = 48 hours;', 'MINIMUM_UPGRADE_DELAY = 0;'],
  ['src/ShareMarket.sol', 'MINIMUM_UPGRADE_DELAY = 48 hours;', 'MINIMUM_UPGRADE_DELAY = 0;'],
  ['src/PoolBeacon.sol', '.getMinDelay() < 48 hours', '.getMinDelay() < 0'],
  ['src/AtomicDeployment.sol', 'timelock.getMinDelay() != 48 hours', 'timelock.getMinDelay() != 0'],
].map(([sourceName, original, replacement]) => Object.freeze({ sourceName, original, replacement })));

export const sha256 = content => createHash('sha256').update(content).digest('hex');
export const sortedObject = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')));

function replaceOnce(content, original, replacement, sourceName) {
  assert.equal(content.split(original).length - 1, 1, `Expected exactly one reviewed timing fragment in ${sourceName}: ${original}`);
  return content.replace(original, replacement);
}

export function transformFullTestSources(originalSources) {
  const sources = Object.fromEntries(Object.entries(originalSources).map(([name, source]) => [name, { ...source }]));
  for (const transform of TIMING_TRANSFORMS) {
    assert(sources[transform.sourceName], `Missing timing source ${transform.sourceName}`);
    sources[transform.sourceName].content = replaceOnce(sources[transform.sourceName].content,
      transform.original, transform.replacement, transform.sourceName);
  }
  assertSourceEquivalence(originalSources, sources);
  return sources;
}

export function assertSourceEquivalence(originalSources, testSources) {
  assert.deepEqual(Object.keys(testSources).sort(), Object.keys(originalSources).sort(), 'Source inventory changed.');
  for (const [name, source] of Object.entries(originalSources)) {
    let restored = testSources[name].content;
    for (const transform of TIMING_TRANSFORMS.filter(item => item.sourceName === name).reverse()) {
      restored = replaceOnce(restored, transform.replacement, transform.original, name);
    }
    assert.equal(restored, source.content, `Unreviewed source difference: ${name}`);
  }
}
