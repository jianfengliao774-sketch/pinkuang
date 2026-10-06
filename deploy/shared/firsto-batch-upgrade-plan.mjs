import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256 } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { integratedUpgradeDeploymentData, reviewedUpgradeBytecode } from './integrated-upgrade-plan.mjs';
import { validateTargetOwnerUpgradeReview } from './target-owner-upgrade-plan.mjs';
import { validateTargetOwnerUpgradeCatalog } from './target-owner-upgrade-proof.mjs';

export const FIRSTO_BATCH_UPGRADE_KIND = 'firsto-batch-purchase-beacon-upgrade-v1';
export const FIRSTO_BATCH_REVIEW_KIND = 'firsto-batch-purchase-review-v1';
export const firstoBatchUpgradeDeploymentOrder = Object.freeze(['FlexiblePurchase', 'PoolVault']);
export const reviewedFirstoBatchProtocol = Object.freeze({
  exchange: '0x3F58C9cbce933c76158B2A29B0d612c46546Dc43',
  runtimeCodehash: '0x84072ba0b149f0cb72a8d1be49797ba293206d931407eeb2a25eeaf9f28db0b0',
});
const HASH = /^0x[\da-f]{64}$/i;
const need = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const beacon = new Interface(['function upgradeTo(address)']);
const lock = new Interface(['function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function execute(address,uint256,bytes,bytes32,bytes32) payable']);
const address = value => { const result = getAddress(value); need(result !== ZeroAddress, 'Zero address.'); return result; };
const predecessorCache = new WeakMap();

/** Derive the current mixed graph from the reviewed predecessor, never from caller-supplied addresses. */
export function firstoBatchPredecessor(input) {
  const identity = evidenceDigest({ catalog: input.priorCoreCatalog, bundle: input.priorCoreBundle,
    record: input.genesisRecord, genesis: input.genesisBundle, manifest: input.trustedGenesisManifest,
    recordPin: input.trustedGenesisRecordDigest, manifestPin: input.trustedGenesisManifestDigest,
    priorPin: input.trustedPriorCoreCatalogDigest });
  const cached = predecessorCache.get(input.priorCoreCatalog);
  if (cached?.identity === identity) return cached.value;
  const approved = validateTargetOwnerUpgradeCatalog(input.priorCoreCatalog, input.priorCoreBundle, input,
    { trustedCatalogDigest: input.trustedPriorCoreCatalogDigest });
  const prior = approved.input;
  const baseline = validateTargetOwnerUpgradeReview(prior);
  const addresses = { ...baseline.addresses }, nodes = JSON.parse(JSON.stringify(baseline.catalog.nodes));
  for (const name of ['PoolFunds', 'FlexiblePurchase', 'PoolVault']) addresses[name] = address(approved.catalog.deployments[name].address);
  for (const name of ['PoolFunds', 'FlexiblePurchase', 'PoolVault']) {
    const artifact = approved.bundle.artifacts[name];
    const dependencies = Object.values(artifact.deployedLinkReferences ?? {}).flatMap(row => Object.keys(row));
    const links = Object.fromEntries(dependencies.map(dependency => [dependency, addresses[dependency]]));
    const immutableAddress = name === 'PoolVault' ? addresses.factory : null;
    const runtime = reviewedUpgradeBytecode.expectedRuntime(artifact, links, addresses[name], immutableAddress);
    nodes[name] = { address: addresses[name], artifact, links, immutableAddress, codehash: keccak256(runtime) };
  }
  const value = { approved, baseline, addresses, nodes };
  predecessorCache.set(input.priorCoreCatalog, { identity, value }); return value;
}

