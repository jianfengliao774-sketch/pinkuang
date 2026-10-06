import { Interface, keccak256 } from 'ethers';
import { buildDigest, evidenceDigest, settleReads } from './firsto-upgrade-proof.mjs';
import { reviewedUpgradeBytecode } from './integrated-upgrade-plan.mjs';
import { targetOwnerVerifiedUpgrade } from './target-owner-upgrade-proof.mjs';

const KIND = 'native-firsto-sale-compatibility-v1';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const need = (ok, message) => { if (!ok) throw new Error(message); };
const verified = new WeakSet();
const native = new Interface([
  'function nativeFirstoSaleVersion() pure returns(uint8)',
  'function nativeFirstoAsk() view returns(tuple(address maker,address collection,uint256 tokenId,uint256 nonce,uint128 price,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion) ask,bytes32 orderHash,bool active)',
  'function delist(uint8 action,uint256 cancellationId,uint256 expectedListedProposalId,bool support) returns(uint256)',
  'function delistingProposal(uint256 id) view returns(uint256,address,uint256,uint48,uint64,uint256,uint256,uint256,uint256,uint256,bool,bool)',
  'function cancelExpired()',
]);
const bindings = new Interface(['function implementation() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)']);

/** A completed successor can retain native sale without being the old native upgrade operation.
 * This only accepts the internally branded, independently pinned target-owner proof;
 * public capability JSON and caller-supplied versions cannot create this proof. */
export async function verifyNativeSaleCompatibility(provider, { upgrade, review, block }) {
  const completed = targetOwnerVerifiedUpgrade(upgrade);
  const catalog = review?.catalog, nodes = catalog?.reviewCatalog?.nodes, factory = catalog?.reviewCatalog?.bindings?.factory;
  need(completed.codeUpgradeComplete === true && same(completed.catalogDigest, review?.catalogDigest)
    && same(completed.reviewCatalogDigest, evidenceDigest(catalog?.reviewCatalog))
    && same(completed.candidateArtifactDigest, buildDigest(review?.bundle)), 'Native compatibility evidence differs from the completed upgrade.');
  need(Number.isSafeInteger(block?.number) && block.number >= completed.blockNumber
    && /^0x[\da-f]{64}$/i.test(block.hash ?? ''), 'Native compatibility requires a current canonical block.');
  const vault = completed.replacements.PoolVault, firsto = nodes.FirstoSale, oldFunds = nodes.PoolFunds;
  need(same(oldFunds.address, review.input.genesisRecord.addresses.PoolFunds)
    && same(firsto.links?.PoolFunds, oldFunds.address), 'Native compatibility must retain the original FirstoSale PoolFunds link.');
  for (const name of ['PoolFunds', 'FlexiblePurchase', 'PoolVault'])
    need(same(completed.replacements[name], catalog.deployments[name]?.address), 'Native compatibility replacement differs from the completed catalog.');
  const artifact = review.bundle.artifacts.PoolVault, abi = new Interface(artifact.abi);
  for (const expected of native.fragments) {
    const actual = abi.getFunction(expected.format('sighash'));
    need(actual && actual.stateMutability === expected.stateMutability
      && actual.outputs.map(item => item.format('sighash')).join(',') === expected.outputs.map(item => item.format('sighash')).join(','),
    `Reviewed native compatibility ABI is missing or changed: ${expected.name}.`);
  }
  const links = { ...Object.fromEntries(Object.entries(nodes).map(([name, node]) => [name, node.address])), ...completed.replacements };
  const expectedCodes = {
    PoolVault: reviewedUpgradeBytecode.expectedRuntime(artifact, links, vault, factory),
    FirstoSale: reviewedUpgradeBytecode.expectedRuntime(firsto.artifact, firsto.links, firsto.address, firsto.immutableAddress),
    OriginalPoolFunds: reviewedUpgradeBytecode.expectedRuntime(oldFunds.artifact, oldFunds.links, oldFunds.address, oldFunds.immutableAddress),
  };
  const addresses = { PoolVault: vault, FirstoSale: firsto.address, OriginalPoolFunds: oldFunds.address };
  const tag = `0x${block.number.toString(16)}`;
  const read = async (to, iface, method) => iface.decodeFunctionResult(method, await provider.send('eth_call',
    [{ to, data: iface.encodeFunctionData(method) }, tag]))[0];
  // These reads depend only on the completed pinned evidence and the same
  // block tag. Launch code and binding reads together, then validate every
  // result before the final canonical-block check can create a capability.
  const [codeEntries, pointer, immutable, version, chain] = await settleReads([
    settleReads(Object.entries(addresses).map(async ([name, address]) =>
      [name, await provider.getCode(address, block.number)])),
    read(catalog.reviewCatalog.bindings.beacon, bindings, 'implementation'), read(vault, bindings, 'OFFICIAL_FACTORY'),
    read(vault, native, 'nativeFirstoSaleVersion'), provider.send('eth_chainId', []),
  ]);
  const codes = Object.fromEntries(codeEntries);
  for (const name of Object.keys(expectedCodes)) need(same(codes[name], expectedCodes[name]), `Native compatibility exact runtime changed: ${name}.`);
  need(same(keccak256(codes.PoolVault), completed.codehash.PoolVault)
    && same(keccak256(codes.FirstoSale), firsto.codehash)
    && same(keccak256(codes.OriginalPoolFunds), oldFunds.codehash), 'Native compatibility reviewed codehash changed.');
  need(same(pointer, vault) && same(immutable, factory) && version === 1n && BigInt(chain) === 56n,
    'Native compatibility current Beacon, Factory, version or chain changed.');
  need(same((await provider.getBlock(block.number))?.hash, block.hash), 'Native compatibility block changed during verification.');
  const value = Object.freeze({ version: 1, kind: KIND, factory, beacon: catalog.reviewCatalog.bindings.beacon,
    implementation: vault, firstoSale: firsto.address, originalPoolFunds: oldFunds.address,
    candidateArtifactDigest: completed.candidateArtifactDigest, catalogDigest: review.catalogDigest,
    targetOwnerOperationId: completed.operationId,
    codehash: Object.freeze(Object.fromEntries(Object.entries(codes).map(([name, code]) => [name, keccak256(code)]))),
    verifiedBlockNumber: block.number, verifiedBlockHash: block.hash });
  verified.add(value); return value;
}

