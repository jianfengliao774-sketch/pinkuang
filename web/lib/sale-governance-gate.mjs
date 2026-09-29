import { Interface, ZeroHash, toQuantity } from 'ethers';

// These views live on the upgradeable ShareMarket. The immutable genesis Lens
// cannot know about them or the Vault's current execution rules.
const saleViews = new Interface([
  'function saleReference(address pool) view returns (uint128 marketPriceWei, uint64 observedAt, bytes32 sourceDigest)',
  'function saleReview(address pool, uint256 proposalId) view returns (uint8 status, uint128 priceWei)',
]);
const MAX_REFERENCE_AGE = 15n * 60n;

async function view(request, market, method, args, blockNumber) {
  const data = saleViews.encodeFunctionData(method, args);
  const result = await request('eth_call', [{ to: market, data }, toQuantity(blockNumber)]);
  return saleViews.decodeFunctionResult(method, result);
}

export async function readSaleReference(request, market, pool, blockNumber, timestamp) {
  const [priceWei, observedAt, sourceDigest] = await view(request, market, 'saleReference', [pool], blockNumber);
  const available = priceWei > 0n && sourceDigest !== ZeroHash
    && observedAt <= timestamp && timestamp - observedAt <= MAX_REFERENCE_AGE;
  return Object.freeze({ available, priceWei, observedAt, sourceDigest,
    reason: available ? null : 'Firsto 市场参考价缺失或超过 15 分钟有效期。' });
}

export async function readSaleReview(request, market, pool, proposalId, blockNumber) {
  const [status, priceWei] = await view(request, market, 'saleReview', [pool, proposalId], blockNumber);
  if (status > 2n) throw new Error('Firsto 出售审核状态无效。');
  return Object.freeze({ status, priceWei });
}

/** A vote can pass while the listing is still blocked by a missing reference or review. */
export function saleExecutionGate({ proposal, passed, state, timestamp, reference, review }) {
  const open = state === 2n && !proposal.executed && timestamp < proposal.endsAt && passed === true;
  if (!reference?.available) return Object.freeze({ discounted: null, reviewRequired: null,
    reviewApproved: false, canExecute: false });
  const discounted = proposal.price < reference.priceWei;
  const reviewRequired = discounted;
  const reviewApproved = !discounted || review?.status === 1n && review.priceWei === proposal.price;
  return Object.freeze({ discounted, reviewRequired, reviewApproved,
    canExecute: open && reviewApproved });
}
