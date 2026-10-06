import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AbiCoder, Interface, Wallet, ZeroHash, keccak256 } from 'ethers';
import { verifyPortfolioDustReceipt } from './portfolio-dust-journal.mjs';
import { FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR, FRESH_BALANCE_ENFORCER } from './fresh-activation-execution.mjs';

const ABI = AbiCoder.defaultAbiCoder();
const MANAGER = new Interface(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
const TIMELOCK = new Interface([
  'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)', 'function upgradeTo(address)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)',
]);
const DELEGATIONS = 'tuple(address delegate,address delegator,bytes32 authority,tuple(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]';
const TYPES = {
  Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }],
  Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
};
// Public synthetic signing key, used only for these in-memory unit fixtures.
const signer = new Wallet(`0x${'11'.repeat(32)}`);
const h = number => `0x${number.toString(16).padStart(64, '0')}`;
const a = number => `0x${number.toString(16).padStart(40, '0')}`;
const fixed = [[FRESH_DELEGATION_MANAGER, 'manager'], [FRESH_DELEGATOR, 'delegator'], [FRESH_BALANCE_ENFORCER, 'enforcer']];
const runtimeFixture = JSON.parse(await readFile(new URL('../src/fixtures/fresh-delegation-runtime.json', import.meta.url), 'utf8'));

async function fixture({ wrapped = true, status = 1 } = {}) {
  const payload = TIMELOCK.encodeFunctionData('upgradeTo', [a(9)]);
  const args = [a(3), 0n, payload, ZeroHash, h(22)];
  const data = TIMELOCK.encodeFunctionData('schedule', [...args, 172800]);
  const operationId = keccak256(ABI.encode(['address', 'uint256', 'bytes', 'bytes32', 'bytes32'], args));
  const plan = { to: a(2), target: a(3), payload, replacement: a(9), predecessor: ZeroHash,
    value: '0', salt: h(22), delaySeconds: 172800, scheduleData: data, operationId };
  const expected = { from: signer.address, to: plan.to, nonce: '7', dataHash: keccak256(data), data, schedulePlan: plan };
  const caveat = { enforcer: FRESH_BALANCE_ENFORCER.address,
    terms: `0x01${signer.address.slice(2)}${'00'.repeat(32)}`, args: '0x' };
  const delegation = { delegate: signer.address, delegator: signer.address,
    authority: `0x${'ff'.repeat(32)}`, caveats: [caveat], salt: 123n };
  delegation.signature = await signer.signTypedData({ name: 'DelegationManager', version: '1', chainId: 56,
    verifyingContract: FRESH_DELEGATION_MANAGER.address }, TYPES, delegation);
  const tx = { hash: h(5), chainId: 56n, from: signer.address, to: wrapped ? FRESH_DELEGATION_MANAGER.address : plan.to,
    nonce: 7, value: 0n, type: 2, data, blockNumber: 100, blockHash: h(10), authorizationList: null };
  const receipt = { hash: tx.hash, from: tx.from, to: tx.to, index: 2, status, contractAddress: null,
    blockNumber: tx.blockNumber, blockHash: tx.blockHash, logs: [] };
  function log(name, values) {
    return { address: plan.to, ...TIMELOCK.encodeEventLog(TIMELOCK.getEvent(name), values),
      transactionHash: tx.hash, transactionIndex: receipt.index, blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash, removed: false };
  }
  if (status === 1) receipt.logs = [
    log('CallScheduled', [operationId, 0n, plan.target, 0n, plan.payload, plan.predecessor, 172800n]),
    log('CallSalt', [operationId, plan.salt]),
  ];
  const runtimes = Object.fromEntries(fixed.map(([pin, name]) => [pin.address.toLowerCase(), runtimeFixture.codes[name].code]));
  const anchor = { number: 110, hash: h(11) }, reads = [];
  const provider = {
    async getTransaction(hash) { assert.equal(hash, tx.hash); reads.push(['tx']); return tx; },
    async getTransactionReceipt(hash) { assert.equal(hash, tx.hash); reads.push(['receipt']); return receipt; },
    async getBlock(tag) {
      reads.push(['block', tag]);
      if (tag === 'finalized') return anchor;
      if (tag === receipt.blockNumber) return { number: receipt.blockNumber, hash: receipt.blockHash, transactions: [h(1), h(2), tx.hash] };
      if (tag === anchor.number) return { ...anchor };
      throw new Error('Unexpected block tag');
    },
    async getCode(address, tag) {
      reads.push(['code', address, tag]); assert.equal(tag, anchor.number);
      return runtimes[address.toLowerCase()] ?? '0x';
    },
  };
  const f = { tx, receipt, plan, expected, provider, anchor, reads, runtimes, log,
    delegations: [delegation], modes: [ZeroHash], executions: [`0x${plan.to.slice(2)}${'00'.repeat(32)}${data.slice(2)}`], contexts: null };
  f.rebuild = () => { f.tx.data = MANAGER.encodeFunctionData('redeemDelegations',
    [f.contexts ?? [ABI.encode([DELEGATIONS], [f.delegations])], f.modes, f.executions]); };
  if (wrapped) f.rebuild();
  f.verify = () => verifyPortfolioDustReceipt(provider, tx.hash, expected);
  return f;
}

