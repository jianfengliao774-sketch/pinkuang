import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { Interface, getCreateAddress, keccak256 } from 'ethers';
import { verifyCompletedDeployment } from './journal-api.mjs';
import { servedArtifactDigest } from './artifact-digest.mjs';
import { INITIALIZATION_PROOF_ABI } from '../shared/initialization-proof.mjs';

// Pure provider fixtures keep the archive proof runnable on Windows without
// weakening the production journal's private-directory requirements.
const account = `0x${'1'.repeat(40)}`;
const hex = n => `0x${n.toString(16).padStart(64, '0')}`;
const distArtifactUrl = new URL('../dist/deployment-artifacts.json', import.meta.url);
const artifactUrl = existsSync(distArtifactUrl) ? distArtifactUrl : new URL('../public/deployment-artifacts.json', import.meta.url);
const trustedArtifactBundle = JSON.parse(readFileSync(artifactUrl, 'utf8'));

function completedProof() {
  const ids = ['PoolFunds', 'PurchaseValidation', 'FlexiblePurchase', 'MiningOperations',
    'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints',
    'AtomicDeployment', 'PoolVault', 'PoolFactory', 'ShareMarket', 'initialize'];
  const record = { status: 'complete', account, steps: [], addresses: {}, spentWei: '0',
    verification: { checks: [{ label: 'graph', passed: true }], code: {} } };
  const transactions = new Map(), receipts = new Map(), blocks = new Map();
  for (const [index, id] of ids.entries()) {
    const nonce = 10 + index, blockNumber = 100 + index;
    const hash = hex(1000 + index), blockHash = hex(2000 + index);
    const data = `0x60${(index + 1).toString(16).padStart(2, '0')}`;
    const address = id === 'initialize' ? null : getCreateAddress({ from: account, nonce });
    const to = id === 'initialize' ? record.addresses.AtomicDeployment : null;
    const receipt = { hash, from: account, to, blockNumber, blockHash, index: 0, status: 1,
      contractAddress: address, gasUsed: 21_000n, gasPrice: 1n, fee: 21_000n };
    transactions.set(hash, { hash, chainId: 56n, from: account, nonce, blockNumber, blockHash, index: 0, to, data, value: 0n });
    receipts.set(hash, receipt);
    blocks.set(blockNumber, blockHash);
    record.steps.push({ id, status: 'confirmed', nonce, txHash: hash, dataHash: keccak256(data),
      receipt: { blockNumber, blockHash, status: 1, gasUsed: '21000', gasPrice: '1', feeWei: '21000' },
      ...(address ? { address, codehash: hex(3000 + index) } : {}) });
    if (address) {
      record.addresses[id] = address;
      record.verification.code[id] = { address, codehash: hex(3000 + index) };
    }
  }
  record.spentWei = (21_000n * BigInt(ids.length)).toString();
  const provider = {
    send: async () => '0x38',
    getTransaction: async hash => transactions.get(hash) ?? null,
    getTransactionReceipt: async hash => receipts.get(hash) ?? null,
    getTransactionCount: async () => 23,
    getBlock: async tag => tag === 'latest' ? { number: 121, hash: hex(2121) }
      : tag === 'finalized' || tag === 120 ? { number: 120, hash: hex(2120) }
        : blocks.has(tag) ? { number: tag, hash: blocks.get(tag),
          transactions: [...transactions.values()].filter(tx => tx.blockNumber === tag).map(tx => tx.hash) } : null,
  };
  return { record, provider, transactions, receipts, blocks };
}

function accelerate(proof, index = 5) {
  const step = proof.record.steps[index], oldHash = step.txHash;
  const winnerHash = hex(9000 + index), original = proof.transactions.get(oldHash);
  proof.transactions.set(oldHash, { ...original, blockNumber: null, blockHash: null });
  proof.transactions.set(winnerHash, { ...original, hash: winnerHash });
  const receipt = { ...proof.receipts.get(oldHash), hash: winnerHash, gasPrice: 2n, fee: 42_000n };
  proof.receipts.delete(oldHash);
  proof.receipts.set(winnerHash, receipt);
  step.previousTxHashes = [oldHash];
  step.finalizedRecovery = true;
  step.txHash = winnerHash;
  step.receipt = { ...step.receipt, gasPrice: '2', feeWei: '42000' };
  proof.record.spentWei = (BigInt(proof.record.spentWei) + 21_000n).toString();
  return { step, oldHash, winnerHash };
}

