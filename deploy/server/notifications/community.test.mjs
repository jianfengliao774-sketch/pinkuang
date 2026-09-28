import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NotificationStore } from './store.mjs';
import { createCommunitySource, createCommunityWorker, renderCommunityAnnouncement } from './community.mjs';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`, hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const factory = addr(1), market = addr(2), publicBaseUrl = 'https://tapeout.cc.cd/bemine/', START = 1_800_000_000_000;
const community = { chatId: '-1004492628953', threadId: 2, username: 'BEMineCommunity', photoUrl: `${publicBaseUrl}images/bemine-share-v11-tech.jpg` };
const pool = n => ({ address: addr(n), createdBlock: 101, createdAt: START / 1000, eventId: `${hash(n)}:0`, collection: addr(20), circuitId: '16210',
  actualCircuitId: null, targetRaiseWei: '7480000000000000000', unitPriceWei: '74800000000000000', totalShares: 100,
  subscribedShares: 1, state: 'Funding', fundingDeadline: START / 1000 + 86400, depositPaused: false, verified: true });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bemine-community-')), path = join(dir, 'private.sqlite');
  let time = START, height = 100;
  let store = new NotificationStore(path, { encryptionKey: 'ab'.repeat(32), now: () => time });
  const items = [], sent = [], edits = [];
  const feed = () => ({ schemaVersion: 1, items: structuredClone(items), nextCursor: null, anchorVerified: true,
    source: { chainId: 56, factory, market, complete: true, unknownReason: null, confirmations: 12, indexedThrough: height,
      observedSafeHead: height, indexedBlockHash: hash(height), indexedTimestamp: Math.floor(time / 1000) - 12, checkedAt: new Date(time).toISOString() } });
  const sender = { sendTopicPhoto: async (target, payload) => { sent.push({ target, payload }); return { message_id: sent.length + 100 }; },
    editTopicCaption: async (target, id, payload) => { edits.push({ target, id, payload }); return { message_id: id }; } };
  const make = (extra = {}) => createCommunityWorker({ store, source: async () => feed(), sender, factory, market, publicBaseUrl, community, now: () => time, ...extra });
  return { get store() { return store; }, items, sent, edits, sender, feed, make,
    height: value => { height = value; }, time: value => { time = value; },
    async baseline() { await make().tick(); height = 101; },
    restart() { store.close(); store = new NotificationStore(path, { encryptionKey: 'ab'.repeat(32), now: () => time }); },
    rows() { return store.db.prepare('SELECT * FROM community_announcements ORDER BY pool').all(); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('baseline excludes historical projects; one announcement per tick persists across restart', async () => {
  const f = fixture();
  try {
    f.items.push({ ...pool(3), createdBlock: 99 });
    assert.equal((await f.make().tick()).status, 'baselined'); assert.equal(f.sent.length, 0);
    f.height(101); f.items.push(pool(4), pool(5));
    assert.equal((await f.make().tick()).sent, 1); assert.equal(f.sent[0].target.threadId, 2); assert.equal(f.sent[0].target.chatId, community.chatId);
    f.restart(); assert.equal((await f.make().tick()).sent, 1);
    f.restart(); assert.equal((await f.make().tick()).sent, 0); assert.equal(f.sent.length, 2);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM notification_queue').get().n, 0);
  } finally { f.close(); }
});

test('confirmed state changes edit original; progress changes alone do not send or edit', async () => {
  const f = fixture();
  try {
    await f.baseline(); const p = pool(3); f.items.push(p); await f.make().tick();
    p.subscribedShares = 20; await f.make().tick(); assert.equal(f.edits.length, 0);
    p.state = 'Funded'; p.subscribedShares = 100; assert.equal((await f.make().tick()).edited, 1);
    assert.match(f.edits[0].payload.caption, /等待购机/);
    p.state = 'Active'; p.actualCircuitId = '999'; await f.make().tick();
    assert.match(f.edits[1].payload.caption, /Miner #999/); assert.equal(f.edits[1].id, 101);
    assert.equal(f.sent.length, 1); await f.make().tick(); assert.equal(f.edits.length, 2);
  } finally { f.close(); }
});

test('expired, full or paused pools are not announced; published pause and expiry update original', async () => {
  const f = fixture();
  try {
    await f.baseline(); const p = pool(3); f.items.push(p, { ...pool(4), subscribedShares: 100 }, { ...pool(5), depositPaused: true },
      { ...pool(6), fundingDeadline: START / 1000 - 1 });
    await f.make().tick(); assert.equal(f.sent.length, 1);
    p.depositPaused = true; await f.make().tick(); assert.match(f.edits.at(-1).payload.caption, /Subscription paused/);
    p.depositPaused = false; f.time(START + 86401_000); await f.make().tick();
    assert.match(f.edits.at(-1).payload.caption, /Subscription closed/); assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('transient failure retries durably and 429 cooldown does not consume attempts', async () => {
  const f = fixture();
  try {
    await f.baseline(); f.items.push(pool(3)); let calls = 0;
    f.sender.sendTopicPhoto = async () => { calls++; throw { code: 429, retryAfterMs: 90000 }; };
    assert.equal((await f.make().tick()).retried, 1); assert.equal(f.rows()[0].attempts, 0);
    f.restart(); f.time(START + 60000); await f.make().tick(); assert.equal(calls, 1);
    f.time(START + 91000); f.sender.sendTopicPhoto = async () => { calls++; throw { retryable: true }; };
    await f.make().tick(); assert.equal(f.rows()[0].attempts, 1);
    f.time(START + 122000); f.sender.sendTopicPhoto = async () => { calls++; return { message_id: 99 }; };
    assert.equal((await f.make().tick()).sent, 1); assert.equal(f.rows()[0].message_id, 99);
  } finally { f.close(); }
});

test('paused new project opens on resume; cancelled queued post resumes and published pause resumes by edit', async () => {
  const f = fixture();
  try {
    await f.baseline(); const p = { ...pool(3), depositPaused: true }; f.items.push(p);
    await f.make().tick(); assert.equal(f.sent.length, 0);
    p.depositPaused = false; const send = f.sender.sendTopicPhoto;
    f.sender.sendTopicPhoto = async () => { throw { retryable: true }; }; await f.make().tick();
    p.depositPaused = true; await f.make().tick(); assert.equal(f.rows()[0].status, 'cancelled');
    p.depositPaused = false; f.sender.sendTopicPhoto = send; await f.make().tick(); assert.equal(f.sent.length, 1);
    p.depositPaused = true; await f.make().tick(); p.depositPaused = false; await f.make().tick();
    assert.equal(f.edits.length, 2); assert.match(f.edits[1].payload.caption, /Open for subscription/);
  } finally { f.close(); }
});

test('429 pauses all community posts durably, not just the failed project', async () => {
  const f = fixture();
  try {
    await f.baseline(); f.items.push(pool(3), pool(4)); let calls = 0;
    f.sender.sendTopicPhoto = async () => { calls++; throw { code: 429, retryAfterMs: 90000 }; };
    await f.make().tick(); f.restart(); f.time(START + 60000); await f.make().tick(); assert.equal(calls, 1);
    f.time(START + 91000); await f.make().tick(); assert.equal(calls, 2);
  } finally { f.close(); }
});

test('eight transient attempts stop; deleted message or closed topic never falls back to fresh send', async () => {
  const f = fixture();
  try {
    await f.baseline(); f.items.push(pool(3)); let calls = 0;
    f.sender.sendTopicPhoto = async () => { calls++; throw { retryable: true }; };
    for (let i = 0; i < 12; i++) { f.time(START + i * 3600_000); await f.make().tick(); }
    assert.equal(calls, 8); assert.equal(f.rows()[0].status, 'blocked');
    f.items.push(pool(4)); f.sender.sendTopicPhoto = async () => ({ message_id: 400 }); await f.make().tick();
    f.items[1].state = 'Active'; f.sender.editTopicCaption = async () => { throw { retryable: false, code: 400 }; };
    assert.equal((await f.make().tick()).blocked, 1); const before = f.rows()[1].attempts;
    await f.make().tick(); assert.equal(f.rows()[1].attempts, before); assert.equal(f.rows()[1].message_id, 400);
  } finally { f.close(); }
});

test('stale, wrong factory, missing verification, malformed price and reorg fail closed', async () => {
  const f = fixture();
  try {
    await f.baseline(); f.items.push(pool(3));
    for (const change of [d => { d.source.checkedAt = new Date(START - 300000).toISOString(); }, d => { d.source.factory = addr(99); },
      d => { d.anchorVerified = false; }, d => { d.items[0].verified = false; }, d => { d.items[0].unitPriceWei = '-1'; },
      d => { delete d.items[0].depositPaused; }]) {
      const data = f.feed(); change(data); await assert.rejects(f.make({ source: async () => data }).tick(), /source/);
    }
    f.height(100); const bad = f.feed(); bad.items[0].createdBlock = 100; bad.source.indexedBlockHash = hash(999);
    await assert.rejects(f.make({ source: async () => bad }).tick(), /source/); assert.equal(f.sent.length, 0);
  } finally { f.close(); }
});

test('concurrent ticks share persistent lease and do not send twice', async () => {
  const f = fixture();
  try {
    await f.baseline(); f.items.push(pool(3)); let release;
    f.sender.sendTopicPhoto = async () => { await new Promise(r => { release = r; }); return { message_id: 1 }; };
    const one = f.make().tick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.make().tick()).status, 'busy'); release(); assert.equal((await one).sent, 1);
    assert.equal((await f.make().tick()).sent, 0);
  } finally { f.close(); }
});

test('deadline crossed during Telegram request is corrected on next tick', async () => {
  const f = fixture();
  try {
    await f.baseline(); f.items.push({ ...pool(3), fundingDeadline: START / 1000 + 1 });
    const send = f.sender.sendTopicPhoto;
    f.sender.sendTopicPhoto = async (...args) => { const result = await send(...args); f.time(START + 2000); return result; };
    await f.make().tick(); assert.match(f.sent[0].payload.caption, /Open for subscription/);
    assert.equal(f.rows()[0].last_state, 'Funding');
    await f.make().tick(); assert.match(f.edits[0].payload.caption, /Subscription closed/); assert.equal(f.rows()[0].last_state, 'Expired');
  } finally { f.close(); }
});

test('safe bounded bilingual template links only verified address at configured HTTPS site', () => {
  const message = renderCommunityAnnouncement(pool(3), { publicBaseUrl, now: START });
  assert(message.caption.length <= 1024); assert.match(message.caption, /参考矿机/); assert.match(message.caption, /0.0748 BNB/);
  assert(!message.caption.includes('10%')); assert(!message.caption.includes('收益'));
  for (const button of message.reply_markup.inline_keyboard[0]) {
    const url = new URL(button.url); assert.equal(url.origin, 'https://tapeout.cc.cd'); assert.equal(url.hash, `#detail/${addr(3)}`);
  }
  assert.throws(() => renderCommunityAnnouncement({ ...pool(3), address: 'https://evil.example' }, { publicBaseUrl }), /source/);
  assert.throws(() => renderCommunityAnnouncement(pool(3), { publicBaseUrl: 'http://example.com' }), /HTTPS/);
});