/** Server-side verified graphs only. A JSON round trip deliberately loses its proof brand. */
export function verifiedNativeSaleCompatibility(graph, { factory } = {}) {
  if (graph?.transactionReady === false) return null;
  const proof = graph?.nativeSaleCompatibility;
  const valid = verified.has(proof) && proof.kind === KIND && proof.version === 1
    && graph.productKind === 'pool' && same(graph.factory, proof.factory)
    && (factory === undefined || same(factory, proof.factory))
    && graph.blockNumber === proof.verifiedBlockNumber
    && same(graph.addresses?.PoolVault, proof.implementation) && same(graph.codehash?.PoolVault, proof.codehash.PoolVault)
    && same(graph.addresses?.FirstoSale, proof.firstoSale) && same(graph.codehash?.FirstoSale, proof.codehash.FirstoSale)
    && graph.targetOwnerUpgrade?.version === 1
    && same(graph.targetOwnerUpgrade.replacements?.PoolVault, proof.implementation)
    && same(graph.targetOwnerUpgrade.codehash?.PoolVault, proof.codehash.PoolVault)
    && same(graph.targetOwnerUpgrade.catalogDigest, proof.catalogDigest)
    && same(graph.targetOwnerUpgrade.candidateArtifactDigest, proof.candidateArtifactDigest)
    && same(graph.targetOwnerUpgrade.operationId, proof.targetOwnerOperationId);
  return valid ? proof : null;
}

export function hasVerifiedNativeSaleCapability(graph, options) {
  return graph?.transactionReady !== false && (graph?.nativeSaleUpgrade?.version === 1
    || verifiedNativeSaleCompatibility(graph, options) !== null);
}
