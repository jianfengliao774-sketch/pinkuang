import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest, evidenceDigest, settleReads } from './firsto-upgrade-proof.mjs';
import { nativeSalePolicyBaseline } from './fresh-native-sale-proof.mjs';

export const FRESH_SALE_POLICY_KIND = 'fresh-sale-policy-upgrade-v1';
const names = ['SaleGovernance', 'PoolVault', 'BudgetPortfolioVault', 'ShareMarket'];
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const need = (ok, message) => { if (!ok) throw new Error(message); };
const view = new Interface(['function implementation() view returns(address)',
  'function OFFICIAL_FACTORY() view returns(address)', 'function saleReviewThresholdBps() view returns(uint16)',
  'function automaticSaleReferenceVersion() view returns(uint8)', 'function saleReferencePublisher() view returns(address)',
  'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function isOperationDone(bytes32) view returns(bool)']);
const beacon = new Interface(['function upgradeTo(address)']);
const market = new Interface(['function upgradeToAndCall(address,bytes)']);
const cache = new WeakMap();

export function freshSalePolicySalt(factory, candidateArtifactDigest) {
  return keccak256(toUtf8Bytes(`bemine.sale-policy.v1:${factory.toLowerCase()}:${candidateArtifactDigest.toLowerCase()}`));
}

/** Operator-owned catalog and full bundle; a caller cannot select artifacts or replacements. */
export function validateFreshSalePolicyCatalog(catalog, bundle, trusted) {
  need(trusted?.freshAuthority && trusted.bundle?.artifacts?.FreshPoolFactory,
    'Sale policy requires the preserved fresh Authority deployment.');
  const a = trusted.record.addresses, authority = trusted.freshAuthority.authority;
  need(catalog?.schemaVersion === 1 && catalog.kind === FRESH_SALE_POLICY_KIND && catalog.chainId === 56
    && ['formal', 'full-test'].includes(catalog.profile)
    && same(catalog.genesisArtifactDigest, trusted.record.artifactDigest)
    && same(catalog.candidateArtifactDigest, buildDigest(bundle)), 'Sale policy artifact identity differs.');
  for (const key of ['factory', 'portfolioFactory', 'beacon', 'portfolioBeacon', 'shareMarket', 'timelock'])
    need(same(catalog.bindings?.[key], a[key]), `Sale policy binding differs: ${key}.`);
  for (const [key, expected] of [['authority', authority.address], ['gasWallet', authority.gasWallet],
    ['proposer', trusted.record.input.ownerMultisig]])
    need(same(catalog.bindings?.[key], expected), `Sale policy role differs: ${key}.`);
  for (const name of names) {
    need(bundle.artifacts?.[name] && catalog.artifacts?.[name]
      && evidenceDigest(catalog.artifacts[name]) === evidenceDigest(bundle.artifacts[name]), `Sale policy artifact differs: ${name}.`);
    if (name !== 'SaleGovernance') need(same(catalog.expectedImplementations?.[name], a[name]), `Sale policy baseline differs: ${name}.`);
  }
  for (const artifact of Object.values(catalog.artifacts))
    for (const links of Object.values(artifact.deployedLinkReferences ?? {})) for (const name of Object.keys(links))
      need(same(catalog.libraries?.[name], a[name]), `Sale policy library differs: ${name}.`);
  need(same(catalog.salt, freshSalePolicySalt(a.factory, catalog.candidateArtifactDigest)), 'Sale policy salt differs.');
  return JSON.parse(JSON.stringify({ catalog, bundle }));
}

export function freshSalePolicyOperation(catalog, replacements) {
  const targets = [catalog.bindings.beacon, catalog.bindings.portfolioBeacon, catalog.bindings.shareMarket];
  const values = [0n, 0n, 0n];
  const payloads = [beacon.encodeFunctionData('upgradeTo', [replacements.PoolVault]),
    beacon.encodeFunctionData('upgradeTo', [replacements.BudgetPortfolioVault]),
    market.encodeFunctionData('upgradeToAndCall', [replacements.ShareMarket, '0x'])];
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]', 'uint256[]', 'bytes[]', 'bytes32', 'bytes32'], [targets, values, payloads, ZeroHash, catalog.salt]));
  return { targets, values, payloads, predecessor: ZeroHash, salt: catalog.salt, operationId };
}

function libraryLinks(artifact, code) {
  const result = {}, bytes = code.slice(2);
  for (const links of Object.values(artifact.deployedLinkReferences ?? {})) for (const [name, locations] of Object.entries(links)) {
    for (const { start, length } of locations) {
      need(length === 20 && start >= 0 && (start + length) * 2 <= bytes.length, 'Sale policy library reference is invalid.');
      const address = getAddress('0x' + bytes.slice(start * 2, (start + length) * 2));
      need(!result[name] || same(result[name], address), 'Sale policy library slots disagree.'); result[name] = address;
    }
  }
  return result;
}

function exactRuntime(artifact, observed, links, address) {
  let expected = artifact.deployedBytecode.slice(2), actual = observed.slice(2);
  for (const libraries of Object.values(artifact.deployedLinkReferences ?? {})) for (const [name, locations] of Object.entries(libraries))
    for (const { start, length } of locations) {
      need(length === 20 && links[name], 'Sale policy runtime has unresolved libraries.');
      expected = expected.slice(0, start * 2) + links[name].slice(2) + expected.slice((start + length) * 2);
    }
  if (artifact.contractName === 'SaleGovernance' && expected.startsWith('73' + '0'.repeat(40)))
    expected = '73' + address.slice(2) + expected.slice(42);
  for (const locations of Object.values(artifact.immutableReferences ?? {})) for (const { start, length } of locations) {
    need(start >= 0 && length > 0 && (start + length) * 2 <= expected.length, 'Sale policy immutable reference is invalid.');
    expected = expected.slice(0, start * 2) + '0'.repeat(length * 2) + expected.slice((start + length) * 2);
    actual = actual.slice(0, start * 2) + '0'.repeat(length * 2) + actual.slice((start + length) * 2);
  }
  need(/^[\da-f]+$/i.test(expected) && expected.length === actual.length && expected.toLowerCase() === actual.toLowerCase(),
    `Sale policy exact runtime differs: ${artifact.contractName}.`);
}

