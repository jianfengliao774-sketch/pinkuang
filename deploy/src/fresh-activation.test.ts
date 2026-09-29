import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AbiCoder, Interface, getAddress, keccak256 } from 'ethers';
import { activationEvidence, activationTransaction, FRESH_ADMIN_ONE, FRESH_ADMIN_TWO, FRESH_GAS_WALLET,
  FreshActivationEngine,
  FRESH_ACTIVATION_STEPS, validatedFreshGasWallet, type FreshActivationRecord } from './fresh-activation';
import { activationCanReconcile, activationCanRequestSignature, activationStepStatusText } from './FreshActivationPanel';
import { artifactDigest, type ArtifactBundle, type DeploymentSnapshot, type Eip1193Provider } from './deployment';
import type { ServerJournal } from './server-journal';

const factory = getAddress('0x1111111111111111111111111111111111111111');
const budget = getAddress('0x2222222222222222222222222222222222222222');
const timelock = getAddress('0x3333333333333333333333333333333333333333');
const authority = getAddress('0x4444444444444444444444444444444444444444');
const hardware = getAddress('0x5555555555555555555555555555555555555555');
const gasWallet = getAddress('0x6666666666666666666666666666666666666666');
const bundle = JSON.parse(readFileSync(new URL('../public/deployment-artifacts.json', import.meta.url), 'utf8')) as ArtifactBundle;
(globalThis as unknown as Record<string, unknown>).__DEPLOYMENT_ARTIFACT_DIGEST__ = artifactDigest(bundle);
const hash = (digit: string) => `0x${digit.repeat(64)}`;
function record(): FreshActivationRecord {
  return { schemaVersion: 1, kind: 'fresh-authority', chainId: 56, account: hardware,
    deploymentId: 'new-graph', genesisArtifactDigest: hash('a'),
    genesis: { factory, portfolioFactory: budget, timelock,
      shareMarket: getAddress('0x7777777777777777777777777777777777777777'),
      portfolioMarket: getAddress('0x8888888888888888888888888888888888888888'), codehash: {} },
    administratorOne: FRESH_ADMIN_ONE, administratorTwo: FRESH_ADMIN_TWO,
    gasWallet, authorityAddress: authority, createdAt: '2026-09-29T00:00:00Z',
    updatedAt: '2026-09-29T00:00:00Z', maxGasBudgetBnb: '0.05',
    gasPriceCapGwei: '3', spentWei: '0', status: 'paused',
    steps: FRESH_ACTIVATION_STEPS.map((id, index) => ({ id, label: id, status: index === 0 ? 'confirmed' : 'waiting' })),
  };
}

test('the truncated screenshot address fails closed; the selected original Gas address is accepted', () => {
  assert.throws(() => validatedFreshGasWallet('0xA285d1933e32b590625aC1F5BEa205Cf2606619', hardware), /42 字符/);
  assert.throws(() => validatedFreshGasWallet(FRESH_ADMIN_ONE, hardware), /不同/);
  assert.throws(() => validatedFreshGasWallet(hardware, hardware), /不同/);
  assert.equal(validatedFreshGasWallet(FRESH_GAS_WALLET, hardware), FRESH_GAS_WALLET);
  assert.equal(validatedFreshGasWallet(gasWallet, hardware), gasWallet);
});

test('the seven transactions bind Authority, both Factories and Timelock with zero BNB value', async () => {
  const saved = record();
  const deploy = await activationTransaction(saved, bundle, 'deployAuthority');
  assert.equal(deploy.to, undefined);
  assert.equal(deploy.value, 0n);
  assert.equal(deploy.gasLimit, 6_000_000n);
  assert.ok(deploy.data.startsWith(bundle.artifacts.PlatformAuthority.bytecode));
  assert.deepEqual(AbiCoder.defaultAbiCoder().decode(['address','address','address','address','address'],
    `0x${deploy.data.slice(bundle.artifacts.PlatformAuthority.bytecode.length)}`).map(String),
  [factory, budget, getAddress(FRESH_ADMIN_ONE), getAddress(FRESH_ADMIN_TWO), gasWallet]);
  const iface = new Interface(bundle.artifacts.PoolFactory.abi);
  for (const [id, target, method, destination] of [
    ['coreOperator',factory,'setOperator',authority], ['coreTreasury',factory,'setTreasury',authority],
    ['budgetOperator',budget,'setOperator',authority], ['budgetTreasury',budget,'setTreasury',authority],
    ['coreOwner',factory,'transferOwnership',timelock], ['budgetOwner',budget,'transferOwnership',timelock],
  ] as const) {
    const tx = await activationTransaction(saved, bundle, id);
    assert.equal(tx.to, target);
    assert.equal(tx.data, iface.encodeFunctionData(method, [destination]));
    assert.equal(tx.value, 0n);
    assert.equal(tx.gasLimit, 150_000n);
  }
});

