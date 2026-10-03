import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { buildTargetOwnerUpgradePlan, targetOwnerUpgradeDeploymentData, targetOwnerUpgradeExpectedRuntime,
  targetOwnerUpgradeDeploymentOrder } from './target-owner-upgrade-plan.mjs';

const json = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const record = json('../public/upgrade-genesis/genesis-record.json');
const genesisBundle = json('../public/upgrade-genesis/genesis-artifacts.json');
const manifest = json('../../web/public/data/frontend-manifest.json');
const dependencies = {
  PoolFunds: [], FlexiblePurchase: ['PoolFunds', 'PurchaseValidation'],
  PoolVault: ['FirstoSale', 'FlexiblePurchase', 'MiningOperations', 'PoolFunds',
    'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints'],
};
// Synthetic linker fixtures exercise the offline planner; they are never deployable candidate approval evidence.
function artifact(name) {
  const prefix = name === 'PoolVault' ? '6000' : `73${'0'.repeat(40)}6000`;
  let code = `0x${prefix}`;
  const refs = {};
  for (const dependency of dependencies[name]) {
    const start = (code.length - 2) / 2;
    code += `__$${keccak256(toUtf8Bytes(dependency)).slice(2, 36)}$__`;
    refs[`src/libraries/${dependency}.sol`] = { [dependency]: [{ start, length: 20 }] };
  }
  const immutableStart = (code.length - 2) / 2;
  const abi = name === 'PoolVault' ? [{ type: 'constructor', stateMutability: 'nonpayable',
    inputs: [{ name: 'officialFactory_', type: 'address' }] }] : [];
  return { contractName: name, abi, bytecode: code + '6000', linkReferences: structuredClone(refs),
    deployedBytecode: code + (name === 'PoolVault' ? '0'.repeat(64) : '') + '00', deployedLinkReferences: refs,
    immutableReferences: name === 'PoolVault' ? { factory: [{ start: immutableStart, length: 32 }] } : {} };
}
const upgradeBundle = { schemaVersion: 1, artifacts: Object.fromEntries(targetOwnerUpgradeDeploymentOrder.map(name => [name, artifact(name)])) };
const replacements = Object.fromEntries(targetOwnerUpgradeDeploymentOrder.map((name, index) =>
  [name, getAddress(`0x${(0x123400 + index).toString(16).padStart(40, '0')}`)]));
const common = { genesisRecord: record, genesisBundle, trustedGenesisManifest: manifest,
  trustedGenesisRecordDigest: evidenceDigest(record), trustedGenesisManifestDigest: evidenceDigest(manifest),
  upgradeBundle, trustedUpgradeArtifactDigest: buildDigest(upgradeBundle), replacements,
  salt: keccak256(toUtf8Bytes('independently reviewed target owner upgrade salt')), delaySeconds: 172800 };
const tl = new Interface(['function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function execute(address,uint256,bytes,bytes32,bytes32) payable']);
const beacon = new Interface(['function upgradeTo(address)']);
function changedCandidate(change) {
  const next = structuredClone(upgradeBundle); change(next);
  return { ...common, upgradeBundle: next, trustedUpgradeArtifactDigest: buildDigest(next) };
}

