import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256 } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { integratedUpgradeDeploymentData, reviewedUpgradeBytecode } from './integrated-upgrade-plan.mjs';

export const TARGET_OWNER_UPGRADE_KIND = 'fixed-target-owner-beacon-upgrade-v1';
export const targetOwnerUpgradeDeploymentOrder = Object.freeze(['PoolFunds', 'FlexiblePurchase', 'PoolVault']);
export const TARGET_OWNER_REVIEW_KIND = 'fixed-target-owner-review-catalog-v1';
export const targetOwnerBaselineNames = Object.freeze([
  'FlexiblePurchase', 'MiningOperations', 'PoolFunds', 'PurchaseValidation', 'RewardAccounting',
  'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints', 'FirstoSale', 'AtomicDeployment', 'PoolVault',
  'FreshPoolFactory', 'ShareMarket', 'BudgetPortfolioFactory', 'BudgetPortfolioVault', 'factory',
  'shareMarket', 'lens', 'beacon', 'timelock', 'portfolioFactory', 'portfolioShareMarket', 'portfolioBeacon',
]);
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
function baseEvidence(input) {
  // These pins must come from the reviewer's independent approved evidence, never the supplied mutable inputs.
  pinned(evidenceDigest(input.genesisRecord), input.trustedGenesisRecordDigest, 'Genesis record');
  pinned(evidenceDigest(input.trustedGenesisManifest), input.trustedGenesisManifestDigest, 'Genesis manifest');
  const old = reviewedUpgradeBytecode.trustedGenesisAddresses(
    input.genesisRecord, input.genesisBundle, input.trustedGenesisManifest);
  candidate(input);
  return old;
}