test('activation proof exports only seven confirmed chain receipts', () => {
  const saved = record();
  assert.throws(() => activationEvidence(saved), /七笔/);
  saved.status = 'complete';
  saved.steps.forEach((step, index) => {
    step.status = 'confirmed'; step.txHash = hash(String(index + 1));
    step.receipt = { blockNumber: 100 + index, blockHash: hash('a'), status: 1,
      gasUsed: '100000', gasPrice: '1000000000', feeWei: '100000000000000' };
  });
  const evidence = activationEvidence(saved);
  assert.deepEqual(evidence.steps.map(step => step.id), [...FRESH_ACTIVATION_STEPS]);
  assert.equal(evidence.authority.address, authority);
  assert.equal(evidence.authority.gasWallet, gasWallet);
  saved.steps[5].receipt!.status = 0;
  assert.throws(() => activationEvidence(saved), /第 6 笔/);
});

test('rejected Stage 2 step stays visible for explicit manual retry', () => {
  assert.equal(activationCanRequestSignature('rejected'), true);
  assert.equal(activationCanRequestSignature('waiting'), true);
  assert.equal(activationCanRequestSignature('uncertain'), false);
  assert.match(activationStepStatusText('rejected'), /手动重试/);
  assert.match(activationStepStatusText('uncertain'), /结果不明/);
});

test('Stage 2 hold disables receipt reconciliation because it must persist its result', () => {
  const ready = { held: false, enabled: true, busy: false, loading: false, recoveryHash: '' };
  assert.equal(activationCanReconcile(ready), true);
  assert.equal(activationCanReconcile({ ...ready, held: true }), false);
  assert.equal(activationCanReconcile({ ...ready, recoveryHash: '0x1234' }), false);
  assert.equal(activationCanReconcile({ ...ready, recoveryHash: hash('a') }), true);
});