test('direct schedule confirms exact operation and both Timelock events without wrapper RPCs', async () => {
  const f = await fixture({ wrapped: false }), result = await f.verify();
  assert.equal(result.success, true); assert.equal(result.envelopeKind, 'direct');
  assert.equal(result.operationId, f.plan.operationId); assert.equal(result.scheduleDataHash, f.expected.dataHash);
  assert.equal(f.reads.length, 4); assert(!f.reads.some(([name]) => name === 'code'));
});
test('fixed MetaMask wrapper verifies a synthetic signed single call and exact event result', async () => {
  const f = await fixture(), result = await f.verify();
  assert.equal(result.success, true); assert.equal(result.envelopeKind, 'wrapped');
  assert.equal(result.operationId, f.plan.operationId); assert.notEqual(keccak256(f.tx.data), f.expected.dataHash);
  assert.deepEqual(result.runtimeAnchor, { blockNumber: f.anchor.number, blockHash: f.anchor.hash });
  assert.equal(f.reads.length, 8);
  assert.deepEqual(f.reads.filter(([name]) => name === 'code').map(([, addr, tag]) => [addr, tag]),
    fixed.map(([pin]) => [pin.address, f.anchor.number]));
  assert.equal(f.reads.at(-1)[1], f.anchor.number);
});
for (const [name, mutate] of [
  ['wrong chain', f => { f.tx.chainId = 1n; }], ['wrong sender', f => { f.tx.from = a(99); }],
  ['wrong nonce', f => { f.tx.nonce++; }], ['nonzero outer value', f => { f.tx.value = 1n; }],
  ['another tx hash', f => { f.receipt.hash = h(99); }], ['receipt sender mismatch', f => { f.receipt.from = a(99); }],
  ['receipt recipient mismatch', f => { f.receipt.to = a(99); }],
  ['receipt block mismatch', f => { f.tx.blockHash = h(99); }],
  ['unapproved wrapper', f => { f.tx.to = a(99); f.receipt.to = a(99); }],
  ['authorization transaction', f => { f.tx.type = 4; }],
  ['extra authorization', f => { f.tx.authorizationList = [{}]; }],
]) test(`wrapped schedule rejects ${name}`, async () => {
  const f = await fixture(); mutate(f); await assert.rejects(f.verify());
});
for (const [name, mutate] of [
  ['another delegate', f => { f.delegations[0].delegate = a(99); }],
  ['another delegator', f => { f.delegations[0].delegator = a(99); }],
  ['non-root authority', f => { f.delegations[0].authority = ZeroHash; }],
  ['another caveat', f => { f.delegations[0].caveats[0].enforcer = a(99); }],
  ['extra caveat', f => { f.delegations[0].caveats.push({ ...f.delegations[0].caveats[0] }); }],
  ['caveat arguments', f => { f.delegations[0].caveats[0].args = '0x01'; }],
  ['nonzero balance terms', f => { f.delegations[0].caveats[0].terms = `0x01${signer.address.slice(2)}${h(1).slice(2)}`; }],
  ['tampered signed salt', f => { f.delegations[0].salt++; }],
  ['short signature', f => { f.delegations[0].signature = '0x01'; }],
  ['two delegations', f => { f.delegations.push({ ...f.delegations[0] }); }],
  ['two executions', f => { f.executions.push(f.executions[0]); }],
  ['no execution', f => { f.executions = []; }],
  ['non-default execution mode', f => { f.modes = [h(1)]; }],
  ['extra permission context', f => { const context = ABI.encode([DELEGATIONS], [f.delegations]); f.contexts = [context, context]; }],
  ['noncanonical context', f => { f.contexts = [`${ABI.encode([DELEGATIONS], [f.delegations])}00`]; }],
  ['another inner target', f => { f.executions[0] = `0x${a(99).slice(2)}${'00'.repeat(32)}${f.expected.data.slice(2)}`; }],
  ['nonzero inner value', f => { f.executions[0] = `0x${f.plan.to.slice(2)}${h(1).slice(2)}${f.expected.data.slice(2)}`; }],
  ['another inner data', f => { f.executions[0] += '00'; }],
]) test(`wrapped schedule rejects ${name}`, async () => {
  const f = await fixture(); mutate(f); f.rebuild(); await assert.rejects(f.verify());
});
test('wrapper trailing bytes cannot be accepted by permissive ABI decoding', async () => {
  const f = await fixture(); f.tx.data += '00'; await assert.rejects(f.verify(), /wrapper_noncanonical/);
});
for (const [pin, name] of fixed) test(`wrapped schedule requires exact ${name} runtime`, async () => {
  const f = await fixture(); f.runtimes[pin.address.toLowerCase()] += '00';
  await assert.rejects(f.verify(), new RegExp(`${name}_runtime`));
});
test('current finalized runtime proof fails closed on canonical anchor changes and RPC failure', async () => {
  const f = await fixture(), original = f.provider.getBlock;
  f.provider.getBlock = async tag => tag === f.anchor.number ? { ...f.anchor, hash: h(99) } : original(tag);
  await assert.rejects(f.verify(), /规范区块发生变化/);
  const g = await fixture(), failure = new Error('archive unavailable');
  g.provider.getCode = async () => { throw failure; };
  await assert.rejects(g.verify(), error => error === failure);
});
for (const [name, mutate] of [
  ['missing scheduled event', f => { f.receipt.logs.shift(); }],
  ['duplicate scheduled event', f => { f.receipt.logs.push(structuredClone(f.receipt.logs[0])); }],
  ['missing salt event', f => { f.receipt.logs.pop(); }],
  ['duplicate salt event', f => { f.receipt.logs.push(structuredClone(f.receipt.logs[1])); }],
  ['wrong emitter', f => { f.receipt.logs[0].address = a(99); }],
  ['different operation id', f => { f.receipt.logs[0].topics[1] = h(99); }],
  ['batch index one', f => { f.receipt.logs[0].topics[2] = h(1); }],
  ['different target', f => { f.receipt.logs[0] = f.log('CallScheduled', [f.plan.operationId, 0n, a(99), 0n, f.plan.payload, ZeroHash, 172800n]); }],
  ['nonzero scheduled value', f => { f.receipt.logs[0] = f.log('CallScheduled', [f.plan.operationId, 0n, f.plan.target, 1n, f.plan.payload, ZeroHash, 172800n]); }],
  ['another payload', f => { f.receipt.logs[0] = f.log('CallScheduled', [f.plan.operationId, 0n, f.plan.target, 0n, '0x1234', ZeroHash, 172800n]); }],
  ['nonzero predecessor', f => { f.receipt.logs[0] = f.log('CallScheduled', [f.plan.operationId, 0n, f.plan.target, 0n, f.plan.payload, h(1), 172800n]); }],
  ['different delay', f => { f.receipt.logs[0] = f.log('CallScheduled', [f.plan.operationId, 0n, f.plan.target, 0n, f.plan.payload, ZeroHash, 172801n]); }],
  ['wrong salt', f => { f.receipt.logs[1] = f.log('CallSalt', [f.plan.operationId, h(99)]); }],
  ['wrong salt operation', f => { f.receipt.logs[1] = f.log('CallSalt', [h(99), f.plan.salt]); }],
  ['removed event', f => { f.receipt.logs[0].removed = true; }],
  ['another event transaction', f => { f.receipt.logs[0].transactionHash = h(99); }],
  ['another event block', f => { f.receipt.logs[0].blockHash = h(99); }],
  ['another event height', f => { f.receipt.logs[0].blockNumber++; }],
  ['another event transaction index', f => { f.receipt.logs[0].transactionIndex++; }],
]) test(`schedule success rejects ${name}`, async () => {
  for (const wrapped of [false, true]) { const f = await fixture({ wrapped }); mutate(f); await assert.rejects(f.verify()); }
});
test('a reverted wrapper retains its original intent while a proved direct failure can be archived', async () => {
  const wrapped = await fixture({ status: 0 }); await assert.rejects(wrapped.verify(), /记录保留.*不.*重发/);
  const direct = await fixture({ wrapped: false, status: 0 }), result = await direct.verify();
  assert.equal(result.success, false); assert.equal(result.envelopeKind, 'direct');
});
test('an unfinalized original returns pending before wrapper runtime reads', async () => {
  const f = await fixture(); f.anchor.number = 99;
  assert.equal(await f.verify(), null); assert.equal(f.reads.length, 3);
});
test('complete schedule API cannot be replaced with dataHash alone or a conflicting plan', async () => {
  const f = await fixture(); delete f.expected.data; await assert.rejects(f.verify(), /完整操作参数/);
  const g = await fixture(); g.plan.delaySeconds = 1; await assert.rejects(g.verify(), /48 小时/);
  const i = await fixture(); i.plan.operationId = h(99); await assert.rejects(i.verify(), /摘要/);
});
