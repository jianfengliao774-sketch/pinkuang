import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, invalidateJournalSession, preloadJournalSession } from '../lib/live-transactions.mjs';

const account = '0x0000000000000000000000000000000000000001';
const other = '0x0000000000000000000000000000000000000002';
const config = { displayOnly: true, origin: 'https://bemine.example', journalBase: '/api/journal' };
function fixture() {
  const requests = [], walletCalls = [];
  const provider = { request: async input => { walletCalls.push(input); assert.fail('warm-up cannot open the wallet'); } };
  let owner = account, missing = false;
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    assert.equal(url, '/api/journal/session');
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'same-origin');
    return new Response(JSON.stringify(missing ? { error: 'login required' } : { account: owner }),
      { status: missing ? 401 : 200 });
  };
  return { provider, fetcher, requests, walletCalls,
    input: { provider, fetcher, account, config },
    switchCookie() { owner = other; }, expireCookie() { missing = true; } };
}

test('existing session warm-up removes the post-signature authentication roundtrip', async () => {
  const f = fixture();
  assert.equal(await preloadJournalSession(f.input), true);
  assert.deepEqual(await authenticate(f.input), { account });
  assert.deepEqual(await authenticate(f.input), { account });
  assert.equal(f.requests.length, 1);
  assert.equal(f.walletCalls.length, 0);
});

test('an absent session warm-up is read-only and never grants authentication', async () => {
  const f = fixture(); f.expireCookie();
  assert.equal(await preloadJournalSession(f.input), false);
  assert.equal(await preloadJournalSession(f.input), false);
  assert.equal(f.requests.length, 2);
  assert.equal(f.walletCalls.length, 0);
});

test('a changed cookie account retires the old cached session', async () => {
  const f = fixture();
  await preloadJournalSession(f.input);
  f.switchCookie();
  assert.equal(await preloadJournalSession({ ...f.input, account: other }), true);
  assert.equal(await preloadJournalSession(f.input), false);
  assert.equal(f.requests.length, 3);
});

test('new providers and journal origins never reuse an authenticated wallet snapshot', async () => {
  const f = fixture(); await preloadJournalSession(f.input);
  await preloadJournalSession({ ...f.input, provider: { request: f.provider.request } });
  await preloadJournalSession({ ...f.input, config: { ...config, origin: 'https://other.example' } });
  assert.equal(f.requests.length, 3);
});

test('a rejected relay session can be invalidated without replaying any transaction', async () => {
  const f = fixture(); await preloadJournalSession(f.input);
  f.expireCookie(); invalidateJournalSession(f.provider);
  assert.equal(await preloadJournalSession(f.input), false);
  assert.equal(f.requests.length, 2);
  assert.equal(f.walletCalls.length, 0);
});

test('a late warm-up cannot resurrect an invalidated session', async () => {
  const f = fixture(); let resolve;
  const fetcher = () => new Promise(done => { resolve = done; });
  const warming = preloadJournalSession({ ...f.input, fetcher });
  invalidateJournalSession(f.provider);
  resolve(new Response(JSON.stringify({ account })));
  assert.equal(await warming, false);
  f.expireCookie();
  assert.equal(await preloadJournalSession(f.input), false);
});

test('a late response for an old account never overwrites a newer account session', async () => {
  const f = fixture(); let resolve;
  const fetcher = () => new Promise(done => { resolve = done; });
  const old = preloadJournalSession({ ...f.input, fetcher });
  f.switchCookie(); await preloadJournalSession({ ...f.input, account: other });
  resolve(new Response(JSON.stringify({ account })));
  assert.equal(await old, false);
  const before = f.requests.length;
  await authenticate({ ...f.input, account: other });
  assert.equal(f.requests.length, before);
});