function wrappedProof() {
  const proof = completedProof();
  const { record, transactions, receipts, provider } = proof;
  record.input = { governanceMode: 'single', ownerMultisig: account, operator: account, treasury: account };
  record.artifactDigest = servedArtifactDigest(artifactUrl);
  const coordinatorStep = record.steps.find(step => step.id === 'AtomicDeployment');
  const coordinator = coordinatorStep.address;
  const trusted = trustedArtifactBundle.artifacts.AtomicDeployment;
  transactions.get(coordinatorStep.txHash).data = trusted.bytecode;
  coordinatorStep.dataHash = keccak256(trusted.bytecode);
  const runtime = '0x60016000';
  coordinatorStep.codehash = keccak256(runtime);
  record.verification.code.AtomicDeployment.codehash = coordinatorStep.codehash;
  const step = record.steps.at(-1), tx = transactions.get(step.txHash), receipt = receipts.get(step.txHash);
  const iface = new Interface(INITIALIZATION_PROOF_ABI);
  const config = [account, account, account, record.addresses.PoolVault, record.addresses.PoolFactory, record.addresses.ShareMarket];
  const planned = iface.encodeFunctionData('deploySingleOwner', [config]);
  step.dataHash = keccak256(planned);
  tx.data = `0xdeadbeef${planned.slice(2)}00`;
  tx.to = receipt.to = `0x${'9'.repeat(40)}`;
  const factory = getCreateAddress({ from: coordinator, nonce: 3 });
  const addresses = { timelock: getCreateAddress({ from: coordinator, nonce: 1 }),
    beacon: getCreateAddress({ from: coordinator, nonce: 2 }), factory,
    shareMarket: getCreateAddress({ from: factory, nonce: 2 }) };
  const events = [
    ['DeploymentCompleted', [factory, addresses.beacon, addresses.shareMarket, addresses.timelock, account, account, account]],
    ['ImplementationsRecorded', ['PoolVault', 'PoolFactory', 'ShareMarket'].flatMap(id =>
      [record.addresses[id], record.steps.find(item => item.id === id).codehash])],
    ['SingleOwnerDeployment', [account, factory]],
  ];
  receipt.logs = events.map(([name, values], index) => ({
    ...iface.encodeEventLog(iface.getEvent(name), values), address: coordinator, removed: false,
    transactionHash: tx.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, index,
  }));
  provider.getCode = async address => { assert.equal(address.toLowerCase(), coordinator.toLowerCase()); return runtime; };
  const coordinatorInterface = new Interface(trusted.abi);
  provider.call = async request => {
    assert.equal(request.to.toLowerCase(), coordinator.toLowerCase());
    const name = coordinatorInterface.parseTransaction(request).name;
    const values = { deployer: [account], deployed: [true], predictedFactory: [factory],
      deployment: [addresses.timelock, addresses.beacon, factory, addresses.shareMarket] };
    return coordinatorInterface.encodeFunctionResult(name, values[name]);
  };
  return { ...proof, tx, receipt, step, coordinator, coordinatorStep, coordinatorInterface };
}

test('completed archive verifies the original finalized deployment', async () => {
  const proof = completedProof();
  await verifyCompletedDeployment(proof.provider, proof.record);
});

test('completed archive accepts same-intent acceleration for creation and initialization and preserves history', async () => {
  for (const index of [5, 12]) {
    for (const nodeRetainsOriginal of [true, false]) {
      const proof = completedProof();
      const { oldHash } = accelerate(proof, index);
      if (!nodeRetainsOriginal) proof.transactions.delete(oldHash);
      const originalRecord = structuredClone(proof.record);
      await verifyCompletedDeployment(proof.provider, proof.record);
      assert.deepEqual(proof.record, originalRecord, 'Verification must preserve every original hash and fee.');
    }
  }
});

