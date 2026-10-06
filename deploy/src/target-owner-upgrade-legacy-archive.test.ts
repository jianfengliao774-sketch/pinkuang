import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveLegacyTargetOwnerDeployment, confirmedTargetOwnerDeployments, newTargetOwnerJournal,
  parseTargetOwnerJournal, TARGET_OWNER_DEPLOYMENTS, targetOwnerNext, targetOwnerPending,
  type TargetOwnerIntent, type TargetOwnerJournal, type TargetOwnerName } from './target-owner-upgrade-ui';

const h = (index: number) => `0x${index.toString(16).padStart(64, '0')}`;
const a = (index: number) => `0x${index.toString(16).padStart(40, '0')}`;
const context = { factory: a(1), genesisRecordDigest: h(2), genesisManifestDigest: h(3),
  candidateArtifactDigest: h(4), catalogDigest: h(5) };
const checkedAt = '2026-10-04T07:00:00.000Z';
const observation = (nonce = 42): TargetOwnerIntent => ({ schemaVersion: 1, chainId: 56, nonce,
  anchor: { blockNumber: 1000, blockHash: h(1000) } });
const unknown = () => ({ status: 'uncertain' as const, from: a(6), dataHash: h(7) });
const confirmed = (index: number) => ({ status: 'confirmed' as const, from: a(6), dataHash: h(7),
  txHash: h(index), address: a(index) });
function pending(step: TargetOwnerName = 'PoolFunds') {
  const journal = newTargetOwnerJournal(context, h(8));
  for (const [index, name] of TARGET_OWNER_DEPLOYMENTS.entries()) {
    if (name === step) { journal.deployments[name] = unknown(); break; }
    journal.deployments[name] = confirmed(20 + index);
  }
  return journal;
}
const archive = (journal = pending(), step: TargetOwnerName | 'schedule' | 'execute' = 'PoolFunds') =>
  archiveLegacyTargetOwnerDeployment(journal, context, { step, acknowledged: true, checkedAt,
    currentIntent: observation() });

test('closing a legacy request preserves the unknown original and only releases that CREATE slot', () => {
  const source = pending(), before = structuredClone(source), observed = observation();
  const next = archiveLegacyTargetOwnerDeployment(source, context, { step: 'PoolFunds',
    acknowledged: true, checkedAt, currentIntent: observed });
  assert.deepEqual(source, before);
  assert.deepEqual(next.abandonedUnknownDeployments, [{ step: 'PoolFunds', transaction: unknown(),
    reason: 'user-canceled-wallet-request', acknowledged: true, checkedAt, observedIntent: observed }]);
  assert.equal(next.deployments.PoolFunds, undefined);
  assert.equal(targetOwnerPending(next), null);
  assert.equal(targetOwnerNext(next), 'PoolFunds');
  assert.deepEqual(confirmedTargetOwnerDeployments(next), {});
  assert.equal(next.failedTransactions, undefined);
  assert.equal(next.schedule, undefined); assert.equal(next.execute, undefined);
  assert.equal(next.salt, before.salt); assert.equal(next.delaySeconds, before.delaySeconds);
  assert.equal(next.abandonedUnknownDeployments![0].transaction.intent, undefined);
  assert.equal(next.abandonedUnknownDeployments![0].transaction.txHash, undefined);
  assert.equal(next.abandonedUnknownDeployments![0].transaction.address, undefined);
  observed.nonce = 99; source.deployments.PoolFunds!.dataHash = h(99);
  assert.equal(next.abandonedUnknownDeployments![0].observedIntent.nonce, 42);
  assert.equal(next.abandonedUnknownDeployments![0].transaction.dataHash, h(7));
});

test('archiving each CREATE preserves confirmed dependencies and leaves the next click at the same step', () => {
  for (const [index, step] of TARGET_OWNER_DEPLOYMENTS.entries()) {
    const source = pending(step), next = archive(source, step);
    assert.deepEqual(confirmedTargetOwnerDeployments(next), confirmedTargetOwnerDeployments(source));
    assert.deepEqual(Object.keys(next.deployments), TARGET_OWNER_DEPLOYMENTS.slice(0, index));
    assert.equal(targetOwnerPending(next), null); assert.equal(targetOwnerNext(next), step);
    assert.equal(next.abandonedUnknownDeployments![0].step, step);
  }
});

