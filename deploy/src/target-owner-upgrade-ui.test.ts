import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { keccak256, type Provider } from 'ethers';
// @ts-ignore Canonical shared ESM helper is tested independently.
import { evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
import { TARGET_OWNER_DEPLOYMENTS, newTargetOwnerJournal, parseTargetOwnerJournal, targetOwnerJournalKey,
  targetOwnerPending, targetOwnerNext, confirmedTargetOwnerDeployments, targetOwnerActionReady, submitTargetOwnerUpgrade, targetOwnerReviewedGas,
  verifyTargetOwnerRecoveryReceipt, VerifiedTargetOwnerTransactionFailure, archiveTargetOwnerFailure } from './target-owner-upgrade-ui';
const h = (index: number) => `0x${index.toString(16).padStart(64, '0')}`;
const a = (index: number) => `0x${index.toString(16).padStart(40, '0')}`;
const context = { factory: a(1), genesisRecordDigest: h(2), genesisManifestDigest: h(3), candidateArtifactDigest: h(4), catalogDigest: h(5) };
const tx = (index: number) => ({ status: 'confirmed' as const, from: a(6), dataHash: h(7), txHash: h(index), address: a(index) });
const journal = () => newTargetOwnerJournal(context, h(8));
const full = () => ({ ...journal(), deployments: Object.fromEntries(TARGET_OWNER_DEPLOYMENTS.map((name, index) => [name, tx(20 + index)])) });
test('journal namespace binds independent old record, manifest, catalog and candidate pins', () => {
  assert.match(targetOwnerJournalKey(context), /^bemine\.target-owner-upgrade\.v1\./);
  for (const key of ['genesisRecordDigest', 'genesisManifestDigest', 'catalogDigest', 'candidateArtifactDigest']) {
    assert.throws(() => parseTargetOwnerJournal(journal(), { ...context, [key]: h(99) }), /不匹配/);
  }
});
test('uncertain send is durable, blocks all retries and restores only its confirmed prefix', () => {
  const item = journal(); item.deployments.PoolFunds = tx(20);
  item.deployments.FlexiblePurchase = { status: 'uncertain', from: a(6), dataHash: h(7) };
  const restored = parseTargetOwnerJournal(JSON.parse(JSON.stringify(item)), context);
  assert.equal(targetOwnerPending(restored), 'FlexiblePurchase'); assert.equal(targetOwnerNext(restored), null);
  assert.deepEqual(Object.keys(confirmedTargetOwnerDeployments(restored)), ['PoolFunds']);
  assert.throws(() => parseTargetOwnerJournal({ ...item, deployments: { ...item.deployments, PoolVault: tx(22) } }, context), /顺序/);
});
test('confirmed local rows require original hashes and cannot assert unconfirmed addresses', () => {
  assert.throws(() => parseTargetOwnerJournal({ ...journal(), deployments: { PoolFunds: { ...tx(20), txHash: undefined } } }, context), /缺少/);
  assert.throws(() => parseTargetOwnerJournal({ ...journal(), deployments: { PoolFunds: { ...tx(20), status: 'uncertain' } } }, context), /未确认/);
  assert.throws(() => parseTargetOwnerJournal({ ...journal(), deployments: { PoolFunds: tx(20), FlexiblePurchase: tx(20) } }, context), /重复/);
});
test('journal rejects unrelated Factory, role migration, zero salt and shortened wait', () => {
  for (const next of [{ ...journal(), authority: {} }, { ...journal(), deployments: { PoolFactory: tx(20) } },
    { ...journal(), salt: h(0) }, { ...journal(), delaySeconds: 172799 }]) assert.throws(() => parseTargetOwnerJournal(next, context));
});
test('scheduled and executed rows require all three receipts and a confirmed prior schedule', () => {
  const schedule = { ...tx(30), address: undefined };
  assert.throws(() => parseTargetOwnerJournal({ ...journal(), schedule }, context), /三个/);
  assert.throws(() => parseTargetOwnerJournal({ ...full(), execute: schedule }, context), /排程/);
  assert.equal(parseTargetOwnerJournal({ ...full(), schedule, execute: { ...schedule, txHash: h(31) } }, context).execute?.status, 'confirmed');
});
test('deployment completion never opens activation; waiting, changed signer and pending sends stay blocked', () => {
  const options = { action: 'execute' as const, onBsc: true, signerAuthorized: true, pending: false,
    graphVerified: true, prefixVerified: true, completedDeployments: 3, operation: 'unscheduled' as const, scheduleConfirmed: false };
  assert.equal(targetOwnerActionReady(options), false);
  assert.equal(targetOwnerActionReady({ ...options, operation: 'waiting', scheduleConfirmed: true }), false);
  assert.equal(targetOwnerActionReady({ ...options, operation: 'ready', scheduleConfirmed: true }), true);
  for (const change of [{ pending: true }, { signerAuthorized: false }, { prefixVerified: false }, { graphVerified: false }, { onBsc: false }]) {
    assert.equal(targetOwnerActionReady({ ...options, operation: 'ready', scheduleConfirmed: true, ...change }), false);
  }
});
test('wallet send follows durable intent, and post-send storage failure preserves uncertainty', async () => {
  const events: string[] = []; let status = 'empty';
  const wallet = { request: async ({ method }: { method: string }) => {
    events.push(method); assert.equal(status, 'uncertain');
    return method === 'eth_chainId' ? '0x38' : method === 'eth_accounts' ? [a(6)] : h(90);
  } };
  await assert.rejects(submitTargetOwnerUpgrade(wallet, { from: a(6), data: '0x6000' }, {
    beforeRequest: () => { status = 'uncertain'; events.push('persist'); },
    definitelyRejected: () => { status = 'empty'; }, submitted: () => { throw new Error('storage full'); },
  }), /storage full/);
  assert.equal(events[0], 'persist'); assert.equal(events.filter(event => event === 'eth_sendTransaction').length, 1);
  assert.equal(status, 'uncertain');
});
test('failed durable write never reaches wallet, explicit rejection restores, ambiguous submission stays blocked', async () => {
  let requests = 0, status = 'empty';
  const wallet = { request: async ({ method }: { method: string }) => { requests++; return method === 'eth_chainId' ? '0x38' : [a(6)]; } };
  const callbacks = { beforeRequest: () => { throw new Error('storage denied'); }, submitted: () => {}, definitelyRejected: () => { status = 'empty'; } };
  await assert.rejects(submitTargetOwnerUpgrade(wallet, { from: a(6), data: '0x6000' }, callbacks), /storage denied/);
  assert.equal(requests, 0);
  for (const code of [4001, -32000]) {
    status = 'empty';
    const rejected = { request: async ({ method }: { method: string }) => {
      if (method === 'eth_sendTransaction') throw Object.assign(new Error('wallet response'), { code });
      return method === 'eth_chainId' ? '0x38' : [a(6)];
    } };
    await assert.rejects(submitTargetOwnerUpgrade(rejected, { from: a(6), data: '0x6000' }, {
      ...callbacks, beforeRequest: () => { status = 'uncertain'; },
    }));
    assert.equal(status, code === 4001 ? 'empty' : 'uncertain');
  }
});
const gasEvidence = JSON.parse(readFileSync(new URL('../evidence/target-owner-create-gas-20261004.json', import.meta.url), 'utf8'));
const gasPin = '0x7f2f154c2c2d6814716273294240826f76a5c027aa37d4445016b74dbadbf48e';
test('actual candidate CREATE gas plan is bounded and never treats local EVM addresses as production deployments', () => {
  assert.deepEqual(targetOwnerReviewedGas(gasEvidence, gasEvidence.pins, gasPin), { PoolFunds: '2500000', FlexiblePurchase: '3590000', PoolVault: '6460000' });
  assert.throws(() => targetOwnerReviewedGas({ ...gasEvidence, fixedCeilingsTested: false }, gasEvidence.pins, gasPin), /摘要/);
  for (const mutate of [
    (evidence: any) => { evidence.pins.trustedUpgradeArtifactDigest = h(99); },
    (evidence: any) => { evidence.deployments[0].gasLimit = '1200000'; },
    (evidence: any) => { evidence.environment.forked = true; },
    (evidence: any) => { evidence.deployments.push(evidence.deployments[0]); },
  ]) { const evidence = structuredClone(gasEvidence); mutate(evidence);
    assert.throws(() => targetOwnerReviewedGas(evidence, gasEvidence.pins, evidenceDigest(evidence))); }
});
test('candidate wallet CREATE sends its measured fixed ceiling without estimate or simulation', async () => {
  const requests: string[] = []; let sent: Record<string, any> | undefined;
  const wallet = { request: async ({ method, params }: { method: string; params?: any }) => {
    requests.push(method); if (method === 'eth_sendTransaction') { sent = params[0]; return h(90); }
    return method === 'eth_chainId' ? '0x38' : [a(6)];
  } };
  await submitTargetOwnerUpgrade(wallet, { from: a(6), data: '0x6000', gasLimit: '2500000' },
    { beforeRequest: () => {}, submitted: () => {}, definitelyRejected: () => {} });
  assert.equal(sent?.gas, '0x2625a0'); assert.equal(sent?.value, '0x0'); assert.equal(sent?.to, undefined);
  assert.equal(requests.includes('eth_estimateGas'), false); assert.equal(requests.includes('eth_call'), false);
});
function failedProvider() {
  const transaction = { hash: h(90), from: a(6), to: null, chainId: 56n, value: 0n, data: '0x6000', blockNumber: 10, blockHash: h(10) };
  const receipt = { hash: h(90), from: a(6), to: null, blockNumber: 10, blockHash: h(10), index: 0,
    status: 0, contractAddress: null, gasUsed: 21000n };
  let blockReads = 0;
  const state = { chain: '0x38', transaction, receipt: receipt as typeof receipt | null, reorg: false, future: false };
  const provider = { send: async () => state.chain, getTransaction: async () => state.transaction,
    getTransactionReceipt: async () => state.receipt,
    getBlock: async (tag: unknown) => {
      if (tag === 'finalized' || tag === 20) return { number: 20, hash: h(20), timestamp: 1000, transactions: [] };
      blockReads++; return { number: 10, hash: state.reorg && blockReads > 1 ? h(99) : h(10), timestamp: 900,
        transactions: state.future ? [] : [h(90)] };
    } } as unknown as Provider;
  return { state, provider };
}
test('only the matching canonical finalized status0 transaction releases the same retry step and preserves evidence', async () => {
  const f = failedProvider(), item = journal();
  item.deployments.PoolFunds = { status: 'submitted', from: a(6), txHash: h(90), dataHash: keccak256('0x6000') };
  let failure: VerifiedTargetOwnerTransactionFailure | null = null;
  try { await verifyTargetOwnerRecoveryReceipt(f.provider, h(90), { from: a(6), dataHash: keccak256('0x6000') }); }
  catch (problem) { assert(problem instanceof VerifiedTargetOwnerTransactionFailure); failure = problem; }
  assert(failure); const recovered = archiveTargetOwnerFailure(item, 'PoolFunds', failure.evidence, context);
  assert.equal(targetOwnerPending(recovered), null); assert.equal(targetOwnerNext(recovered), 'PoolFunds');
  assert.equal(recovered.failedTransactions?.[0].evidence.status, 0); assert.equal(recovered.failedTransactions?.[0].transaction.txHash, h(90));
  assert.equal(item.deployments.PoolFunds?.status, 'submitted');
  assert.throws(() => archiveTargetOwnerFailure(item, 'PoolFunds', { ...failure.evidence, txHash: h(91) }, context), /另一笔/);
});
test('unknown, mismatched failed transactions, noncanonical inclusion and reorg never release retry', async () => {
  const expected = { from: a(6), dataHash: keccak256('0x6000') };
  const pending = failedProvider(); pending.state.receipt = null;
  assert.equal(await verifyTargetOwnerRecoveryReceipt(pending.provider, h(90), expected), null);
  for (const mutate of [
    (f: ReturnType<typeof failedProvider>) => { f.state.chain = '0x1'; },
    (f: ReturnType<typeof failedProvider>) => { f.state.transaction.from = a(7); },
    (f: ReturnType<typeof failedProvider>) => { f.state.transaction.value = 1n; },
    (f: ReturnType<typeof failedProvider>) => { f.state.transaction.data = '0x6001'; },
    (f: ReturnType<typeof failedProvider>) => { f.state.future = true; },
    (f: ReturnType<typeof failedProvider>) => { f.state.reorg = true; },
  ]) { const f = failedProvider(); mutate(f);
    await assert.rejects(verifyTargetOwnerRecoveryReceipt(f.provider, h(90), expected), problem => !(problem instanceof VerifiedTargetOwnerTransactionFailure)); }
});
