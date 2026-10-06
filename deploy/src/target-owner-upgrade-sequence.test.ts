import assert from 'node:assert/strict';
import test from 'node:test';
import type { Provider } from 'ethers';
import { TARGET_OWNER_DEPLOYMENTS, newTargetOwnerJournal, runTargetOwnerUpgradeSequence, targetOwnerRecoveryPhase,
  waitForTargetOwnerFinality, type TargetOwnerJournal, type TargetOwnerStep, type TargetOwnerOperation } from './target-owner-upgrade-ui';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const context = { factory: a(1), genesisRecordDigest: h(2), genesisManifestDigest: h(3), candidateArtifactDigest: h(4), catalogDigest: h(5) };
const initial = () => newTargetOwnerJournal(context, h(8));
function adapter(source = initial(), operation: TargetOwnerOperation = 'unscheduled') {
  const calls: string[] = []; let live = true;
  const put = (journal: TargetOwnerJournal, step: TargetOwnerStep, status: 'submitted' | 'confirmed') => {
    const row = { status, from: a(6), dataHash: h(7), txHash: h(20 + calls.length),
      ...(TARGET_OWNER_DEPLOYMENTS.includes(step as any) && status === 'confirmed' ? { address: a(20 + calls.length) } : {}) };
    return step === 'schedule' || step === 'execute' ? { ...journal, [step]: row }
      : { ...journal, deployments: { ...journal.deployments, [step]: row } };
  };
  const options = { journal: source, assertCurrent: () => { assert(live, 'stopped'); },
    inspect: async (_journal: TargetOwnerJournal) => { calls.push('inspect'); return { operation }; },
    submit: async (journal: TargetOwnerJournal, step: TargetOwnerStep) => { calls.push(`submit:${step}`); return put(journal, step, 'submitted'); },
    recover: async (journal: TargetOwnerJournal, step: TargetOwnerStep) => { calls.push(`recover:${step}`);
      return { journal: put(journal, step, 'confirmed'), outcome: 'confirmed' as const, readyAt: 173000 }; },
  };
  return { options, calls, stop: () => { live = false; } };
}
test('one click sends three candidates then schedule, never execute even after a 48-hour suspension', async () => {
  const f = adapter();
  const recover = f.options.recover;
  f.options.recover = async (source, step) => { const result = await recover(source, step);
    if (step === 'schedule') f.options.inspect = async () => ({ operation: 'ready' }); return result; };
  const result = await runTargetOwnerUpgradeSequence(f.options);
  assert.deepEqual(f.calls.filter(call => call.startsWith('submit:')), ['submit:PoolFunds', 'submit:FlexiblePurchase', 'submit:PoolVault', 'submit:schedule']);
  assert.equal(result.outcome, 'waiting'); assert.equal(result.journal.schedule?.status, 'confirmed');
  assert.equal(result.journal.execute, undefined);
});
test('partial prefix resumes only the missing CREATEs; original pending hash is recovered before any new send', async () => {
  const source = initial(); source.deployments.PoolFunds = { status: 'confirmed', from: a(6), dataHash: h(7), txHash: h(20), address: a(20) };
  source.deployments.FlexiblePurchase = { status: 'submitted', from: a(6), dataHash: h(7), txHash: h(21) };
  const f = adapter(source); await runTargetOwnerUpgradeSequence(f.options);
  assert.equal(f.calls[0], 'recover:FlexiblePurchase');
  assert.deepEqual(f.calls.filter(call => call.startsWith('submit:')), ['submit:PoolVault', 'submit:schedule']);
});
test('hashless unknown send, unfinished receipt and failed receipt stop instead of retrying', async () => {
  const unknown = initial(); unknown.deployments.PoolFunds = { status: 'uncertain', from: a(6), dataHash: h(7) };
  const f = adapter(unknown); assert.equal((await runTargetOwnerUpgradeSequence(f.options)).outcome, 'unknown'); assert.deepEqual(f.calls, []);
  for (const outcome of ['waiting', 'failed'] as const) {
    const source = initial(); source.deployments.PoolFunds = { ...unknown.deployments.PoolFunds!, status: 'submitted', txHash: h(20) };
    const f = adapter(source); f.options.recover = async () => ({ journal: source, outcome }) as any;
    assert.equal((await runTargetOwnerUpgradeSequence(f.options)).outcome, outcome); assert.deepEqual(f.calls, []);
  }
});
test('execute requires a new click with a confirmed schedule and currently ready chain operation', async () => {
  const f = adapter(); const scheduled = (await runTargetOwnerUpgradeSequence(f.options)).journal;
  for (const operation of ['waiting', 'done', 'ready'] as const) {
    const next = adapter(scheduled, operation); const result = await runTargetOwnerUpgradeSequence(next.options);
    assert.deepEqual(next.calls.filter(call => call.startsWith('submit:')), operation === 'ready' ? ['submit:execute'] : []);
    assert.equal(result.outcome, operation === 'waiting' ? 'waiting' : 'done');
  }
});
test('cancellation in asynchronous inspection, recovery or wallet submission prevents every later send', async () => {
  for (const stage of ['inspect', 'recover', 'submit'] as const) {
    const source = initial(); if (stage === 'recover') source.deployments.PoolFunds = { status: 'submitted', from: a(6), dataHash: h(7), txHash: h(20) };
    const f = adapter(source), old = f.options[stage];
    f.options[stage] = (async (...args: any[]) => { const result = await (old as any)(...args); f.stop(); return result; }) as any;
    await assert.rejects(runTargetOwnerUpgradeSequence(f.options), /stopped/);
    assert(f.calls.filter(call => call.startsWith('submit:')).length <= (stage === 'submit' ? 1 : 0));
  }
});
test('last candidate recovery requests full operation classification, unlike incomplete deployment prefixes', () => {
  assert.equal(targetOwnerRecoveryPhase('PoolFunds'), 'prepared'); assert.equal(targetOwnerRecoveryPhase('FlexiblePurchase'), 'prepared');
  assert.equal(targetOwnerRecoveryPhase('PoolVault'), undefined); assert.equal(targetOwnerRecoveryPhase('schedule'), 'scheduled');
  assert.equal(targetOwnerRecoveryPhase('execute'), 'done');
});
test('receipt waiting reads only original receipt and, only after inclusion, finalized head', async () => {
  let receipts = 0, heads = 0, waits = 0;
  const provider = { getTransactionReceipt: async (hash: string) => { assert.equal(hash, h(20)); receipts++;
    return receipts < 3 ? null : { hash, blockNumber: 10 }; },
  getBlock: async (tag: string) => { assert.equal(tag, 'finalized'); heads++; return { hash: h(30), number: heads === 1 ? 9 : 10 }; },
  getTransaction: () => { throw new Error('unnecessary paid read'); }, getCode: () => { throw new Error('unnecessary paid read'); } } as unknown as Provider;
  assert.equal(await waitForTargetOwnerFinality(provider, h(20), { assertCurrent: () => {}, attempts: 4, wait: async () => { waits++; } }), true);
  assert.equal(receipts, 4); assert.equal(heads, 2); assert.equal(waits, 3);
  receipts = 0; heads = 0;
  assert.equal(await waitForTargetOwnerFinality(provider, h(20), { assertCurrent: () => {}, attempts: 2, wait: async () => {} }), false);
  assert.equal(receipts, 2); assert.equal(heads, 0);
});
test('receipt read failure and context cancellation stop the bounded wait immediately', async () => {
  let reads = 0; let current = true;
  const provider = { getTransactionReceipt: async () => { reads++; current = false; return null; } } as unknown as Provider;
  await assert.rejects(waitForTargetOwnerFinality(provider, h(20), { assertCurrent: () => { assert(current, 'stopped'); }, wait: async () => assert.fail('must not wait') }), /stopped/);
  assert.equal(reads, 1);
  await assert.rejects(waitForTargetOwnerFinality({ getTransactionReceipt: async () => { throw new Error('rpc unavailable'); } } as unknown as Provider,
    h(20), { assertCurrent: () => {}, wait: async () => assert.fail('must not wait') }), /rpc unavailable/);
});
