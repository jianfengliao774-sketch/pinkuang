import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Interface } from 'ethers';
import { JournalStore } from './journal-store.mjs';
import { readFirstoAskJournal, writeFirstoAskJournal, createPendingFirstoSaleIntentReader,
  writeFirstoAskStatus, readFirstoAskPublisherStatus, acquireFirstoAskJournalLock } from './firsto-ask-publisher-store.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`, factory = address(1), exchange = address(2), pool = address(3);
const saleAbi = new Interface(['function completeFirstoSale(uint256,uint256,uint16,uint256) payable']);
const intentFor = (proposal = 1) => ({ version: 2, chainId: 56, factory, target: pool, targetType: 'pool',
  action: { kind: 'completeFirstoSale' }, nonce: 7, value: '101', submittedAt: 1000,
  data: saleAbi.encodeFunctionData('completeFirstoSale', [proposal, 100, 100, 1]) });
const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'native-ask-state-')); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('publication state survives restart, preserves attempted bytes and rejects another deployment', t => {
  const path = join(temporary(t), 'asks.json'), journal = readFirstoAskJournal(path, { factory, exchange });
  journal.pools[pool] = { pool, askHash: `0x${'ab'.repeat(32)}`, nonce: '1', phase: 'ambiguous', envelope: { message: { nonce: '1' } } };
  writeFirstoAskJournal(path, journal);
  assert.deepEqual(readFirstoAskJournal(path, { factory, exchange }), journal);
  assert.throws(() => readFirstoAskJournal(path, { factory: address(5), exchange }), /another deployment/);
});

test('API-owned publication lock excludes another worker and reuses the same private inode after release',
  { skip: process.platform !== 'linux' }, t => {
    const path = join(temporary(t), 'asks.json'), release = acquireFirstoAskJournalLock(path);
    const inode = statSync(`${path}.lock`).ino;
    try { assert.throws(() => acquireFirstoAskJournalLock(path), /lock already exists/); }
    finally { release(); }
    const next = acquireFirstoAskJournalLock(path);
    try { assert.equal(statSync(`${path}.lock`).ino, inode); assert.equal(statSync(`${path}.lock`).mode & 0o777, 0o600); }
    finally { next(); }
  });

test('prepared records do not reserve asks; armed unknown sends survive restart and bind to the current proposal', t => {
  const path = join(temporary(t), 'journal.sqlite'), owner = address(7), intent = intentFor();
  let store = new JournalStore(path);
  const reader = createPendingFirstoSaleIntentReader(path, { factory });
  try {
    store.putMarket(owner, intent, 0);
    assert.equal(reader.hasPendingSaleIntent(pool, { nonce: '1' }), false);
    store.close(); store = new JournalStore(path);
    assert.equal(reader.hasPendingSaleIntent(pool, { nonce: '1' }), false, 'restart cannot turn preparation into signing');
    store.armMarket(owner, 1);
    assert.equal(reader.hasPendingSaleIntent(pool, { nonce: '1' }), true, 'unknown hash stays protected');
    store.close(); store = new JournalStore(path);
    assert.equal(reader.hasPendingSaleIntent(pool, { nonce: '1' }), true);
    assert.equal(reader.hasPendingSaleIntent(pool, { nonce: '2' }), false, 'old proposal cannot buy a new listing');
    assert.equal(reader.hasPendingSaleIntent(address(8), { nonce: '1' }), false);
    assert.deepEqual(store.market(owner).record, intent, 'publication never changes recovery state');
    store.deleteMarket(owner, 2, { transactionHash: `0x${'ab'.repeat(32)}`, status: 'confirmed', finalized: true });
    store.putMarket(owner, { ...intentFor(2), nonce: 8 }, 3);
    assert.equal(reader.hasPendingSaleIntent(pool, { nonce: '2' }), false, 'old signing key does not arm a new preparation');
    for (const patch of [{ hash: `0x${'cd'.repeat(32)}` }, { recoveryHashes: [`0x${'cd'.repeat(32)}`] },
      { cancellationRequests: [{ nonce: 8 }] }]) {
      store.db.prepare('UPDATE market SET record=?').run(JSON.stringify({ ...intentFor(2), nonce: 8, ...patch }));
      assert.equal(reader.hasPendingSaleIntent(pool, { nonce: '2' }), true);
    }
    store.db.prepare('UPDATE market SET record=?').run(JSON.stringify({ ...intentFor(), data: '0x1234', hash: `0x${'cd'.repeat(32)}` }));
    assert.equal(reader.hasPendingSaleIntent(pool, { nonce: '2' }), true, 'undecodable broadcast remains conservative');
  } finally { reader.close(); store.close(); }
});

test('public publication status is bounded, identity-specific and does not turn stale data into freshness', t => {
  const path = join(temporary(t), 'status.json'), stamp = 1790904988000;
  const status = { schemaVersion: 1, chainId: 56, factory, exchange, enabled: true,
    updatedAt: new Date(stamp - 100000).toISOString(), pools: { [pool]: { pool, status: 'publication-unknown', askHash: `0x${'ab'.repeat(32)}` } } };
  writeFirstoAskStatus(path, status);
  const result = readFirstoAskPublisherStatus(path, { factory, exchange, pool, now: () => stamp });
  assert.equal(result.stale, true); assert.equal(result.item.status, 'publication-unknown');
  assert(!Object.hasOwn(result.item, 'account')); assert.throws(() => readFirstoAskPublisherStatus(path,
    { factory: address(7), exchange, pool, now: () => stamp }));
  writeFileSync(path, 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.throws(() => readFirstoAskPublisherStatus(path, { factory, exchange, pool, now: () => stamp }), /bounded/);
});

test('the real finalized journal deletion releases the buyer gate while its immutable result stays archived', t => {
  const path = join(temporary(t), 'journal.sqlite'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE market(account TEXT PRIMARY KEY,revision INTEGER,record TEXT); CREATE TABLE market_signing(account TEXT PRIMARY KEY,intent_key TEXT); CREATE TABLE market_results(account TEXT,hash TEXT,result TEXT,PRIMARY KEY(account,hash))');
  chmodSync(path, 0o600);
  const owner = address(7), record = { version: 2, chainId: 56, factory, target: pool, targetType: 'pool',
    action: { kind: 'completeFirstoSale' }, hash: `0x${'ab'.repeat(32)}`, status: 'complete' };
  db.prepare('INSERT INTO market VALUES(?,?,?)').run(owner, 1, JSON.stringify(record));
  const store = Object.assign(Object.create(JournalStore.prototype), { db });
  const reader = createPendingFirstoSaleIntentReader(path, { factory });
  try {
    assert.equal(reader.hasPendingSaleIntent(pool), true, 'A client completion label cannot release an unresolved server intent.');
    const result = { transactionHash: `0x${'ab'.repeat(32)}`, status: 'confirmed', finalized: true };
    assert.equal(store.deleteMarket(owner, 1, result), 2);
    assert.equal(store.market(owner).record, null);
    assert.equal(reader.hasPendingSaleIntent(pool), false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM market_results').get().n, 1);
    db.prepare('UPDATE market SET revision=3,record=? WHERE account=?').run(JSON.stringify({ ...record, hash: `0x${'cd'.repeat(32)}` }), owner);
    assert.equal(reader.hasPendingSaleIntent(pool), true, 'A new unresolved purchase remains independent of the archived result.');
  } finally { reader.close(); store.close(); }
});
