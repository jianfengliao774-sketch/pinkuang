import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonRpcProvider, Wallet, keccak256 } from 'ethers';
import { readJournal, writeJournal, reconcilePending, recoverPending, runKeeperCycle } from './purchase-keeper.mjs';

// Disposable random signers and a loopback-only Anvil. Never read a real key or contact BSC.
// These tests exercise an actual txpool and receipts; contract purchase invariants live in Foundry.
let node, provider, directory;
const pool = '0x2222222222222222222222222222222222222222';
const factory = '0x1111111111111111111111111111111111111111';

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'pinkuang-recovery-integration-'));
  const listener = createServer();
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise((done, reject) => listener.close(error => error ? reject(error) : done()));
  node = spawn(fileURLToPath(new URL('../node_modules/.bin/anvil', import.meta.url)),
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '56', '--no-mining', '--base-fee', '0', '--gas-price', '1000000000', '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      assert.equal((await response.json()).result, '0x38');
      provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }); return;
    } catch { await delay(100); }
  }
  throw new Error('Disposable Anvil did not start.');
});

after(() => { provider?.destroy(); node?.kill('SIGTERM'); if (directory) rmSync(directory, { recursive: true, force: true }); });

async function originalPurchase(name) {
  const signer = Wallet.createRandom().connect(provider);
  await provider.send('anvil_setBalance', [signer.address, '0xde0b6b3a7640000']);
  const options = { factory, pool, journal: join(directory, `${name}.json`), send: true, once: true,
    maxGasWei: 10_000_000_000_000_000n, maxGasPrice: 10_000_000_000n, maxSpeedUps: 3, pendingSeconds: 120 };
  const raw = await signer.signTransaction({ chainId: 56, type: 0, nonce: 0, to: pool, data: '0x1234', value: 0,
    gasLimit: 50_000n, gasPrice: 1_000_000_000n });
  const hash = keccak256(raw);
  const journal = { version: 1, chainId: 56, factory, pool, gasSpentWei: '0', gasReceipts: {}, transaction: {
    phase: 'signed', from: signer.address, nonce: 0, to: pool, data: '0x1234', value: '0', listingId: '1',
    createdAt: new Date().toISOString(), speedUps: 0, hash,
    attempts: [{ kind: 'purchase', raw, hash, gasLimit: '50000', gasPrice: '1000000000', createdAt: new Date().toISOString(), broadcastCount: 0 }],
  } };
  writeJournal(options.journal, journal);
  assert.equal(readJournal(options.journal, options).transaction.attempts[0].hash, hash);
  await provider.broadcastTransaction(raw);
  journal.transaction.phase = 'broadcast'; writeJournal(options.journal, journal);
  return { signer, options, journal, originalHash: hash };
}

async function mine(count) { for (let n = 0; n < count; n++) await provider.send('evm_mine', []); }

test('actual txpool replaces a purchase at the same nonce and accounts only its finalized receipt', async () => {
  const { signer, options, journal, originalHash } = await originalPurchase('speed-up');
  const diagnostic = await reconcilePending(provider, options, journal);
  assert.equal(diagnostic.status, 'pending-receipt');
  const bumped = await recoverPending(provider, { ...options, speedUp: true }, signer, journal, diagnostic);
  assert.equal(bumped.status, 'broadcast');
  assert.notEqual(bumped.hash, originalHash);
  assert.equal(journal.transaction.attempts.length, 2);
  const transaction = await provider.getTransaction(bumped.hash);
  assert.equal(transaction.nonce, 0); assert.equal(transaction.to.toLowerCase(), pool); assert.equal(transaction.data, '0x1234');
  await mine(1);
  assert.equal((await reconcilePending(provider, options, journal)).status, 'pending-confirmations');
  await mine(1);
  assert.equal((await reconcilePending(provider, options, journal)).status, 'pending-finality', 'two confirmations are not enough to resolve the nonce');
  await mine(64); // Anvil's finalized tag uses two 32-slot epochs, unlike BSC's finality gadget.
  const complete = await reconcilePending(provider, options, journal);
  assert.equal(complete.status, 'confirmed'); assert.equal(complete.hash, bumped.hash);
  assert.equal(complete.finality, 'bsc-finalized');
  assert.equal(await provider.getTransactionReceipt(originalHash), null);
  assert.deepEqual(Object.keys(journal.gasReceipts), [bumped.hash]);
  const spent = journal.gasSpentWei;
  assert.equal(await reconcilePending(provider, options, journal), null);
  assert.equal(journal.gasSpentWei, spent);
});

test('actual txpool cancellation consumes only the old nonce and permanently stops this journal', async () => {
  const { signer, options, journal, originalHash } = await originalPurchase('cancel');
  const result = await recoverPending(provider, { ...options, cancelPending: true }, signer, journal, await reconcilePending(provider, options, journal));
  assert.equal(result.status, 'broadcast');
  const cancel = await provider.getTransaction(result.hash);
  assert.equal(cancel.nonce, 0); assert.equal(cancel.to, signer.address); assert.equal(cancel.data, '0x'); assert.equal(cancel.value, 0n);
  await mine(66);
  const complete = await reconcilePending(provider, options, journal);
  assert.equal(complete.status, 'cancelled'); assert.equal(complete.finality, 'bsc-finalized');
  assert.equal(await provider.getTransactionReceipt(originalHash), null);
  assert.equal((await runKeeperCycle(provider, { ...options, send: false })).status, 'purchase-nonce-cancelled');
  assert.equal(await provider.getTransactionCount(signer.address), 1);
});

test('the original winning during cancellation broadcast is recovered as a purchase, never as a cancellation', async () => {
  const { signer, options, journal, originalHash } = await originalPurchase('race');
  const racingProvider = new Proxy(provider, { get(target, property) {
    if (property === 'broadcastTransaction') return async raw => { await mine(66); return provider.broadcastTransaction(raw); };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const cancellation = await recoverPending(racingProvider, { ...options, cancelPending: true }, signer, journal, await reconcilePending(provider, options, journal));
  assert.equal(cancellation.status, 'broadcast-result-unknown');
  assert.equal(journal.transaction.attempts.length, 2, 'cancel hash stays queryable despite nonce-too-low RPC result');
  const complete = await reconcilePending(provider, options, journal);
  assert.equal(complete.status, 'confirmed'); assert.equal(complete.hash, originalHash);
  assert.equal(Object.keys(journal.gasReceipts).length, 1);
  assert.equal(await provider.getTransactionCount(signer.address), 1);
});