test('Stage 2 pre-send outage and explicit 4001 are retryable; nonce drift and ambiguous send are not', async () => {
  let saved = record();
  saved.steps[0].nonce = 4;
  let nonce = 5, walletNonce = 5, sends = 0, artifactOutage = true;
  let walletMode: 'reject' | 'success' | 'ambiguous' | 'invalid-format' | 'invalid-format-drift'
    | 'invalid-format-wrapped' | 'other-format' = 'reject';
  const sentTransactions: Record<string, string>[] = [];
  const wallet: Eip1193Provider = { request: async req => {
    if (req.method !== 'eth_sendTransaction') throw new Error(`Unexpected wallet method ${req.method}`);
    sends++;
    sentTransactions.push((req.params as Record<string, string>[])[0]);
    if (walletMode === 'reject') throw Object.assign(new Error('user rejected'), { code: 4001 });
    if (walletMode === 'ambiguous') throw new Error('response lost after broadcast');
    if (walletMode === 'invalid-format-drift') walletNonce = 6;
    if (walletMode === 'invalid-format' || walletMode === 'invalid-format-drift') throw new Error('Invalid transaction envelope type: specified type "0x4" but included a gasPrice instead of maxFeePerGas and maxPriorityFeePerGas');
    if (walletMode === 'invalid-format-wrapped') throw Object.assign(new Error('wallet RPC failed'),
      { info: { error: { message: 'Invalid transaction envelope type: specified type 0x4 but included a gasPrice instead of maxFeePerGas and maxPriorityFeePerGas' } } });
    if (walletMode === 'other-format') throw new Error('Invalid transaction envelope type: gasPrice field is malformed');
    return hash('a');
  } };
  const journal = {
    loadFreshActivation: async () => structuredClone(saved),
    saveFreshActivation: async (next: FreshActivationRecord) => { saved = structuredClone(next); },
    freshActivationCredentialStatus: async () => ({ credentialVerified: true, gasWallet }),
    assertCurrentArtifact: async () => { if (artifactOutage) throw new Error('artifact unavailable'); },
    readCurrentNonce: async () => ({ latest: nonce, pending: nonce }),
  } as unknown as ServerJournal;
  const genesis = { id: saved.deploymentId, account: hardware, kind: 'integrated-v2', status: 'complete',
    input: { ownerMultisig: hardware, operator: hardware, treasury: hardware } } as DeploymentSnapshot;
  const engine = new FreshActivationEngine(wallet, bundle, journal, genesis);
  const internals = engine as unknown as {
    exclusive: (action: () => Promise<unknown>) => Promise<unknown>;
    latest: () => Promise<FreshActivationRecord>;
    verifyPinnedState: () => Promise<unknown>;
    account: () => Promise<string>;
    provider: Record<string, (...args: unknown[]) => Promise<unknown>>;
  };
  internals.exclusive = action => action(); // Node has no browser Web Locks; the engine's busy guard is tested elsewhere.
  internals.latest = async () => structuredClone(saved);
  internals.verifyPinnedState = async () => ({ number: 100, hash: hash('b') });
  internals.account = async () => hardware;
  internals.provider = {
    getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
    getBalance: async () => 1_000_000_000_000_000_000n,
    getBlock: async () => ({ gasLimit: 30_000_000n }),
    getTransactionCount: async () => walletNonce,
  };
  await assert.rejects(engine.sendNext(saved), /artifact unavailable/);
  assert.equal(saved.steps[1].status, 'rejected');
  assert.equal(saved.steps[1].rejectionKind, 'pre-send');
  assert.equal(sends, 0);
  nonce = 6; artifactOutage = false;
  await assert.rejects(engine.sendNext(saved), /nonce 或交易内容已变化/);
  assert.equal(saved.steps[1].status, 'rejected');
  assert.equal(sends, 0);
  nonce = 5;
  await assert.rejects(engine.sendNext(saved), /user rejected/);
  assert.equal(saved.steps[1].status, 'rejected');
  assert.equal(saved.steps[1].rejectionKind, 'wallet-rejected');
  assert.equal(sends, 1);
  walletMode = 'success';
  const submitted = await engine.sendNext(saved);
  assert.equal(submitted.steps[1].status, 'submitted');
  assert.equal(submitted.steps[1].txHash, hash('a'));
  const submittedTransaction = sentTransactions.at(-1)!;
  assert.equal(submittedTransaction.type, '0x2');
  assert.equal(submittedTransaction.maxFeePerGas, '0x3b9aca00');
  assert.equal(submittedTransaction.maxPriorityFeePerGas, '0x3b9aca00');
  assert.equal(Object.hasOwn(submittedTransaction, 'gasPrice'), false);
  saved = record(); saved.steps[0].nonce = 4;
  walletMode = 'ambiguous';
  await assert.rejects(engine.sendNext(saved), /response lost/);
  assert.equal(saved.steps[1].status, 'uncertain');
  assert.equal(sends, 3);
  await assert.rejects(engine.sendNext(saved), /只可核验/);
  assert.equal(sends, 3);

  // The exact wallet-side format error is classified as unsent only when both
  // the independent node and wallet still report the original unused nonce.
  saved = record(); saved.steps[0].nonce = 4;
  walletMode = 'invalid-format';
  await assert.rejects(engine.sendNext(saved), /Invalid transaction envelope type/);
  assert.equal(saved.steps[1].status, 'rejected');
  assert.equal(saved.steps[1].rejectionKind, 'pre-send');
  assert.equal(sends, 4);

  saved = record(); saved.steps[0].nonce = 4;
  walletMode = 'invalid-format-drift';
  await assert.rejects(engine.sendNext(saved), /Invalid transaction envelope type/);
  assert.equal(saved.steps[1].status, 'uncertain');
  await assert.rejects(engine.sendNext(saved), /只可核验/);
  assert.equal(sends, 5);

  walletNonce = 5;
  saved = record(); saved.steps[0].nonce = 4;
  walletMode = 'invalid-format-wrapped';
  await assert.rejects(engine.sendNext(saved), /wallet RPC failed/);
  assert.equal(saved.steps[1].status, 'rejected');
  saved = record(); saved.steps[0].nonce = 4;
  walletMode = 'other-format';
  await assert.rejects(engine.sendNext(saved), /gasPrice field is malformed/);
  assert.equal(saved.steps[1].status, 'uncertain');
});

