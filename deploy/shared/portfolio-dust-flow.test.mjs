import test from 'node:test';
import assert from 'node:assert/strict';
import { runPortfolioDustFlow } from './portfolio-dust-flow.mjs';
import { assertPortfolioDustConfirmedState } from './portfolio-dust-journal.mjs';

const h = number => `0x${number.toString(16).padStart(64, '0')}`;
const a = number => `0x${number.toString(16).padStart(40, '0')}`;
const fresh = () => ({ kind: 'portfolio-dust-journal-v1', configDigest: h(1), salt: h(2),
  delaySeconds: 172800, transactions: {}, failed: [] });
const tx = (step, status = 'confirmed') => ({ status, from: a(1), nonce: step === 'deploy' ? '7' : '8',
  dataHash: h(step === 'deploy' ? 3 : 4), txHash: h(step === 'deploy' ? 5 : 6),
  ...(status === 'confirmed' ? { success: true, blockNumber: step === 'deploy' ? 100 : 101,
    blockHash: h(10), ...(step === 'deploy' ? { address: a(9) } : {}) } : {}) });
const proof = (operation = 'unscheduled', overrides = {}) => ({ chainId: 56, blockNumber: 110,
  readOnly: true, chainActionsPerformed: false, replacement: a(9), replacementVerified: true,
  operation, implState: operation === 'done' ? 'new' : 'old', minDelay: '172800', ...overrides });
function harness(initial = null, overrides = {}) {
  let row = initial;
  const calls = [], returned = [];
  const callbacks = {
    getJournal: () => row,
    saveJournal: value => { row = value; calls.push(['save']); },
    createJournal: live => { calls.push(['create', live]); return fresh(); },
    inspect: async current => { calls.push(['inspect', current]); const live = proof(null,
      { replacement: null, replacementVerified: false }); returned.push(live); return live; },
    checkOriginal: async (step, current) => {
      calls.push(['check', step, current.transactions[step].txHash]);
      const live = proof(current.transactions.schedule ? 'waiting' : 'unscheduled');
      const confirmed = { ...current.transactions[step], ...tx(step) };
      assertPortfolioDustConfirmedState(step, confirmed, live);
      row = { ...current, transactions: { ...current.transactions, [step]: confirmed } };
      returned.push(live); return live;
    },
    send: async (step, current) => {
      calls.push(['send', step]);
      const live = proof(step === 'schedule' ? 'waiting' : 'unscheduled');
      assertPortfolioDustConfirmedState(step, tx(step), live);
      row = { ...current, transactions: { ...current.transactions, [step]: tx(step) } };
      returned.push(live); return live;
    },
    ...overrides,
  };
  return { callbacks, calls, returned, get row() { return row; }, set row(value) { row = value; },
    run: () => runPortfolioDustFlow(callbacks) };
}
const phases = calls => calls.filter(([name]) => ['inspect', 'check', 'send'].includes(name))
  .map(call => call.slice(0, 2));

