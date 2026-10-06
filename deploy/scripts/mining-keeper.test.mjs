import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder, Interface, keccak256, solidityPackedKeccak256 } from 'ethers';
import { buildVectorTree, startSamples } from './mining-proofs.mjs';
import { assertStage, miningDecision, parseMiningArguments, readMiningState, runMiningCycle } from './mining-keeper.mjs';
import { OFFICIAL_COLLECTIONS, readJournal, writeJournal } from './purchase-keeper.mjs';

const fixture = readFileSync(new URL('../../contracts/test/utils/MiningStartFixtures.sol', import.meta.url), 'utf8');
const values = [...fixture.matchAll(/(?:inputs|outputs)\s*=\s*hex"([0-9a-f]+)"/g)].map(row => row[1]);
const task = { cycles: 1, root: '0x850c8ad5850c125982a71d3ecf96bd485f1f25a600bec4e02559e9413e16cc63',
  vectors: Array.from({ length: 256 }, (_, index) => ({ input: `0x${values[0].slice(index * 2, index * 2 + 2)}`,
    out: `0x${values[1].slice(index * 2, index * 2 + 2)}` })) };

test('task-1 official vectors rebuild the fork-proven Merkle root; a corrupt vector fails closed', () => {
  assert.equal(buildVectorTree(task).root, task.root);
  const changed = structuredClone(task);
  changed.vectors[5].out = '0xff';
  assert.throws(() => buildVectorTree(changed), /root mismatch/);
});

test('sample proofs open to the official root at indices derived from anchor and NFT identity', () => {
  const tree = buildVectorTree(task), anchor = keccak256('0x1234');
  const circuits = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', tokenId = 16210n;
  const result = startSamples(tree, anchor, circuits, tokenId, 32);
  assert.equal(result.inputs.length, 32);
  const coder = AbiCoder.defaultAbiCoder();
  for (let i = 0; i < 32; i += 1) {
    const index = Number(BigInt(solidityPackedKeccak256(['bytes32', 'address', 'uint256', 'uint32'],
      [anchor, circuits, tokenId, i])) % 256n);
    let leaf = keccak256(keccak256(coder.encode(['uint32', 'bytes', 'bytes'],
      [index, result.inputs[i], result.outputs[i]])));
    for (const sibling of result.proofs[i]) {
      leaf = keccak256(leaf.toLowerCase() < sibling.toLowerCase() ? `${leaf}${sibling.slice(2)}` : `${sibling}${leaf.slice(2)}`);
    }
    assert.equal(leaf, task.root);
  }
});

test('restart only a stopped pure-verified miner after the block cooldown', () => {
  const eligible = { status: 3n, optimal: false, taskId: 1n, verifWeight: 0n, unverWeight: 0n, stopBlock: 100n };
  assert.equal(miningDecision({ ...eligible, status: 1n }, 1301, 1200n).status, 'mining-active');
  assert.equal(miningDecision(eligible, 1300, 1200n).status, 'stop-cooldown');
  assert.equal(miningDecision(eligible, 1301, 1200n).status, 'restart-eligible');
  for (const changed of [{ status: 0n }, { status: 2n }, { optimal: true }, { taskId: 0n },
    { verifWeight: 100n }, { unverWeight: 1n }, { stopBlock: 0n }]) {
    assert.equal(miningDecision({ ...eligible, ...changed }, 1301, 1200n).status, 'inactive-requires-review');
  }
});

test('send requires explicit journal and an HTTPS RPC', () => {
  const base = ['--factory', '0x0000000000000000000000000000000000000001',
    '--pool', '0x0000000000000000000000000000000000000002'];
  assert.throws(() => parseMiningArguments([...base, '--send']), /journal/);
  assert.throws(() => parseMiningArguments([...base, '--rpc', 'http://example.com']), /HTTPS/);
  assert.equal(parseMiningArguments([...base, '--journal', '/tmp/mining-test.json', '--send']).send, true);
});

