import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Transaction, Wallet, keccak256 } from 'ethers';
import { archiveFinalizedAuthorityFailure, authorityOperationId, prepareAuthorityCall,
  runAuthorityRelay } from './authority-relay.mjs';
import { acquireWalletLock, readJournal, writeJournal } from './purchase-keeper.mjs';
import { authorityTypedAction } from '../shared/authority-typed.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const authority = address(11), market = address(12), pool = address(13), code = '0x6000';
const getter = new Interface(['function gasWallet() view returns(address)',
  'function coreFactory() view returns(address)', 'function budgetFactory() view returns(address)',
  'function administratorOne() view returns(address)', 'function administratorTwo() view returns(address)',
  'function nonces(address) view returns(uint256)']);

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'authority-auto-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'authority.json'), admin = Wallet.createRandom(), gas = Wallet.createRandom();
  const command = async price => {
    const args = { market, pool, proposalId: '7', priceWei: price, approved: true };
    const typed = authorityTypedAction(authority, 'reviewSale', args, '0', '9999999999');
    return { authority, expectedCodehash: keccak256(code), kind: 'reviewSale', args,
      nonce: '0', deadline: '9999999999', signature: await admin.signTypedData(typed.domain, typed.types, typed.message) };
  };
  const first = await command('100'), prepared = prepareAuthorityCall(first);
  const raw = await gas.signTransaction({ type: 0, chainId: 56, nonce: 17, to: authority,
    value: 0n, data: prepared.data, gasLimit: 650000n, gasPrice: 1000000000n });
  const signed = Transaction.from(raw);
  const tx = { phase: 'reverted', kind: first.kind, from: gas.address, to: authority,
    data: prepared.data, value: '0', nonce: 17, hash: signed.hash, blockNumber: 100, blockHash: hash(100),
    finality: 'bsc-finalized', finalizedBlockNumber: 110, finalizedBlockHash: hash(110), gasCostWei: '21000', speedUps: 0,
    attempts: [{ kind: 'purchase', raw, hash: signed.hash, gasLimit: '650000', gasPrice: '1000000000', broadcastCount: 1 }] };
  const journal = { version: 1, chainId: 56, factory: authority, pool: authority, transactionTarget: authority,
    transaction: tx, gasSpentWei: '31000', gasReceipts: { [signed.hash]: '21000', [hash(90)]: '10000' } };
  writeJournal(path, journal);
  const state = { network: 56n, code, wallet: gas.address, core: address(20), budget: address(21),
    finalized: { number: 110, hash: hash(110) },
    current: { number: 115, hash: hash(115), gasLimit: 30000000n },
    transaction: { hash: signed.hash, from: gas.address, to: authority, data: prepared.data,
      nonce: 17, value: 0n, chainId: 56n, gasLimit: 650000n, gasPrice: 1000000000n, type: 0,
      blockNumber: 100, blockHash: hash(100) },
    receipt: { hash: signed.hash, from: gas.address, to: authority, blockNumber: 100, blockHash: hash(100), status: 0, fee: 21000n },
    canonical: new Map([[100, { number: 100, hash: hash(100) }]]), latestNonce: 18, pendingNonce: 18, finalizedNonce: 18 };
  const calls = [], broadcasts = [];
  const record = (kind, args, value) => { calls.push([kind, ...args]); return value; };
  const provider = {
    getNetwork: async () => record('network', [], { chainId: state.network }),
    getCode: async (...args) => record('code', args, state.code),
    getBlock: async tag => record('block', [tag], tag === 'latest' ? state.current : tag === 'finalized' ? state.finalized
      : state.canonical.get(tag) ?? (tag === state.current.number ? state.current : tag === state.finalized.number ? state.finalized : null)),
    getTransaction: async h => record('transaction', [h], state.transaction),
    getTransactionReceipt: async h => record('receipt', [h], state.receipt),
    getTransactionCount: async (account, tag) => record('nonce', [account, tag], tag === 'pending' ? state.pendingNonce
      : typeof tag === 'number' ? state.finalizedNonce : state.latestNonce),
    call: async tx => {
      const parsed = getter.parseTransaction(tx);
      record('call', [parsed.name, tx.blockTag], null);
      return getter.encodeFunctionResult(parsed.name, [parsed.name === 'gasWallet' ? state.wallet
        : parsed.name === 'coreFactory' ? state.core : parsed.name === 'budgetFactory' ? state.budget
        : parsed.name === 'nonces' ? 0n : admin.address]);
    },
    getFeeData: async () => ({ gasPrice: 1000000000n }), getBalance: async () => 10n ** 18n,
    estimateGas: async () => assert.fail('No recovery or submission simulation'),
    broadcastTransaction: async bytes => { broadcasts.push(bytes); return { hash: keccak256(bytes) }; },
  };
  const options = { journal: path, authority, factory: authority, pool: authority, transactionTarget: authority,
    expectedCodehash: keccak256(code), expectedGasWallet: gas.address };
  return { path, directory, admin, gas, command, first, prepared, raw, tx, journal, state, calls, broadcasts, provider, options };
}