/** Independently pinned full review, including the completed core predecessor and protocol source evidence. */
export function validateFirstoBatchUpgradeReview(input) {
  const prior = firstoBatchPredecessor(input), catalog = input.reviewCatalog;
  need(HASH.test(input.trustedReviewCatalogDigest ?? '') && same(evidenceDigest(catalog), input.trustedReviewCatalogDigest),
    'Firsto batch review differs from its independent pin.');
  need(catalog?.schemaVersion === 1 && catalog.kind === FIRSTO_BATCH_REVIEW_KIND && catalog.chainId === 56
    && catalog.profile === prior.approved.catalog.profile, 'Unsupported Firsto batch review.');
  need(same(catalog.priorCoreCatalogDigest, input.trustedPriorCoreCatalogDigest)
    && same(catalog.candidateArtifactDigest, input.trustedUpgradeArtifactDigest)
    && same(buildDigest(input.upgradeBundle), input.trustedUpgradeArtifactDigest), 'Predecessor or candidate artifact pin differs.');
  // Reuse the original strict artifact/link/constructor checks; the old graph remains the historical predecessor.
  const originalReview = { ...prior.baseline.catalog, candidateArtifactDigest: input.trustedUpgradeArtifactDigest };
  validateTargetOwnerUpgradeReview({ ...prior.approved.input, upgradeBundle: input.upgradeBundle,
    trustedUpgradeArtifactDigest: input.trustedUpgradeArtifactDigest, reviewCatalog: originalReview,
    trustedReviewCatalogDigest: evidenceDigest(originalReview) });
  need(evidenceDigest(catalog.nodes) === evidenceDigest(prior.nodes)
    && evidenceDigest(catalog.bindings) === evidenceDigest(prior.baseline.catalog.bindings)
    && evidenceDigest(catalog.authority) === evidenceDigest(prior.baseline.catalog.authority)
    && same(catalog.deployer, prior.baseline.catalog.deployer), 'Current mixed graph differs from the approved completed core graph.');
  need(Number.isSafeInteger(catalog.anchor?.blockNumber) && catalog.anchor.blockNumber >= prior.approved.catalog.verification.blockNumber
    && HASH.test(catalog.anchor.blockHash ?? ''), 'Current finalized review anchor is missing.');
  need(HASH.test(input.trustedProtocolReviewDigest ?? '')
    && same(evidenceDigest(input.protocolReview), input.trustedProtocolReviewDigest)
    && same(catalog.protocolReviewDigest, input.trustedProtocolReviewDigest)
    && input.protocolReview?.kind === 'firsto-batch-exact-source-review-v1'
    && input.protocolReview.chainId === 56 && input.protocolReview.exactRuntimeMatch === true
    && input.protocolReview.localFillVerified === true
    && same(input.protocolReview.exchange, reviewedFirstoBatchProtocol.exchange)
    && same(input.protocolReview.runtimeCodehash, reviewedFirstoBatchProtocol.runtimeCodehash), 'Exact protocol source and local fill evidence are required.');
  const runtimes = Object.fromEntries(Object.entries(prior.nodes).map(([name, node]) => [name,
    reviewedUpgradeBytecode.expectedRuntime(node.artifact, node.links, node.address, node.immutableAddress)]));
  return { old: prior.baseline.old, catalog, addresses: prior.addresses, runtimes,
    implementationNames: prior.baseline.implementationNames, predecessor: prior.approved, protocol: reviewedFirstoBatchProtocol };
}

export function prepareFirstoBatchUpgradeDeployment(name, input, { deploymentsPrefix = {} } = {}) {
  const review = validateFirstoBatchUpgradeReview(input), index = firstoBatchUpgradeDeploymentOrder.indexOf(name);
  need(index >= 0 && Object.keys(deploymentsPrefix).sort().join(',')
    === firstoBatchUpgradeDeploymentOrder.slice(0, index).sort().join(','), 'Only the exact confirmed deployment prefix is permitted.');
  const addresses = { ...review.addresses }, used = new Set(Object.values(addresses).map(value => value.toLowerCase()));
  for (const prior of firstoBatchUpgradeDeploymentOrder.slice(0, index)) {
    const item = deploymentsPrefix[prior], deployed = address(typeof item === 'string' ? item : item?.address);
    need(!used.has(deployed.toLowerCase()), 'Replacement reuses a preserved graph address.');
    used.add(deployed.toLowerCase()); addresses[prior] = deployed;
  }
  const data = integratedUpgradeDeploymentData(name, input.upgradeBundle, addresses);
  need((data.length - 2) / 2 <= 49152, 'Deployment exceeds the initcode size limit.');
  return { name, to: null, value: '0', data, unsigned: true, deployer: address(review.catalog.deployer),
    baselineVerified: false, replacementDeploymentVerified: false };
}

