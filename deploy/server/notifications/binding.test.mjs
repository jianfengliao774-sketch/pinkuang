import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationStore } from './store.mjs';
import { createNotificationService } from './service.mjs';
import { TelegramClient, TelegramDeliveryError } from './telegram.mjs';

const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`;
const key = Buffer.alloc(32, 17);
const fakeToken = `123456789:${'x'.repeat(40)}`;
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bemine-notify-test-')); chmodSync(dir, 0o700);
  let now = 1_800_000_000_000;
  const store = new NotificationStore(join(dir, 'private.sqlite'), { encryptionKey: key, now: () => now });
  const sent = [], telegram = { sendMessage: async (chatId, text, options) => { sent.push({ chatId, text, options }); return { message_id: sent.length }; } };
  const service = createNotificationService({ store, telegram, publicBaseUrl: 'https://example.test/bemine/' });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  let updateId = 0;
  const update = (text, peer = 123456789, options = {}) => ({ update_id: ++updateId, message: { text,
    from: { id: peer, is_bot: false, username: 'private_user', first_name: 'Private person', language_code: 'en', ...options.from },
    chat: { id: peer, type: 'private', ...options.chat } } });
  const call = (path, body = {}, account = A, method = 'POST') => service.handleWallet({ account, method, path, body });
  const begin = async (account = A, language = 'zh') => {
    const { status, body } = await call('/binding', { language }, account);
    assert.equal(status, 201); return { ...body, token: new URL(body.url).searchParams.get('start') };
  };
  return { dir, store, telegram, service, sent, update, call, begin, advance: ms => { now += ms; }, now: () => now };
}

test('binding requires verified wallet and explicit confirmation; no IDs are exposed by status', async t => {
  const f = setup(t);
  assert.equal((await f.call('/binding', {}, null)).status, 401);
  const started = await f.begin();
  assert.equal(started.token.length, 32);
  assert.equal((await f.call('/status', {}, A, 'GET')).body.binding.status, 'pending');
  assert.equal((await f.call('/binding/confirm', { id: started.id })).status, 409);
  await f.service.handleTelegramUpdate(f.update(`/start ${started.token}`));
  const paired = (await f.call('/status', {}, A, 'GET')).body;
  assert.equal(paired.connected, false); assert.equal(paired.binding.status, 'paired');
  assert.equal(paired.binding.telegramLabel, '@private_user');
  assert.ok(!JSON.stringify(paired).includes('123456789'));
  assert.equal((await f.call('/binding/confirm', { id: started.id }, B)).status, 409);
  const confirmed = await f.call('/binding/confirm', { id: started.id, language: 'zh' });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.connected, true);
  assert.equal(f.store.getBinding(A).telegram.chatId, '123456789');
  assert.match(f.sent[0].text, /返回拼矿网页/);
  assert.equal(f.sent[0].options.reply_markup.inline_keyboard[0][0].url, 'https://example.test/bemine/?lang=zh#notifications');
});

test('forwarded token only stages a visible account; cannot replace binding without wallet confirmation', async t => {
  const f = setup(t), first = await f.begin();
  await f.service.handleTelegramUpdate(f.update(`/start ${first.token}`, 11111));
  await f.call('/binding/confirm', { id: first.id });
  const next = await f.begin();
  await f.service.handleTelegramUpdate(f.update(`/start ${next.token}`, 22222, { from: { username: 'unexpected_account' } }));
  assert.equal(f.store.getBinding(A).telegram.chatId, '11111');
  const pending = (await f.call('/status', {}, A, 'GET')).body.binding;
  assert.equal(pending.telegramLabel, '@unexpected_account');
  assert.equal((await f.call('/binding/confirm', { id: next.id }, B)).status, 409);
  await f.call('/disconnect');
  assert.equal((await f.call('/binding/confirm', { id: next.id })).status, 409);
  assert.equal(f.store.getBinding(A), null);
});

test('expired, consumed, replaced and replayed nonces cannot bind', async t => {
  const f = setup(t), first = await f.begin();
  await f.service.handleTelegramUpdate(f.update(`/start ${first.token}`));
  await f.service.handleTelegramUpdate(f.update(`/start ${first.token}`, 22222));
  assert.equal(f.store.pendingBinding(A).telegram.chatId, '123456789');
  f.advance(10_001);
  const replacement = await f.begin();
  assert.equal((await f.call('/binding/confirm', { id: first.id })).status, 409);
  f.advance(10 * 60_000);
  await f.service.handleTelegramUpdate(f.update(`/start ${replacement.token}`));
  assert.equal(f.store.pendingBinding(A), null);
  assert.equal((await f.call('/binding/confirm', { id: replacement.id })).status, 409);
});

test('group, forged peer and bot updates cannot consume tokens', async t => {
  const f = setup(t), pending = await f.begin();
  await f.service.handleTelegramUpdate(f.update(`/start ${pending.token}`, 123456789, { chat: { type: 'group' } }));
  await f.service.handleTelegramUpdate(f.update(`/start ${pending.token}`, 123456789, { chat: { id: 44444 } }));
  await f.service.handleTelegramUpdate(f.update(`/start ${pending.token}`, 123456789, { from: { is_bot: true } }));
  assert.equal(f.store.pendingBinding(A).status, 'pending'); assert.equal(f.sent.length, 0);
});

test('contacts and bot reply payloads are encrypted on disk; nonce plaintext is never stored', async t => {
  const f = setup(t), pending = await f.begin();
  f.telegram.sendMessage = async () => { throw new Error('network'); };
  await f.service.handleTelegramUpdate(f.update(`/start ${pending.token}`));
  await f.call('/binding/confirm', { id: pending.id });
  for (const name of readdirSync(f.dir)) {
    const bytes = readFileSync(join(f.dir, name));
    for (const sensitive of ['private_user', 'Private person', '123456789', pending.token]) assert.equal(bytes.includes(sensitive), false, `${name} leaks ${sensitive}`);
  }
  assert.throws(() => new NotificationStore(join(f.dir, 'private.sqlite'), { encryptionKey: Buffer.alloc(32, 18) }), /does not match/);
});

test('binding and nonce consumption survive restart', async t => {
  const f = setup(t), pending = await f.begin();
  await f.service.handleTelegramUpdate(f.update(`/start ${pending.token}`));
  f.store.close();
  const reopened = new NotificationStore(join(f.dir, 'private.sqlite'), { encryptionKey: key, now: f.now });
  t.after(() => reopened.close());
  assert.equal(reopened.pendingBinding(A).status, 'paired');
  assert.equal(reopened.stageBinding(pending.token, { userId: '22222', chatId: '22222' }), false);
  reopened.confirmBinding(A, pending.id);
  assert.equal(reopened.getBinding(A).telegram.username, 'private_user');
});

test('Telegram /stop mutes linked wallets and cancels unconfirmed pairing; language selection persists', async t => {
  const f = setup(t), pending = await f.begin(A, 'en');
  await f.service.handleTelegramUpdate(f.update(`/start ${pending.token}`));
  await f.call('/binding/confirm', { id: pending.id });
  const callback = { update_id: 100, callback_query: { id: 'language-choice', data: 'lang:zh', from: { id: 123456789 }, message: { chat: { id: 123456789, type: 'private' } } } };
  await f.service.handleTelegramUpdate(callback);
  assert.equal(f.store.preferences(A).language, 'zh');
  await f.service.handleTelegramUpdate(f.update('/stop'));
  assert.equal(f.store.preferences(A).enabled, false);
  assert.equal((await f.call('/preferences', { enabled: true })).body.notificationsEnabled, true);
  assert.equal((await f.call('/preferences', { language: 'fr' })).status, 400);
});

test('unknown language defaults to English; /start without token links trusted site only', async t => {
  const f = setup(t);
  await f.service.handleTelegramUpdate(f.update('/start', 123456789, { from: { language_code: 'fr' } }));
  assert.match(f.sent[0].text, /Welcome to BEMine/);
  assert.equal(f.sent[0].options.reply_markup.inline_keyboard[0][0].url, 'https://example.test/bemine/?lang=en#notifications');
  assert.throws(() => createNotificationService({ store: f.store, telegram: f.telegram, publicBaseUrl: 'http://evil.test' }), /trusted HTTPS/);
});

test('inbound reply retry is durable and duplicate webhook cannot repeat effects', async t => {
  const f = setup(t), pending = await f.begin();
  let attempts = 0;
  f.telegram.sendMessage = async (...args) => { if (++attempts === 1) throw new TelegramDeliveryError('network'); f.sent.push(args); };
  const update = f.update(`/start ${pending.token}`);
  await f.service.handleTelegramUpdate(update);
  assert.equal(f.store.pendingBinding(A).status, 'paired'); assert.equal(attempts, 1);
  await f.service.handleTelegramUpdate(update); assert.equal(attempts, 1);
  f.advance(2000); await f.service.flushBotReplies(); assert.equal(attempts, 2);
  await f.service.handleTelegramUpdate(update); assert.equal(attempts, 2);
});

test('failed webhook persistence rolls back nonce consumption and update receipt together', async t => {
  const f = setup(t), pending = await f.begin(), update = f.update(`/start ${pending.token}`);
  const enqueue = f.store.enqueueBotReply;
  f.store.enqueueBotReply = () => { throw new Error('simulated disk failure'); };
  await assert.rejects(f.service.handleTelegramUpdate(update), /simulated disk failure/);
  assert.equal(f.store.pendingBinding(A).status, 'pending');
  f.store.enqueueBotReply = enqueue;
  await f.service.handleTelegramUpdate(update);
  assert.equal(f.store.pendingBinding(A).status, 'paired'); assert.equal(f.sent.length, 1);
});

test('queue persists deduplication, retries, expiration, inbox isolation and worker lease', t => {
  const f = setup(t), job = { id: 'sale:pool:1:open:wallet', account: A, kind: 'sale_proposed', payload: { pool: 'public-pool' }, dueAt: f.now() };
  assert.equal(f.store.enqueue(job), true); assert.equal(f.store.enqueue(job), false);
  assert.equal(f.store.due().length, 1);
  f.store.retry(job.id, { dueAt: f.now() + 1000, errorCode: 'rate_limited' }); assert.equal(f.store.due().length, 0);
  f.advance(1000); assert.equal(f.store.due()[0].attempts, 1);
  f.store.ack(job.id, f.now()); assert.equal(f.store.due().length, 0);
  f.store.enqueue({ ...job, id: 'expiring', expiresAt: f.now() - 1 }); assert.equal(f.store.due().length, 0);
  f.store.addInbox({ ...job, createdAt: f.now() }); assert.equal(f.store.inbox(B).length, 0);
  f.store.readInbox(B, job.id); assert.equal(f.store.inbox(A)[0].readAt, null);
  assert.equal(f.store.acquireLease('worker', 'processA', 1000), true);
  assert.equal(f.store.acquireLease('worker', 'processB', 1000), false);
  assert.equal(f.store.releaseLease('worker', 'processB'), false);
  f.advance(1001); assert.equal(f.store.acquireLease('worker', 'processB', 1000), true);
});

test('private database rejects insecure permissions and dangling symlink', t => {
  const f = setup(t), target = join(f.dir, 'dangling.sqlite');
  symlinkSync(join(f.dir, 'missing-file.sqlite'), target);
  assert.throws(() => new NotificationStore(target, { encryptionKey: key }), /not a symlink/);
  chmodSync(f.dir, 0o755);
  assert.throws(() => new NotificationStore(join(f.dir, 'other.sqlite'), { encryptionKey: key }), /private/);
  chmodSync(f.dir, 0o700);
});

test('Telegram sender sanitizes transport errors and classifies blocked/rate limits', async () => {
  const broken = new TelegramClient({ token: fakeToken, fetchImpl: async () => { throw new Error(`failed https://api.telegram.org/bot${fakeToken}`); } });
  await assert.rejects(broken.sendMessage('12345', 'hello'), error => error.code === 'network' && !error.stack.includes(fakeToken));
  const blocked = new TelegramClient({ token: fakeToken, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error_code: 403, description: 'private contact' }) }) });
  await assert.rejects(blocked.sendMessage('12345', 'hello'), error => error.blocked && !error.retryable && !error.message.includes('private contact'));
  let count = 0;
  const limited = new TelegramClient({ token: fakeToken, fetchImpl: async () => { count++; return { ok: false, status: 429, json: async () => ({ error_code: 429, parameters: { retry_after: 120 } }) }; } });
  await assert.rejects(limited.sendMessage('12345', 'hello'), error => error.retryAfterMs === 120_000 && error.rateLimitScope === 'global');
  await assert.rejects(limited.sendMessage('67890', 'hello'), error => error.code === 'rate_limited' && error.rateLimitScope === 'global'); assert.equal(count, 1);
});

