import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, toUtf8Bytes } from 'ethers';
import { TARGET_OWNER_DEPLOYMENTS, newTargetOwnerJournal, targetOwnerJournalKey,
  type TargetOwnerJournal, type UpgradeTransaction } from './target-owner-upgrade-ui';
import { prepareReadyTargetOwnerRecordSwitch, preserveReadyTargetOwnerRecordSwitch,
  type ReadyTargetOwnerProof, type ReadyScheduleReceipt } from './target-owner-ready-recovery';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const context = { factory: a(1), genesisRecordDigest: h(2), genesisManifestDigest: h(3),
  candidateArtifactDigest: h(4), catalogDigest: h(5) };
const key = targetOwnerJournalKey(context);
function journal(seed: number, pending = false): TargetOwnerJournal {
  return { ...newTargetOwnerJournal(context, h(seed)),
    deployments: Object.fromEntries(TARGET_OWNER_DEPLOYMENTS.map((name, index) => [name, {
      status: 'confirmed', from: a(6), dataHash: h(7), txHash: h(seed + 10 + index), address: a(seed + 10 + index),
    }])), schedule: { status: pending ? 'submitted' : 'confirmed', from: a(6), dataHash: h(7), txHash: h(seed + 20) } };
}
function proof(item: TargetOwnerJournal, ready = true): ReadyTargetOwnerProof {
  const timestamp = Math.floor(Date.now() / 1000), readyAt = timestamp + (ready ? -1 : 60);
  return { chainId: 56, canonical: true, finalized: { number: 10, hash: h(100), timestamp }, checked: {
    phase: 'scheduled', baselineVerified: true, replacementDeploymentVerified: true,
    verifiedDeploymentNames: [...TARGET_OWNER_DEPLOYMENTS],
    deployments: Object.fromEntries(TARGET_OWNER_DEPLOYMENTS.map(name => [name,
      { address: item.deployments[name]!.address!, txHash: item.deployments[name]!.txHash! }])),
    candidateArtifactDigest: context.candidateArtifactDigest, reviewCatalogDigest: context.catalogDigest,
    operationId: keccak256(toUtf8Bytes(item.salt)), operation: ready ? 'ready' : 'waiting', ready,
    readyAt, timelockTimestamp: String(readyAt), codeUpgradeComplete: false,
    blockNumber: 10, blockHash: h(100), checkedAt: new Date().toISOString(),
  } };
}
const receipt = (item: TargetOwnerJournal): ReadyScheduleReceipt => ({ status: 1, hash: item.schedule!.txHash!,
  from: item.schedule!.from, blockNumber: 9, blockHash: h(90) });
const verify = async (item: TargetOwnerJournal) => receipt(item);
const prove = async (item: TargetOwnerJournal) => proof(item);
const prepare = (source = journal(20, true), target = journal(40)) =>
  prepareReadyTargetOwnerRecordSwitch(source, target, context, verify, prove);
class MemoryStorage {
  values = new Map<string, string>();
  writes: string[] = [];
  constructor(raw: string) { this.values.set(key, raw); }
  getItem(name: string) { return this.values.get(name) ?? null; }
  setItem(name: string, value: string) { this.writes.push(name); this.values.set(name, value); }
}

test('strict successful pending schedule is promoted, preserved, and only the proved ready batch is selected', async () => {
  const source = journal(20, true), target = journal(40), seen: string[] = [];
  const prepared = await prepareReadyTargetOwnerRecordSwitch(source, target, context,
    async (item, original) => { seen.push('receipt'); assert.equal(original.status, 'submitted'); return receipt(item); },
    async (item, role) => {
      seen.push(role); assert.equal(item.schedule!.status, 'confirmed');
      return proof(item, role === 'imported');
    });
  assert.deepEqual(seen, ['receipt', 'existing', 'imported']);
  assert.equal(source.schedule!.status, 'submitted');
  assert.equal(prepared.sourceJournal.schedule!.status, 'submitted');
  assert.equal(prepared.preservedJournal.schedule!.status, 'confirmed');
  const archive = JSON.parse(prepared.archiveJson);
  assert.equal(archive.sourceJournal.schedule.status, 'submitted');
  assert.equal(archive.confirmedJournal.schedule.txHash, source.schedule!.txHash);
  assert.equal(archive.confirmedJournal.schedule.status, 'confirmed');
  assert.deepEqual(prepared.replacementJournal, target);
  assert.notEqual(prepared.sourceOperationId, prepared.targetOperationId);
  assert.throws(() => { prepared.preservedJournal.schedule!.status = 'uncertain'; }, TypeError);
});