test('a fresh nonce observation does not become the old intent or a prepared replacement request', () => {
  const next = archive(pending());
  assert.equal(Object.keys(next.deployments).length, 0);
  assert.deepEqual(next.abandonedUnknownDeployments![0].transaction, unknown());
  const secondObservation = observation(43);
  next.deployments.PoolFunds = { ...unknown(), intent: secondObservation };
  const parsed = parseTargetOwnerJournal(next, context);
  assert.equal(parsed.deployments.PoolFunds?.intent?.nonce, 43);
  assert.equal(parsed.abandonedUnknownDeployments![0].observedIntent.nonce, 42);
  assert.throws(() => archive(parsed), /原交易/);
});

test('the operation requires explicit acknowledgement and validates the newly observed intent', () => {
  const source = pending(), before = structuredClone(source);
  assert.throws(() => archiveLegacyTargetOwnerDeployment(source, context, { step: 'PoolFunds',
    acknowledged: false as true, checkedAt, currentIntent: observation() }), /确认/);
  for (const intent of [{ ...observation(), nonce: -1 }, { ...observation(), chainId: 1 },
    { ...observation(), nonce: Number.MAX_SAFE_INTEGER + 1 },
    { ...observation(), anchor: { blockNumber: 0, blockHash: h(0) } }]) {
    assert.throws(() => archiveLegacyTargetOwnerDeployment(source, context, { step: 'PoolFunds',
      acknowledged: true, checkedAt, currentIntent: intent as TargetOwnerIntent }), /意图/);
  }
  assert.deepEqual(source, before);
});

test('known hashes, recorded intents and deployment addresses can never use legacy closure', () => {
  for (const row of [{ ...unknown(), txHash: h(90) }, { ...unknown(), intent: observation() },
    { ...unknown(), status: 'submitted' as const, txHash: h(90) }, confirmed(20),
    { ...unknown(), address: a(90) }, { ...unknown(), resolved: true }]) {
    const source = pending(); source.deployments.PoolFunds = row;
    const before = structuredClone(source);
    assert.throws(() => archive(source)); assert.deepEqual(source, before);
  }
});

test('only the current pending step is archivable and deployment prefix cannot be skipped', () => {
  assert.throws(() => archive(pending(), 'FlexiblePurchase'), /当前/);
  assert.throws(() => archive(pending('FlexiblePurchase'), 'PoolFunds'), /当前/);
  assert.throws(() => archive(newTargetOwnerJournal(context, h(8))), /当前/);
  const complete = pending('PoolVault'); complete.deployments.PoolVault = confirmed(22);
  assert.throws(() => archive(complete, 'PoolVault'), /当前/);
  const skipped = pending('PoolVault'); delete skipped.deployments.PoolFunds;
  assert.throws(() => archive(skipped, 'PoolVault'), /顺序/);
});

test('unknown scheduling and execution requests stay blocked, even after all CREATE receipts are confirmed', () => {
  const complete = pending('PoolVault'); complete.deployments.PoolVault = confirmed(22);
  complete.schedule = unknown(); assert.equal(targetOwnerPending(complete), 'schedule');
  assert.throws(() => archive(complete, 'schedule'), /治理/);
  complete.schedule = { ...unknown(), status: 'confirmed', txHash: h(30) };
  complete.execute = unknown(); assert.equal(targetOwnerPending(complete), 'execute');
  assert.throws(() => archive(complete, 'execute'), /治理/);
  assert.deepEqual(complete.execute, unknown());
});

test('multiple attempts at one CREATE are retained and the 100 entry cap does not mutate the source', () => {
  let source = pending();
  for (let count = 0; count < 100; count++) {
    source.deployments.PoolFunds = unknown();
    source = archiveLegacyTargetOwnerDeployment(source, context, { step: 'PoolFunds', acknowledged: true,
      checkedAt, currentIntent: observation(42 + count) });
  }
  assert.equal(source.abandonedUnknownDeployments!.length, 100);
  source.deployments.PoolFunds = unknown(); const before = structuredClone(source);
  assert.throws(() => archive(source), /格式/); assert.deepEqual(source, before);
});

