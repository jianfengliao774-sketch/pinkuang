import assert from 'node:assert/strict';
import test from 'node:test';
import { newTargetOwnerJournal, parseTargetOwnerImportFile, parseTargetOwnerJournal,
  type TargetOwnerJournal } from './target-owner-upgrade-ui';

const h = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const a = (value: number) => `0x${value.toString(16).padStart(40, '0')}`;
const context = { factory: a(1), genesisRecordDigest: h(2), genesisManifestDigest: h(3),
  candidateArtifactDigest: h(4), catalogDigest: h(5) };
const file = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' });
function scheduledJournal(): TargetOwnerJournal {
  const journal = newTargetOwnerJournal(context, h(8));
  for (const [index, name] of ['PoolFunds', 'FlexiblePurchase', 'PoolVault'].entries()) {
    journal.deployments[name as keyof typeof journal.deployments] = {
      status: 'confirmed', from: a(6), dataHash: h(10 + index), txHash: h(20 + index), address: a(30 + index),
    };
  }
  journal.schedule = { status: 'confirmed', from: a(6), dataHash: h(13), txHash: h(23) };
  return journal;
}

test('own full export above the old 100 KB cap restores only its pinned journal', async () => {
  const journal = scheduledJournal();
  const exported = file({ schemaVersion: 1, kind: 'fixed-target-owner-upgrade-wallet-record-v1',
    exportedAt: '2026-10-06T12:00:00.000Z', release: { metadata: 'published' }, journal,
    plan: { ignoredArtifactBytes: 'a'.repeat(205000), operationId: h(99) },
    preflight: { ready: false }, postUpgradeProof: { codeUpgradeComplete: true }, activated: true });
  assert(exported.size > 200000 && exported.size <= 512 * 1024);
  assert.deepEqual(await parseTargetOwnerImportFile(exported, context), journal);
  assert.deepEqual(await parseTargetOwnerImportFile(file(journal), context), journal);
});

test('oversized or empty files are rejected before they are read', async () => {
  let reads = 0;
  const unread = (size: number) => ({ size, text: async () => { reads++; return '{}'; } });
  await assert.rejects(parseTargetOwnerImportFile(unread(512 * 1024 + 1), context), /512 KiB/);
  await assert.rejects(parseTargetOwnerImportFile(unread(0), context), /文件为空/);
  assert.equal(reads, 0);
  await assert.rejects(parseTargetOwnerImportFile({ size: 10, text: async () => 'x'.repeat(512 * 1024 + 1) }, context), /512 KiB/);
});

test('a large envelope cannot enlarge the actual persisted journal limit', async () => {
  const journal = newTargetOwnerJournal(context, h(8));
  journal.failedTransactions = [{ step: 'schedule', transaction: {
    status: 'submitted', from: a(6), dataHash: h(7), txHash: h(50),
  }, evidence: { kind: 'target-owner-finalized-failed-transaction-v1', chainId: 56, status: 0,
    txHash: h(50), from: a(6), to: a(1), value: '0', dataHash: h(7), blockNumber: 1,
    blockHash: h(51), gasUsed: '9'.repeat(100001), checkedAt: '2026-10-06T12:00:00.000Z' } }];
  assert.deepEqual(parseTargetOwnerJournal(journal, context), journal);
  const oversized = file({ kind: 'fixed-target-owner-upgrade-wallet-record-v1', journal });
  assert(oversized.size < 512 * 1024);
  await assert.rejects(parseTargetOwnerImportFile(oversized, context), /100,000 字节/);
});

test('import still enforces the pinned journal schema and context despite accompanying export claims', async () => {
  const journal = scheduledJournal();
  for (const changed of [{ ...journal, candidateArtifactDigest: h(99) }, { ...journal, salt: h(0) },
    { ...journal, deployments: { ...journal.deployments, PoolVault: undefined } }]) {
    await assert.rejects(parseTargetOwnerImportFile(file({ journal: changed,
      plan: { operationId: h(23) }, preflight: { ready: true } }), context));
  }
});