test('exact finalized failure archives signed bytes and all fees; idle recovery makes zero reads or sends', async t => {
  const f = await fixture(t), result = await archiveFinalizedAuthorityFailure(f.provider, f.options, f.journal);
  assert.equal(result.operationId, authorityOperationId(authority, f.prepared.data));
  assert.equal(result.status, 'reverted'); assert.equal(result.archived, true);
  const saved = readJournal(f.path, f.options);
  assert.equal(saved.transaction, null); assert.equal(saved.gasSpentWei, '31000');
  assert.deepEqual(saved.gasReceipts, f.journal.gasReceipts);
  assert.equal(saved.reviewedAuthorityFailures[0].transaction.attempts[0].raw, f.raw);
  const reads = f.calls.length;
  assert.equal(await archiveFinalizedAuthorityFailure(f.provider, f.options, saved), null);
  assert.equal(f.calls.length, reads); assert.deepEqual(f.broadcasts, []);
  for (const phase of ['signed', 'broadcast', 'confirming', 'cancelled', 'cancel-reverted', 'confirmed']) {
    assert.equal(await archiveFinalizedAuthorityFailure(f.provider, f.options, { transaction: { phase } }), null);
  }
  assert.equal(f.calls.length, reads);
});

test('archival permits one explicitly authorized new operation and retains the old failure ledger', async t => {
  const f = await fixture(t);
  const newCommand = await f.command('101');
  const options = { commandObject: newCommand, journal: f.path, send: true, gasLimit: 650000n,
    maxGasWei: 10n ** 18n, maxGasPrice: 3000000000n };
  assert.equal((await runAuthorityRelay(f.provider, options, f.gas)).status, 'previous-operation-failed-review-required');
  assert.deepEqual(f.broadcasts, []);
  await archiveFinalizedAuthorityFailure(f.provider, f.options, f.journal);
  let signatures = 0;
  const signer = { address: f.gas.address, signTransaction: tx => { signatures++; return f.gas.signTransaction(tx); } };
  const result = await runAuthorityRelay(f.provider, options, signer);
  assert.equal(result.status, 'broadcast'); assert.notEqual(result.hash, f.tx.hash);
  assert.equal(signatures, 1); assert.equal(f.broadcasts.length, 1);
  const saved = readJournal(f.path, f.options);
  assert.equal(saved.transaction.nonce, 18); assert.equal(saved.transaction.operationId,
    authorityOperationId(authority, prepareAuthorityCall(newCommand).data));
  assert.equal(saved.reviewedAuthorityFailures[0].transaction.hash, f.tx.hash);
  assert.equal(saved.gasSpentWei, '31000');
});