test('parse binds repeated archives and later active requests to the same sender and calldata', () => {
  for (const row of [{ ...unknown(), from: a(9) }, { ...unknown(), dataHash: h(9) }]) {
    const next = archive(); next.deployments.PoolFunds = row;
    assert.throws(() => parseTargetOwnerJournal(next, context), /不匹配/);
    assert.throws(() => archive(next), /不匹配/);
  }
  const next = archive(); next.deployments.PoolFunds = confirmed(20);
  assert.equal(parseTargetOwnerJournal(next, context).deployments.PoolFunds?.status, 'confirmed');
  const duplicate = structuredClone(next.abandonedUnknownDeployments![0]); duplicate.transaction.from = a(9);
  next.abandonedUnknownDeployments!.push(duplicate);
  assert.throws(() => parseTargetOwnerJournal(next, context), /不匹配/);
});

test('parse refuses fabricated archive success, hash, nonce, address and extra fields', () => {
  const mutations = [
    (row: any) => { row.transaction.status = 'confirmed'; },
    (row: any) => { row.transaction.status = 'submitted'; },
    (row: any) => { row.transaction.txHash = h(90); },
    (row: any) => { row.transaction.intent = observation(); },
    (row: any) => { row.transaction.address = a(90); },
    (row: any) => { row.transaction.nonce = 42; },
    (row: any) => { row.transaction.from = a(0); },
    (row: any) => { row.transaction.dataHash = '0x1234'; },
    (row: any) => { row.resolved = true; },
    (row: any) => { row.reason = 'failed'; },
    (row: any) => { row.acknowledged = false; },
    (row: any) => { delete row.acknowledged; },
    (row: any) => { row.checkedAt = 'not a date'; },
    (row: any) => { row.checkedAt = '2026-10-04'; },
    (row: any) => { row.observedIntent.chainId = 1; },
    (row: any) => { row.observedIntent.nonce = -1; },
    (row: any) => { row.observedIntent.originalNonce = 42; },
    (row: any) => { row.observedIntent.anchor.blockHash = '0x1234'; },
  ];
  for (const mutate of mutations) {
    const item = archive(); mutate(item.abandonedUnknownDeployments![0]);
    assert.throws(() => parseTargetOwnerJournal(item, context));
  }
});

test('archive parsing rejects governance steps, missing dependency receipts and reordered CREATE history', () => {
  for (const step of ['schedule', 'execute', 'PoolFactory', 'FlexiblePurchase', 'PoolVault']) {
    const item = archive(); (item.abandonedUnknownDeployments![0] as any).step = step;
    assert.throws(() => parseTargetOwnerJournal(item, context));
  }
  const item = archive(pending('FlexiblePurchase'), 'FlexiblePurchase');
  item.abandonedUnknownDeployments!.push(archive().abandonedUnknownDeployments![0]);
  assert.throws(() => parseTargetOwnerJournal(item, context), /顺序/);
  const prefix = archive(pending('FlexiblePurchase'), 'FlexiblePurchase');
  delete prefix.deployments.PoolFunds;
  assert.throws(() => parseTargetOwnerJournal(prefix, context), /前缀/);
});

test('archived requests neither count as completed nor create a failed transaction proof on round-trip', () => {
  const item = archive(pending('PoolVault'), 'PoolVault');
  const restored = parseTargetOwnerJournal(JSON.parse(JSON.stringify(item)), context);
  assert.deepEqual(restored, item);
  assert.deepEqual(Object.keys(confirmedTargetOwnerDeployments(restored)), ['PoolFunds', 'FlexiblePurchase']);
  assert.equal(targetOwnerNext(restored), 'PoolVault');
  assert.equal(restored.failedTransactions, undefined);
  assert.equal(restored.schedule, undefined); assert.equal(restored.execute, undefined);
  const mismatch = { ...context, catalogDigest: h(99) };
  assert.throws(() => parseTargetOwnerJournal(restored, mismatch), /不匹配/);
});