test('fresh deployment uses only initial, deploy receipt and schedule receipt proofs', async () => {
  const f = harness(), result = await f.run();
  assert.deepEqual(phases(f.calls), [['inspect', null], ['send', 'deploy'], ['send', 'schedule']]);
  assert.equal(f.returned.length, 3);
  assert.equal(result.proof, f.returned[2]);
  assert.equal(result.pending, false);
  assert.equal(f.row.transactions.deploy.status, 'confirmed');
  assert.equal(f.row.transactions.schedule.status, 'confirmed');
});
test('resumed confirmed deployment rechecks original receipt once before scheduling', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy');
  const f = harness(row), result = await f.run();
  assert.deepEqual(phases(f.calls), [['check', 'deploy'], ['send', 'schedule']]);
  assert.equal(f.calls[0][2], row.transactions.deploy.txHash);
  assert.equal(result.proof, f.returned[1]);
});
test('recovered pending deployment is not rechecked a second time and uses its original hash', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy', 'submitted');
  const f = harness(row); await f.run();
  assert.deepEqual(phases(f.calls), [['check', 'deploy'], ['send', 'schedule']]);
  assert.equal(f.calls[0][2], row.transactions.deploy.txHash);
});
test('pending and unknown original intents cannot lead to any new send', async () => {
  for (const status of ['submitted', 'uncertain']) {
    for (const step of ['deploy', 'schedule']) {
      const row = fresh(); row.transactions.deploy = tx('deploy'); row.transactions[step] = tx(step, status);
      if (status === 'uncertain') delete row.transactions[step].txHash;
      const f = harness(row, { checkOriginal: async (name, current) => {
        f.calls.push(['check', name]); assert.equal(current.transactions[name].status, status); return null;
      } });
      const result = await f.run();
      assert.deepEqual(phases(f.calls), [['check', step]]); assert.equal(result.pending, true);
      assert.equal(f.row, row); assert.equal(result.proof, null);
    }
  }
});
test('an ambiguous send preserves its original intent and a later invocation cannot resend it', async () => {
  const failure = new Error('wallet transport disconnected after send');
  const f = harness(null, { send: async (step, current) => {
    f.calls.push(['send', step]);
    const intent = tx(step, 'uncertain'); delete intent.txHash;
    f.row = { ...current, transactions: { ...current.transactions, [step]: intent } };
    throw failure;
  } });
  await assert.rejects(f.run(), error => error === failure);
  const original = f.row;
  assert.equal(original.transactions.deploy.status, 'uncertain');
  f.callbacks.checkOriginal = async (step, current) => {
    f.calls.push(['check', step]); assert.equal(current, original); return null;
  };
  const result = await f.run();
  assert.equal(result.pending, true); assert.equal(f.row, original);
  assert.deepEqual(phases(f.calls), [['inspect', null], ['send', 'deploy'], ['check', 'deploy']]);
});
test('recovered pending schedule verifies both original receipts and reuses only the last proof', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy'); row.transactions.schedule = tx('schedule', 'submitted');
  const f = harness(row), result = await f.run();
  assert.deepEqual(phases(f.calls), [['check', 'schedule'], ['check', 'deploy']]);
  assert.equal(result.proof, f.returned[1]); assert.equal(result.proof.operation, 'waiting');
});
test('a new invocation always rechecks both saved confirmed receipts', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy'); row.transactions.schedule = tx('schedule');
  const f = harness(row); await f.run(); await f.run();
  assert.deepEqual(phases(f.calls), [['check', 'deploy'], ['check', 'schedule'], ['check', 'deploy'], ['check', 'schedule']]);
});
test('only the last proof of this invocation is passed to the next receipt check', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy'); row.transactions.schedule = tx('schedule', 'submitted');
  const f = harness(row), originalCheck = f.callbacks.checkOriginal, supplied = [];
  f.callbacks.checkOriginal = async (step, current, lastProof) => {
    supplied.push(lastProof); return originalCheck(step, current);
  };
  await f.run();
  assert.equal(supplied[0], null); assert.equal(supplied[1], f.returned[0]);
  await f.run();
  assert.equal(supplied[2], null); assert.equal(supplied[3], f.returned[2]);
});
test('receipt callback rejection of a reusable proof scope is propagated without sending', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy'); row.transactions.schedule = tx('schedule');
  const failure = new Error('proof operationId or delay scope differs');
  const f = harness(row, { checkOriginal: async (step, current, lastProof) => {
    f.calls.push(['check', step]);
    if (lastProof) throw failure;
    return proof('waiting');
  } });
  await assert.rejects(f.run(), error => error === failure);
  assert.deepEqual(phases(f.calls), [['check', 'deploy'], ['check', 'schedule']]); assert.equal(f.row, row);
});
test('a saved confirmed schedule canceled after confirmation is blocked without resending', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy'); row.transactions.schedule = tx('schedule');
  const f = harness(row, { checkOriginal: async (step, current) => {
    f.calls.push(['check', step]); return proof('unscheduled');
  } });
  await assert.rejects(f.run(), /取消/);
  assert.deepEqual(phases(f.calls), [['check', 'deploy'], ['check', 'schedule']]); assert.equal(f.row, row);
});
test('unavailable saved confirmation and failed receipt proof propagate without new transactions', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy');
  const pending = harness(row, { checkOriginal: async () => null });
  await assert.rejects(pending.run(), /原确认记录/); assert.equal(pending.row, row);
  for (const reason of ['sender mismatch', 'nonce mismatch', 'calldata mismatch', 'receipt inclusion mismatch', 'runtime mismatch']) {
    const failure = new Error(reason), f = harness(row, { checkOriginal: async () => { throw failure; } });
    await assert.rejects(f.run(), error => error === failure); assert.equal(f.calls.length, 0); assert.equal(f.row, row);
  }
});
test('candidate mismatch, a proof behind its receipt and unsaved confirmation block the next step', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy');
  for (const live of [proof('unscheduled', { replacementVerified: false }),
    proof('unscheduled', { replacement: a(99) }), proof('unscheduled', { blockNumber: 99 }),
    proof('unscheduled', { chainId: 1 })]) {
    const f = harness(row, { checkOriginal: async () => live }); await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
  }
  const pendingRow = fresh(); pendingRow.transactions.deploy = tx('deploy', 'submitted');
  const f = harness(pendingRow, { checkOriginal: async () => proof() });
  await assert.rejects(f.run(), /原交易尚未获得/); assert.equal(f.row, pendingRow);
});
test('changed journal scope or original transaction identity prevents reuse and send', async () => {
  for (const change of [row => { row.salt = h(99); }, row => { row.delaySeconds++; },
    row => { row.transactions.deploy.nonce = '9'; }, row => { row.transactions.deploy.txHash = h(99); },
    row => { row.transactions.deploy.dataHash = h(99); }, row => { row.transactions.deploy.from = a(99); }]) {
    const row = fresh(); row.transactions.deploy = tx('deploy');
    const f = harness(row, { checkOriginal: async () => { const changed = structuredClone(row); change(changed); f.row = changed; return proof(); } });
    await assert.rejects(f.run(), /发生变化/); assert.equal(f.calls.length, 0);
  }
});
test('old/new implementation gates remain in place before deploy, schedule and completion', async () => {
  const beforeDeploy = harness(null, { inspect: async () => proof(null, { implState: 'new' }) });
  await assert.rejects(beforeDeploy.run(), /当前合约已变化/);
  assert(!beforeDeploy.calls.some(([name]) => name === 'send'));
  const row = fresh(); row.transactions.deploy = tx('deploy');
  const beforeSchedule = harness(row, { checkOriginal: async () => proof('unscheduled', { implState: 'new' }) });
  await assert.rejects(beforeSchedule.run(), /此补丁已生效/);
  const incoherent = harness(row, { checkOriginal: async () => proof('done', { implState: 'old' }) });
  await assert.rejects(incoherent.run(), /阶段不一致/);
  const done = harness(row, { checkOriginal: async () => proof('done') });
  assert.equal((await done.run()).proof.operation, 'done'); assert.equal(done.calls.length, 0);
});
test('schedule send must supply its own confirmed proof; deployment proof cannot confirm it', async () => {
  const row = fresh(); row.transactions.deploy = tx('deploy');
  const f = harness(row, { send: async (step, current) => {
    f.calls.push(['send', step]); f.row = { ...current, transactions: { ...current.transactions, schedule: tx('schedule') } };
    return proof('unscheduled');
  } });
  await assert.rejects(f.run(), /取消/); assert.deepEqual(phases(f.calls), [['check', 'deploy'], ['send', 'schedule']]);
});
