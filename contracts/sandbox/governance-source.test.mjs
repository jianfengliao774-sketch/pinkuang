import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sandboxGovernance } from './generate-governance.mjs';

test('sandbox governance has no changes beyond durations, name, import and six inline entries', async () => {
  const production = await readFile(new URL('../src/libraries/SaleGovernance.sol', import.meta.url), 'utf8');
  const sandbox = await readFile(new URL('./SandboxSaleGovernance.sol', import.meta.url), 'utf8');
  assert.equal(sandbox, sandboxGovernance(production));
  const original = sandbox
    .replace('"../src/PoolSaleState.sol"', '"../PoolSaleState.sol"')
    .replace('library SandboxSaleGovernance {', 'library SaleGovernance {')
    .replace('PROPOSE_INTERVAL = 60 seconds;', 'PROPOSE_INTERVAL = 7 days;')
    .replace('VOTE_DURATION = 5 minutes;', 'VOTE_DURATION = 1 days;')
    .replace('LISTING_DURATION = 15 minutes;', 'LISTING_DURATION = 7 days;');
  const start = original.indexOf('library SaleGovernance {');
  let count = 0;
  const restored = original.slice(0, start) + original.slice(start).replace(/(\)\s+)internal\b/g, (_match, before) => {
    count++;
    return `${before}external`;
  });
  assert.equal(count, 6);
  assert.equal(restored, production);
  assert.match(sandbox, /p\.yesCount \* 2 > p\.snapshotMemberCount && p\.yesShares \* 2 > p\.snapshotTotalShares/);
  assert.match(sandbox, /block\.timestamp >= p\.endsAt/);
  assert.match(sandbox, /block\.timestamp - observedAt > 15 minutes/);
});

test('generator refuses changed production rules instead of silently accepting different entry points', () => {
  assert.throws(() => sandboxGovernance('library SaleGovernance {}'), /Expected one production source fragment/);
});
