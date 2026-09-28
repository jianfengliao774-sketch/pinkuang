import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotificationRuntime, startOptionalNotifications } from './runtime.mjs';

test('optional notification startup failures never prevent the independent journal from starting', async () => {
  const statuses = [];
  assert.equal(await startOptionalNotifications({}, { configure: () => { throw new Error('private config'); }, onStatus: x => statuses.push(x) }), null);
  let closed = false;
  assert.equal(await startOptionalNotifications({}, { configure: () => ({}), create: () => ({ start: async () => { throw new Error('private transport'); }, close: async () => { closed = true; } }), onStatus: x => statuses.push(x) }), null);
  assert.equal(closed, true);
  assert.deepEqual(statuses, [{ status: 'startup_unavailable' }, { status: 'startup_unavailable' }]);
});

test('identity gate, exact webhook secret and unavailable chain are isolated from wallet binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bemine-notification-runtime-'));
  const config = { dbPath: join(dir, 'private', 'notifications.sqlite'), encryptionKey: 'ab'.repeat(32),
    webhookSecret: 'x'.repeat(48), token: 'fixture', botUsername: 'BEMineNotifyBot',
    publicBaseUrl: 'https://example.test/bemine/', factory: `0x${'1'.repeat(40)}`, market: `0x${'2'.repeat(40)}`, indexUrl: 'http://127.0.0.1:4180' };
  let read = false, sent = 0, resolveStatus;
  const observed = new Promise(resolve => { resolveStatus = resolve; });
  const runtime = createNotificationRuntime(config, {
    telegram: { request: async () => ({ is_bot: true, username: 'BEMineNotifyBot' }), sendMessage: async () => { sent++; } },
    source: async () => { read = true; throw new Error('fixture index unavailable'); },
    onStatus: resolveStatus,
  });
  try {
    assert.equal(runtime.capabilities().enabled, false);
    assert.equal(runtime.acceptsWebhook(config.webhookSecret), false);
    await runtime.start();
    assert.equal(runtime.capabilities().enabled, true);
    assert.equal(runtime.acceptsWebhook(config.webhookSecret), true);
    assert.equal(runtime.acceptsWebhook(`${config.webhookSecret}x`), false);
    assert.equal(runtime.acceptsWebhook(['x']), false);
    const result = await runtime.handleWallet({ account: `0x${'3'.repeat(40)}`, method: 'GET', path: '/status' });
    assert.equal(result.status, 200);
    assert.equal(result.body.connected, false);
    assert.equal((await observed).status, 'source_or_delivery_unavailable');
    assert.equal(read, true); assert.equal(sent, 0);
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
  assert.equal(runtime.capabilities().enabled, false);
});
