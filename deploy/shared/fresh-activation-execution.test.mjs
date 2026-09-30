import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { decodeFreshActivationEnvelope, verifyFreshActivationExecution, expectedFreshActivationCall, assertFreshActivationWalletScope,
  FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR, FRESH_BALANCE_ENFORCER } from './fresh-activation-execution.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/fresh-activation-envelope.json', import.meta.url)));
const abi = AbiCoder.defaultAbiCoder();
const manager = new Interface(['function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)']);
const factory = new Interface(['function setOperator(address)', 'function setTreasury(address)', 'function transferOwnership(address)',
  'event OperatorChanged(address indexed previousOperator,address indexed newOperator)',
  'event TreasuryChanged(address indexed previousTreasury,address indexed newTreasury)',
  'event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)']);
const delegationType = 'tuple(address delegate,address delegator,bytes32 authority,tuple(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]';
const mode = `0x${'00'.repeat(32)}`;
const other = '0x1111111111111111111111111111111111111111';
const clone = value => structuredClone(value);
function input(id = 'coreOperator', wrapped = true, status = 1) {
  const record = { schemaVersion: 1, kind: 'fresh-authority', chainId: 56, account: fixture.account,
    genesis: { factory: '0xd81dBD0E622447D26405B3576F0C3Fd698AF01B8',
      portfolioFactory: '0xc72016011AA2E16Ff48f864f35BAd34CB0Bb21Dc',
      timelock: '0x44e4a0aF0eFa499B17b9f04cD725970eB757c20e' },
    authorityAddress: '0x2222222222222222222222222222222222222222' };
  const owner = id.endsWith('Owner');
  const fn = owner ? 'transferOwnership' : id.endsWith('Operator') ? 'setOperator' : 'setTreasury';
  const data = factory.encodeFunctionData(fn, [owner ? record.genesis.timelock : record.authorityAddress]);
  const step = { id, nonce: 101, dataHash: keccak256(data), txHash: `0x${'bb'.repeat(32)}` };
  const expected = expectedFreshActivationCall(record, step);
  const execution = `0x${expected.target.slice(2)}${'00'.repeat(32)}${data.slice(2)}`;
  const tx = { from: record.account, to: wrapped ? FRESH_DELEGATION_MANAGER.address : expected.target,
    nonce: 101, chainId: 56n, value: 0n, type: 2, blockNumber: 100, blockHash: `0x${'aa'.repeat(32)}`,
    hash: `0x${'cc'.repeat(32)}`, data: wrapped ? manager.encodeFunctionData('redeemDelegations', [[fixture.permissionContext], [mode], [execution]]) : data };
  const event = factory.encodeEventLog(factory.getEvent(expected.eventName), [expected.previousAddress, expected.nextAddress]);
  const receipt = { hash: tx.hash, from: tx.from, to: tx.to, status, blockNumber: tx.blockNumber, blockHash: tx.blockHash,
    logs: status ? [{ address: expected.target, transactionHash: tx.hash, blockHash: tx.blockHash,
      blockNumber: tx.blockNumber, index: 0, removed: false, ...event }] : [] };
  return { record, step, tx, receipt, expected, runtimeProof: clone(fixture.runtimeProof) };
}
function outer(p, alter) {
  const d = manager.decodeFunctionData('redeemDelegations', p.tx.data);
  const values = [[...d[0]], [...d[1]], [...d[2]]]; alter(values);
  p.tx.data = manager.encodeFunctionData('redeemDelegations', values);
}
function context(p, alter) {
  outer(p, values => {
    const [decoded] = abi.decode([delegationType], values[0][0]);
    const ds = decoded.map(d => ({ delegate: d.delegate, delegator: d.delegator, authority: d.authority,
      caveats: d.caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })), salt: d.salt, signature: d.signature }));
    alter(ds); values[0][0] = abi.encode([delegationType], [ds]);
  });
}

