import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256 } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { integratedUpgradeDeploymentData, reviewedUpgradeBytecode } from './integrated-upgrade-plan.mjs';

export const TARGET_OWNER_UPGRADE_KIND = 'fixed-target-owner-beacon-upgrade-v1';
export const targetOwnerUpgradeDeploymentOrder = Object.freeze(['PoolFunds', 'FlexiblePurchase', 'PoolVault']);
const HASH = /^0x[\da-f]{64}$/i;
const BYTECODE = /^0x(?:[\da-f]{2}|__\$[\da-f]{34}\$__)+$/i;
const PLACEHOLDER = /^__\$[\da-f]{34}\$__$/i;
const links = Object.freeze({
  PoolFunds: [], FlexiblePurchase: ['PoolFunds', 'PurchaseValidation'],
  PoolVault: ['FirstoSale', 'FlexiblePurchase', 'MiningOperations', 'PoolFunds',
    'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints'],
});
const beacon = new Interface(['function upgradeTo(address)']);
const timelock = new Interface([
  'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function execute(address,uint256,bytes,bytes32,bytes32) payable',
]);
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function address(value, label) {
  try { const normalized = getAddress(value); need(normalized !== ZeroAddress, 'zero'); return normalized; }
  catch { throw new Error(`Invalid ${label} address.`); }
}
function pinned(value, digest, label) {
  need(HASH.test(digest ?? '') && same(value, digest), `${label} differs from its independently pinned digest.`);
}
function artifactLinks(artifact, field, bytecode) {
  need(BYTECODE.test(bytecode ?? ''), `Missing or malformed ${artifact.contractName} ${field} bytecode.`);
  const found = [], occupied = new Set();
  const references = artifact[field];
  need(references && typeof references === 'object' && !Array.isArray(references), `Missing ${field}.`);
  for (const [source, libraries] of Object.entries(references)) {
    for (const [name, locations] of Object.entries(libraries)) {
      need(source === `src/libraries/${name}.sol` && Array.isArray(locations) && locations.length > 0,
        `Unexpected ${artifact.contractName} ${field} source.`);
      found.push(name);
      for (const { start, length } of locations) {
        need(Number.isSafeInteger(start) && start >= 0 && length === 20 && 2 + (start + length) * 2 <= bytecode.length,
          `Invalid ${artifact.contractName} ${name} link location.`);
        need(PLACEHOLDER.test(bytecode.slice(2 + start * 2, 2 + (start + length) * 2)),
          `Missing ${artifact.contractName} ${name} link placeholder.`);
        for (let offset = start; offset < start + length; offset++) {
          need(!occupied.has(offset), `Overlapping ${artifact.contractName} links.`); occupied.add(offset);
        }
      }
    }
  }
  need(found.sort().join(',') === [...links[artifact.contractName]].sort().join(','),
    `Unexpected ${artifact.contractName} ${field} dependencies.`);
  return occupied;
}
function candidate(input) {
  pinned(buildDigest(input.upgradeBundle), input.trustedUpgradeArtifactDigest, 'Candidate artifact bundle');
  need(!same(input.trustedUpgradeArtifactDigest, input.genesisRecord.artifactDigest), 'Candidate must differ from genesis.');
  for (const name of targetOwnerUpgradeDeploymentOrder) {
    const artifact = input.upgradeBundle?.artifacts?.[name];
    need(artifact?.contractName === name && Array.isArray(artifact.abi), `Missing reviewed ${name} artifact.`);
    artifactLinks(artifact, 'linkReferences', artifact.bytecode);
    const occupied = artifactLinks(artifact, 'deployedLinkReferences', artifact.deployedBytecode);
    need((artifact.deployedBytecode.length - 2) / 2 <= 24576, `${name} exceeds EIP-170.`);
    need((artifact.bytecode.length - 2) / 2 <= 49152, `${name} exceeds EIP-3860.`);
    const constructors = artifact.abi.filter(item => item.type === 'constructor');
    const immutableGroups = Object.values(artifact.immutableReferences ?? {});
    if (name === 'PoolVault') {
      need(constructors.length === 1 && constructors[0].stateMutability === 'nonpayable'
        && constructors[0].inputs?.length === 1 && constructors[0].inputs[0].type === 'address',
      'PoolVault must have only its preserved factory constructor argument.');
      need(immutableGroups.length === 1 && Array.isArray(immutableGroups[0]) && immutableGroups[0].length > 0,
        'PoolVault must declare its preserved factory immutable binding.');
      for (const { start, length } of immutableGroups[0]) {
        need(Number.isSafeInteger(start) && start >= 0 && length === 32
          && 2 + (start + length) * 2 <= artifact.deployedBytecode.length
          && artifact.deployedBytecode.slice(2 + start * 2, 2 + (start + length) * 2) === '0'.repeat(64),
        'Invalid PoolVault factory immutable reference.');
        for (let offset = start; offset < start + length; offset++) {
          need(!occupied.has(offset), 'Overlapping PoolVault factory binding.'); occupied.add(offset);
        }
      }
    } else {
      need(constructors.length === 0 && immutableGroups.length === 0, `${name} must remain a constructor-free library.`);
      need(artifact.deployedBytecode.startsWith(`0x73${'0'.repeat(40)}`), `${name} library self-address prefix is missing.`);
    }
  }
}
function checked(input) {
  // These pins must come from the reviewer's independent approved evidence, never the supplied mutable inputs.
  pinned(evidenceDigest(input.genesisRecord), input.trustedGenesisRecordDigest, 'Genesis record');
  pinned(evidenceDigest(input.trustedGenesisManifest), input.trustedGenesisManifestDigest, 'Genesis manifest');
  const old = reviewedUpgradeBytecode.trustedGenesisAddresses(
    input.genesisRecord, input.genesisBundle, input.trustedGenesisManifest);
  candidate(input);
  need(input.replacements && !Array.isArray(input.replacements)
    && Object.keys(input.replacements).sort().join(',') === [...targetOwnerUpgradeDeploymentOrder].sort().join(','),
  'Exactly PoolFunds, FlexiblePurchase and PoolVault replacement keys are required.');
  const used = new Set(Object.values(old).filter(value => typeof value === 'string').map(value => value.toLowerCase()));
  const replacements = {};
  for (const name of targetOwnerUpgradeDeploymentOrder) {
    replacements[name] = address(input.replacements[name], name);
    need(!used.has(replacements[name].toLowerCase()), `Replacement ${name} reuses a graph address.`);
    used.add(replacements[name].toLowerCase());
  }
  need(HASH.test(input.salt ?? '') && BigInt(input.salt) !== 0n, 'A unique nonzero bytes32 salt is required.');
  need(Number.isSafeInteger(input.delaySeconds) && input.delaySeconds >= 172800, 'Delay must be at least 48 hours.');
  return { old, replacements, addresses: { ...old, ...replacements } };
}
function deployment(name, input, graph) {
  need(targetOwnerUpgradeDeploymentOrder.includes(name), 'Unknown target-owner deployment.');
  const artifact = input.upgradeBundle.artifacts[name];
  const data = integratedUpgradeDeploymentData(name, input.upgradeBundle, graph.addresses);
  need((data.length - 2) / 2 <= 49152, `${name} constructor initcode exceeds EIP-3860.`);
  const expectedRuntime = reviewedUpgradeBytecode.expectedRuntime(artifact, graph.addresses,
    graph.replacements[name], name === 'PoolVault' ? address(graph.old.factory, 'preserved factory') : null);
  return { name, address: graph.replacements[name], value: '0', data, expectedRuntime,
    codehash: keccak256(expectedRuntime), constructorArgs: name === 'PoolVault' ? [address(graph.old.factory, 'preserved factory')] : [],
    libraries: Object.fromEntries(links[name].map(dependency => [dependency, address(graph.addresses[dependency], dependency)])) };
}

