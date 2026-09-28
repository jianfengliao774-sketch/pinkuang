/** A small, bounded per-client limiter for public entry points before database or RPC work. */
export function clientAddress(req) {
  const peer = req.socket?.remoteAddress || 'unknown';
  // Only the loopback nginx hop is trusted to identify the public client.
  if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') {
    const forwarded = req.headers?.['x-real-ip'];
    if (typeof forwarded === 'string' && /^[\da-fA-F:.]{3,45}$/.test(forwarded)) return forwarded;
  }
  return peer;
}

export function createRequestLimiter({ windowMs = 60_000, perClient, maxClients = 10_000, now = Date.now }) {
  if (![windowMs, perClient, maxClients].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('Invalid request limiter configuration.');
  let window = -1;
  const counts = new Map();
  return req => {
    const current = Math.floor(now() / windowMs);
    if (current !== window) { window = current; counts.clear(); }
    const client = clientAddress(req);
    const count = counts.get(client) ?? 0;
    if (count >= perClient || count === 0 && counts.size >= maxClients) return false;
    counts.set(client, count + 1);
    return true;
  };
}
