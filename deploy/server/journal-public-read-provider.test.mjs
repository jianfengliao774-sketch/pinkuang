import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournalService, createPublicOfficialReadProvider } from './journal-api.mjs';

async function endpoint(reply) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const row = JSON.parse(Buffer.concat(parts).toString());
    calls.push(row); await reply(row, res, calls);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const respond = (row, res, value) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: row.id, ...value }));
};
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'bounded reads did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const call = index => [{ to: '0x' + '1'.repeat(40), data: `0x${index.toString(16).padStart(2, '0')}` }, 'latest'];

test('public official helper caps four single reads and blocks all writes before transport', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  let active = 0, highWater = 0, started = 0;
  const f = await endpoint(async (row, res) => {
    assert.equal(Array.isArray(row), false);
    assert.equal(row.method, 'eth_call');
    started++; active++; highWater = Math.max(highWater, active);
    try { await held; } finally { active--; }
    respond(row, res, { result: '0x1234' });
  });
  const provider = createPublicOfficialReadProvider(f.url);
  try {
    assert.equal(provider._getConnection().timeout, 9000);
    assert.equal(f.calls.length, 0, 'constructor does not start a one-off proof');
    const reads = Array.from({ length: 8 }, (_, index) => provider.send('eth_call', call(index)));
    const outcomes = Promise.allSettled(reads);
    await until(() => started === 4);
    assert.equal(highWater, 4);
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign',
      'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'unknown_method'])
      await assert.rejects(provider.send(method, ['0x00']), /read-only/i);
    await assert.rejects(async () => provider._send([
      { jsonrpc: '2.0', id: 101, method: 'eth_call', params: call(0) },
      { jsonrpc: '2.0', id: 102, method: 'eth_call', params: call(1) },
    ]), /read-only|batched/i);
    assert.equal(started, 4);
    release();
    assert.deepEqual((await outcomes).map(row => row.status), Array(8).fill('fulfilled'));
    assert.equal(started, 8); assert.equal(highWater, 4);
  } finally { release(); await provider.settleAndDestroy(); await f.close(); }
});

test('public HTTP429 is retried three times at most without hidden Retry-After or permanent lockout', async () => {
  let throttled = true;
  const f = await endpoint((row, res) => {
    if (throttled) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '3600' });
      res.end('rate limited');
    } else respond(row, res, { result: '0x38' });
  });
  const provider = createPublicOfficialReadProvider(f.url, 200);
  try {
    const began = Date.now();
    await assert.rejects(provider.send('eth_chainId', []), error => {
      assert.ok(error.info.responseStatus.startsWith('429'));
      assert.doesNotMatch(error.message, /exceeded maximum retry limit/); return true;
    });
    assert.equal(f.calls.length, 3);
    assert.ok(Date.now() - began < 7000, 'HTTP layer must not sleep for Retry-After');
    throttled = false;
    assert.equal(await provider.send('eth_chainId', []), '0x38');
    assert.equal(f.calls.length, 4, 'next refresh can read the same node');
  } finally { await provider.settleAndDestroy(); await f.close(); }
});

test('public node transport failure never uses an ambient fallback and later same-node reads recover', async () => {
  let healthy = false;
  const backup = await endpoint((row, res) => respond(row, res, { result: '0x38' }));
  const f = await endpoint((row, res) => {
    if (!healthy) { res.writeHead(503); res.end('unavailable'); }
    else respond(row, res, { result: '0x38' });
  });
  const prior = process.env.BEMINE_READ_FALLBACK_RPC_URL;
  process.env.BEMINE_READ_FALLBACK_RPC_URL = backup.url;
  const provider = createPublicOfficialReadProvider(f.url, 200);
  try {
    await assert.rejects(provider.send('eth_chainId', []));
    assert.equal(f.calls.length, 1); assert.equal(backup.calls.length, 0);
    healthy = true;
    assert.equal(await provider.send('eth_chainId', []), '0x38');
    assert.equal(f.calls.length, 2); assert.equal(backup.calls.length, 0);
  } finally {
    if (prior === undefined) delete process.env.BEMINE_READ_FALLBACK_RPC_URL;
    else process.env.BEMINE_READ_FALLBACK_RPC_URL = prior;
    await provider.settleAndDestroy(); await f.close(); await backup.close();
  }
});

test('public read timeout and contract revert do not retry', async () => {
  let hang = true;
  const f = await endpoint((row, res) => {
    if (!hang) respond(row, res, { error: { code: 3, message: 'execution reverted', data: '0x' } });
  });
  const provider = createPublicOfficialReadProvider(f.url, 80);
  try {
    await assert.rejects(provider.send('eth_call', call(0)));
    assert.equal(f.calls.length, 1);
    hang = false;
    await assert.rejects(provider.send('eth_call', call(1)), /revert/);
    assert.equal(f.calls.length, 2);
  } finally { await provider.settleAndDestroy(); await f.close(); }
});

test('journal close settles its own public provider and leaves an injected provider owned by its caller', async () => {
  const f = await endpoint((row, res) => respond(row, res, { result: '0x38' }));
  const directory = await mkdtemp(join(tmpdir(), 'journal-public-close-'));
  try {
    const currentArtifactDigest = () => '0x' + '1'.repeat(64);
    const own = createJournalService({ dbPath: join(directory, 'own.sqlite'), origin: 'http://127.0.0.1',
      currentArtifactDigest, readRpcUrl: f.url });
    await own.close();
    assert.equal(f.calls.length, 0, 'closing an idle service starts no RPC work');
    let destroyed = 0, settled = 0;
    const injected = { destroy() { destroyed++; }, async settleAndDestroy() { settled++; } };
    const supplied = createJournalService({ dbPath: join(directory, 'supplied.sqlite'), origin: 'http://127.0.0.1',
      currentArtifactDigest, provider: injected });
    await supplied.close();
    assert.equal(destroyed, 0); assert.equal(settled, 0);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});
