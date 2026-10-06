import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, getCreateAddress, keccak256 } from 'ethers';
import { INITIALIZATION_PROOF_ABI, verifyInitializationExecution } from '../shared/initialization-proof.mjs';

const iface = new Interface(INITIALIZATION_PROOF_ABI);
const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;

export function initializationProofFixture({ wrapped = true, mode = 'single',integrated=false } = {}) {
  const account = addr(1), coordinator = addr(10);
  const record = {
    chainId: 56, account,
    input: { governanceMode: mode, ownerMultisig: mode === 'single' ? account : addr(2), operator: addr(3), treasury: addr(4) },
    addresses: { AtomicDeployment: coordinator, PoolVault: addr(11), PoolFactory: addr(12), ShareMarket: addr(13) },
    steps: [],
  };
  if(integrated){record.kind='integrated-v2';Object.assign(record.addresses,{BudgetPortfolioFactory:addr(14),BudgetPortfolioVault:addr(15)});}
  for (const [index, [id, address]] of Object.entries(record.addresses).entries()) {
    record.steps.push({ id, status: 'confirmed', address, codehash: hash(50 + index) });
  }
  const config = { ...record.input, vaultImplementation: record.addresses.PoolVault,
    factoryImplementation: record.addresses.PoolFactory, marketImplementation: record.addresses.ShareMarket };
  const inner = iface.encodeFunctionData(integrated?'deployIntegratedSingleOwner':mode === 'single' ? 'deploySingleOwner' : 'deploy',
    [integrated?{core:config,portfolioFactoryImplementation:record.addresses.BudgetPortfolioFactory,portfolioVaultImplementation:record.addresses.BudgetPortfolioVault}:config]);
  const step = { id: 'initialize', status: 'submitted', nonce: 1148, txHash: hash(100), dataHash: keccak256(inner) };
  record.steps.push(step);
  const tx = {
    hash: step.txHash, from: account, nonce: step.nonce, chainId: 56n, value: 0n,
    to: wrapped ? addr(20) : coordinator, data: wrapped ? `0xcef6d209${'00'.repeat(32)}${inner.slice(2)}${'00'.repeat(28)}` : inner,
    blockNumber: 123, blockHash: hash(200),
  };
  const factory = getCreateAddress({ from: coordinator, nonce: 3 });
  const addresses = {
    timelock: getCreateAddress({ from: coordinator, nonce: 1 }),
    beacon: getCreateAddress({ from: coordinator, nonce: 2 }), factory,
    shareMarket: getCreateAddress({ from: factory, nonce: 2 }),
  };
  const events = [
    ['DeploymentCompleted', [addresses.factory, addresses.beacon, addresses.shareMarket, addresses.timelock,
      config.ownerMultisig, config.operator, config.treasury]],
    ['ImplementationsRecorded', [config.vaultImplementation, record.steps[1].codehash,
      config.factoryImplementation, record.steps[2].codehash, config.marketImplementation, record.steps[3].codehash]],
    ['SingleOwnerDeployment', [config.ownerMultisig, addresses.factory]],
  ];
  if(integrated){addresses.portfolioFactory=getCreateAddress({from:coordinator,nonce:5});addresses.portfolioBeacon=getCreateAddress({from:coordinator,nonce:4});
    addresses.portfolioShareMarket=getCreateAddress({from:addresses.portfolioFactory,nonce:1});
    events.push(['IntegratedDeploymentCompleted',[factory,addresses.portfolioFactory,addresses.portfolioBeacon,addresses.portfolioShareMarket,addresses.timelock]],
      ['PortfolioImplementationsRecorded',[record.addresses.BudgetPortfolioFactory,record.steps[4].codehash,record.addresses.BudgetPortfolioVault,record.steps[5].codehash]]);
  }
  const receipt = {
    hash: tx.hash, from: tx.from, to: tx.to, status: 1, blockNumber: tx.blockNumber, blockHash: tx.blockHash,
    logs: events.map(([name, args], index) => ({
      ...iface.encodeEventLog(iface.getEvent(name), args), address: coordinator,
      removed: false, transactionHash: tx.hash, blockHash: tx.blockHash, blockNumber: tx.blockNumber, index: 30 + index,
    })),
  };
  return { record, step, tx, receipt, inner, addresses, events };
}