const poisons = [
  ['wrong chain', f => { f.state.network = 1n; }],
  ['unknown finalized height', f => { f.state.finalized.number = undefined; }],
  ['non-integer finalized height', f => { f.state.finalized.number = 110.5; }],
  ['unsafe finalized height', f => { f.state.finalized.number = Number.MAX_SAFE_INTEGER + 1; }],
  ['missing finalized hash', f => { f.state.finalized.hash = null; }],
  ['not finalized', f => { f.state.finalized.number = 99; }],
  ['insufficient confirmations', f => { f.state.current.number = 100; f.state.finalized.number = 100; }],
  ['runtime changed', f => { f.state.code = '0x6001'; }],
  ['wallet rotated', f => { f.state.wallet = address(99); }],
  ['current block reorganized', f => { f.state.canonical.set(115, { number: 115, hash: hash(1) }); }],
  ['finalized block reorganized', f => { f.state.canonical.set(110, { number: 110, hash: hash(1) }); }],
  ['wrong canonical block number', f => { f.state.canonical.set(115, { number: 114, hash: hash(115) }); }],
  ['missing receipt', f => { f.state.receipt = null; }],
  ['success receipt', f => { f.state.receipt.status = 1; }],
  ['receipt reorganized', f => { f.state.canonical.set(100, { number: 100, hash: hash(1) }); }],
  ['receipt fee changed', f => { f.state.receipt.fee = 21001n; }],
  ['fee ledger sum changed', f => { f.journal.gasSpentWei = '31001'; }],
  ['receipt block identity changed', f => { f.state.receipt.blockHash = hash(1); }],
  ['missing mined transaction identity', f => { delete f.state.transaction.blockHash; }],
  ['other target', f => { f.state.transaction.to = address(99); }],
  ['other calldata', f => { f.state.transaction.data += '00'; }],
  ['other sender', f => { f.state.transaction.from = address(99); }],
  ['nonzero value', f => { f.state.transaction.value = 1n; }],
  ['signed gas changed', f => { f.state.transaction.gasPrice += 1n; }],
  ['nonce not finalized', f => { f.state.finalizedNonce = 17; }],
  ['pending nonce behind latest', f => { f.state.pendingNonce = 17; }],
  ['missing raw signed bytes', f => { delete f.tx.attempts[0].raw; }],
  ['cancel attempt', f => { f.tx.attempts[0].kind = 'cancel'; }],
  ['wrong transaction kind', f => { f.tx.kind = 'executeOperation'; }],
];
for (const [name, poison] of poisons) test(`failure recovery retains hold: ${name}`, async t => {
  const f = await fixture(t); poison(f);
  const before = readFileSync(f.path, 'utf8');
  await assert.rejects(archiveFinalizedAuthorityFailure(f.provider, f.options, f.journal));
  assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(f.journal.transaction, f.tx);
  assert.equal(f.journal.reviewedAuthorityFailures, undefined); assert.deepEqual(f.broadcasts, []);
});

test('reviewed artifact runtime plus pinned constructor views supports activation records without a full hash', async t => {
  const f = await fixture(t);
  const options = { ...f.options, expectedCodehash: undefined, reviewedRuntimeMatches: observed => observed === code,
    expectedCoreFactory: f.state.core, expectedBudgetFactory: f.state.budget };
  assert.equal((await archiveFinalizedAuthorityFailure(f.provider, options, f.journal)).archived, true);
});
for (const poison of ['runtime', 'core', 'budget']) test(`artifact-pinned recovery rejects changed ${poison}`, async t => {
  const f = await fixture(t);
  const options = { ...f.options, expectedCodehash: undefined, reviewedRuntimeMatches: observed => observed === code,
    expectedCoreFactory: f.state.core, expectedBudgetFactory: f.state.budget };
  if (poison === 'runtime') f.state.code = '0x6001'; else f.state[poison] = address(999);
  await assert.rejects(archiveFinalizedAuthorityFailure(f.provider, options, f.journal), /runtime or Gas wallet/);
  assert.equal(f.journal.transaction, f.tx); assert.deepEqual(f.broadcasts, []);
});

test('a finalized anchor changing during the final fee/nonce reads prevents the archival write', async t => {
  const f = await fixture(t), original = f.provider.getBlock;
  let finalizedReads = 0;
  f.provider.getBlock = async tag => {
    if (tag === 110 && ++finalizedReads === 2) return { number: 110, hash: hash(999) };
    return original(tag);
  };
  await assert.rejects(archiveFinalizedAuthorityFailure(f.provider, f.options, f.journal), /anchor changed/);
  assert.equal(f.journal.transaction, f.tx); assert.equal(f.journal.reviewedAuthorityFailures, undefined);
});

test('wallet recovery only uses the existing exact pointer, preserves its bytes and rejects missing/other pointers', async t => {
  const f = await fixture(t), root = join(f.directory, 'wallets'), other = join(f.directory, 'other.json');
  writeJournal(other, { ...f.journal, transaction: null });
  assert.throws(() => acquireWalletLock(f.gas.address, f.path, root, { existingJournalOnly: true }), /existing journal pointer/);
  const release = acquireWalletLock(f.gas.address, f.path, root); release();
  const pointer = join(root, `56-${f.gas.address.toLowerCase()}.json`), before = readFileSync(pointer, 'utf8');
  const recover = acquireWalletLock(f.gas.address, f.path, root, { existingJournalOnly: true }); recover();
  assert.equal(readFileSync(pointer, 'utf8'), before);
  assert.throws(() => acquireWalletLock(f.gas.address, other, root, { existingJournalOnly: true }), /exact existing journal pointer/);
  assert.equal(readFileSync(pointer, 'utf8'), before);
});
