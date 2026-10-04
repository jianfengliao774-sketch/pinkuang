import { getAddress, ZeroAddress } from 'ethers';

export const OFFICIAL_TARGET_MARKET = '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const uint = value => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value)
  && BigInt(value) < 2n ** 256n ? BigInt(value) : null;
const addr = value => { try { return getAddress(value).toLowerCase(); } catch { return null; } };
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const inactiveStatuses = new Set(['pending_approval', 'filled', 'cancelled', 'expired', 'asset_transferred', 'approval_revoked', 'invalid']);

/** A successful, complete fresh detail is required to prove no Firsto asks.
 * A transport error, mismatched identity or malformed row is unknown, never
 * an empty order book. Reference prices and bids cannot keep a target listed. */
export function firstoListingEvidence(delivery, identity, now = Date.now()) {
  const fetched = timestamp(delivery?.fetchedAt), served = timestamp(delivery?.responseDate);
  const unknown = { status: 'unknown', observedAt: null };
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(fetched) || !Number.isSafeInteger(served)
    || fetched > now + 30_000 || served > now + 30_000
    || now - fetched > 60_000 || now - served > 120_000) return unknown;
  const detail = delivery?.detail, asset = detail?.asset, orders = detail?.orders;
  const owner = addr(asset?.owner), id = uint(asset?.tokenId);
  if (!same(asset?.collection, identity.collection) || id?.toString() !== identity.tokenId
    || !same(owner, identity.owner) || owner === ZeroAddress
    || asset.category !== 'official_mining'
    || !['official_mining', 'unknown'].includes(asset.classification)
    || !Array.isArray(orders?.signedAsks) || !Array.isArray(orders?.asksAndOnchainBids)
    || orders.signedAsks.length > 500 || orders.asksAndOnchainBids.length > 500) return unknown;
  let uncertain = false;
  for (const [groupIndex, group] of [orders.signedAsks, orders.asksAndOnchainBids].entries()) {
    for (const order of group) {
      if (!order || typeof order !== 'object' || Array.isArray(order)) { uncertain = true; continue; }
      if (order.side === 'bid') continue;
      if (order.side !== 'ask' && !(groupIndex === 0 && order.side === undefined)) { uncertain = true; continue; }
      if (typeof order.status !== 'string') { uncertain = true; continue; }
      if (order.status !== 'open') {
        if (!inactiveStatuses.has(order.status)) uncertain = true;
        continue;
      }
      const maker = addr(order.maker), tokenId = uint(order.tokenId), price = uint(order.priceWei);
      if (!addr(order.collection) || !maker || tokenId === null || price === null) { uncertain = true; continue; }
      if (!same(order.collection, identity.collection) || tokenId.toString() !== identity.tokenId
        || maker !== owner || price === 0n) continue;
      if (order.chainId != null && order.chainId !== 56 && order.chainId !== '56') { uncertain = true; continue; }
      const expiry = order.expiry ?? order.expiresAt;
      if (order.expiry != null && order.expiresAt != null
        && (uint(order.expiry) === null || uint(order.expiresAt) === null || uint(order.expiry) !== uint(order.expiresAt))) {
        uncertain = true; continue;
      }
      if (expiry != null) {
        const seconds = uint(expiry);
        if (seconds === null) { uncertain = true; continue; }
        if (seconds <= BigInt(Math.floor(now / 1000))) continue;
      }
      return { status: 'available', observedAt: new Date(fetched).toISOString(), expiresAt: expiry ?? null };
    }
  }
  // Another open-ask summary contradicting the arrays is a schema/evidence
  // mismatch. Do not turn that inconsistency into automatic delisting.
  if (asset.bestAsk?.status === 'open' || detail.bestAsk?.status === 'open') uncertain = true;
  return uncertain ? unknown : { status: 'absent', observedAt: new Date(fetched).toISOString() };
}
