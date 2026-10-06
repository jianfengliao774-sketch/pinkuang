const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const need = (ok, text) => { if (!ok) throw new Error(text); };
/** Only a caller's just-verified proof may enter here, never stored or React state. */
export function portfolioDustProofForReceipt(proof, row, plan, receipt) {
  if (!proof) return null;
  need(proof.chainId === 56 && proof.readOnly === true && proof.chainActionsPerformed === false
    && Number.isSafeInteger(proof.blockNumber) && proof.blockNumber > 0
    && proof.replacementVerified === true && same(proof.replacement, row.transactions.deploy.address)
    && same(proof.portfolioBeacon, plan.target) && same(proof.timelock, plan.to)
    && same(proof.operationId, plan.operationId) && Number.isSafeInteger(row.delaySeconds)
    && /^\d+$/.test(proof.minDelay) && BigInt(row.delaySeconds) >= BigInt(proof.minDelay),
  '本轮链上核验与原部署范围不一致，记录保留；不会发送新交易。');
  // A later receipt, e.g. schedule after deploy, still needs a new complete graph.
  return proof.blockNumber >= receipt.blockNumber ? proof : null;
}