test('mining journal cannot be mistaken for purchase or a different mining stage', () => {
  const pool = '0x0000000000000000000000000000000000000002';
  const outer = new Interface(['function mine(bytes)']);
  const inner = new Interface(['function arm(address,uint256)',
    'function start(address,uint256,uint32,uint256,bytes[],bytes[],bytes32[][],bytes32)']);
  const arm = outer.encodeFunctionData('mine', [inner.encodeFunctionData('arm',
    ['0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', 1])]);
  assert.doesNotThrow(() => assertStage({ miningStage: 'arming', transaction: { to: pool, data: arm, value: '0' } }, { pool }));
  assert.throws(() => assertStage({ miningStage: 'starting', transaction: { to: pool, data: arm, value: '0' } }, { pool }), /disagree/);
  assert.throws(() => assertStage({ miningStage: 'arming', transaction: { to: pool, data: '0x12345678', value: '0' } }, { pool }));
  const authority = '0x0000000000000000000000000000000000000003';
  const wrapper = new Interface(['function executeOperation(address,bytes)']);
  const wrapped = wrapper.encodeFunctionData('executeOperation', [pool, arm]);
  assert.doesNotThrow(() => assertStage({ miningStage: 'arming', transaction: { to: authority, data: wrapped, value: '0' } },
    { pool, authority, transactionTarget: authority }));
  assert.throws(() => assertStage({ miningStage: 'arming', transaction: { to: authority, data: wrapped, value: '0' } },
    { pool, transactionTarget: authority }), /different action/);
  assert.throws(() => assertStage({ miningStage: 'arming', transaction: { to: authority,
    data: wrapper.encodeFunctionData('executeOperation', [authority, arm]), value: '0' } },
  { pool, authority, transactionTarget: authority }), /invalid authority wrapper/);
});

test('authority mode binds a new transaction target and preserves the original pool identity', () => {
  const parsed = parseMiningArguments(['--factory', '0x0000000000000000000000000000000000000001',
    '--pool', '0x0000000000000000000000000000000000000002',
    '--authority', '0x0000000000000000000000000000000000000003']);
  assert.equal(parsed.transactionTarget, parsed.authority);
  assert.notEqual(parsed.transactionTarget, parsed.pool);
});

