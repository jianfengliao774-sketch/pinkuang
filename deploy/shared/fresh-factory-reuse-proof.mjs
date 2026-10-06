import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest, evidenceDigest, settleReads } from './firsto-upgrade-proof.mjs';

export const FRESH_FACTORY_REUSE_KIND = 'fresh-sold-machine-reuse-upgrade-v1';
export const FACTORY_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const need = (ok, message) => { if (!ok) throw new Error(message); };
const actions = new Interface(['function upgradeToAndCall(address,bytes)']);
const views = new Interface(['function soldMachineReuseVersion() view returns(uint8)',
  'function proxiableUUID() view returns(bytes32)', 'function owner() view returns(address)',
  'function timelock() view returns(address)', 'function getMinDelay() view returns(uint256)',
  'function PROPOSER_ROLE() view returns(bytes32)', 'function hasRole(bytes32,address) view returns(bool)',
  'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function isOperationDone(bytes32) view returns(bool)']);
const cache = new WeakMap();
const validDelay = value => Number.isSafeInteger(value) && value >= 0
  || typeof value === 'string' && /^(0|[1-9]\d{0,15})$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);

export function factoryReuseSalt(factory, digest) {
  return keccak256(toUtf8Bytes(`bemine.sold-machine-reuse.v1:${factory.toLowerCase()}:${digest.toLowerCase()}`));
}

function immutableSlots(artifact) {
  const references = artifact.immutableReferences ?? {}, groups = Object.values(references);
  need(groups.length === 1 && Array.isArray(groups[0]) && groups[0].length > 0,
    'Factory reuse must contain only the UUPS self immutable.');
  const occupied = new Set();
  for (const slot of groups[0]) {
    need(Number.isSafeInteger(slot.start) && slot.start >= 0 && slot.length === 32
      && (slot.start + 32) * 2 <= artifact.deployedBytecode.length - 2, 'Factory UUPS immutable reference is invalid.');
    for (let index = slot.start; index < slot.start + 32; index++) {
      need(!occupied.has(index), 'Factory UUPS immutable references overlap.'); occupied.add(index);
    }
    need(/^0+$/.test(artifact.deployedBytecode.slice(2 + slot.start * 2, 2 + (slot.start + 32) * 2)),
      'Factory UUPS immutable artifact is not canonical.');
  }
  return groups[0];
}

/** A reviewed local attachment to the existing policy catalog, never a browser-selected candidate. */
export function validateFreshFactoryReuseCatalog(catalog, bundle, trusted) {
  need(trusted?.freshAuthority && trusted?.freshSalePolicy && trusted.bundle?.artifacts?.FreshPoolFactory,
    'Factory reuse requires the preserved fresh Authority and sale policy evidence.');
  const a = trusted.record.addresses, policy = trusted.freshSalePolicy.catalog;
  need(catalog?.schemaVersion === 1 && catalog.kind === FRESH_FACTORY_REUSE_KIND && catalog.chainId === 56
    && ['formal', 'full-test'].includes(catalog.profile) && catalog.profile === policy.profile
    && same(catalog.genesisArtifactDigest, trusted.record.artifactDigest)
    && same(catalog.candidateArtifactDigest, buildDigest(bundle)), 'Factory reuse artifact identity differs.');
  for (const key of ['factory', 'timelock']) need(same(catalog.bindings?.[key], a[key]), `Factory reuse binding differs: ${key}.`);
  need(same(catalog.bindings?.proposer, policy.bindings.proposer)
    && same(catalog.bindings.proposer, trusted.record.input.ownerMultisig), 'Factory reuse proposer differs.');
  need(same(catalog.expectedImplementations?.FreshPoolFactory, a.FreshPoolFactory)
    && same(a.PoolFactory ?? a.FreshPoolFactory, a.FreshPoolFactory), 'Factory reuse baseline differs.');
  need(validDelay(catalog.minimumDelaySeconds) && (catalog.profile === 'full-test'
    ? BigInt(catalog.minimumDelaySeconds) === 0n : BigInt(catalog.minimumDelaySeconds) >= 172800n), 'Factory reuse delay differs from its profile.');
  need(Object.keys(bundle.artifacts ?? {}).join(',') === 'FreshPoolFactory'
    && Object.keys(catalog.artifacts ?? {}).join(',') === 'FreshPoolFactory', 'Factory reuse may replace only FreshPoolFactory.');
  const artifact = bundle.artifacts.FreshPoolFactory;
  need(artifact.contractName === 'FreshPoolFactory' && Array.isArray(artifact.abi)
    && evidenceDigest(artifact) === evidenceDigest(catalog.artifacts.FreshPoolFactory), 'Factory reuse artifact differs.');
  for (const refs of [artifact.linkReferences, artifact.deployedLinkReferences])
    need(Object.values(refs ?? {}).every(libraries => Object.values(libraries).every(slots => Array.isArray(slots) && slots.length === 0)),
      'Factory reuse cannot introduce linked libraries.');
  need(/^0x[\da-f]+$/i.test(artifact.bytecode ?? '') && /^0x[\da-f]+$/i.test(artifact.deployedBytecode ?? '')
    && artifact.bytecode.length % 2 === 0 && artifact.deployedBytecode.length % 2 === 0
    && artifact.deployedBytecode.length <= 24576 * 2 + 2
    && !artifact.abi.some(fragment => fragment.type === 'constructor' && fragment.inputs?.length), 'Factory reuse creation or runtime is invalid.');
  immutableSlots(artifact);
  for (const method of ['soldMachineReuseVersion', 'proxiableUUID', 'upgradeToAndCall', 'owner', 'timelock'])
    need(new Interface(artifact.abi).getFunction(method), `Factory reuse ABI is missing ${method}.`);
  need(same(catalog.salt, factoryReuseSalt(a.factory, catalog.candidateArtifactDigest)), 'Factory reuse salt differs.');
  return JSON.parse(JSON.stringify({ catalog, bundle }));
}

