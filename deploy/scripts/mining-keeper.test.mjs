import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, keccak256, solidityPackedKeccak256 } from 'ethers';
import { buildVectorTree, startSamples } from './mining-proofs.mjs';
import { assertStage, miningDecision, parseMiningArguments } from './mining-keeper.mjs';

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
});