test('hashless Stage 2 signing resumes only after both nonce witnesses; retry keeps the original intent', async () => {
  let saved = record(); saved.genesisArtifactDigest = artifactDigest(bundle);
  saved.steps[0].nonce = 4;
  const planned = await activationTransaction(saved, bundle, 'coreOperator');
  saved.steps[1] = { id: 'coreOperator', label: 'coreOperator', status: 'signing', nonce: 5,
    dataHash: keccak256(planned.data), gasLimit: planned.gasLimit.toString(),
    gasPriceWei: '1000000000', maxFeeWei: '150000000000000' };
  let serverPending = 6, walletPending = 5, releases = 0;
  const sent: Record<string, string>[] = [];
  const wallet: Eip1193Provider = { request: async req => {
    if (req.method !== 'eth_sendTransaction') throw new Error(`Unexpected wallet method ${req.method}`);
    sent.push((req.params as Record<string, string>[])[0]);
    return hash('c');
  } };
  const journal = {
    loadFreshActivation: async () => structuredClone(saved),
    saveFreshActivation: async (next: FreshActivationRecord) => { saved = structuredClone(next); },
    freshActivationCredentialStatus: async () => ({ credentialVerified: true, gasWallet }),
    assertCurrentArtifact: async () => {},
    readCurrentNonce: async () => ({ latest: 5, pending: serverPending }),
    releaseUnusedFreshSigning: async (id: string, nonce: number, dataHash: string) => {
      releases++;
      assert.equal(id, 'coreOperator'); assert.equal(nonce, 5);
      assert.equal(dataHash, saved.steps[1].dataHash);
      saved.steps[1].status = 'rejected'; saved.steps[1].rejectionKind = 'nonce-witnessed';
      return structuredClone(saved);
    },
  } as unknown as ServerJournal;
  const genesis = { id: saved.deploymentId, account: hardware, kind: 'integrated-v2', status: 'complete',
    input: { ownerMultisig: hardware, operator: hardware, treasury: hardware } } as DeploymentSnapshot;
  const engine = new FreshActivationEngine(wallet, bundle, journal, genesis);
  const internals = engine as unknown as {
    exclusive: (action: () => Promise<unknown>) => Promise<unknown>;
    verifyPinnedState: () => Promise<unknown>; account: () => Promise<string>;
    provider: Record<string, (...args: unknown[]) => Promise<unknown>>;
  };
  internals.exclusive = action => action();
  internals.verifyPinnedState = async () => ({ number: 100, hash: hash('b') });
  internals.account = async () => hardware;
  internals.provider = {
    getTransactionCount: async (_account: unknown, tag: unknown) => tag === 'pending' ? walletPending : 5,
    getFeeData: async () => ({ gasPrice: 2_000_000_000n }),
    getBalance: async () => 1_000_000_000_000_000_000n,
    getBlock: async () => ({ gasLimit: 30_000_000n }),
  };
  await assert.rejects(engine.releaseUnusedSigning(saved), /nonce 已变化/);
  assert.equal(releases, 0);
  serverPending = 5; walletPending = 6;
  await assert.rejects(engine.releaseUnusedSigning(saved), /nonce 已变化/);
  assert.equal(releases, 0);
  walletPending = 5;
  saved.steps[1].dataHash = hash('d');
  await assert.rejects(engine.releaseUnusedSigning(saved), /交易内容或 Gas 字段/);
  assert.equal(releases, 0);
  saved.steps[1].dataHash = keccak256(planned.data);
  genesis.input.operator = gasWallet;
  await assert.rejects(engine.releaseUnusedSigning(saved), /部署角色或管理员地址/);
  assert.equal(releases, 0);
  genesis.input.operator = hardware;
  const released = await engine.releaseUnusedSigning(saved);
  assert.equal(released.steps[1].status, 'rejected');
  assert.equal(released.steps[1].rejectionKind, 'nonce-witnessed');
  assert.equal(sent.length, 0, 'nonce recovery does not call the wallet signer');
  assert.equal(releases, 1);
  const submitted = await engine.sendNext(released);
  assert.equal(submitted.steps[1].status, 'submitted');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, hardware);
  assert.equal(sent[0].to, factory);
  assert.equal(sent[0].nonce, '0x5');
  assert.equal(sent[0].data, planned.data);
  assert.equal(sent[0].maxFeePerGas, '0x3b9aca00');
  assert.equal(sent[0].maxPriorityFeePerGas, '0x3b9aca00');
});

