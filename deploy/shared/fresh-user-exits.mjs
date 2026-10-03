/** Shared browser/server list: only existing zero-value exits and their settlement steps. */
export const FRESH_USER_EXIT_ACTIONS = Object.freeze({
  pool: Object.freeze(['withdrawDeposit','finalizeFailure','claim','withdrawBnb','harvest','cancelExpired']),
  portfolio: Object.freeze(['withdrawDeposit','finalizeFundingFailure','claimFailedFunding','finalizeAcquisition',
    'collectChildBem','claimBem','withdrawBnb','settleChildSale','expireChildSale']),
  market: Object.freeze(['cancel','expire','withdrawBnb']),
  portfolioMarket: Object.freeze(['cancel','expire','withdrawBnb']),
});
export function isFreshUserExit(targetType, action, value = '0') {
  try { return BigInt(value) === 0n && Object.hasOwn(FRESH_USER_EXIT_ACTIONS,targetType)
    && FRESH_USER_EXIT_ACTIONS[targetType].includes(action); }
  catch { return false; }
}