test('acceleration history cannot forge a known transaction identity or payload', async () => {
  const variants = [
    ['hash', tx => { tx.hash = hex(99999); }],
    ['chain', tx => { tx.chainId = 1n; }],
    ['sender', tx => { tx.from = `0x${'2'.repeat(40)}`; }],
    ['nonce', tx => { tx.nonce++; }],
    ['target', tx => { tx.to = account; }],
    ['value', tx => { tx.value = 1n; }],
    ['calldata', tx => { tx.data = '0x'; }],
  ];
  for (const [label, mutate] of variants) {
    const proof = completedProof();
    const { oldHash } = accelerate(proof);
    mutate(proof.transactions.get(oldHash));
    await assert.rejects(verifyCompletedDeployment(proof.provider, proof.record),
      /acceleration history differs/, label);
  }
});

test('acceleration history must be bounded, valid, unique and marked as recovered', async () => {
  const variants = [
    ['missing recovery marker', (proof, step) => { delete step.finalizedRecovery; }],
    ['nonboolean recovery marker', (proof, step) => { step.finalizedRecovery = 'true'; }],
    ['not an array', (proof, step) => { step.previousTxHashes = step.previousTxHashes[0]; }],
    ['null', (proof, step) => { step.previousTxHashes = null; }],
    ['invalid hash', (proof, step) => { step.previousTxHashes = ['0xnot-a-hash']; }],
    ['current winner', (proof, step) => { step.previousTxHashes = [step.txHash]; }],
    ['another step', (proof, step) => { step.previousTxHashes = [proof.record.steps[0].txHash]; }],
    ['duplicate', (proof, step) => { step.previousTxHashes.push(step.previousTxHashes[0]); }],
    ['oversized', (proof, step) => { step.previousTxHashes = Array.from({ length: 17 }, (_, i) => hex(20000 + i)); }],
  ];
  for (const [label, mutate] of variants) {
    const proof = completedProof();
    const { step } = accelerate(proof);
    mutate(proof, step);
    await assert.rejects(verifyCompletedDeployment(proof.provider, proof.record), /invalid acceleration history/, label);
  }
});

test('history never substitutes for the finalized winning transaction and receipt', async () => {
  const variants = [
    ['missing winner', (proof, step) => { proof.transactions.delete(step.txHash); }],
    ['wrong winner nonce', (proof, step) => { proof.transactions.get(step.txHash).nonce++; }],
    ['wrong planned calldata', (proof, step) => { step.dataHash = keccak256('0x6000'); }],
    ['wrong receipt', (proof, step) => { step.receipt.gasPrice = '1'; }],
    ['wrong gas total', proof => { proof.record.spentWei = '0'; }],
    ['wrong contract identity', (proof, step) => { step.address = account; }],
    ['replaced payload', (proof, step) => { step.replacementHash = hex(8000); }],
    ['unfinalized winner', proof => {
      const getBlock = proof.provider.getBlock;
      proof.provider.getBlock = async tag => tag === 'finalized' ? { number: 104, hash: hex(2104) } : getBlock(tag);
    }],
    ['changed finalized anchor', proof => {
      const getBlock = proof.provider.getBlock;
      proof.provider.getBlock = async tag => tag === 120 ? { number: 120, hash: hex(5000) } : getBlock(tag);
    }],
  ];
  for (const [label, mutate] of variants) {
    const proof = completedProof();
    const { step } = accelerate(proof);
    mutate(proof, step);
    await assert.rejects(verifyCompletedDeployment(proof.provider, proof.record), { status: 409 }, label);
  }
});

test('a history RPC failure keeps the deployment locked instead of treating it as a dropped transaction', async () => {
  const proof = completedProof();
  const { oldHash } = accelerate(proof);
  const getTransaction = proof.provider.getTransaction;
  proof.provider.getTransaction = async hash => {
    if (hash === oldHash) throw new Error('RPC unavailable');
    return getTransaction(hash);
  };
  await assert.rejects(verifyCompletedDeployment(proof.provider, proof.record), { status: 503 });
});