test('explicit group topic and same-origin poster required', () => {
  const f = fixture();
  try {
    for (const value of [{ ...community, threadId: undefined }, { ...community, threadId: 3 }, { ...community, chatId: '12345' },
      { ...community, photoUrl: 'https://evil.example/poster.jpg' }]) assert.throws(() => f.make({ community: value }));
  } finally { f.close(); }
});

test('community source pins page hash and prior anchor, rejects mixed snapshots and bounds', async () => {
  const f = fixture();
  try {
    f.height(102); const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options }); const page = Number(url.searchParams.get('cursor'));
      return new Response(JSON.stringify({ source: f.feed().source, data: { schemaVersion: 1, items: [pool(page + 3)], nextCursor: page === 0 ? 1 : null, anchorVerified: true } }));
    };
    const source = createCommunitySource({ baseUrl: 'http://127.0.0.1:4180', fetchImpl });
    const data = await source({ block: 100, hash: hash(100) }); assert.equal(data.items.length, 2);
    assert.match(calls[0].url, /\/v1\/community/); assert.match(calls[1].url, /atBlock=102/); assert.match(calls[1].url, /anchorBlock=100/);
    assert.equal(calls[0].options.redirect, 'error');
    const mixed = async (url, options) => { const response = await fetchImpl(url, options), body = await response.json();
      if (url.searchParams.get('cursor') !== '0') body.source.indexedBlockHash = hash(500); return new Response(JSON.stringify(body)); };
    await assert.rejects(createCommunitySource({ baseUrl: 'http://localhost:4180', fetchImpl: mixed })(), /source/);
    await assert.rejects(createCommunitySource({ baseUrl: 'http://localhost:4180', fetchImpl, maxPages: 1 })(), /bound/);
    assert.throws(() => createCommunitySource({ baseUrl: 'https://external.example' }), /loopback/);
  } finally { f.close(); }
});
