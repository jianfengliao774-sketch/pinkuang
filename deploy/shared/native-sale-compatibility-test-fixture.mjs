import { Interface } from 'ethers';
import { evidenceDigest } from './firsto-upgrade-proof.mjs';
import { createTargetOwnerFixture } from './target-owner-upgrade-test-fixture.mjs';
import { validateTargetOwnerUpgradeCatalog, verifyTargetOwnerUpgrade } from './target-owner-upgrade-proof.mjs';
import { verifyNativeSaleCompatibility } from './native-sale-compatibility.mjs';

const abi = new Interface([
  'function nativeFirstoSaleVersion() pure returns(uint8)',
  'function nativeFirstoAsk() view returns(tuple(address maker,address collection,uint256 tokenId,uint256 nonce,uint128 price,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion) ask,bytes32 orderHash,bool active)',
  'function delist(uint8,uint256,uint256,bool) returns(uint256)',
  'function delistingProposal(uint256) view returns(uint256,address,uint256,uint48,uint64,uint256,uint256,uint256,uint256,uint256,bool,bool)',
  'function cancelExpired()',
]);

/** Synthetic proof chain only. No credentials, network calls or transactions. */
export async function nativeSaleCompatibilityFixture({ missingAbi = false } = {}) {
  const f = createTargetOwnerFixture({ vaultAbi: missingAbi ? [] : abi.fragments.map(fragment => JSON.parse(fragment.format('json'))) });
  const send = f.provider.send.bind(f.provider);
  f.provider.send = async (method, args) => {
    if (method === 'eth_call' && args[0].data === abi.encodeFunctionData('nativeFirstoSaleVersion')) {
      if (f.state.nativeReadError) throw Error('native view unavailable');
      return abi.encodeFunctionResult('nativeFirstoSaleVersion', [f.state.nativeVersion ?? 1n]);
    }
    return send(method, args);
  };
  const review = validateTargetOwnerUpgradeCatalog(f.finalCatalog, f.input.upgradeBundle, f.input,
    { trustedCatalogDigest: evidenceDigest(f.finalCatalog) });
  const block = structuredClone(f.blocks.get(400)), upgrade = await verifyTargetOwnerUpgrade(f.provider, { targetOwnerUpgrade: review }, block);
  const input = { review, upgrade, block };
  const makeGraph = async () => ({ factory: f.input.reviewCatalog.bindings.factory, productKind: 'pool', blockNumber: block.number,
    addresses: { ...Object.fromEntries(Object.entries(f.input.reviewCatalog.nodes).map(([name, node]) => [name, node.address])), ...upgrade.replacements },
    codehash: { PoolVault: upgrade.codehash.PoolVault, FirstoSale: f.input.reviewCatalog.nodes.FirstoSale.codehash },
    targetOwnerUpgrade: { version: 1, replacements: upgrade.replacements, codehash: upgrade.codehash,
      candidateArtifactDigest: upgrade.candidateArtifactDigest, catalogDigest: review.catalogDigest, operationId: upgrade.operationId },
    nativeSaleCompatibility: await verifyNativeSaleCompatibility(f.provider, input) });
  return { ...f, review, upgrade, block, compatibilityInput: input, makeGraph };
}