test('restored Stage 2 roles and both administrator addresses are pinned before wallet signing', async () => {
  const original = record();
  original.genesisArtifactDigest = artifactDigest(bundle);
  let saved = structuredClone(original), sends = 0;
  const wallet: Eip1193Provider = { request: async request => {
    if (request.method === 'eth_sendTransaction') sends++;
    throw new Error(`Unexpected wallet method ${request.method}`);
  } };
  const journal = { loadFreshActivation: async () => structuredClone(saved) } as unknown as ServerJournal;
  const genesis = { id: original.deploymentId, account: hardware, kind: 'integrated-v2', status: 'complete',
    input: { ownerMultisig: hardware, operator: hardware, treasury: hardware } } as DeploymentSnapshot;
  const engine = new FreshActivationEngine(wallet, bundle, journal, genesis);
  const internals = engine as unknown as { exclusive: (action: () => Promise<unknown>) => Promise<unknown> };
  internals.exclusive = action => action();
  for (const role of ['operator', 'treasury'] as const) {
    genesis.input[role] = gasWallet;
    await assert.rejects(engine.sendNext(saved), /恢复的部署角色或管理员地址/);
    genesis.input[role] = hardware;
    assert.equal(sends, 0);
  }
  for (const administrator of ['administratorOne', 'administratorTwo'] as const) {
    saved = structuredClone(original);
    saved[administrator] = gasWallet;
    await assert.rejects(engine.sendNext(saved), /恢复的部署角色或管理员地址/);
    assert.equal(sends, 0);
  }
});

test('a finalized third-step failure requires a separate same-action, new-nonce hardware confirmation', async () => {
  let saved = record();
  saved.genesisArtifactDigest = artifactDigest(bundle);
  saved.status = 'aborted';
  saved.steps[0].nonce = 0;
  saved.steps[1] = { id: 'coreOperator', label: 'coreOperator', status: 'confirmed', nonce: 1 };
  const original = await activationTransaction(saved, bundle, 'coreTreasury');
  const fee = '100000000000000';
  saved.steps[2] = { id: 'coreTreasury', label: 'coreTreasury', status: 'failed', nonce: 8,
    dataHash: keccak256(original.data), txHash: hash('a'), gasLimit: original.gasLimit.toString(),
    gasPriceWei: '1000000000', maxFeeWei: '150000000000000',
    receipt: { blockNumber: 120, blockHash: hash('b'), status: 0,
      gasUsed: '100000', gasPrice: '1000000000', feeWei: fee } };
  saved.spentWei = fee;
  let recoveries = 0;
  const sent: Record<string, string>[] = [];
  const wallet: Eip1193Provider = { request: async request => {
    if (request.method !== 'eth_sendTransaction') throw new Error(`Unexpected wallet method ${request.method}`);
    sent.push((request.params as Record<string, string>[])[0]);
    return hash('c');
  } };
  const journal = {
    loadFreshActivation: async () => structuredClone(saved),
    saveFreshActivation: async (next: FreshActivationRecord) => { saved = structuredClone(next); },
    readCurrentNonce: async () => ({ latest: 9, pending: 9 }),
    freshActivationCredentialStatus: async () => ({ credentialVerified: true, gasWallet }),
    assertCurrentArtifact: async () => {},
    recoverFinalizedFreshAttempt: async (id: string, nonce: number, winnerHash: string) => {
      recoveries++;
      assert.equal(id, 'coreTreasury'); assert.equal(nonce, 8); assert.equal(winnerHash, hash('a'));
      const failed = structuredClone(saved.steps[2]);
      saved.steps[2] = { id: 'coreTreasury', label: 'coreTreasury', status: 'waiting',
        attempts: [{ ...failed, status: 'failed', nonce: 8,
          dataHash: failed.dataHash!, receipt: failed.receipt!,
          recovery: { winnerHash, finalizedBlockNumber: 125,
          finalizedBlockHash: hash('d') } }] };
      saved.status = 'paused';
      return structuredClone(saved);
    },
  } as unknown as ServerJournal;
  const genesis = { id: saved.deploymentId, account: hardware, kind: 'integrated-v2', status: 'complete',
    input: { ownerMultisig: hardware, operator: hardware, treasury: hardware } } as DeploymentSnapshot;
  const engine = new FreshActivationEngine(wallet, bundle, journal, genesis);
  const internals = engine as unknown as {
    exclusive: (action: () => Promise<unknown>) => Promise<unknown>;
    verifyPinnedState: () => Promise<unknown>;
    finalizedReceipt: () => Promise<unknown>;
    proveAncestor: () => Promise<void>;
    account: () => Promise<string>;
    provider: Record<string, (...args: unknown[]) => Promise<unknown>>;
  };
  internals.exclusive = action => action();
  internals.account = async () => hardware;
  internals.verifyPinnedState = async () => ({ number: 125, hash: hash('d') });
  internals.proveAncestor = async () => {};
  internals.finalizedReceipt = async () => ({ hash: hash('a'), from: hardware,
    blockNumber: 120, blockHash: hash('b'), status: 0, gasUsed: 100000n,
    gasPrice: 1000000000n, fee: 100000000000000n });
  internals.provider = {
    getTransaction: async () => ({ hash: hash('a'), chainId: 56n, from: hardware,
      nonce: 8, blockNumber: 120, blockHash: hash('b'),
      to: factory, data: original.data, value: 0n }),
    getTransactionCount: async () => 9,
    getFeeData: async () => ({ gasPrice: 1000000000n }),
    getBalance: async () => 1_000_000_000_000_000_000n,
    getBlock: async (height: unknown) => ({ number: height === 120 ? 120 : 125,
      hash: height === 120 ? hash('b') : hash('d'), gasLimit: 30_000_000n }),
  };
  const recovered = await engine.recoverFinalizedAttempt(saved);
  assert.equal(recoveries, 1);
  assert.equal(sent.length, 0, 'recovery must not ask the wallet to send');
  assert.equal(recovered.steps[2].attempts?.[0].receipt.feeWei, fee);
  const submitted = await engine.sendNext(recovered);
  assert.equal(submitted.steps[2].status, 'submitted');
  assert.equal(submitted.spentWei, fee, 'the failed attempt remains in the Gas budget');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].nonce, '0x9');
  assert.equal(sent[0].to, factory);
  assert.equal(sent[0].data, original.data);
});

