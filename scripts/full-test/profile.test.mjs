import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRoot } from '../../deploy/scripts/build-artifacts.mjs';
import { originalContractSources } from './build-artifacts.mjs';
import { assertSourceEquivalence, FULL_TEST_TIMINGS, TIMING_TRANSFORMS, transformFullTestSources } from './profile.mjs';

test('full test changes exactly ten reviewed waits, restoring every formal byte', () => {
  const originals = originalContractSources();
  const transformed = transformFullTestSources(originals);
  assert.equal(TIMING_TRANSFORMS.length, 10);
  assertSourceEquivalence(originals, transformed);
  assert.deepEqual(FULL_TEST_TIMINGS, { holdSeconds: 0, proposalCooldownSeconds: 0,
    voteSeconds: 86400, listingSeconds: 604800, upgradeDelaySeconds: 0 });
  for (const name of ['src/PoolVault.sol', 'src/libraries/FirstoSale.sol', 'src/PoolLens.sol', 'src/libraries/RewardAccounting.sol']) {
    assert.equal(transformed[name].content, originals[name].content, `${name} must remain formal.`);
  }
  assert.match(transformed['src/BudgetPortfolioVault.sol'].content, /MAX_PURCHASE_DURATION = 7 days;/);
  assert.match(transformed['src/BudgetPortfolioVault.sol'].content, /endsAt = uint64\(block.timestamp \+ 1 days\);/);
  assert.match(transformed['src/ShareMarket.sol'].content, /ORDER_DURATION = 7 days;/);
});

test('unknown edits, missing/duplicated fragments and extra sources fail closed', () => {
  const originals = originalContractSources();
  const transformed = transformFullTestSources(originals);
  transformed['src/PoolVault.sol'].content += '\n// unreviewed edit';
  assert.throws(() => assertSourceEquivalence(originals, transformed), /Unreviewed source difference/);
  for (const transform of TIMING_TRANSFORMS) {
    for (const content of [originals[transform.sourceName].content.replace(transform.original, ''),
      originals[transform.sourceName].content + transform.original]) {
      const bad = { ...originals, [transform.sourceName]: { content } };
      assert.throws(() => transformFullTestSources(bad), /Expected exactly one reviewed timing fragment/);
    }
  }
  const extra = transformFullTestSources(originals);
  extra['unreviewed.sol'] = { content: '' };
  assert.throws(() => assertSourceEquivalence(originals, extra), /Source inventory changed/);
});

test('formal source files are read-only inputs and no imports are redirected', () => {
  const originals = originalContractSources();
  const transformed = transformFullTestSources(originals);
  for (const [name, source] of Object.entries(originals)) {
    assert.equal(readFileSync(join(repositoryRoot, 'contracts', name), 'utf8'), source.content);
    assert.deepEqual([...transformed[name].content.matchAll(/import[^;]+;/g)].map(m => m[0]),
      [...source.content.matchAll(/import[^;]+;/g)].map(m => m[0]));
  }
});