test('an existing confirmed scheduled batch still requires fresh full graph proof but no pending receipt promotion', async () => {
  let receipts = 0, proofs = 0;
  const prepared = await prepareReadyTargetOwnerRecordSwitch(journal(20), journal(40), context,
    async () => { receipts++; return null; }, async item => { proofs++; return proof(item); });
  assert.equal(receipts, 0); assert.equal(proofs, 2); assert.equal(prepared.preservedJournal.schedule!.status, 'confirmed');
});

test('unknown schedule without original hash never reaches verification or archives', async () => {
  const source = journal(20, true); source.schedule = { ...source.schedule!, status: 'uncertain', txHash: undefined };
  let calls = 0;
  await assert.rejects(prepareReadyTargetOwnerRecordSwitch(source, journal(40), context,
    async () => { calls++; return null; }, prove), /完整交易哈希/);
  assert.equal(calls, 0);
});

test('pending or incomplete deployment cannot be replaced by another ready record', async () => {
  const source = journal(20, true); delete source.schedule; delete source.deployments.PoolVault;
  source.deployments.FlexiblePurchase = { status: 'uncertain', from: a(6), dataHash: h(7) };
  await assert.rejects(prepare(source), /三个已确认部署/);
  assert.equal(source.deployments.FlexiblePurchase.status, 'uncertain');
});

test('submitted, unknown and confirmed execution rows all forbid switching records', async () => {
  for (const status of ['uncertain', 'submitted', 'confirmed'] as const) {
    const source = journal(20); source.execute = { status, from: a(6), dataHash: h(7), txHash: h(300) };
    await assert.rejects(prepare(source), /执行升级记录/);
  }
});

test('imported pending schedule or execution cannot assert that an earlier batch is ready', async () => {
  await assert.rejects(prepare(journal(20), journal(40, true)), /未知部署或执行请求/);
  const target = journal(40); target.execute = { status: 'uncertain', from: a(6), dataHash: h(7), txHash: h(300) };
  await assert.rejects(prepare(journal(20), target), /执行升级记录/);
  await assert.rejects(prepare(journal(20), { ...journal(40), ready: true } as TargetOwnerJournal), /以外的操作/);
});

test('failure, unknown result and mismatched receipt cannot archive or release the original pending request', async () => {
  const source = journal(20, true), original = JSON.stringify(source);
  for (const mutate of [
    () => null,
    (row: ReadyScheduleReceipt) => ({ ...row, status: 0 }),
    (row: ReadyScheduleReceipt) => ({ ...row, hash: h(999) }),
    (row: ReadyScheduleReceipt) => ({ ...row, from: a(999) }),
  ]) {
    await assert.rejects(prepareReadyTargetOwnerRecordSwitch(source, journal(40), context,
      async item => mutate(receipt(item)), prove), /最终成功回执/);
    assert.equal(JSON.stringify(source), original);
  }
  await assert.rejects(prepareReadyTargetOwnerRecordSwitch(source, journal(40), context,
    async () => { throw new Error('unknown result'); }, prove), /unknown result/);
  assert.equal(JSON.stringify(source), original);
});

test('receipt ahead of the finalized full graph snapshot is not a promotion proof', async () => {
  await assert.rejects(prepareReadyTargetOwnerRecordSwitch(journal(20, true), journal(40), context,
    async item => ({ ...receipt(item), blockNumber: 11 }), prove), /尚未最终确认/);
});

test('an early old schedule and a completed operation cannot replace the current schedule', async () => {
  await assert.rejects(prepareReadyTargetOwnerRecordSwitch(journal(20), journal(40), context, verify,
    async (item, role) => proof(item, role !== 'imported')), /尚未到期/);
  await assert.rejects(prepareReadyTargetOwnerRecordSwitch(journal(20), journal(40), context, verify,
    async item => { const value = proof(item); value.checked.operation = 'done'; return value; }), /完整正式图/);
});

