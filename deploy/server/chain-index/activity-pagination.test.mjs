import test from 'node:test';
import assert from 'node:assert/strict';
import { ChainIndex } from './indexer.mjs';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;

test('activity exposes complete filtered raw and overview counts independently of its cursor', () => {
  let rpcCalls = 0;
  const forbidden = async () => { rpcCalls++; throw new Error('Counting must not perform RPC'); };
  const index = new ChainIndex({ getLogs: forbidden, call: forbidden, send: forbidden },
    { dbPath: ':memory:', factory: addr(1), market: addr(2), startBlock: 0 });
  try {
    index.db.prepare('INSERT INTO headers(number,hash,parent_hash,timestamp) VALUES(?,?,?,?)').run(1, hash(1), hash(0), 100);
    const insert = index.db.prepare('INSERT INTO logs(block_number,tx_index,log_index,tx_hash,address,kind,name,args) VALUES(?,?,?,?,?,?,?,?)');
    const pool = addr(3), alice = addr(4), bob = addr(5);
    for (let n = 0; n < 7; n++) {
      insert.run(1, n, 0, hash(n + 10), pool, 'pool', 'Transfer', JSON.stringify({ from: addr(0), to: alice, value: '1' }));
      insert.run(1, n, 1, hash(n + 10), pool, 'pool', 'Deposited', JSON.stringify({ user: alice, shares: '1', amount: '100' }));
    }
    insert.run(1, 7, 0, hash(17), pool, 'pool', 'Transfer', JSON.stringify({ from: alice, to: bob, value: '1' }));
    insert.run(1, 8, 0, hash(18), pool, 'pool', 'Transfer', JSON.stringify({ from: addr(0), to: bob, value: '1' }));
    const first = index.activity({ account: alice, limit: 5 });
    assert.equal(first.items.length, 5); assert.equal(first.totalCount, 15); assert.equal(first.overviewTotalCount, 8);
    const second = index.activity({ account: alice, limit: 5, cursor: first.nextCursor });
    assert.equal(second.items.length, 5); assert.equal(second.totalCount, 15); assert.equal(second.overviewTotalCount, 8);
    assert.equal(new Set([...first.items, ...second.items].map(row => `${row.transactionHash}:${row.logIndex}`)).size, 10);
    const all = index.activity({ pool, limit: 50 });
    assert.equal(all.items.length, 16); assert.equal(all.totalCount, 16); assert.equal(all.overviewTotalCount, 9);
    const nobody = index.activity({ account: addr(99), limit: 5 });
    assert.equal(nobody.totalCount, 0); assert.equal(nobody.overviewTotalCount, 0); assert.equal(nobody.nextCursor, null);
    const emptyCursor = index.activity({ account: alice, cursor: '0:0:0', limit: 5 });
    assert.equal(emptyCursor.items.length, 0); assert.equal(emptyCursor.totalCount, 15); assert.equal(emptyCursor.overviewTotalCount, 8);
    assert.equal(rpcCalls, 0);
  } finally { index.close(); }
});
