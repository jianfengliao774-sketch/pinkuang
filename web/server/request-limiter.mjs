// The retired live API may be deployed separately from the integrated deploy service.
import { isIP } from 'node:net';

function clientAddress(req) {
  const peer = req.socket?.remoteAddress ?? 'unknown';
  const realIp = req.headers?.['x-real-ip'];
  let address = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)
    && typeof realIp === 'string' && isIP(realIp) ? realIp : peer;
  if (isIP(address) !== 6) return address;
  const dotted = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    address = `${dotted[1]}${(octets[0] << 8 | octets[1]).toString(16)}:${(octets[2] << 8 | octets[3]).toString(16)}`;
  }
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(word => parseInt(word, 16));
  if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0xffff || words[5] === 0))
    return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  return `${words.slice(0, 4).map(word => word.toString(16).padStart(4, '0')).join(':')}::/64`;
}

export function createRequestLimiter({ perClient, windowMs = 60_000, maxClients = 10_000, now = Date.now }) {
  if (![perClient, windowMs, maxClients].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('Invalid request limiter configuration.');
  let window = -1;
  const counts = new Map();
  return req => {
    const current = Math.floor(now() / windowMs);
    if (current !== window) { window = current; counts.clear(); }
    const client = clientAddress(req);
    const count = counts.get(client) ?? 0;
    if (count >= perClient) return false;
    if (count === 0 && counts.size >= maxClients) counts.delete(counts.keys().next().value);
    if (count > 0) counts.delete(client);
    counts.set(client, count + 1);
    return true;
  };
}