export function freshFactoryReuseOperation(catalog, implementation) {
  const targets = [catalog.bindings.factory], values = [0n];
  const payloads = [actions.encodeFunctionData('upgradeToAndCall', [getAddress(implementation), '0x'])];
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]', 'uint256[]', 'bytes[]', 'bytes32', 'bytes32'], [targets, values, payloads, ZeroHash, catalog.salt]));
  return { targets, values, payloads, predecessor: ZeroHash, salt: catalog.salt, operationId };
}

/** Compare every byte. __self is the exact deployed implementation address, not a masked region. */
export function factoryReuseRuntimeMatches(artifact, observed, implementation) {
  let expected = artifact.deployedBytecode.slice(2).toLowerCase();
  const self = getAddress(implementation).slice(2).toLowerCase().padStart(64, '0');
  for (const { start, length } of immutableSlots(artifact))
    expected = expected.slice(0, start * 2) + self + expected.slice((start + length) * 2);
  return /^0x[\da-f]+$/i.test(observed ?? '') && observed.slice(2).toLowerCase() === expected;
}

/** A baseline proxy stays on its existing graph. Only the fixed completed one-target upgrade is accepted. */
export async function verifyFreshFactoryReuse(provider, trusted, block) {
  const evidence = trusted.freshFactoryReuse;
  if (!evidence) return null;
  const { catalog, bundle } = evidence, a = trusted.record.addresses, tag = '0x' + block.number.toString(16);
  const slot = await provider.getStorage(a.factory, FACTORY_IMPLEMENTATION_SLOT, block.number);
  need(/^0x0{24}[\da-f]{40}$/i.test(slot), 'Factory reuse implementation slot is invalid.');
  const implementation = getAddress('0x' + slot.slice(-40));
  if (same(implementation, a.FreshPoolFactory)) return null;
  need(!same(implementation, ZeroAddress) && !Object.values(a).some(old => same(old, implementation)), 'Factory reuse implementation reuses a preserved address.');
  let providers = cache.get(evidence);
  if (!providers) { providers = new WeakMap(); cache.set(evidence, providers); }
  const prior = providers.get(provider);
  if (prior && same(prior.implementation, implementation)) {
    need(same((await provider.getBlock(prior.value.blockNumber))?.hash, prior.value.blockHash), 'Factory reuse proof anchor changed.');
    return prior.value;
  }
  const code = await provider.getCode(implementation, block.number);
  need(factoryReuseRuntimeMatches(bundle.artifacts.FreshPoolFactory, code, implementation), 'Factory reuse exact runtime differs.');
  const read = async (to, method, args = []) => views.decodeFunctionResult(method, await provider.send('eth_call',
    [{ to, data: views.encodeFunctionData(method, args) }, tag]))[0];
  const operation = freshFactoryReuseOperation(catalog, implementation);
  const [version, proxyVersion, uuid, owner, timelock, delay, proposerRole, operationId, done] = await settleReads([
    read(implementation, 'soldMachineReuseVersion'), read(a.factory, 'soldMachineReuseVersion'),
    read(implementation, 'proxiableUUID'), read(a.factory, 'owner'), read(a.factory, 'timelock'),
    read(a.timelock, 'getMinDelay'), read(a.timelock, 'PROPOSER_ROLE'),
    read(a.timelock, 'hashOperationBatch', [operation.targets, operation.values, operation.payloads, ZeroHash, operation.salt]),
    read(a.timelock, 'isOperationDone', [operation.operationId]),
  ]);
  need(version === 1n && proxyVersion === 1n && same(uuid, FACTORY_IMPLEMENTATION_SLOT)
    && same(owner, a.timelock) && same(timelock, a.timelock) && delay === BigInt(catalog.minimumDelaySeconds)
    && same(operationId, operation.operationId) && done === true, 'Factory reuse version, UUPS, bindings or fixed Timelock execution are incomplete.');
  need(await read(a.timelock, 'hasRole', [proposerRole, catalog.bindings.proposer]) === true, 'Factory reuse proposer permission changed.');
  need(same((await provider.getBlock(block.number))?.hash, block.hash), 'Factory reuse proof block changed.');
  const codehash = keccak256(code), value = Object.freeze({ version: 1,
    replacements: { PoolFactory: implementation, FreshPoolFactory: implementation },
    codehash: { PoolFactory: codehash, FreshPoolFactory: codehash },
    candidateArtifactDigest: catalog.candidateArtifactDigest, operationId: operation.operationId,
    blockNumber: block.number, blockHash: block.hash });
  providers.set(provider, { implementation, value }); return value;
}
