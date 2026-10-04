import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  targetOwnerCiPins, legacySourceCompiledTests,
  selectTargetOwnerHeadTests, assertTargetOwnerCiDigests,
} from './target-owner-ci-profile.mjs';

const approvedPins = Object.freeze({
  legacySourceHead: '1486d897331e7a54a08f86d9068f3c2682258adf',
  legacyArtifactSourceCommit: '6361bff1247e7297b96d2659145a0e7256e6765c',
  legacyArtifactDigest: '0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927',
  candidateArtifactDigest: '0xc9be5208ec97a0513d29c5f1d35a9e89f54c998b5994d2a291c09e5e496881e5',
  reviewCatalogDigest: '0x01ff90f9a074a6faeb71c452bd8ad36fc0989b143f68fe5240c4d6ece0c538ba',
});
const approvedDigests = () => ({
  legacyArtifactDigest: approvedPins.legacyArtifactDigest,
  legacyArtifactSourceCommit: approvedPins.legacyArtifactSourceCommit,
  candidateArtifactDigest: approvedPins.candidateArtifactDigest,
  reviewCatalogDigest: approvedPins.reviewCatalogDigest,
  catalogCandidateArtifactDigest: approvedPins.candidateArtifactDigest,
});
const sourceTests = () => readdirSync(fileURLToPath(new URL('../src/', import.meta.url)))
  .filter(name => name.endsWith('.test.ts')).sort();

test('owner-upgrade CI keeps independent legacy source, formal artifact, candidate and review pins immutable', () => {
  assert.deepEqual(targetOwnerCiPins, approvedPins);
  assert.equal(Object.isFrozen(targetOwnerCiPins), true);
  assert.notEqual(targetOwnerCiPins.legacyArtifactDigest, targetOwnerCiPins.candidateArtifactDigest);
  assert.notEqual(targetOwnerCiPins.legacySourceHead, targetOwnerCiPins.legacyArtifactSourceCommit);
  assert.throws(() => { targetOwnerCiPins.legacyArtifactDigest = approvedPins.candidateArtifactDigest; }, TypeError);
});

test('each input root and the catalog candidate link is checked against its own independent pin', () => {
  assert.doesNotThrow(() => assertTargetOwnerCiDigests(approvedDigests()));
  for (const key of Object.keys(approvedDigests())) {
    const wrong = key === 'legacyArtifactSourceCommit' ? 'f'.repeat(40) : `0x${'f'.repeat(64)}`;
    assert.throws(() => assertTargetOwnerCiDigests({ ...approvedDigests(), [key]: wrong }), key);
    const missing = approvedDigests(); delete missing[key];
    assert.throws(() => assertTargetOwnerCiDigests(missing), `${key} is required`);
  }
  assert.throws(() => assertTargetOwnerCiDigests({ ...approvedDigests(),
    legacyArtifactDigest: approvedPins.candidateArtifactDigest }), 'candidate cannot replace the legacy root');
  assert.throws(() => assertTargetOwnerCiDigests({ ...approvedDigests(),
    candidateArtifactDigest: approvedPins.legacyArtifactDigest,
    catalogCandidateArtifactDigest: approvedPins.legacyArtifactDigest }), 'matching supplied roots cannot approve a different candidate');
});

test('HEAD selection excludes exactly five legacy source-compilation suites and retains every other current UI regression', () => {
  const excluded = ['deployment.test.ts', 'deployment-replacement.test.ts', 'fresh-activation.integration.test.ts',
    'stage2-evm-recovery.test.ts', 'stage2-wrapped-evm-recovery.test.ts'];
  assert.deepEqual([...legacySourceCompiledTests].sort(), [...excluded].sort());
  assert.equal(Object.isFrozen(legacySourceCompiledTests), true);
  assert.throws(() => legacySourceCompiledTests.push('target-owner-upgrade-ui.test.ts'), TypeError);
  const inventory = sourceTests();
  const before = [...inventory], selected = selectTargetOwnerHeadTests(inventory);
  assert.deepEqual(inventory, before, 'selection must not mutate the discovered test inventory');
  assert.deepEqual([...selected].sort(), inventory.filter(name => !excluded.includes(name)).sort());
  for (const name of ['target-owner-upgrade-ui.test.ts', 'upgrade-transactions.test.ts',
    'fresh-active-upgrade-ui.test.ts', 'wallet.test.ts', 'server-journal.test.ts']) {
    assert(inventory.includes(name), `tracked regression is missing: ${name}`);
    assert(selected.includes(name), `HEAD regression was excluded: ${name}`);
  }
  const future = 'future-wallet-safety.test.ts';
  assert(selectTargetOwnerHeadTests([...sourceTests(), future]).includes(future),
    'new tests remain included without expanding a hand-maintained HEAD allowlist');
});

test('HEAD selection refuses incomplete legacy inventory or omission of the new wallet UI suite', () => {
  const names = sourceTests();
  for (const required of [...legacySourceCompiledTests, 'target-owner-upgrade-ui.test.ts']) {
    assert.throws(() => selectTargetOwnerHeadTests(names.filter(name => name !== required)), required);
  }
});

test('HEAD selection rejects duplicate test names, traversal and paths outside the TypeScript test inventory', () => {
  const names = sourceTests();
  assert.throws(() => selectTargetOwnerHeadTests([...names, names[0]]), /Duplicate/);
  for (const malformed of ['../wallet.test.ts', 'src/wallet.test.ts', '/wallet.test.ts',
    'wallet.test.mjs', 'wallet.test.ts --test-name-pattern skip', 'wallet.ts']) {
    assert.throws(() => selectTargetOwnerHeadTests([...names, malformed]), /Unexpected TypeScript test path/);
  }
});