export function buildFirstoBatchUpgradePlan(input) {
  const review = validateFirstoBatchUpgradeReview(input), addresses = { ...review.addresses }, replacements = {};
  need(input.replacements && Object.keys(input.replacements).sort().join(',')
    === [...firstoBatchUpgradeDeploymentOrder].sort().join(','), 'Exactly two replacement addresses are required.');
  const used = new Set(Object.values(addresses).map(value => value.toLowerCase()));
  for (const name of firstoBatchUpgradeDeploymentOrder) {
    const value = address(input.replacements[name]); need(!used.has(value.toLowerCase()), 'Replacement reuses a graph address.');
    used.add(value.toLowerCase()); replacements[name] = value; addresses[name] = value;
  }
  need(HASH.test(input.salt ?? '') && !same(input.salt, ZeroHash), 'Unique nonzero upgrade salt is required.');
  need(Number.isSafeInteger(input.delaySeconds) && input.delaySeconds >= 172800, 'The full 48-hour upgrade delay is required.');
  const deployments = firstoBatchUpgradeDeploymentOrder.map(name => {
    const artifact = input.upgradeBundle.artifacts[name], dependencies = Object.values(artifact.deployedLinkReferences).flatMap(row => Object.keys(row));
    const data = integratedUpgradeDeploymentData(name, input.upgradeBundle, addresses);
    const expectedRuntime = reviewedUpgradeBytecode.expectedRuntime(artifact, addresses, replacements[name], name === 'PoolVault' ? addresses.factory : null);
    need((expectedRuntime.length - 2) / 2 <= 24576 && (data.length - 2) / 2 <= 49152, 'Deployment exceeds EVM code size limits.');
    return { name, address: replacements[name], value: '0', data, expectedRuntime, codehash: keccak256(expectedRuntime),
      constructorArgs: name === 'PoolVault' ? [addresses.factory] : [],
      libraries: Object.fromEntries(dependencies.map(dependency => [dependency, addresses[dependency]])) };
  });
  const target = addresses.beacon, to = addresses.timelock, data = beacon.encodeFunctionData('upgradeTo', [replacements.PoolVault]);
  const args = [target, 0n, data, ZeroHash, input.salt];
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(['address','uint256','bytes','bytes32','bytes32'], args));
  const scheduleData = lock.encodeFunctionData('schedule', [...args, input.delaySeconds]), executeData = lock.encodeFunctionData('execute', args);
  return { kind: FIRSTO_BATCH_UPGRADE_KIND, chainId: 56, unsigned: true, priorCoreCatalogDigest: input.trustedPriorCoreCatalogDigest,
    upgradeArtifactDigest: input.trustedUpgradeArtifactDigest, protocolReviewDigest: input.trustedProtocolReviewDigest,
    replacements, preservedFactory: addresses.factory, target, timelock: to, value: '0', data, predecessor: ZeroHash,
    salt: input.salt, delaySeconds: input.delaySeconds, operationId, deployments,
    steps: [{ name: 'Firsto batch single-leaf procurement', target, implementation: replacements.PoolVault, value: '0', data }],
    scheduleData, executeData, schedule: { to, value: '0', data: scheduleData }, execute: { to, value: '0', data: executeData },
    currentChainStateVerified: false, replacementDeploymentVerified: false, saltUniquenessVerified: false };
}