test('missing baseline, deployment, context or receipt binding cannot be used as ready proof', async () => {
  const changes: ((value: ReadyTargetOwnerProof) => void)[] = [
    value => { value.checked.baselineVerified = false; },
    value => { value.checked.replacementDeploymentVerified = false; },
    value => { value.checked.verifiedDeploymentNames = ['PoolFunds']; },
    value => { value.checked.deployments.PoolVault.txHash = h(999); },
    value => { value.checked.deployments.PoolVault.address = a(999); },
    value => { value.checked.candidateArtifactDigest = h(999); },
    value => { value.checked.reviewCatalogDigest = h(999); },
    value => { value.checked.phase = 'unscheduled'; },
    value => { value.checked.codeUpgradeComplete = true; },
  ];
  for (const change of changes) await assert.rejects(prepareReadyTargetOwnerRecordSwitch(journal(20), journal(40), context,
    verify, async item => { const value = proof(item); change(value); return value; }), /完整正式图/);
});

test('reorg, wrong chain, nonfinal snapshot and read failures leave the current journal intact', async () => {
  const source = journal(20), original = JSON.stringify(source);
  for (const change of [
    (value: ReadyTargetOwnerProof) => { (value as any).canonical = false; },
    (value: ReadyTargetOwnerProof) => { (value as any).chainId = 1; },
    (value: ReadyTargetOwnerProof) => { value.checked.blockHash = h(999); },
    (value: ReadyTargetOwnerProof) => { value.checked.blockNumber = 11; },
  ]) await assert.rejects(prepareReadyTargetOwnerRecordSwitch(source, journal(40), context,
    verify, async item => { const value = proof(item); change(value); return value; }));
  await assert.rejects(prepareReadyTargetOwnerRecordSwitch(source, journal(40), context,
    verify, async () => { throw new Error('canonical read failed'); }), /canonical read failed/);
  assert.equal(JSON.stringify(source), original);
});

test('stale block, checked time and mismatched ready timestamp are rejected', async () => {
  for (const change of [
    (value: ReadyTargetOwnerProof) => { value.finalized.timestamp -= 121; },
    (value: ReadyTargetOwnerProof) => { value.checked.checkedAt = new Date(Date.now() - 121000).toISOString(); },
    (value: ReadyTargetOwnerProof) => { value.checked.timelockTimestamp = '2'; },
    (value: ReadyTargetOwnerProof) => { value.checked.readyAt = value.finalized.timestamp + 1; value.checked.timelockTimestamp = String(value.checked.readyAt); },
  ]) await assert.rejects(prepareReadyTargetOwnerRecordSwitch(journal(20), journal(40), context,
    verify, async item => { const value = proof(item); change(value); return value; }));
});

test('same salt, same proved operation ID and foreign context cannot change current records', async () => {
  await assert.rejects(prepare(journal(20), { ...journal(40), salt: h(20) }), /当前排程/);
  await assert.rejects(prepareReadyTargetOwnerRecordSwitch(journal(20), journal(40), context,
    verify, async item => { const value = proof(item); value.checked.operationId = h(999); return value; }), /相同操作 ID/);
  await assert.rejects(prepare(journal(20), { ...journal(40), factory: a(999) }), /不匹配/);
});

test('input mutation during asynchronous proof prevents selection', async () => {
  const source = journal(20, true), target = journal(40);
  await assert.rejects(prepareReadyTargetOwnerRecordSwitch(source, target, context, async item => {
    source.schedule!.txHash = h(999); return receipt(item);
  }, prove), /记录已变化/);
  const current = journal(20);
  await assert.rejects(prepareReadyTargetOwnerRecordSwitch(current, target, context, verify, async (item, role) => {
    if (role === 'imported') target.schedule!.dataHash = h(999); return proof(item);
  }), /记录已变化/);
});

test('preservation writes and reads immutable history before returning replacement, without writing current', async () => {
  const source = journal(20, true), raw = JSON.stringify(source, null, 2), storage = new MemoryStorage(raw), prepared = await prepare(source);
  const result = preserveReadyTargetOwnerRecordSwitch(storage, key, raw, prepared, () => {});
  assert.equal(storage.getItem(key), raw); assert.deepEqual(storage.writes, [result.archiveKey]);
  assert.equal(storage.getItem(result.archiveKey), prepared.archiveJson);
  assert.deepEqual(result.replacementJournal, journal(40));
  assert.match(result.archiveKey, /\.preserved\.0x[\da-f]{64}\.[\da-f]{64}$/);
  preserveReadyTargetOwnerRecordSwitch(storage, key, raw, prepared, () => {});
  assert.equal(storage.writes.length, 1);
});

