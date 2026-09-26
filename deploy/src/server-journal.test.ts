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
    const result = path.endsWith('/deployment') ? { record: null, archives: [], archiveNextCursor: null, latestCompleted: null, revision: 0 }
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

test('lost archive response reconciles the committed record without repeating the POST', async () => {
  const originalFetch = globalThis.fetch;
  const account = '0x1111111111111111111111111111111111111111';
  let archivePosts = 0;
  globalThis.fetch = async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/deployment/archive')) {
      archivePosts += 1;
      throw new TypeError('connection closed after commit');
    }
    assert.equal(path, '/api/journal/deployment');
    return new Response(JSON.stringify({ record: null, revision: 9,
      archives: [{ id: 'deployment-a', chainId: 56, account, status: 'complete' }],
      archiveNextCursor: null, latestCompleted: { id: 'deployment-a', chainId: 56, account, status: 'complete' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const journal = new ServerJournal(account);
    const result = await journal.archiveDeployment('deployment-a');
    assert.equal(result.record, null);
    assert.equal(result.revision, 9);
    assert.equal(result.latestCompleted?.id, 'deployment-a');
    assert.equal(archivePosts, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('archived deployment pagination is scoped to the selected wallet', async () => {
  const originalFetch = globalThis.fetch;
  const account = '0x1111111111111111111111111111111111111111';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    assert.equal(url.pathname, '/api/journal/deployment/archives');
    assert.equal(url.searchParams.get('cursor'), '123');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(new Headers(init?.headers).get('X-Pinkuang-Account'), account);
    return new Response(JSON.stringify({ items: [{ id: 'old', chainId: 56, account }], nextCursor: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const journal = new ServerJournal(account);
    assert.equal((await journal.loadArchivedDeployments('123')).items[0].id, 'old');
    await assert.rejects(journal.loadArchivedDeployments('0'), /分页参数无效/);
  } finally { globalThis.fetch = originalFetch; }
});
