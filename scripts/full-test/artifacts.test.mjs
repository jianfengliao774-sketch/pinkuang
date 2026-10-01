import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { artifactContentDigest, libraryNames, linkedDeploymentOrder, repositoryRoot, requiredContracts, validateArtifacts } from '../../deploy/scripts/build-artifacts.mjs';
import { outputDirectory, outputPath } from './build-artifacts.mjs';
import { FULL_TEST_TIMINGS, TIMING_TRANSFORMS, ADMINISTRATOR_TRANSFORMS, sha256 } from './profile.mjs';

test('independent profile binds the same 21 ABIs and only approved input changes', () => {
  const saved = JSON.parse(readFileSync(outputPath, 'utf8'));
  const formal = JSON.parse(readFileSync(join(repositoryRoot, 'deploy/public/deployment-artifacts.json'), 'utf8'));
  validateArtifacts(saved.artifacts);
  assert.equal(saved.metadata.profile, 'full-test');
  assert.deepEqual(saved.metadata.timings, FULL_TEST_TIMINGS);
  assert.equal(saved.metadata.formalArtifactDigest, artifactContentDigest(formal));
  assert.deepEqual(saved.originalSourceHashes, formal.sourceHashes);
  const modifiedNames = new Set([...TIMING_TRANSFORMS, ...ADMINISTRATOR_TRANSFORMS].map(item => item.sourceName));
  for (const [name, originalHash] of Object.entries(saved.originalSourceHashes)) {
    assert.equal(name.startsWith('src/') ? sha256(readFileSync(join(repositoryRoot, 'contracts', name)))
      : sha256(readFileSync(join(repositoryRoot, 'node_modules', name))), originalHash);
    assert.equal(saved.sourceHashes[name] !== originalHash, modifiedNames.has(name), `Unexpected transformed input ${name}`);
  }
  for (const name of requiredContracts) assert.deepEqual(saved.artifacts[name].abi, formal.artifacts[name].abi);
  assert.notEqual(artifactContentDigest(saved), artifactContentDigest(formal));
  const changed = structuredClone(saved);
  changed.metadata.timings.holdSeconds = 1;
  assert.notEqual(artifactContentDigest(changed), artifactContentDigest(saved), 'Profile metadata must be digest-bound.');
});

test('measured full 16+7 gas plan has exact steps, correct digest, and sufficient headroom', () => {
  const bundle = JSON.parse(readFileSync(outputPath, 'utf8'));
  const gas = JSON.parse(readFileSync(join(outputDirectory, 'gas-plan.json'), 'utf8'));
  assert.equal(gas.artifactDigest, artifactContentDigest(bundle));
  assert.equal(gas.kind, 'bemine-full-test-gas-plan');
  const expected = [...linkedDeploymentOrder(bundle.artifacts).filter(name => libraryNames.includes(name)),
    'AtomicDeployment', 'PoolVault', 'FreshPoolFactory', 'ShareMarket', 'BudgetPortfolioFactory', 'BudgetPortfolioVault', 'initialize'];
  assert.deepEqual(Object.keys(gas.gasLimits), expected);
  assert.deepEqual(Object.keys(gas.activationGasLimits), ['deployAuthority', 'coreOperator', 'coreTreasury', 'budgetOperator', 'budgetTreasury', 'coreOwner', 'budgetOwner']);
  if (gas.measurementArtifactDigest) {
    const reuse = JSON.parse(readFileSync(join(outputDirectory, 'bootstrap-reuse-proof.json'), 'utf8'));
    assert.equal(reuse.previousArtifactDigest, gas.measurementArtifactDigest);
    assert.equal(reuse.artifactDigest, gas.artifactDigest);
    assert.equal(reuse.changedRuntime, 'PlatformAuthority');
    assert.equal(reuse.preservedRuntimeCount, 20);
    assert.equal(gas.activationGasLimits.deployAuthority, '6000000');
    assert.match(gas.limitPolicy, /explicit 6,000,000 gas cap/);
    return;
  }
  const evidence = JSON.parse(readFileSync(join(outputDirectory, 'local-graph-evidence.json'), 'utf8'));
  assert.equal(evidence.steps.length, 23);
  assert.equal(evidence.artifactDigest, gas.artifactDigest);
  assert.equal(evidence.productionTransactions, 0);
  assert.match(evidence.protocolEvidence, /not live protocol or mainnet\/fork evidence/);
  const limits = { ...gas.gasLimits, ...gas.activationGasLimits };
  for (const step of evidence.steps) {
    assert.match(limits[step.id], /^[1-9][0-9]*$/);
    assert(BigInt(limits[step.id]) > BigInt(step.gasUsed) * 130n / 100n + 50_000n);
    assert(BigInt(limits[step.id]) < 16_777_216n);
  }
});