test('archive collision, write error and inexact readback do not write or delete current journal', async () => {
  const source = journal(20, true), raw = JSON.stringify(source), prepared = await prepare(source);
  const archiveKey = `${key}.preserved.${prepared.sourceOperationId.toLowerCase()}.${prepared.archiveDigest.slice(2)}`;
  const collision = new MemoryStorage(raw); collision.values.set(archiveKey, 'different preserved record');
  assert.throws(() => preserveReadyTargetOwnerRecordSwitch(collision, key, raw, prepared, () => {}), /不同记录/);
  assert.equal(collision.getItem(archiveKey), 'different preserved record'); assert.equal(collision.getItem(key), raw);
  const denied = new MemoryStorage(raw); denied.setItem = () => { throw new Error('archive write denied'); };
  assert.throws(() => preserveReadyTargetOwnerRecordSwitch(denied, key, raw, prepared, () => {}), /archive write denied/);
  assert.equal(denied.getItem(key), raw);
  const truncated = new MemoryStorage(raw); truncated.setItem = (name, value) => truncated.values.set(name, value.slice(0, -1));
  assert.throws(() => preserveReadyTargetOwnerRecordSwitch(truncated, key, raw, prepared, () => {}), /没有完整保存/);
  assert.equal(truncated.getItem(key), raw);
});

test('current raw barrier and caller lock cancellation stop preservation without clobbering another tab', async () => {
  const source = journal(20, true), raw = JSON.stringify(source), prepared = await prepare(source);
  const changed = new MemoryStorage(raw); changed.values.set(key, JSON.stringify(journal(60)));
  assert.throws(() => preserveReadyTargetOwnerRecordSwitch(changed, key, raw, prepared, () => {}), /另一标签/);
  assert.equal(changed.writes.length, 0);
  const storage = new MemoryStorage(raw);
  storage.setItem = (name, value) => { storage.values.set(name, value); storage.values.set(key, 'concurrent update'); };
  assert.throws(() => preserveReadyTargetOwnerRecordSwitch(storage, key, raw, prepared, () => {}), /另一标签/);
  assert.equal(storage.getItem(key), 'concurrent update');
  const canceled = new MemoryStorage(raw);
  assert.throws(() => preserveReadyTargetOwnerRecordSwitch(canceled, key, raw, prepared,
    () => { throw new Error('exclusive run canceled'); }), /exclusive run canceled/);
  assert.equal(canceled.getItem(key), raw); assert.equal(canceled.writes.length, 0);
});

test('unprepared copies and wrong current key cannot preserve records', async () => {
  const source = journal(20, true), raw = JSON.stringify(source), prepared = await prepare(source), storage = new MemoryStorage(raw);
  assert.throws(() => preserveReadyTargetOwnerRecordSwitch(storage, key, raw, { ...prepared }, () => {}), /完整核验/);
  assert.throws(() => preserveReadyTargetOwnerRecordSwitch(storage, `${key}.other`, raw, prepared, () => {}), /记录键/);
  assert.equal(storage.getItem(key), raw); assert.equal(storage.writes.length, 0);
});

test('the first proof is rechecked after a long second read, and expiry is enforced before storage writes', async () => {
  const originalNow = Date.now;
  try {
    let now = originalNow(); Date.now = () => now;
    await assert.rejects(prepareReadyTargetOwnerRecordSwitch(journal(20), journal(40), context, verify, async (item, role) => {
      if (role === 'imported') now += 121000;
      const result = proof(item); result.checked.checkedAt = new Date(now).toISOString(); return result;
    }), /当前最终区块|过期/);
    now = originalNow();
    const source = journal(20), raw = JSON.stringify(source), storage = new MemoryStorage(raw), prepared = await prepare(source);
    now += 121000;
    assert.throws(() => preserveReadyTargetOwnerRecordSwitch(storage, key, raw, prepared, () => {}), /证明过期/);
    assert.equal(storage.writes.length, 0); assert.equal(storage.getItem(key), raw);
  } finally { Date.now = originalNow; }
});
