import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { feeCollectionDecision, parseTreasuryArguments, remainingTreasuryGasBudget,
  unresolvedTreasuryJournal } from './treasury-collector.mjs';
import { writeJournal } from './purchase-keeper.mjs';

const FACTORY = '0xcB24E7F96D81037086A268d6ea63c53f91D412A2';
const MARKET = '0x0B274eFD3E33139209D1C62512F7e2345F16dD3c';
const POOL = '0x1111111111111111111111111111111111111111';
const journal = { gasSpentWei: '0', gasReceipts: {}, transaction: null };

test('fee collector is read-only by default and refuses an unjournaled sender or remote HTTP RPC', () => {
  const dry = parseTreasuryArguments(['--factory', FACTORY]);
  assert.equal(dry.send, false);
  assert.throws(() => parseTreasuryArguments(['--factory', FACTORY, '--send']), /journal-dir/);
  assert.throws(() => parseTreasuryArguments(['--factory', FACTORY, '--rpc', 'http://remote.example']), /HTTPS/);
});

test('a BNB credit must exceed the worst-case gas and the cumulative gas budget', () => {
  const gas = 30_000n, price = 1_000_000_000n;
  const small = feeCollectionDecision(35_000_000_000_000n, gas, price, journal, 100_000_000_000_000n);
  assert.equal(small.allowed, false);
  assert.equal(small.reason, 'fee-exceeds-claim');
  const enough = feeCollectionDecision(50_000_000_000_000n, gas, price, journal, 100_000_000_000_000n);
  assert.equal(enough.allowed, true);
  assert.equal(enough.gasLimit, 36_000n);
  assert.equal(enough.maximumFeeWei, 36_000_000_000_000n);
  const spent = { ...journal, gasSpentWei: '70000000000000', gasReceipts: {} };
  assert.equal(feeCollectionDecision(50_000_000_000_000n, gas, price, spent, 100_000_000_000_000n).reason,
    'gas-budget-exceeded');
});

test('an unresolved fee nonce is found even after its on-chain credit falls to zero', () => {
  const journalDir = mkdtempSync(join(tmpdir(), 'treasury-collector-'));
  try {
    const options = { factory: FACTORY, journalDir };
    const old = { version: 1, chainId: 56, factory: FACTORY, pool: MARKET, gasSpentWei: '0', gasReceipts: {},
      transaction: { phase: 'intent', nonce: 3, from: FACTORY, to: MARKET, data: '0x12345678', value: '0' } };
    writeJournal(join(journalDir, `${MARKET.toLowerCase()}.json`), old);
    assert.equal(unresolvedTreasuryJournal(options).address, MARKET);
    writeJournal(join(journalDir, `${POOL.toLowerCase()}.json`), { ...old, pool: POOL, transaction: { ...old.transaction, to: POOL } });
    assert.throws(() => unresolvedTreasuryJournal(options), /Multiple treasury journals/);
  } finally { rmSync(journalDir, { recursive: true, force: true }); }
});

test('one cumulative Gas ceiling covers market and every pool fee withdrawal', () => {
  const journalDir = mkdtempSync(join(tmpdir(), 'treasury-gas-budget-'));
  try {
    const options = { factory: FACTORY, journalDir, maxGasWei: 100n };
    writeJournal(join(journalDir, `${MARKET.toLowerCase()}.json`), { version: 1, chainId: 56,
      factory: FACTORY, pool: MARKET, transaction: null, gasSpentWei: '70',
      gasReceipts: { [`0x${'a'.repeat(64)}`]: '70' } });
    writeJournal(join(journalDir, `${POOL.toLowerCase()}.json`), { version: 1, chainId: 56,
      factory: FACTORY, pool: POOL, transaction: null, gasSpentWei: '20',
      gasReceipts: { [`0x${'b'.repeat(64)}`]: '20' } });
    assert.equal(remainingTreasuryGasBudget(options, { pool: POOL }), 30n);
    assert.equal(remainingTreasuryGasBudget(options, { pool: MARKET }), 80n);
    assert.equal(remainingTreasuryGasBudget({ ...options, maxGasWei: 50n }, { pool: POOL }), 0n);
  } finally { rmSync(journalDir, { recursive: true, force: true }); }
});
