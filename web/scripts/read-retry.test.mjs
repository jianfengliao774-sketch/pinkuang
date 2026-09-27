import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveDataError, fetchLiveJson } from '../lib/live-config.mjs';
import { READ_CANCELLED, retryReadRound, settleReadRound } from '../lib/read-retry.mjs';

const problem = (code, status) => new LiveDataError(code, 'original failure', { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('HTTP 503 is structured and a fresh read succeeds after the one-second retry', async () => {
  let requests = 0, clears = 0; const delays = [];
  const result = await retryReadRound(() => fetchLiveJson('https://example.test/pools', {
    fetcher: async () => new Response(JSON.stringify({ source: 'new' }), {
      status: ++requests === 1 ? 503 : 200, headers: { 'content-type': 'application/json' },
    }),
  }), { onAttempt: () => clears++, wait: async ms => delays.push(ms) });
  assert.deepEqual(result, { source: 'new' });
  assert.equal(requests, 2); assert.equal(clears, 2); assert.deepEqual(delays, [1000]);
});

test('source changes drain the old round before rereading catalog and every dependent result', async () => {
  const oldRead = deferred(), started = deferred(), events = [];
  let catalogs = 0;
  const pending = retryReadRound(async () => {
    const source = ++catalogs;
    events.push(`catalog:${source}`);
    const results = await settleReadRound({
      stats: async () => { events.push(`stats:${source}`); if (source === 1) throw problem('source_changed'); return source; },
      positions: async () => {
        events.push(`positions:${source}`);
        if (source === 1) { started.resolve(); await oldRead.promise; events.push('old drained'); }
        return source;
      },
    });
    return { source, ...results };
  }, { wait: async () => events.push('wait') });
  await started.promise;
  assert.equal(catalogs, 1);
  oldRead.resolve();
  assert.deepEqual(await pending, { source: 2, stats: 2, positions: 2 });
  assert.deepEqual(events, ['catalog:1', 'stats:1', 'positions:1', 'old drained', 'wait', 'catalog:2', 'stats:2', 'positions:2']);
});

test('permission, validation and ordinary network errors fail immediately with the original error', async () => {
  for (const error of [problem('http_unavailable', 400), problem('http_unavailable', 401),
    problem('http_unavailable', 403), problem('http_unavailable', 500), problem('http_unavailable'),
    problem('artifact_mismatch'), problem('index_reorg'), problem('network_unavailable'), new Error('HTTP 503')]) {
    let attempts = 0;
    await assert.rejects(retryReadRound(async () => { attempts++; throw error; }, {
      wait: async () => assert.fail('must not delay or retry'),
    }), actual => actual === error);
    assert.equal(attempts, 1);
  }
});

test('HTTP 403 status survives fetch wrapping and does not retry', async () => {
  let requests = 0;
  await assert.rejects(retryReadRound(() => fetchLiveJson('https://example.test/pools', {
    fetcher: async () => { requests++; return new Response('', { status: 403 }); },
  }), { wait: async () => assert.fail('must not retry authorization failure') }), error =>
    error instanceof LiveDataError && error.code === 'http_unavailable' && error.details.status === 403);
  assert.equal(requests, 1);
});

test('recoverable reads stop at three total attempts and preserve the final error', async () => {
  for (const error of [problem('http_unavailable', 502), problem('http_unavailable', 503),
    problem('http_unavailable', 504), problem('index_incomplete'), problem('index_stale'), problem('source_changed')]) {
    let attempts = 0, delays = 0;
    await assert.rejects(retryReadRound(async () => { attempts++; throw error; }, {
      wait: async ms => { assert.equal(ms, 1000); delays++; },
    }), actual => actual === error);
    assert.equal(attempts, 3); assert.equal(delays, 2);
  }
});

test('an obsolete route drains its reads but neither retries nor writes to the replacement route', async () => {
  const oldRead = deferred(), started = deferred();
  let current = true, attempts = 0, rendered = 'new route';
  const pending = retryReadRound(async () => {
    attempts++;
    return settleReadRound({
      stats: async () => { throw problem('source_changed'); },
      positions: async () => { started.resolve(); await oldRead.promise; return 'old account'; },
    });
  }, { isCurrent: () => current, wait: async () => assert.fail('obsolete round must not retry') })
    .then(result => { if (result !== READ_CANCELLED) rendered = result; return result; });
  await started.promise; current = false; oldRead.resolve();
  assert.equal(await pending, READ_CANCELLED); assert.equal(attempts, 1); assert.equal(rendered, 'new route');
});

test('a successful obsolete read and a cancelled retry delay cannot publish or start another round', async () => {
  const read = deferred(); let current = true;
  const successful = retryReadRound(() => read.promise, { isCurrent: () => current });
  current = false; read.resolve('old result');
  assert.equal(await successful, READ_CANCELLED);
  let attempts = 0; current = true;
  const cancelled = await retryReadRound(async () => { attempts++; throw problem('index_incomplete'); }, {
    isCurrent: () => current, wait: async () => { current = false; },
  });
  assert.equal(cancelled, READ_CANCELLED); assert.equal(attempts, 1);
});

test('concurrent non-retryable failures take precedence, including synchronous read failures', async () => {
  const forbidden = problem('http_unavailable', 403), finished = [];
  await assert.rejects(retryReadRound(() => settleReadRound({
    transient: () => { throw problem('source_changed'); },
    forbidden: () => { throw forbidden; },
    slow: async () => { await Promise.resolve(); finished.push('drained'); },
  }), { wait: async () => assert.fail('permission failure must not retry') }), actual => actual === forbidden);
  assert.deepEqual(finished, ['drained']);
});
