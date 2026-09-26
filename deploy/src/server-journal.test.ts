import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerJournal } from './server-journal';

test('journal operations bind the selected wallet in one request without a separate session round trip', async () => {
  const originalFetch = globalThis.fetch;
  const account = '0x1111111111111111111111111111111111111111';
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    paths.push(path);
    assert.equal(new Headers(init?.headers).get('X-Pinkuang-Account'), account);
    const result = path.endsWith('/deployment') ? { record: null, archives: [], revision: 0 }
      : path.endsWith('/market') ? { record: null, revision: 0 } : { id: 'quote-1' };
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const journal = new ServerJournal(account);
    assert.equal((await journal.loadDeployment()).record, null);
    assert.equal(await journal.marketStorage().getItem('pinkuang.market.pending.v1'), null);
    await journal.saveQuote({ reference: 'example' });
    assert.deepEqual(paths, ['/api/journal/deployment', '/api/journal/market', '/api/journal/quote']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