test('browser ancestry proof crosses a long pause without trusting a skipped header', async () => {
  const wallet: Eip1193Provider = { request: async () => { throw new Error('wallet must not be used'); } };
  const engine = new FreshActivationEngine(wallet, bundle, {} as ServerJournal, {} as DeploymentSnapshot);
  const internals = engine as unknown as {
    provider: { getBlock: (height: number) => Promise<{ number: number; hash: string; parentHash: string }> };
    proveAncestor: (number: number, hash: string, descendant: { number: number; hash: string }) => Promise<void>;
  };
  const blockHash = (height: number) => height === 120 ? hash('d')
    : `0x${height.toString(16).padStart(64, '0')}`;
  let broken = false;
  internals.provider = { getBlock: async height => ({ number: height, hash: blockHash(height),
    parentHash: broken && height === 125 ? hash('e') : blockHash(height - 1) }) };
  await internals.proveAncestor(120, hash('d'), { number: 4220, hash: blockHash(4220) });
  broken = true;
  await assert.rejects(internals.proveAncestor(120, hash('d'),
    { number: 4220, hash: blockHash(4220) }), /不在同一条最终确认链/);
});

test('browser checks an old finalized receipt by canonical height without scanning a million blocks', async () => {
  const wallet: Eip1193Provider = { request: async () => { throw new Error('wallet must not be used'); } };
  const engine = new FreshActivationEngine(wallet, bundle, {} as ServerJournal, {} as DeploymentSnapshot);
  const internals = engine as unknown as {
    provider: { getBlock: (height: number) => Promise<{ number: number; hash: string }> };
    requireCanonicalFinalizedBlock: (number: number, hash: string,
      finalized: { number: number; hash: string }) => Promise<void>;
  };
  let reads = 0;
  internals.provider = { getBlock: async height => { reads++; return { number: height, hash: hash('d') }; } };
  const finalized = { number: 1_100_120, hash: hash('e') };
  await internals.requireCanonicalFinalizedBlock(120, hash('d'), finalized);
  assert.equal(reads, 1);
  await assert.rejects(internals.requireCanonicalFinalizedBlock(120, hash('a'), finalized),
    /不在当前最终确认链/);
  await assert.rejects(internals.requireCanonicalFinalizedBlock(finalized.number + 1, hash('d'), finalized),
    /尚未最终确认/);
});
