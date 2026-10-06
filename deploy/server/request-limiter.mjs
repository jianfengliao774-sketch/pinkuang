import { isIP } from 'node:net';

/** A small, bounded per-client limiter for public entry points before database or RPC work. */
function normalizedClient(address) {
  const version = isIP(address);
  if (version !== 6) return address;
  // Treat an IPv6 /64 as one client so rotating interface addresses cannot
  // reset the quota or fill the bounded client table. Preserve IPv4-mapped
  // addresses as individual IPv4 clients instead of grouping all of them.
  let expanded = address.toLowerCase();
  const dotted = expanded.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    expanded = `${dotted[1]}${(octets[0] << 8 | octets[1]).toString(16)}:${(octets[2] << 8 | octets[3]).toString(16)}`;
  }
  const halves = expanded.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(word => parseInt(word, 16));
  if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0xffff || words[5] === 0))
    return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  return `${words.slice(0, 4).map(word => word.toString(16).padStart(4, '0')).join(':')}::/64`;
}

export function clientAddress(req) {
  const peer = req.socket?.remoteAddress || 'unknown';
  // Only the loopback nginx hop is trusted to identify the public client.
  if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') {
    const forwarded = req.headers?.['x-real-ip'];
    if (typeof forwarded === 'string' && isIP(forwarded)) return normalizedClient(forwarded);
  }
  return normalizedClient(peer);
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
    if (count >= perClient) return false;
    // A rotating set of client IPs must not fill the table and deny every
    // later visitor for the rest of the window. Evict the oldest entry while
    // preserving the fixed memory bound. nginx must overwrite X-Real-IP.
    if (count === 0 && counts.size >= maxClients) counts.delete(counts.keys().next().value);
    if (count > 0) counts.delete(client);
    counts.set(client, count + 1);
    return true;
  };
}

/** Bounded quota for an already authenticated identity, independent of its IP.
 * Once full, refuse new identities until the window rolls over rather than
 * evicting an existing identity and resetting its quota. */
export function createKeyedLimiter({ windowMs = 60_000, perKey, maxKeys = 10_000, now = Date.now }) {
  if (![windowMs, perKey, maxKeys].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('Invalid keyed limiter configuration.');
  let window = -1;
  const counts = new Map();
  return key => {
    if (typeof key !== 'string' || !key) return false;
    const current = Math.floor(now() / windowMs);
    if (current !== window) { window = current; counts.clear(); }
    const count = counts.get(key) ?? 0;
    if (count >= perKey) return false;
    if (count === 0 && counts.size >= maxKeys) return false;
    if (count > 0) counts.delete(key);
    counts.set(key, count + 1);
    return true;
  };
}
