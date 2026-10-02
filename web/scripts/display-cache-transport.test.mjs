import test from 'node:test';
import assert from 'node:assert/strict';
import { readDisplayCache, DISPLAY_CACHE_TIMEOUT_MS } from '../lib/display-cache-transport.mjs';
import { fetchLiveJson } from '../lib/live-config.mjs';

test('test cache read tolerates latency above the previous 2.5 second deadline', async () => {
  let requests = 0;
  const result = await readDisplayCache(() => fetchLiveJson('https://example.test/cache', {
    timeoutMs: DISPLAY_CACHE_TIMEOUT_MS,
    fetcher: async (_url, { signal }) => {
      requests++;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2700);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      return Response.json({ items: [] });
    },
  }));
  assert.deepEqual(result, { items: [] });
  assert.equal(requests, 1);
});

test('a dropped connection retries once and a persistent outage stops', async () => {
  const network = Object.assign(new Error('offline'), { code: 'network_unavailable' });
  const delays = [];
  let requests = 0;
  assert.equal(await readDisplayCache(async () => {
    if (++requests === 1) throw network;
    return 'cached';
  }, { wait: async ms => delays.push(ms) }), 'cached');
  assert.equal(requests, 2); assert.deepEqual(delays, [500]);
  requests = 0;
  await assert.rejects(readDisplayCache(async () => { requests++; throw network; }, { wait: async () => {} }), error => error === network);
  assert.equal(requests, 2);
});

test('identity, JSON and HTTP errors never repeat this transport request', async () => {
  for (const code of ['index_identity', 'invalid_json', 'http_unavailable']) {
    let requests = 0;
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(readDisplayCache(async () => { requests++; throw error; }), error);
    assert.equal(requests, 1);
  }
});