/** Detect the complete fixed batch once, then reuse its canonical proof; ordinary graph reads check current code hashes. */
export async function verifyFreshSalePolicy(provider, trusted, block, { nativeUpgrade = null } = {}) {
  const policy = trusted.freshSalePolicy;
  if (!policy) return null;
  const { catalog, bundle } = policy, a = trusted.record.addresses, tag = '0x' + block.number.toString(16);
  const read = async (to, method, args = []) => view.decodeFunctionResult(method,
    await provider.send('eth_call', [{ to, data: view.encodeFunctionData(method, args) }, tag]))[0];
  const current = await settleReads([read(a.beacon, 'implementation'), read(a.portfolioBeacon, 'implementation'),
    provider.getStorage(a.shareMarket, SLOT, block.number).then(slot => {
      need(/^0x0{24}[\da-f]{40}$/i.test(slot), 'Sale policy market implementation slot is invalid.');
      return getAddress('0x' + slot.slice(-40));
    })]);
  if (nativeUpgrade) current[0] = getAddress(nativeSalePolicyBaseline(nativeUpgrade));
  const old = ['PoolVault', 'BudgetPortfolioVault', 'ShareMarket'].map((name, i) => same(current[i], a[name]));
  if (old.every(Boolean)) return null;
  need(old.every(value => !value), 'Sale policy upgrade is incomplete; all three targets must change in one batch.');
  const replacements = Object.fromEntries(['PoolVault', 'BudgetPortfolioVault', 'ShareMarket'].map((name, i) => [name, getAddress(current[i])]));
  need(new Set(current.map(value => value.toLowerCase())).size === 3
    && current.every(value => !same(value, ZeroAddress) && !Object.values(a).some(oldAddress => same(value, oldAddress))),
  'Sale policy replacement reuses a preserved graph address.');
  let providers = cache.get(policy);
  if (!providers) { providers = new WeakMap(); cache.set(policy, providers); }
  const key = current.map(value => value.toLowerCase()).join(':'), prior = providers.get(provider);
  if (prior?.key === key) {
    need(same((await provider.getBlock(prior.value.blockNumber))?.hash, prior.value.blockHash), 'Sale policy proof anchor changed.');
    return prior.value;
  }
  const codes = Object.fromEntries(await settleReads(Object.entries(replacements).map(async ([name, address]) =>
    [name, await provider.getCode(address, block.number)])));
  const links = libraryLinks(bundle.artifacts.PoolVault, codes.PoolVault);
  const saleGovernance = links.SaleGovernance;
  need(saleGovernance && !same(saleGovernance, ZeroAddress)
    && !Object.values(a).some(value => same(saleGovernance, value)) && !current.some(value => same(saleGovernance, value)),
  'Sale policy requires a separately deployed reviewed SaleGovernance library.');
  for (const [name, address] of Object.entries(links)) if (name !== 'SaleGovernance')
    need(same(address, a[name]), `Sale policy changed an unrelated library: ${name}.`);
  replacements.SaleGovernance = saleGovernance;
  codes.SaleGovernance = await provider.getCode(saleGovernance, block.number);
  const runtimeLinks = { ...a, SaleGovernance: saleGovernance };
  for (const name of names) exactRuntime(bundle.artifacts[name], codes[name], runtimeLinks, replacements[name]);
  const operation = freshSalePolicyOperation(catalog, replacements);
  const [coreBinding, budgetBinding, coreThreshold, budgetThreshold, referenceVersion, publisher, operationId, done] = await settleReads([
    read(replacements.PoolVault, 'OFFICIAL_FACTORY'), read(replacements.BudgetPortfolioVault, 'OFFICIAL_FACTORY'),
    read(replacements.PoolVault, 'saleReviewThresholdBps'), read(replacements.BudgetPortfolioVault, 'saleReviewThresholdBps'),
    read(a.shareMarket, 'automaticSaleReferenceVersion'), read(a.shareMarket, 'saleReferencePublisher'),
    read(a.timelock, 'hashOperationBatch', [operation.targets, operation.values, operation.payloads, ZeroHash, operation.salt]),
    read(a.timelock, 'isOperationDone', [operation.operationId]),
  ]);
  need(same(coreBinding, a.factory) && same(budgetBinding, a.portfolioFactory)
    && coreThreshold === 8000n && budgetThreshold === 8000n && referenceVersion === 1n
    && same(publisher, trusted.freshAuthority.authority.gasWallet)
    && same(operationId, operation.operationId) && done === true,
  'Sale policy bindings, version or fixed Timelock execution are incomplete.');
  const value = Object.freeze({ replacements, runtimeLinks,
    codehash: Object.fromEntries(names.map(name => [name, keccak256(codes[name])])),
    candidateArtifactDigest: catalog.candidateArtifactDigest, operationId: operation.operationId,
    saleReviewThresholdBps: 8000, automaticSaleReferenceVersion: 1, blockNumber: block.number, blockHash: block.hash });
  providers.set(provider, { key, value }); return value;
}
