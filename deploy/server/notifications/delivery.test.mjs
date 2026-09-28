import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NotificationStore } from './store.mjs';
import { createNotificationWorker, createNotificationSource, verifyNotificationSource, renderNotification } from './delivery.mjs';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`, hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const factory = addr(1), market = addr(2), pool = addr(3), alice = addr(5), bob = addr(6);
const publicBaseUrl = 'https://tapeout.cc.cd/bemine/';
const START = 1_800_000_000_000;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'bemine-notification-delivery-')), dbPath = join(directory, 'private.sqlite');
  let time = START - 3 * 86400_000;
  let store = new NotificationStore(dbPath, { encryptionKey: 'ab'.repeat(32), now: () => time });
  const sent = [];
  const bind = (account, chatId = '123') => {
    const pending = store.issueBinding(account);
    store.stageBinding(pending.token, { userId: chatId, chatId, username: `user${chatId}` });
    store.confirmBinding(account, pending.id);
  };
  bind(alice); time = START;
  const p = { proposalId: '1', eventId: `${hash(11)}:0`, createdAt: START / 1000 - 3600,
    endsAt: START / 1000 + 23 * 3600, owners: [{ account: alice, shares: '49' }, { account: bob, shares: '49' }],
    votes: [], priceWei: '1000000000000000000', passed: false, open: true, roundExecuted: false, executed: false };
  const data = { schemaVersion: 1, nextCursor: null, anchorVerified: true,
    items: [{ address: pool, circuitId: '16210', verified: true, proposals: [p] }] };
  const feed = () => ({ ...structuredClone(data), source: { chainId: 56, factory, market, complete: true, unknownReason: null,
    confirmations: 12, indexedThrough: 100, indexedBlockHash: hash(100), observedSafeHead: 100,
    checkedAt: new Date(time).toISOString(), indexedTimestamp: time / 1000 - 12 } });
  const sender = { sendMessage: async (chatId, text, options) => { sent.push({ chatId, text, options }); return { message_id: sent.length }; } };
  const make = (extra = {}) => createNotificationWorker({ store, source: async () => feed(), sender,
    factory, market, publicBaseUrl, now: () => time, ...extra });
  return { get store() { return store; }, sent, sender, p, data, feed, make, bind,
    time: value => { time = value; }, now: () => time,
    restart() { store.close(); store = new NotificationStore(dbPath, { encryptionKey: 'ab'.repeat(32), now: () => time }); },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('confirmed notifications deduplicate durably across worker and database restarts', async () => {
  const f = fixture();
  try {
    assert.equal((await f.make().tick()).sent, 1);
    assert.equal(f.store.inbox(bob).length, 1, 'unbound snapshot owners still receive an in-app item');
    assert.match(f.sent[0].options.reply_markup.inline_keyboard[0][0].url, /#detail\/0x/);
    f.restart(); assert.equal((await f.make().tick()).sent, 0); assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('late binding catches up only active relevant proposals, not historical listing and sale events', async () => {
  const f = fixture();
  try {
    await f.make().tick(); f.time(START + 60_000); f.bind(bob, '456');
    assert.equal((await f.make().tick()).sent, 1); assert.equal(f.sent.at(-1).chatId, '456');
    f.time(START + 120_000); f.store.disconnect(bob);
    f.p.open = false; f.p.executed = true; f.p.roundExecuted = true;
    f.p.listing = { eventId: `${hash(12)}:0`, timestamp: (START + 100_000) / 1000, expiresAt: START / 1000 + 7 * 86400 };
    f.p.completed = { eventId: `${hash(13)}:0`, timestamp: (START + 110_000) / 1000 };
    f.bind(bob, '789');
    const before = f.sent.length; await f.make().tick();
    assert.equal(f.sent.length - before, 1, 'only Alice was bound before the actual completion');
    assert.equal(f.sent.at(-1).chatId, '123'); assert.match(f.sent.at(-1).text, /sale completed/i);
  } finally { f.close(); }
});

test('stale, incomplete, wrong deployment, mixed/reorg and unsupported snapshots send nothing', async () => {
  const f = fixture();
  try {
    const changes = [s => { s.source.complete = false; }, s => { s.source.checkedAt = new Date(START - 300000).toISOString(); },
      s => { s.source.indexedTimestamp -= 300; }, s => { s.source.factory = addr(99); },
      s => { s.source.chainId = 1; }, s => { s.items[0].verified = false; }, s => { s.nextCursor = 1; }];
    for (const change of changes) {
      const feed = f.feed(); change(feed);
      await assert.rejects(f.make({ source: async () => feed }).tick(), /source/);
    }
    f.store.setMeta('delivery_checkpoint', { block: 100, hash: hash(99) });
    await assert.rejects(f.make().tick(), /source/); assert.equal(f.sent.length, 0);
  } finally { f.close(); }
});

test('reminders stop after voting, early listing by another candidate, or reaching actual deadline', async () => {
  const f = fixture();
  try {
    await f.make().tick(); f.time((f.p.endsAt - 5 * 3600) * 1000);
    assert.equal((await f.make().tick()).sent, 1); assert.match(f.sent.at(-1).text, /6 hours/);
    f.p.votes.push({ account: alice }); f.time((f.p.endsAt - 1800) * 1000);
    assert.equal((await f.make().tick()).sent, 0);
    f.p.votes = []; f.p.roundExecuted = true; f.p.open = false;
    assert.equal((await f.make().tick()).sent, 0, 'another winning candidate closes this candidate reminders');
    f.p.roundExecuted = false; f.time(f.p.endsAt * 1000 + 1000); f.p.passed = true;
    await f.make().tick(); assert.match(f.sent.at(-1).text, /cannot be executed after its deadline/);
    assert(!f.sent.at(-1).text.includes('Miner listed for sale'));
  } finally { f.close(); }
});

test('429 retry_after persists across restart and pauses the whole sender queue', async () => {
  const f = fixture();
  try {
    f.time(START - 1000); f.bind(bob, '456'); f.time(START);
    let attempts = 0;
    f.sender.sendMessage = async () => { attempts++; throw { code: 'rate_limited', retryAfterMs: 90000, retryable: true }; };
    assert.equal((await f.make().tick()).retried, 1); assert.equal(attempts, 1);
    f.restart(); f.time(START + 60_000); await f.make().tick(); assert.equal(attempts, 1);
    f.sender.sendMessage = async () => { attempts++; };
    f.time(START + 91000); assert.equal((await f.make().tick()).sent, 2); assert.equal(attempts, 3);
  } finally { f.close(); }
});

test('disconnect cancels pending tasks and rebinding never sends a queued task to an old chat', async () => {
  const f = fixture();
  try {
    f.sender.sendMessage = async () => { throw { retryable: true }; };
    await f.make().tick(); f.time(START + 1000); f.bind(alice, '999');
    f.sender.sendMessage = async (chatId) => { f.sent.push({ chatId }); };
    f.time(START + 31000); await f.make().tick(); assert.deepEqual(f.sent, [{ chatId: '999' }]);
    f.p.endsAt = (START + 31000) / 1000 + 1200; f.time(START + 700000);
    f.sender.sendMessage = async () => { throw { retryable: true }; };
    await f.make().tick(); f.store.disconnect(alice);
    f.sender.sendMessage = async chatId => { f.sent.push({ chatId }); }; f.time(START + 740000);
    await f.make().tick(); assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('one busy Telegram chat delays only its own job without consuming retries or blocking another user', async () => {
  const f = fixture();
  try {
    f.time(START - 1000); f.bind(bob, '456'); f.time(START);
    const second = structuredClone(f.p); second.proposalId = '2'; second.eventId = `${hash(12)}:0`;
    f.p.owners = [{ account: alice, shares: '49' }]; f.data.items[0].proposals.push(second);
    let aliceCount = 0;
    f.sender.sendMessage = async chatId => {
      if (chatId === '123' && ++aliceCount > 1) throw { code: 'rate_limited', rateLimitScope: 'chat', retryAfterMs: 800, retryable: true };
      f.sent.push({ chatId });
    };
    const result = await f.make().tick();
    assert.equal(result.sent, 2); assert.equal(result.retried, 1);
    assert.deepEqual(f.sent, [{ chatId: '123' }, { chatId: '456' }]);
    assert.equal(f.store.getMeta('delivery_not_before'), null);
    const pending = f.store.db.prepare("SELECT attempts,due_at FROM notification_queue WHERE status='pending'").get();
    assert.equal(pending.attempts, 0); assert.equal(pending.due_at, START + 1000);
  } finally { f.close(); }
});

test('shared durable lease prevents independent workers draining the same queue simultaneously', async () => {
  const f = fixture();
  try {
    let release; const waiting = new Promise(resolve => { release = resolve; });
    const first = f.make({ source: async () => { await waiting; return f.feed(); } }).tick();
    assert.equal((await f.make().tick()).status, 'busy'); release(); await first; assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('source client pins every page and rejects duplicate pools, changed head, missing anchor and remote URLs', async () => {
  const f = fixture();
  try {
    const calls = [];
    const source = createNotificationSource({ baseUrl: 'http://127.0.0.1:4180', fetchImpl: async url => {
      calls.push(String(url)); const first = calls.length === 1;
      return new Response(JSON.stringify({ source: f.feed().source,
        data: { schemaVersion: 1, anchorVerified: true, items: first ? f.data.items : [], nextCursor: first ? 5 : null } }));
    } });
    const result = await source({ block: 99, hash: hash(99) });
    assert.equal(result.items.length, 1); assert.match(calls[1], /atBlock=100/); assert.match(calls[1], /anchorBlock=99/);
    assert.throws(() => createNotificationSource({ baseUrl: 'https://untrusted.example' }), /loopback/);
    const duplicated = createNotificationSource({ baseUrl: 'http://localhost:4180', fetchImpl: async () =>
      new Response(JSON.stringify({ source: f.feed().source, data: { schemaVersion: 1, items: f.data.items, nextCursor: 5 } })) });
    await assert.rejects(duplicated(), /source/);
  } finally { f.close(); }
});

test('bilingual copy distinguishes reached vote thresholds, listing, and actual completed sale', () => {
  const payload = { kind: 'vote_closed', pool, circuitId: '1', proposalId: '2', priceWei: '1100000000000000000', shares: '1', endsAt: START / 1000, passed: true };
  const zh = renderNotification(payload, 'zh', publicBaseUrl), en = renderNotification(payload, 'en', publicBaseUrl);
  assert.match(zh.text, /达门槛，但本轮未执行挂牌/); assert.match(zh.text, /1.1 BNB/); assert.match(en.text, /no listing was executed/);
  assert.match(renderNotification({ ...payload, kind: 'listed' }, 'zh', publicBaseUrl).text, /尚未成交/);
  assert.match(renderNotification({ ...payload, kind: 'completed' }, 'zh', publicBaseUrl).text, /链上已确认矿机成交/);
});