for (const id of ['coreOperator', 'coreTreasury', 'budgetOperator', 'budgetTreasury', 'coreOwner', 'budgetOwner']) {
  test(`${id}: exact direct execution`, () => {
    const p = input(id, false); delete p.runtimeProof;
    assert.equal(verifyFreshActivationExecution(p).kind, 'direct');
  });
  test(`${id}: actual canonical signed self delegation`, () => {
    const p = input(id); const result = verifyFreshActivationExecution(p);
    assert.equal(result.kind, 'wrapped'); assert.equal(result.manager, FRESH_DELEGATION_MANAGER.address);
    assert.equal(result.delegator, FRESH_DELEGATOR.address); assert.equal(result.innerDataHash, p.step.dataHash);
  });
}
test('runtime fixture hashes are pinned to the official deployments', () => {
  for (const [name, constant] of [['manager', FRESH_DELEGATION_MANAGER], ['delegator', FRESH_DELEGATOR], ['enforcer', FRESH_BALANCE_ENFORCER]])
    assert.equal(keccak256(fixture.runtimeProof[`${name}Code`]), constant.codeHash);
});
test('current wallet scope accepts only the observed supported delegation', () => {
  assert.equal(assertFreshActivationWalletScope(fixture.runtimeProof.accountCode).delegator, FRESH_DELEGATOR.address);
  assert.throws(() => assertFreshActivationWalletScope(`0xef0100${other.slice(2)}`), /account_delegation/);
  assert.throws(() => assertFreshActivationWalletScope('0x'), /account_delegation/);
  assert.throws(() => assertFreshActivationWalletScope(undefined), /account_code/);
});
test('accepted historical execution does not depend on future account delegation', () => {
  const p = input(); delete p.runtimeProof.accountCode;
  assert.equal(verifyFreshActivationExecution(p).kind, 'wrapped');
  p.runtimeProof.accountCode = '0x';
  assert.equal(verifyFreshActivationExecution(p).kind, 'wrapped');
});
test('reverted wrapped call decodes but cannot be marked executed', () => {
  const p = input('coreTreasury', true, 0);
  assert.equal(decodeFreshActivationEnvelope(p).status, 0);
  assert.throws(() => verifyFreshActivationExecution(p), /execution_reverted/);
});
test('reverted direct call decodes without runtime proof', () => {
  const p = input('budgetTreasury', false, 0); delete p.runtimeProof;
  assert.equal(decodeFreshActivationEnvelope(p).kind, 'direct');
});
test('replacement candidate may have another hash but must retain planned nonce', () => {
  const p = input(); assert.notEqual(p.step.txHash, p.tx.hash);
  assert.equal(verifyFreshActivationExecution(p).transactionHash, p.tx.hash);
});