/** Pure unsigned constructor data, with the same independently pinned evidence checks as the plan. */
export function targetOwnerUpgradeDeploymentData(name, input) { return deployment(name, input, checked(input)).data; }
/** Exact expected runtime including library self-address, links and the existing factory immutable. */
export function targetOwnerUpgradeExpectedRuntime(name, input) { return deployment(name, input, checked(input)).expectedRuntime; }

/** Offline review artifact only. It does not read RPC, sign, deploy, schedule or execute anything. */
export function buildTargetOwnerUpgradePlan(input) {
  const graph = checked(input);
  const target = address(graph.old.beacon, 'preserved beacon');
  const to = address(graph.old.timelock, 'preserved timelock');
  const data = beacon.encodeFunctionData('upgradeTo', [graph.replacements.PoolVault]);
  const args = [target, 0n, data, ZeroHash, input.salt];
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'bytes', 'bytes32', 'bytes32'], args));
  const scheduleData = timelock.encodeFunctionData('schedule', [...args, input.delaySeconds]);
  const executeData = timelock.encodeFunctionData('execute', args);
  return {
    kind: TARGET_OWNER_UPGRADE_KIND, chainId: 56, unsigned: true,
    genesisRecordDigest: input.trustedGenesisRecordDigest, genesisManifestDigest: input.trustedGenesisManifestDigest,
    genesisArtifactDigest: buildDigest(input.genesisBundle), upgradeArtifactDigest: input.trustedUpgradeArtifactDigest,
    replacements: graph.replacements, preservedFactory: address(graph.old.factory, 'preserved factory'),
    timelock: to, target, value: '0', data, predecessor: ZeroHash, salt: input.salt,
    delaySeconds: input.delaySeconds, operationId,
    deployments: targetOwnerUpgradeDeploymentOrder.map(name => deployment(name, input, graph)),
    steps: [{ name: 'Existing single-machine beacon', target, implementation: graph.replacements.PoolVault, value: '0', data }],
    scheduleData, executeData, schedule: { to, value: '0', data: scheduleData }, execute: { to, value: '0', data: executeData },
    currentChainStateVerified: false, replacementDeploymentVerified: false, saltUniquenessVerified: false,
  };
}