test('strict initialization proof recognizes exact direct single and multisig calls without claiming envelope authorization', () => {
  for (const mode of ['single', 'multisig']) {
    const fixture = initializationProofFixture({ wrapped: false, mode });
    fixture.receipt.logs = [];
    const proof = verifyInitializationExecution(fixture);
    assert.equal(proof.kind, 'direct');
    assert.equal(proof.outerDataHash, fixture.step.dataHash);
    assert.deepEqual(proof.addresses, fixture.addresses);
  }
});

test('integrated recovery requires both exact graphs and all five coordinator events',()=>{
  for(const wrapped of [false,true]){
    const fixture=initializationProofFixture({wrapped,integrated:true});
    const result=verifyInitializationExecution(fixture);assert.deepEqual(result.addresses,fixture.addresses);
    if(wrapped)for(const mutate of [f=>f.receipt.logs.pop(),f=>f.record.addresses.BudgetPortfolioVault=addr(99),f=>f.receipt.logs[3].data+='00']){
      const invalid=structuredClone(fixture);mutate(invalid);assert.throws(()=>verifyInitializationExecution(invalid));
    }
  }
});

test('strict wrapped proof binds exact roles, implementations, code hashes and predicted graph to one receipt', () => {
  const fixture = initializationProofFixture();
  const before = structuredClone(fixture);
  const proof = verifyInitializationExecution(fixture);
  assert.equal(proof.kind, 'wrapped');
  assert.equal(proof.coordinator.toLowerCase(), fixture.record.addresses.AtomicDeployment.toLowerCase());
  assert.equal(proof.outerTo.toLowerCase(), fixture.tx.to.toLowerCase());
  assert.equal(proof.outerDataHash, keccak256(fixture.tx.data));
  assert.equal(proof.plannedDataHash, fixture.step.dataHash);
  assert.notEqual(proof.outerDataHash, proof.plannedDataHash);
  assert.deepEqual(proof.addresses, fixture.addresses);
  assert.deepEqual(fixture, before, 'Receipt recognition must not mutate or silently replace the saved intent.');
});

test('receipt-owned ethers logs may omit removed while keeping transaction and block identity mandatory', () => {
  const fixture = initializationProofFixture();
  fixture.receipt.logs.forEach(log => { delete log.removed; });
  assert.equal(verifyInitializationExecution(fixture).kind, 'wrapped');
  fixture.receipt.logs[0].blockHash = hash(999);
  assert.throws(() => verifyInitializationExecution(fixture), /different receipt/);
});

