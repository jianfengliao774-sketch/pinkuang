/** Finality waiting is a normal pending state, not a banner-worthy failure. */
export function awaitingTransactionFinality(result) {
  return result?.status === 'pending' && /^0x[0-9a-f]{64}$/i.test(result.hash ?? '')
    && typeof result.message === 'string'
    && result.message.trim() === 'Transaction is not finalized on the canonical chain.';
}
