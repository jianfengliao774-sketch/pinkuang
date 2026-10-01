import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitingTransactionFinality } from '../lib/transaction-notice.mjs';

const pending = { status: 'pending', hash: `0x${'a'.repeat(64)}`,
  message: 'Transaction is not finalized on the canonical chain.' };

test('normal finality waiting with a broadcast hash stays in background status', () => {
  assert.equal(awaitingTransactionFinality(pending), true);
  assert.equal(awaitingTransactionFinality({ ...pending, message: ` ${pending.message} ` }), true);
});

test('failures, unknown submissions and other messages are not silently suppressed', () => {
  for (const result of [null, { ...pending, status: 'reverted' }, { ...pending, status: 'confirmed' },
    { ...pending, hash: undefined }, { ...pending, hash: '0x1234' },
    { ...pending, message: 'login required' }, { ...pending, message: 'RPC timeout' },
    { ...pending, message: 409 }]) {
    assert.equal(awaitingTransactionFinality(result), false);
  }
});