test('completed archive proves canonical inclusion without historical account state', async () => {
  const proof = completedProof();
  proof.provider.getTransactionCount = async () => { throw new Error('missing trie node'); };
  await verifyCompletedDeployment(proof.provider, proof.record);
  for (const [label, mutation] of [
    ['receipt index differs', p => { p.receipts.get(p.record.steps[0].txHash).index = 1; }],
    ['transaction index differs', p => { p.transactions.get(p.record.steps[0].txHash).index = 1; }],
    ['canonical transaction absent', p => {
      const getBlock = p.provider.getBlock;
      p.provider.getBlock = async tag => tag === 100 ? { number: 100, hash: p.blocks.get(100), transactions: [] } : getBlock(tag);
    }],
    ['canonical wrong transaction', p => {
      const getBlock = p.provider.getBlock;
      p.provider.getBlock = async tag => tag === 100
        ? { number: 100, hash: p.blocks.get(100), transactions: [hex(8888)] } : getBlock(tag);
    }],
  ]) {
    const candidate = completedProof();
    mutation(candidate);
    await assert.rejects(verifyCompletedDeployment(candidate.provider, candidate.record), { status: 409 }, label);
  }
});

test('wrapped initialization archive authenticates the trusted coordinator and preserves outer transaction evidence', async () => {
  const proof = wrappedProof();
  proof.provider.getTransactionCount = async () => { throw new Error('missing trie node'); };
  const original = structuredClone(proof.record);
  await verifyCompletedDeployment(proof.provider, proof.record, { trustedArtifactBundle });
  assert.deepEqual(proof.record, original);
  assert.notEqual(keccak256(proof.tx.data), proof.step.dataHash, 'The inner planned hash must never be overwritten with the wrapper hash.');
});

test('wrapped initialization refuses forged envelopes, events, trusted creation identity and runtime state', async () => {
  const variants = [
    ['outer sender', p => { p.tx.from = `0x${'8'.repeat(40)}`; }],
    ['outer nonce', p => { p.tx.nonce++; }],
    ['outer value', p => { p.tx.value = 1n; }],
    ['missing events', p => { p.receipt.logs = []; }],
    ['forged emitter', p => { p.receipt.logs[0].address = p.tx.to; }],
    ['unbound artifact digest', p => { p.record.artifactDigest = hex(9); }],
    ['forged creation calldata', p => {
      p.transactions.get(p.coordinatorStep.txHash).data = '0x6000';
      p.coordinatorStep.dataHash = keccak256('0x6000');
    }],
    ['wrong runtime', p => { p.provider.getCode = async () => '0x6002'; }],
    ['missing runtime', p => { p.provider.getCode = async () => '0x'; }],
    ['not deployed', p => {
      const call = p.provider.call;
      p.provider.call = async request => p.coordinatorInterface.parseTransaction(request).name === 'deployed'
        ? p.coordinatorInterface.encodeFunctionResult('deployed', [false]) : call(request);
    }],
    ['wrong deployer', p => {
      const call = p.provider.call;
      p.provider.call = async request => p.coordinatorInterface.parseTransaction(request).name === 'deployer'
        ? p.coordinatorInterface.encodeFunctionResult('deployer', [p.tx.to]) : call(request);
    }],
    ['wrong deployment graph', p => {
      const call = p.provider.call;
      p.provider.call = async request => p.coordinatorInterface.parseTransaction(request).name === 'deployment'
        ? p.coordinatorInterface.encodeFunctionResult('deployment', [account, account, account, account]) : call(request);
    }],
    ['changed finalized block', p => {
      const getBlock = p.provider.getBlock;
      p.provider.getBlock = async tag => tag === 120 ? { number: 120, hash: hex(6666) } : getBlock(tag);
    }],
  ];
  for (const [label, mutate] of variants) {
    const proof = wrappedProof();
    mutate(proof);
    await assert.rejects(verifyCompletedDeployment(proof.provider, proof.record, { trustedArtifactBundle }), { status: 409 }, label);
  }
  const proof = wrappedProof();
  proof.provider.call = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(verifyCompletedDeployment(proof.provider, proof.record, { trustedArtifactBundle }), { status: 503 });
});
