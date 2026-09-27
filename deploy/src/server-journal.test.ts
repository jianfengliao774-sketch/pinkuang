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

test('a stale deployment tab checks the server digest immediately before wallet signing', async () => {
  const originalFetch = globalThis.fetch;
  const account = '0x1111111111111111111111111111111111111111';
  const oldDigest = `0x${'1'.repeat(64)}`;
  let currentDigest = oldDigest;
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input), 'http://localhost').pathname, '/api/journal/build');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('X-Pinkuang-Account'), account);
    return new Response(JSON.stringify({ artifactDigest: currentDigest }), { status: 200 });
  };
  try {
    const journal = new ServerJournal(account);
    await journal.assertCurrentArtifact(oldDigest);
    currentDigest = `0x${'2'.repeat(64)}`;
    await assert.rejects(journal.assertCurrentArtifact(oldDigest), /旧版合约产物/);
  } finally { globalThis.fetch = originalFetch; }
});

test('nonce witness uses the authenticated wallet and leaves deployment revision untouched', async () => {
  const originalFetch = globalThis.fetch;
  const account = '0x1111111111111111111111111111111111111111';
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    paths.push(path);
    assert.equal(new Headers(init?.headers).get('X-Pinkuang-Account'), account);
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.credentials, 'same-origin');
    if (path.endsWith('/nonce')) {
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      return new Response(JSON.stringify({ latest: 7, pending: 8 }), { status: 200 });
    }
    if (init?.method === 'PUT') {
      assert.equal(JSON.parse(String(init.body)).expectedRevision, 4);
      return new Response(JSON.stringify({ revision: 5 }), { status: 200 });
    }
    return new Response(JSON.stringify({ record: null, revision: 4,
      archives: [], archiveNextCursor: null, latestCompleted: null }), { status: 200 });
  };
  try {
    const journal = new ServerJournal(account);
    await journal.loadDeployment();
    assert.deepEqual(await journal.readCurrentNonce(), { latest: 7, pending: 8 });
    await journal.saveDeployment({ chainId: 56, account } as Parameters<ServerJournal['saveDeployment']>[0]);
    assert.deepEqual(paths, ['/api/journal/deployment', '/api/journal/deployment/nonce', '/api/journal/deployment']);
  } finally { globalThis.fetch = originalFetch; }
});

test('nonce witness rejects malformed or inconsistent counters and preserves server errors', async () => {
  const originalFetch = globalThis.fetch;
  let reply: unknown = null;
  let status = 200;
  globalThis.fetch = async () => new Response(JSON.stringify(reply), { status });
  try {
    const journal = new ServerJournal('0x1111111111111111111111111111111111111111');
    for (const badReply of [null, {}, { latest: -1, pending: 0 }, { latest: 0, pending: -1 },
      { latest: 1, pending: 0 }, { latest: '0', pending: 0 }, { latest: 0, pending: '0' },
      { latest: 0.5, pending: 1 }, { latest: 0, pending: 1.5 },
      { latest: 0, pending: Number.MAX_SAFE_INTEGER + 1 }, { latest: Number.MAX_SAFE_INTEGER + 1, pending: Number.MAX_SAFE_INTEGER + 1 }]) {
      reply = badReply;
      await assert.rejects(journal.readCurrentNonce(), /交易序号格式异常或不一致/);
    }
    reply = { latest: 0, pending: 0 };
    assert.deepEqual(await journal.readCurrentNonce(), reply);
    reply = { error: '服务器暂时无法独立核对交易序号；请稍后重试。' }; status = 503;
    await assert.rejects(journal.readCurrentNonce(), /服务器暂时无法独立核对/);
  } finally { globalThis.fetch = originalFetch; }
});
