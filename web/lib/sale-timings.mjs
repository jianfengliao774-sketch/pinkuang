const FORMAL = Object.freeze({ holdSeconds: 604800n, proposalCooldownSeconds: 604800n,
  nextRoundSeconds: 518400n, voteSeconds: 86400n, listingSeconds: 604800n });
const TEST = Object.freeze({ holdSeconds: 0n, proposalCooldownSeconds: 0n,
  nextRoundSeconds: 0n, voteSeconds: 86400n, listingSeconds: 604800n });

/** Sale waiting periods only. Reward accounting retains its real 86400-second day. */
export function saleTimings(config) { return config?.testProfile === true ? TEST : FORMAL; }