/** Full current graph is reviewed per node; a new Funds address never rewrites an existing FirstoSale link. */
export function validateTargetOwnerUpgradeReview(input) {
  const old = baseEvidence(input), catalog = input.reviewCatalog;
  pinned(evidenceDigest(catalog), input.trustedReviewCatalogDigest, 'Current review catalog');
  need(catalog?.schemaVersion === 1 && catalog.kind === TARGET_OWNER_REVIEW_KIND && catalog.chainId === 56
    && ['formal', 'full-test'].includes(catalog.profile), 'Unsupported current review catalog.');
  for (const [key, expected] of Object.entries({ genesisRecordDigest: input.trustedGenesisRecordDigest,
    genesisManifestDigest: input.trustedGenesisManifestDigest, genesisArtifactDigest: buildDigest(input.genesisBundle),
    candidateArtifactDigest: input.trustedUpgradeArtifactDigest })) need(same(catalog[key], expected), `Review ${key} differs.`);
  need(Number.isSafeInteger(catalog.anchor?.blockNumber) && catalog.anchor.blockNumber > 0
    && HASH.test(catalog.anchor?.blockHash ?? ''), 'Current graph anchor is missing.');
  const formal = ['factory', 'portfolioFactory', 'beacon', 'portfolioBeacon', 'timelock', 'lens', 'shareMarket', 'portfolioShareMarket'];
  for (const name of formal) need(same(catalog.bindings?.[name], old[name]), `Preserved formal binding differs: ${name}.`);
  need(same(catalog.bindings?.proposer, input.genesisRecord.input.ownerMultisig), 'Current proposer differs.');
  address(catalog.deployer, 'reviewed deployer');
  const active = catalog.authority, manifestActive = input.trustedGenesisManifest.freshAuthority;
  need(active && HASH.test(active.codehash ?? ''), 'Current Authority review is missing.');
  for (const name of ['address', 'administratorOne', 'administratorTwo', 'gasWallet']) {
    address(active[name], `Authority ${name}`);
    need(manifestActive && same(active[name], manifestActive[name]), `Preserved Authority ${name} differs.`);
  }
  need(same(active.codehash, manifestActive.codehash), 'Preserved Authority codehash differs.');
  need(new Set([active.address, active.administratorOne, active.administratorTwo, active.gasWallet,
    old.factory, old.portfolioFactory, old.timelock].map(value => value.toLowerCase())).size === 7, 'Authority roles overlap.');
  const nodeNames = [...targetOwnerBaselineNames, ...(catalog.nodes?.PortfolioShareMarketImplementation ? ['PortfolioShareMarketImplementation'] : [])];
  need(catalog.nodes && Object.keys(catalog.nodes).sort().join(',') === nodeNames.sort().join(','),
    'The complete current baseline graph is required.');
  const aliases = { factory: 'ERC1967Proxy', shareMarket: 'ERC1967Proxy', portfolioFactory: 'ERC1967Proxy',
    portfolioShareMarket: 'ERC1967Proxy', lens: 'PoolLens', beacon: 'PoolBeacon', portfolioBeacon: 'PoolBeacon', timelock: 'PoolTimelock',
    PortfolioShareMarketImplementation: 'ShareMarket' };
  const graph = Object.fromEntries(nodeNames.map(name => [name, address(catalog.nodes[name]?.address, `baseline ${name}`)]));
  for (const name of formal) need(same(graph[name], old[name]), `Baseline formal address differs: ${name}.`);
  for (const name of ['PoolFunds', 'FlexiblePurchase', 'PurchaseValidation', 'MiningOperations', 'RewardAccounting', 'ShareCheckpoints'])
    need(same(graph[name], old[name]), `Unrelated baseline library changed: ${name}.`);
  need(same(catalog.nodes.FirstoSale.links?.PoolFunds, old.PoolFunds), 'Existing FirstoSale must retain old PoolFunds.');
  const runtimes = {};
  for (const name of nodeNames) {
    const node = catalog.nodes[name], artifact = node.artifact;
    need(artifact?.contractName === (aliases[name] ?? name) && Array.isArray(artifact.abi)
      && BYTECODE.test(artifact.deployedBytecode ?? '') && node.links && typeof node.links === 'object'
      && !Array.isArray(node.links), `Missing complete baseline artifact: ${name}.`);
    const found = [];
    for (const [source, references] of Object.entries(artifact.deployedLinkReferences ?? {})) {
      for (const [dependency, locations] of Object.entries(references)) {
        need(source === `src/libraries/${dependency}.sol` && Array.isArray(locations) && locations.length > 0,
          `Malformed baseline link graph: ${name}.`);
        need(same(node.links[dependency], graph[dependency]), `Baseline per-node link differs: ${name}/${dependency}.`);
        found.push(dependency);
      }
    }
    need([...new Set(found)].sort().join(',') === Object.keys(node.links).sort().join(','), `Baseline link keys differ: ${name}.`);
    const immutable = ({ AtomicDeployment: input.genesisRecord.account, PoolVault: old.factory,
      BudgetPortfolioVault: old.portfolioFactory, FreshPoolFactory: graph.FreshPoolFactory, ShareMarket: graph.ShareMarket,
      BudgetPortfolioFactory: graph.BudgetPortfolioFactory, lens: old.factory, beacon: old.factory,
      portfolioBeacon: old.portfolioFactory, PortfolioShareMarketImplementation: graph.PortfolioShareMarketImplementation })[name] ?? null;
    const hasImmutable = Object.values(artifact.immutableReferences ?? {}).flat().length > 0;
    need(hasImmutable ? immutable && same(node.immutableAddress, immutable) : node.immutableAddress == null,
      `Baseline immutable differs: ${name}.`);
    runtimes[name] = reviewedUpgradeBytecode.expectedRuntime(artifact, node.links, graph[name], hasImmutable ? immutable : null);
    need(HASH.test(node.codehash ?? '') && same(keccak256(runtimes[name]), node.codehash), `Baseline artifact codehash differs: ${name}.`);
    if ([...formal, 'PoolFunds', 'FlexiblePurchase', 'PurchaseValidation', 'MiningOperations', 'RewardAccounting', 'ShareCheckpoints', 'AtomicDeployment'].includes(name))
      need(same(runtimes[name], reviewedUpgradeBytecode.genesisRuntime(name, input.genesisRecord, input.genesisBundle)),
        `Preserved original genesis runtime differs: ${name}.`);
  }
  const implementationNames = catalog.implementations ?? { factory: 'FreshPoolFactory', portfolioFactory: 'BudgetPortfolioFactory',
    shareMarket: 'ShareMarket', portfolioShareMarket: 'ShareMarket', beacon: 'PoolVault', portfolioBeacon: 'BudgetPortfolioVault' };
  const expectedPointers = { factory: ['FreshPoolFactory'], portfolioFactory: ['BudgetPortfolioFactory'], shareMarket: ['ShareMarket'],
    portfolioShareMarket: ['ShareMarket', 'PortfolioShareMarketImplementation'], beacon: ['PoolVault'], portfolioBeacon: ['BudgetPortfolioVault'] };
  need(Object.keys(implementationNames).sort().join(',') === Object.keys(expectedPointers).sort().join(','), 'Current implementation pointer keys differ.');
  for (const [name, permitted] of Object.entries(expectedPointers)) need(permitted.includes(implementationNames[name])
    && graph[implementationNames[name]], `Current implementation alias differs: ${name}.`);
  return { old, catalog, addresses: graph, runtimes, implementationNames };
}