test('wrapped proof cannot use calldata containment alone or spoof coordinator event emitters', () => {
  const cases = [
    ['no logs', f => { f.receipt.logs = []; }],
    ['fake emitter', f => { f.receipt.logs[0].address = addr(30); }],
    ['all events copied from another contract', f => { f.receipt.logs.forEach(log => { log.address = addr(30); }); }],
    ['one event missing', f => { f.receipt.logs.pop(); }],
    ['duplicate event', f => { f.receipt.logs.push({ ...f.receipt.logs[0], index: 33 }); }],
    ['duplicate replaces another event', f => { f.receipt.logs[1] = { ...f.receipt.logs[0], index: 31 }; }],
    ['events reordered', f => { [f.receipt.logs[0], f.receipt.logs[1]] = [f.receipt.logs[1], f.receipt.logs[0]]; }],
    ['calldata unrelated', f => { f.tx.data = '0xcef6d209'; }],
    ['calldata duplicated', f => { f.tx.data += f.inner.slice(2); }],
    ['payload appears only at nibble boundary', f => { f.tx.data = `0x0${f.inner.slice(2)}0`; }],
    ['payload changed', f => { f.tx.data = f.tx.data.replace(f.inner.slice(2), `${f.inner.slice(2, -2)}ff`); }],
    ['direct target with different calldata', f => { f.tx.to = f.receipt.to = f.record.addresses.AtomicDeployment; }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = initializationProofFixture();
    mutate(fixture);
    assert.throws(() => verifyInitializationExecution(fixture), /Initialization proof:/, label);
  }
});

test('wrapped proof rejects every mismatching role, graph, implementation and runtime hash event field', () => {
  for (const eventIndex of [0, 1, 2]) {
    const fixture = initializationProofFixture();
    for (let field = 0; field < fixture.events[eventIndex][1].length; field++) {
      const changed = initializationProofFixture();
      const [name, args] = changed.events[eventIndex];
      args[field] = eventIndex === 1 && field % 2 === 1 ? hash(999) : addr(999);
      Object.assign(changed.receipt.logs[eventIndex], iface.encodeEventLog(iface.getEvent(name), args));
      assert.throws(() => verifyInitializationExecution(changed), /mismatched/, `${name} field ${field}`);
    }
  }
});

test('receipt identity and unique canonical-order log evidence cannot be forged', () => {
  const cases = [
    ['wrong chain', f => { f.tx.chainId = 1n; }],
    ['nonzero value', f => { f.tx.value = 1n; }],
    ['wrong sender', f => { f.tx.from = addr(99); }],
    ['wrong receipt sender', f => { f.receipt.from = addr(99); }],
    ['wrong nonce', f => { f.tx.nonce++; }],
    ['missing saved nonce', f => { delete f.step.nonce; }],
    ['wrong saved tx hash', f => { f.step.txHash = hash(99); }],
    ['wrong receipt hash', f => { f.receipt.hash = hash(99); }],
    ['wrong receipt target', f => { f.receipt.to = addr(99); }],
    ['failed receipt', f => { f.receipt.status = 0; }],
    ['wrong receipt block', f => { f.receipt.blockNumber++; }],
    ['wrong receipt blockhash', f => { f.receipt.blockHash = hash(99); }],
    ['log removed', f => { f.receipt.logs[0].removed = true; }],
    ['log removed flag null', f => { f.receipt.logs[0].removed = null; }],
    ['log removed flag string', f => { f.receipt.logs[0].removed = 'false'; }],
    ['log removed flag numeric', f => { f.receipt.logs[0].removed = 0; }],
    ['log tx hash differs', f => { f.receipt.logs[0].transactionHash = hash(99); }],
    ['log block hash differs', f => { f.receipt.logs[0].blockHash = hash(99); }],
    ['log block number differs', f => { f.receipt.logs[0].blockNumber++; }],
    ['duplicate log index', f => { f.receipt.logs[1].index = f.receipt.logs[0].index; }],
    ['missing log index', f => { delete f.receipt.logs[1].index; }],
    ['noncanonical event data suffix', f => { f.receipt.logs[0].data += '00'; }],
    ['extra event topic', f => { f.receipt.logs[0].topics.push(hash(99)); }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = initializationProofFixture();
    mutate(fixture);
    assert.throws(() => verifyInitializationExecution(fixture), /Initialization proof:/, label);
  }
});

test('wrapped recovery requires matching saved plan and confirmed nonduplicate prerequisites', () => {
  assert.throws(() => verifyInitializationExecution(initializationProofFixture({ mode: 'multisig' })), /only for single-owner/);
  const cases = [
    ['changed planned data hash', f => { f.step.dataHash = hash(99); }],
    ['changed owner', f => { f.record.input.ownerMultisig = addr(99); }],
    ['unsupported mode', f => { f.record.input.governanceMode = 'unexpected'; }],
    ['zero role', f => { f.record.input.operator = addr(0); }],
    ['changed operator', f => { f.record.input.operator = addr(99); }],
    ['changed treasury', f => { f.record.input.treasury = addr(99); }],
  ];
  for (const id of ['AtomicDeployment', 'PoolVault', 'PoolFactory', 'ShareMarket']) {
    cases.push([`unconfirmed ${id}`, f => { f.record.steps.find(step => step.id === id).status = 'submitted'; }]);
    cases.push([`missing ${id}`, f => { f.record.steps = f.record.steps.filter(step => step.id !== id); }]);
    cases.push([`duplicate ${id}`, f => { f.record.steps.push({ ...f.record.steps.find(step => step.id === id) }); }]);
    cases.push([`wrong address ${id}`, f => { f.record.steps.find(step => step.id === id).address = addr(99); }]);
    cases.push([`invalid code hash ${id}`, f => { f.record.steps.find(step => step.id === id).codehash = '0x'; }]);
  }
  for (const [label, mutate] of cases) {
    const fixture = initializationProofFixture();
    mutate(fixture);
    assert.throws(() => verifyInitializationExecution(fixture), /Initialization proof:/, label);
  }
});

test('direct initialization also rejects changed calldata and saved plan mismatches', () => {
  for (const mutate of [
    f => { f.tx.data += '00'; },
    f => { f.step.dataHash = hash(99); },
    f => { f.tx.value = 1n; },
    f => { f.record.addresses.PoolVault = addr(99); },
  ]) {
    const fixture = initializationProofFixture({ wrapped: false });
    mutate(fixture);
    assert.throws(() => verifyInitializationExecution(fixture), /Initialization proof:/);
  }
});
