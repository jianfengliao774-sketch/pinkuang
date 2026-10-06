/**
 * Direct member-wallet calls that do not depend on a purchase/mining worker.
 * This is a target-type AND selector policy, not transaction authorization:
 * callers must still verify the current deployment, registered target, exact
 * calldata/value and the user's wallet. Never use it for Authority forwarding.
 */
export const FRESH_WALLET_ACTIONS = Object.freeze({
  pool: Object.freeze(['deposit', 'withdrawDeposit', 'finalizeFailure', 'harvest', 'claim', 'withdrawBnb',
    'propose', 'vote', 'executeSale', 'cancelExpired', 'delist', 'completeFirstoSale']),
  portfolio: Object.freeze(['deposit', 'withdrawDeposit', 'finalizeFundingFailure', 'claimFailedFunding',
    'finalizeAcquisition', 'collectChildBem', 'claimBem', 'withdrawBnb', 'transfer',
    'proposeChildSale', 'voteChildSale', 'executeChildSale', 'settleChildSale', 'expireChildSale']),
  market: Object.freeze(['list', 'fill', 'cancel', 'expire', 'withdrawBnb']),
  portfolioMarket: Object.freeze(['list', 'fill', 'cancel', 'expire', 'withdrawBnb']),
});
const payable = Object.freeze({
  pool: Object.freeze(['deposit', 'completeFirstoSale']), portfolio: Object.freeze(['deposit']),
  market: Object.freeze(['fill']), portfolioMarket: Object.freeze(['fill']),
});

export function isFreshWalletAction(targetType, action, value = '0') {
  if (!Object.hasOwn(FRESH_WALLET_ACTIONS, targetType) || !FRESH_WALLET_ACTIONS[targetType].includes(action)) return false;
  let wei;
  if (typeof value === 'bigint') wei = value;
  else if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 78) wei = BigInt(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value)) wei = BigInt(value);
  else return false;
  if (wei < 0n || wei >= 2n ** 256n) return false;
  return payable[targetType].includes(action) ? wei > 0n : wei === 0n;
}