test('Telegram send uses fixed host, no parse mode and bounded per-chat rate', async () => {
  const requests = [];
  const client = new TelegramClient({ token: fakeToken, fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; } });
  await client.sendMessage('12345', '<private&literal>');
  await assert.rejects(client.sendMessage('12345', 'second'), error => error.code === 'rate_limited' && error.retryAfterMs > 500 && error.rateLimitScope === 'chat');
  await client.sendMessage('67890', 'another recipient');
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).origin, 'https://api.telegram.org');
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.parse_mode, undefined); assert.equal(payload.text, '<private&literal>');
  assert.equal(requests[0].options.redirect, 'error');
  assert.throws(() => client.request('../arbitrary', {}), /Unsupported/);
});

test('local chat cooldown can be requeued without consuming transport retry attempts', t => {
  const f = setup(t), job = { id: 'chat-cooldown', account: A, kind: 'proposal', payload: {}, dueAt: f.now() };
  f.store.enqueue(job);
  for (let i = 0; i < 10; i++) f.store.retry(job.id, { dueAt: f.now(), errorCode: 'telegram_chat_cooldown', countAttempt: false });
  assert.equal(f.store.due()[0].attempts, 0);
  f.store.retry(job.id, { dueAt: f.now(), errorCode: 'telegram_network' });
  assert.equal(f.store.due()[0].attempts, 1);
});