test('exact three deployments produce only one existing beacon schedule and execute', () => {
  const plan = buildTargetOwnerUpgradePlan(common);
  assert.deepEqual(Object.keys(plan.replacements), ['PoolFunds', 'FlexiblePurchase', 'PoolVault']);
  assert.equal(plan.steps.length, 1); assert.equal(plan.target, record.addresses.beacon);
  assert.equal(plan.schedule.to, record.addresses.timelock); assert.equal(plan.execute.to, record.addresses.timelock);
  assert.equal(plan.schedule.value, '0'); assert.equal(plan.execute.value, '0');
  const scheduled = tl.parseTransaction({ data: plan.scheduleData });
  const executed = tl.parseTransaction({ data: plan.executeData });
  assert.equal(scheduled.name, 'schedule'); assert.equal(executed.name, 'execute');
  assert.deepEqual([...scheduled.args].slice(0, 5), [...executed.args]);
  assert.equal(scheduled.args[0], record.addresses.beacon); assert.equal(scheduled.args[1], 0n);
  assert.equal(scheduled.args[3], ZeroHash); assert.equal(scheduled.args[5], 172800n);
  assert.equal(beacon.parseTransaction({ data: scheduled.args[2] }).args[0], replacements.PoolVault);
  assert.equal(plan.operationId, keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'bytes', 'bytes32', 'bytes32'], [...executed.args])));
  assert.equal(plan.currentChainStateVerified, false); assert.equal(plan.replacementDeploymentVerified, false);
  assert.equal(plan.saltUniquenessVerified, false); assert.equal(plan.unsigned, true);
});
test('new Flexible uses new Funds plus old validation; Vault preserves other links and old factory', () => {
  const plan = buildTargetOwnerUpgradePlan(common);
  const [funds, flexible, vault] = plan.deployments;
  assert.deepEqual(funds.libraries, {});
  assert.deepEqual(flexible.libraries, { PoolFunds: replacements.PoolFunds, PurchaseValidation: record.addresses.PurchaseValidation });
  for (const [name, linked] of Object.entries(vault.libraries)) {
    assert.equal(linked, replacements[name] ?? record.addresses[name]);
  }
  assert.deepEqual(vault.constructorArgs, [record.addresses.factory]);
  assert.equal(vault.data.slice(-64), record.addresses.factory.slice(2).toLowerCase().padStart(64, '0'));
  for (const entry of plan.deployments) {
    assert.equal(entry.data, targetOwnerUpgradeDeploymentData(entry.name, common));
    assert.equal(entry.expectedRuntime, targetOwnerUpgradeExpectedRuntime(entry.name, common));
    assert.equal(entry.codehash, keccak256(entry.expectedRuntime));
  }
  assert(funds.expectedRuntime.startsWith(`0x73${replacements.PoolFunds.slice(2).toLowerCase()}`));
  assert(vault.expectedRuntime.includes(record.addresses.factory.slice(2).toLowerCase().padStart(64, '0')));
});
test('extra/missing keys, reused old addresses, duplicate and zero replacements are rejected', () => {
  for (const next of [{ ...replacements, PoolFactory: record.addresses.factory },
    { PoolFunds: replacements.PoolFunds, PoolVault: replacements.PoolVault }]) {
    assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, replacements: next }), /replacement keys/);
  }
  for (const next of [{ ...replacements, PoolFunds: record.addresses.PoolFunds },
    { ...replacements, FlexiblePurchase: replacements.PoolFunds }, { ...replacements, PoolVault: ZeroAddress }]) {
    assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, replacements: next }), /reuses|Invalid/);
  }
});
test('each old proof and candidate require independent digest pins', () => {
  for (const key of ['trustedGenesisRecordDigest', 'trustedGenesisManifestDigest', 'trustedUpgradeArtifactDigest']) {
    assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, [key]: undefined }), /pinned digest/);
    assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, [key]: ZeroHash }), /pinned digest/);
  }
  const next = structuredClone(upgradeBundle); next.artifacts.PoolFunds.bytecode += '00';
  assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, upgradeBundle: next }), /Candidate artifact bundle/);
  const changedRecord = structuredClone(record); changedRecord.addresses.beacon = replacements.PoolVault;
  assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, genesisRecord: changedRecord }), /Genesis record/);
  const changedManifest = structuredClone(manifest); changedManifest.beacon = replacements.PoolVault;
  assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, trustedGenesisManifest: changedManifest }), /Genesis manifest/);
  const changedGenesis = structuredClone(genesisBundle); changedGenesis.artifacts.PoolFunds.bytecode += '00';
  assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, genesisBundle: changedGenesis }), /Genesis artifact digest/);
});
test('repinning one old input cannot evade trusted genesis graph consistency', () => {
  const next = structuredClone(record); next.verification.code.PoolFunds.codehash = ZeroHash;
  assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, genesisRecord: next,
    trustedGenesisRecordDigest: evidenceDigest(next) }), /runtime is not derived/);
});
test('missing/unexpected links and malformed linker locations fail even for a repinned artifact', () => {
  for (const field of ['linkReferences', 'deployedLinkReferences']) {
    assert.throws(() => buildTargetOwnerUpgradePlan(changedCandidate(next => {
      delete next.artifacts.FlexiblePurchase[field]['src/libraries/PoolFunds.sol'];
    })), /dependencies|Unresolved/);
    assert.throws(() => buildTargetOwnerUpgradePlan(changedCandidate(next => {
      next.artifacts.FlexiblePurchase[field]['src/libraries/PoolFunds.sol'].PoolFunds[0].length = 19;
    })), /link location/);
  }
  assert.throws(() => buildTargetOwnerUpgradePlan(changedCandidate(next => {
    next.artifacts.PoolFunds.linkReferences['src/libraries/PurchaseValidation.sol'] = { PurchaseValidation: [{ start: 0, length: 20 }] };
  })), /placeholder|dependencies/);
});
test('ABI alone, wrong factory constructor and missing factory immutable are not approval evidence', () => {
  assert.throws(() => buildTargetOwnerUpgradePlan(changedCandidate(next => { next.artifacts.PoolVault.bytecode = '0x'; })), /malformed/);
  assert.throws(() => buildTargetOwnerUpgradePlan(changedCandidate(next => {
    next.artifacts.PoolVault.abi[0].inputs.push({ name: 'authority', type: 'address' });
  })), /constructor argument/);
  assert.throws(() => buildTargetOwnerUpgradePlan(changedCandidate(next => { next.artifacts.PoolVault.immutableReferences = {}; })), /immutable binding/);
});
test('salt and full 48-hour delay are mandatory and bound into canonical calldata', () => {
  for (const salt of [undefined, ZeroHash, '0x01']) assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, salt }), /salt/);
  for (const delaySeconds of [undefined, 172799, 172800.5, '172800', -1]) {
    assert.throws(() => buildTargetOwnerUpgradePlan({ ...common, delaySeconds }), /48 hours/);
  }
  const salt = keccak256(toUtf8Bytes('different reviewed salt'));
  assert.notEqual(buildTargetOwnerUpgradePlan({ ...common, salt }).operationId, buildTargetOwnerUpgradePlan(common).operationId);
  const plan = buildTargetOwnerUpgradePlan({ ...common, delaySeconds: 172801 });
  assert.equal(tl.parseTransaction({ data: plan.scheduleData }).args[5], 172801n);
});