const mutations = {
  'wrong chain': p => { p.tx.chainId = 1n; },
  'wrong account': p => { p.tx.from = other; },
  'wrong nonce': p => { p.tx.nonce++; },
  'unsafe numeric nonce': p => { p.tx.nonce = Number.MAX_SAFE_INTEGER + 1; },
  'outer value': p => { p.tx.value = 1n; },
  'different receipt transaction': p => { p.receipt.hash = `0x${'dd'.repeat(32)}`; },
  'different receipt from': p => { p.receipt.from = other; },
  'different receipt to': p => { p.receipt.to = other; },
  'different block number': p => { p.receipt.blockNumber++; },
  'different block hash': p => { p.receipt.blockHash = `0x${'dd'.repeat(32)}`; },
  'unknown receipt status': p => { p.receipt.status = null; },
  'wrong outer manager': p => { p.tx.to = p.receipt.to = other; },
  'type4 authorization envelope': p => { p.tx.type = 4; },
  'unexpected authorization list': p => { p.tx.authorizationList = [{}]; },
  'CREATE step': p => { p.step.id = 'deployAuthority'; },
  'unknown step': p => { p.step.id = 'other'; },
  'wrong recorded planned hash': p => { p.step.dataHash = `0x${'ff'.repeat(32)}`; },
  'caller swaps expected target': p => { p.expected.target = other; },
  'caller swaps expected event': p => { p.expected.eventName = 'OwnershipTransferred'; },
  'caller swaps previous role': p => { p.expected.previousAddress = other; },
  'caller swaps next role': p => { p.expected.nextAddress = other; },
  'caller swaps data': p => { p.expected.data += '00'; },
  'factory collision': p => { p.record.genesis.portfolioFactory = p.record.genesis.factory; },
  'missing runtime proof': p => { delete p.runtimeProof; },
  'wrong manager runtime': p => { p.runtimeProof.managerCode += '00'; },
  'wrong delegator runtime': p => { p.runtimeProof.delegatorCode += '00'; },
  'wrong enforcer runtime': p => { p.runtimeProof.enforcerCode += '00'; },
  'outer trailing bytes': p => { p.tx.data += '00'; },
  'duplicate executions': p => outer(p, d => { d[0].push(d[0][0]); d[1].push(d[1][0]); d[2].push(d[2][0]); }),
  'mismatched array lengths': p => outer(p, d => { d[0].push(d[0][0]); }),
  'empty arrays': p => outer(p, d => { d[0] = []; d[1] = []; d[2] = []; }),
  'batch mode': p => outer(p, d => { d[1][0] = `0x01${'00'.repeat(31)}`; }),
  'try execution mode': p => outer(p, d => { d[1][0] = `0x0001${'00'.repeat(30)}`; }),
  'nonzero mode payload': p => outer(p, d => { d[1][0] = `0x${'00'.repeat(31)}01`; }),
  'wrong inner target': p => outer(p, d => { d[2][0] = `0x${other.slice(2)}${d[2][0].slice(42)}`; }),
  'nonzero inner value': p => outer(p, d => { d[2][0] = `${d[2][0].slice(0,42)}${'00'.repeat(31)}01${d[2][0].slice(106)}`; }),
  'wrong inner call': p => outer(p, d => { d[2][0] = `${d[2][0].slice(0,106)}${factory.encodeFunctionData('setTreasury',[other]).slice(2)}`; }),
  'trailing inner bytes': p => outer(p, d => { d[2][0] += '00'; }),
  'trailing context bytes': p => outer(p, d => { d[0][0] += '00'; }),
  'empty delegation context': p => context(p, ds => { ds.length = 0; }),
  'duplicate delegations': p => context(p, ds => { ds.push(ds[0]); }),
  'foreign delegate': p => context(p, ds => { ds[0].delegate = other; }),
  'foreign delegator': p => context(p, ds => { ds[0].delegator = other; }),
  'nonroot authority': p => context(p, ds => { ds[0].authority = mode; }),
  'additional caveat': p => context(p, ds => { ds[0].caveats.push(ds[0].caveats[0]); }),
  'missing caveat': p => context(p, ds => { ds[0].caveats = []; }),
  'foreign caveat': p => context(p, ds => { ds[0].caveats[0].enforcer = other; }),
  'positive balance allowance': p => context(p, ds => { ds[0].caveats[0].terms = `${ds[0].caveats[0].terms.slice(0,-2)}01`; }),
  'caveat args': p => context(p, ds => { ds[0].caveats[0].args = '0x00'; }),
  'tampered signed salt': p => context(p, ds => { ds[0].salt++; }),
  'short signature': p => context(p, ds => { ds[0].signature = ds[0].signature.slice(0,-2); }),
  'missing success event': p => { p.receipt.logs = []; },
  'duplicate success event': p => { p.receipt.logs.push(clone(p.receipt.logs[0])); },
  'unrelated Factory role event': p => { const log = clone(p.receipt.logs[0]); log.address = p.record.genesis.portfolioFactory; p.receipt.logs.push(log); },
  'wrong emitting Factory': p => { p.receipt.logs[0].address = p.record.genesis.portfolioFactory; },
  'wrong previous event role': p => { p.receipt.logs[0].topics[1] = `0x${'00'.repeat(12)}${other.slice(2)}`; },
  'wrong next event role': p => { p.receipt.logs[0].topics[2] = `0x${'00'.repeat(12)}${other.slice(2)}`; },
  'nonempty event data': p => { p.receipt.logs[0].data = '0x00'; },
  'removed event': p => { p.receipt.logs[0].removed = true; },
  'event transaction mismatch': p => { p.receipt.logs[0].transactionHash = `0x${'dd'.repeat(32)}`; },
  'event block mismatch': p => { p.receipt.logs[0].blockNumber++; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`reject ${name}`, () => {
  const p = input(); mutate(p); assert.throws(() => verifyFreshActivationExecution(p));
});
test('direct extra calldata is never treated as wrapped', () => {
  const p = input('coreOperator', false); p.tx.data += '00';
  assert.throws(() => verifyFreshActivationExecution(p), /direct_data/);
});
test('failed wrapped envelope still rejects unexpected nested call', () => {
  const p = input('coreOperator', true, 0); outer(p, d => { d[2][0] += '00'; });
  assert.throws(() => decodeFreshActivationEnvelope(p), /inner_execution/);
});
