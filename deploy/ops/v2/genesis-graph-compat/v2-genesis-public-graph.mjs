// This module is copied into a staged d09b25c v2 runtime. It only describes
// that runtime's original integrated-v2 deployment; it has no upgrade path.
const HASH = /^0x[0-9a-f]{64}$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const manifestNames = Object.freeze({
  factory: 'factory', shareMarket: 'shareMarket', lens: 'lens', beacon: 'beacon', timelock: 'timelock',
  portfolioFactory: 'portfolioFactory', portfolioMarket: 'portfolioShareMarket',
  portfolioBeacon: 'portfolioBeacon', portfolioImplementation: 'BudgetPortfolioVault',
  portfolioFactoryImplementation: 'BudgetPortfolioFactory',
});

export function formatV2GenesisGraph(record, graph, finalized, activation) {
  assert(record?.schemaVersion === 1 && record.kind === 'integrated-v2' && record.status === 'complete',
    'Only the original integrated-v2 deployment can be published.');
  const initial = record.steps?.find(step => step.id === 'initialize');
  assert(initial?.status === 'confirmed' && initial.receipt?.status === 1
    && HASH.test(initial.txHash) && HASH.test(initial.receipt.blockHash), 'Initialization proof is incomplete.');
  assert(Number.isSafeInteger(finalized?.number) && HASH.test(finalized.hash)
    && finalized.number >= record.verification?.blockNumber
    && Number.isSafeInteger(activation?.number) && Number.isSafeInteger(activation.timestamp)
    && activation.timestamp > 0 && activation.number === initial.receipt.blockNumber
    && same(activation.hash, initial.receipt.blockHash) && activation.number <= finalized.number,
  'Finalized or activation block is inconsistent with the reviewed record.');
  assert(graph?.productKind === 'pool' && same(graph.factory, record.addresses?.factory)
    && same(graph.legacyFactory, record.addresses?.factory)
    && same(graph.artifactDigest, record.artifactDigest)
    && graph.blockNumber === finalized.number && !graph.upgrade,
  'The verified graph is not the original deployment.');

  const addresses = {}, codehash = {};
  for (const [key, name] of Object.entries(manifestNames)) {
    const address = record.addresses?.[name], code = record.verification?.code?.[name];
    assert(typeof address === 'string' && same(code?.address, address) && HASH.test(code?.codehash),
      `Missing reviewed ${name} code evidence.`);
    addresses[key] = address;
    codehash[key] = code.codehash;
  }
  const manifest = {
    schemaVersion: 1, chainId: 56, kind: 'integrated-v2', ...addresses,
    deployment: { txHash: initial.txHash, blockNumber: initial.receipt.blockNumber,
      blockHash: initial.receipt.blockHash },
    artifactDigest: record.artifactDigest, sourceCommit: record.sourceCommit,
    verifiedAt: new Date(activation.timestamp * 1000).toISOString(),
    verifiedBlockNumber: activation.number, codehash,
  };
  return {
    status: 'verified', chainId: 56, stage: 'genesis', artifactDigest: record.artifactDigest,
    genesisArtifactDigest: record.artifactDigest, upgradeArtifactDigest: null, operationId: null,
    verifiedBlockNumber: finalized.number, verifiedBlockHash: finalized.hash,
    stageActivationBlock: activation.number, stageActivationHash: activation.hash,
    factory: addresses.factory, portfolioFactory: addresses.portfolioFactory,
    operationalReady: false, readMode: 'current', stale: false, manifest,
  };
}

/** Single-flight finalized verification; failed RPC reads never become a snapshot. */
export function createV2GenesisGraphReader({ provider, trustedProduct, graphVerifier, now = Date.now,
  ttlMs = 20_000, retryMs = 3_000 } = {}) {
  assert(typeof graphVerifier === 'function' && typeof now === 'function'
    && Number.isSafeInteger(ttlMs) && ttlMs >= 1 && Number.isSafeInteger(retryMs) && retryMs >= 1,
  'Invalid v2 graph reader configuration.');
  let cached = null, pending = null, retryAt = 0;
  return async () => {
    const age = cached ? now() - cached.savedAt : Infinity;
    if (age >= 0 && age < ttlMs) return { ...cached.body, snapshotAgeMs: age };
    if (!pending && now() < retryAt) throw new Error('Product graph retry is cooling down.');
    if (!pending) {
      pending = (async () => {
        const record = trustedProduct?.record;
        assert(provider && record?.schemaVersion === 1 && record.kind === 'integrated-v2'
          && !trustedProduct.upgradeRecord, 'Reviewed original v2 graph is unavailable.');
        assert(BigInt(await provider.send('eth_chainId', [])) === 56n, 'Product RPC is not BSC mainnet.');
        const finalized = await provider.getBlock('finalized');
        assert(Number.isSafeInteger(finalized?.number) && HASH.test(finalized.hash),
          'Finalized BSC block is unavailable.');
        const initial = record.steps?.find(step => step.id === 'initialize');
        assert(initial?.receipt, 'Initialization record is unavailable.');
        const [activation, graph] = await Promise.all([
          provider.getBlock(initial.receipt.blockNumber),
          graphVerifier(provider, record.addresses.factory, finalized),
        ]);
        const again = await provider.getBlock(finalized.number);
        assert(same(again?.hash, finalized.hash), 'Finalized BSC block changed during verification.');
        const body = formatV2GenesisGraph(record, graph, finalized, activation);
        cached = { body, savedAt: now() };
        return body;
      })().catch(error => { retryAt = now() + retryMs; throw error; })
        .finally(() => { pending = null; });
    }
    const body = await pending;
    return { ...body, snapshotAgeMs: Math.max(0, now() - cached.savedAt) };
  };
}