const auditFactory = '0x1111111111111111111111111111111111111111';
const auditPool = '0x2222222222222222222222222222222222222222';
const stateReads = new Interface([
  'function state() view returns(uint8)', 'function isPool(address) view returns(bool)',
  'function factory() view returns(address)', 'function operator() view returns(address)',
  'function params() view returns(tuple(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline))',
]);
function stateProvider(state, calls, registered = true) {
  return { getNetwork: async () => ({ chainId: 56n }),
    getBlock: async () => ({ number: 123, hash: '0x' + 'ab'.repeat(32) }),
    call: async transaction => {
      const parsed = stateReads.parseTransaction(transaction); calls.push(parsed.name);
      return stateReads.encodeFunctionResult(parsed.name, parsed.name === 'state' ? [state]
        : parsed.name === 'isPool' ? [registered]
        : parsed.name === 'params' ? [[OFFICIAL_COLLECTIONS[0], 1, 1, 1, auditFactory, 1, 1000, 2000]]
        : [auditFactory]);
    } };
}
function privateMiningOptions(t) {
  const root = mkdtempSync(join(tmpdir(), 'mining-state-regression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { factory: auditFactory, pool: auditPool, transactionTarget: auditPool,
    journal: join(root, 'pool.json'), send: true };
}

test('non-Active pools make only one contract state read, with no mining metadata or wallet action', async t => {
  const options = privateMiningOptions(t);
  for (const state of [0n, 1n, 3n, 4n, 5n]) {
    const calls = [];
    const result = await readMiningState(stateProvider(state, calls), options);
    assert.equal(result.status, 'pool-not-active'); assert.equal(result.state, state);
    assert.deepEqual(calls, ['state']);
    assert.equal(existsSync(options.journal), false);
  }
});

test('Active pools still independently verify registration and cannot trust only the state selector', async t => {
  const options = privateMiningOptions(t), calls = [];
  await assert.rejects(readMiningState(stateProvider(2n, calls, false), options), /not registered/);
  assert.deepEqual([...calls].sort(), ['state', 'isPool', 'factory', 'params', 'operator'].sort());
});

test('a same-pool read-only snapshot avoids repeated mining RPC and cannot authorize a real send', async t => {
  const options = privateMiningOptions(t);
  const snapshot = { status: 'mining-active', chainId: 56, factory: auditFactory, pool: auditPool,
    blockNumber: 123, operator: auditFactory, circuits: OFFICIAL_COLLECTIONS[0], circuitId: 1n,
    miner: { optimal: false, verifWeight: 1n, unverWeight: 0n } };
  const noRpc = new Proxy({}, { get: () => () => assert.fail('snapshot monitor must not repeat RPC') });
  assert.deepEqual(await runMiningCycle(noRpc, { ...options, send: false }, null, undefined, snapshot),
    { status: 'mining-active', circuitId: 1n });
  await assert.rejects(runMiningCycle(noRpc, { ...options, send: false }, null, undefined,
    { ...snapshot, pool: auditFactory }), /does not match/);
  const calls = [];
  const result = await runMiningCycle(stateProvider(0n, calls), options,
    { getAddress: () => assert.fail('inactive state cannot reach the wallet') }, undefined, snapshot);
  assert.equal(result.status, 'pool-not-active');
  assert.deepEqual(calls, ['state'], 'send mode ignores a cached Active observation and rereads state');
});

for (const stage of ['arming', 'starting']) for (const state of [3n, 4n])
test(`finalized ${stage} leaving Active (${state}) retires only its follow-up and preserves receipt and fees`, async t => {
  const options = privateMiningOptions(t);
  const inner = new Interface(['function arm(address,uint256)',
    'function start(address,uint256,uint32,uint256,bytes[],bytes[],bytes32[][],bytes32)']);
  const data = new Interface(['function mine(bytes)']).encodeFunctionData('mine', [stage === 'arming'
    ? inner.encodeFunctionData('arm', [OFFICIAL_COLLECTIONS[0], 1])
    : inner.encodeFunctionData('start', [OFFICIAL_COLLECTIONS[0], 1, 1, 100, [], [], [], '0x' + '00'.repeat(32)])]);
  const journal = readJournal(options.journal, options), hash = '0x' + 'cd'.repeat(32);
  journal.transaction = { phase: 'confirmed', nonce: 1, from: auditFactory, to: auditPool,
    value: '0', data, hash, finality: 'bsc-finalized', blockNumber: 100,
    blockHash: '0x' + 'ab'.repeat(32), finalizedBlockNumber: 102, finalizedBlockHash: '0x' + 'ef'.repeat(32) };
  journal.miningStage = stage; journal.armRetries = 1;
  journal.gasSpentWei = '1000'; journal.gasReceipts = { [hash]: '1000' };
  const original = structuredClone(journal); writeJournal(options.journal, journal);
  const calls = [], result = await runMiningCycle(stateProvider(state, calls), options,
    { getAddress: () => assert.fail('completed inactive follow-up must not access signer') });
  assert.equal(result.status, 'pool-not-active'); assert.equal(result.followupResolved, true);
  const after = readJournal(options.journal, options);
  assert.equal(after.miningStage, 'monitoring'); assert.equal(after.armRetries, 0);
  assert.deepEqual(after.transaction, original.transaction);
  assert.equal(after.gasSpentWei, original.gasSpentWei); assert.deepEqual(after.gasReceipts, original.gasReceipts);
  assert.deepEqual(calls, ['state']);
});

test('a claimed confirmed follow-up without BSC finality cannot be retired or clear its transaction', async t => {
  const options = privateMiningOptions(t), journal = readJournal(options.journal, options);
  journal.miningStage = 'arming';
  journal.transaction = { phase: 'confirmed', nonce: 1, from: auditFactory, to: auditPool, value: '0',
    data: '0x12345678', hash: '0x' + 'cd'.repeat(32) };
  writeJournal(options.journal, journal); const before = readFileSync(options.journal, 'utf8');
  await assert.rejects(runMiningCycle({}, options), /no BSC finalized proof/);
  assert.equal(readFileSync(options.journal, 'utf8'), before);
});
