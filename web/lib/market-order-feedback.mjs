import { abi } from './chain-client.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = value => /^0x[\da-f]{64}$/i.test(value ?? '');

/** Presentation only. A submitted cancellation stays pending; only a matched
 * successful receipt hides a stale cached order. No read or resend is made. */
export function marketOrderFeedback(records, market, account, now = Date.now()) {
  const feedback = new Map();
  if (!market || !account) return feedback;
  for (const record of records) {
    if (!same(record.target, market) || !same(record.account, account) || !hash(record.hash)) continue;
    if (!['pending', 'confirmed'].includes(record.status)) continue;
    if (record.status === 'confirmed' && (!Number.isFinite(record.confirmedAt) || now - record.confirmedAt > 10 * 60_000)) continue;
    try {
      const call = abi.ShareMarket.parseTransaction({ data: record.data });
      if (!['cancel', 'expire'].includes(call?.name)) continue;
      const id = call.args[0].toString(), old = feedback.get(id);
      if (old?.status === 'confirmed') continue;
      feedback.set(id, { status: record.status, hash: record.hash });
    } catch { /* Old records without calldata cannot identify an order. */ }
  }
  return feedback;
}

export function applyMarketOrderFeedback(orders, feedback) {
  return orders.filter(row => feedback.get((row.id ?? row.orderId).toString())?.status !== 'confirmed')
    .map(row => ({ ...row, cancellationPending: feedback.get((row.id ?? row.orderId).toString())?.status === 'pending' }));
}
