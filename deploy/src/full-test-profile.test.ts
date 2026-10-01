import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { fullTestActivationProfile, validateFullTestConsoleConfig } from './full-test-profile';
import { fullTestStepGasLimit } from './deployment';
import { validatedFreshGasWallet } from './fresh-activation';
const digest = `0x${'1'.repeat(64)}`;
const deployer = getAddress('0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E');
const value = { schemaVersion: 1 as const, profile: 'full-test' as const, chainId: 56 as const, artifactDigest: digest,
  roles: { deployer, administratorOne: deployer, administratorTwo: deployer,
    gasWallet: getAddress('0x0C14b1008cFFe78711d65b13C8Ce5ca9B944252C') },
  timings: { holdSeconds: 0, proposalCooldownSeconds: 0, voteSeconds: 86400, listingSeconds: 604800, upgradeDelaySeconds: 0 } };
test('test deployer is the sole administrator, and the separate gas role is bound', () => {
  const config = validateFullTestConsoleConfig(value, digest);
  const profile = fullTestActivationProfile(config);
  assert.equal(profile.minTimelockDelaySeconds, 0);
  assert.equal(validatedFreshGasWallet(value.roles.gasWallet, deployer, profile), value.roles.gasWallet);
  assert.throws(() => validateFullTestConsoleConfig({ ...value, roles: { ...value.roles, gasWallet: deployer } }, digest));
  assert.throws(() => validateFullTestConsoleConfig(value, `0x${'2'.repeat(64)}`));
});
test('test gas plans cannot borrow a production digest or unbounded limit', () => {
  const plan = { schemaVersion: 1 as const, kind: 'bemine-full-test-gas-plan' as const, artifactDigest: digest,
    gasLimits: { initialize: '24000000' } };
  assert.equal(fullTestStepGasLimit(plan, digest, 'initialize'), 24000000n);
  assert.throws(() => fullTestStepGasLimit(plan, digest, 'PoolVault'));
  assert.throws(() => fullTestStepGasLimit(plan, `0x${'2'.repeat(64)}`, 'initialize'));
  assert.throws(() => fullTestStepGasLimit({ ...plan, gasLimits: { initialize: '30000001' } }, digest, 'initialize'));
});