function checked(input) {
  const old = baseEvidence(input);
  const current = input.reviewCatalog ? validateTargetOwnerUpgradeReview(input).addresses : old;
  need(input.replacements && !Array.isArray(input.replacements)
    && Object.keys(input.replacements).sort().join(',') === [...targetOwnerUpgradeDeploymentOrder].sort().join(','),
  'Exactly PoolFunds, FlexiblePurchase and PoolVault replacement keys are required.');
  const used = new Set([...Object.values(old), ...Object.values(current)].filter(value => typeof value === 'string').map(value => value.toLowerCase()));
  const replacements = {};
  for (const name of targetOwnerUpgradeDeploymentOrder) {
    replacements[name] = address(input.replacements[name], name);
    need(!used.has(replacements[name].toLowerCase()), `Replacement ${name} reuses a graph address.`);
    used.add(replacements[name].toLowerCase());
  }
  need(HASH.test(input.salt ?? '') && BigInt(input.salt) !== 0n, 'A unique nonzero bytes32 salt is required.');
  need(Number.isSafeInteger(input.delaySeconds) && input.delaySeconds >= 172800, 'Delay must be at least 48 hours.');
  return { old, replacements, addresses: { ...current, ...replacements } };
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

/** Prepare only the next dependency deployment. Prior addresses are claims until receipt verification succeeds. */
export function prepareTargetOwnerUpgradeDeployment(name, input, { deploymentsPrefix = {} } = {}) {
  const baseline = validateTargetOwnerUpgradeReview(input), index = targetOwnerUpgradeDeploymentOrder.indexOf(name);
  need(index >= 0, 'Unknown target-owner deployment.');
  need(Object.keys(deploymentsPrefix).sort().join(',') === targetOwnerUpgradeDeploymentOrder.slice(0, index).sort().join(','),
    'Only the exact prior deployment prefix is permitted.');
  const addresses = { ...baseline.addresses }, used = new Set([...Object.values(baseline.old), ...Object.values(addresses)].map(value => value.toLowerCase()));
  for (const previous of targetOwnerUpgradeDeploymentOrder.slice(0, index)) {
    const value = deploymentsPrefix[previous], deployed = address(typeof value === 'string' ? value : value?.address, previous);
    need(!used.has(deployed.toLowerCase()), `Replacement ${previous} reuses a graph address.`); used.add(deployed.toLowerCase()); addresses[previous] = deployed;
  }
  const data = integratedUpgradeDeploymentData(name, input.upgradeBundle, addresses);
  need((data.length - 2) / 2 <= 49152, `${name} initcode exceeds EIP-3860.`);
  return { name, to: null, value: '0', data, unsigned: true, deployer: address(baseline.catalog.deployer, 'deployer'),
    baselineVerified: false, replacementDeploymentVerified: false };
}

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
