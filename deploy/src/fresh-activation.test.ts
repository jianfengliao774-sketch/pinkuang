import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AbiCoder, Interface, getAddress } from 'ethers';
import { activationEvidence, activationTransaction, FRESH_ADMIN_ONE, FRESH_ADMIN_TWO,
  FreshActivationEngine,
  FRESH_ACTIVATION_STEPS, validatedFreshGasWallet, type FreshActivationRecord } from './fresh-activation';
import { activationCanRequestSignature, activationStepStatusText } from './FreshActivationPanel';
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

test('the truncated screenshot address fails closed; only a distinct complete public Gas address is accepted', () => {
  assert.throws(() => validatedFreshGasWallet('0xA285d1933e32b590625aC1F5BEa205Cf2606619', hardware), /42 字符/);
  assert.throws(() => validatedFreshGasWallet(FRESH_ADMIN_ONE, hardware), /不同/);
  assert.throws(() => validatedFreshGasWallet(hardware, hardware), /不同/);
  assert.throws(() => validatedFreshGasWallet('0xA285d1933e32b5990625aC1F5BEa205Cf2606619', hardware), /旧版 Gas 钱包/);
  assert.equal(validatedFreshGasWallet(gasWallet, hardware), gasWallet);
});

test('the seven transactions bind Authority, both Factories and Timelock with zero BNB value', async () => {
  const saved = record();
  const deploy = await activationTransaction(saved, bundle, 'deployAuthority');
  assert.equal(deploy.to, undefined);
  assert.equal(deploy.value, 0n);
  assert.equal(deploy.gasLimit, 4_000_000n);
  assert.ok(deploy.data.startsWith(bundle.artifacts.PlatformAuthority.bytecode));
  assert.deepEqual(AbiCoder.defaultAbiCoder().decode(['address','address','address','address','address'],
    `0x${deploy.data.slice(bundle.artifacts.PlatformAuthority.bytecode.length)}`).map(String),
  [factory, budget, FRESH_ADMIN_ONE, FRESH_ADMIN_TWO, gasWallet]);
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

test('Stage 2 pre-send outage and explicit 4001 are retryable; nonce drift and ambiguous send are not', async () => {
  let saved = record();
  saved.steps[0].nonce = 4;
  let nonce = 5, walletNonce = 5, sends = 0, artifactOutage = true;
  let walletMode: 'reject' | 'success' | 'ambiguous' | 'invalid-format' | 'invalid-format-drift' = 'reject';
  const sentTransactions: Record<string, string>[] = [];
  const wallet: Eip1193Provider = { request: async req => {
    if (req.method !== 'eth_sendTransaction') throw new Error(`Unexpected wallet method ${req.method}`);
    sends++;
    sentTransactions.push((req.params as Record<string, string>[])[0]);
    if (walletMode === 'reject') throw Object.assign(new Error('user rejected'), { code: 4001 });
    if (walletMode === 'ambiguous') throw new Error('response lost after broadcast');
    if (walletMode === 'invalid-format-drift') walletNonce = 6;
    if (walletMode === 'invalid-format' || walletMode === 'invalid-format-drift') throw new Error('Invalid transaction envelope type: specified type "0x4" but included a gasPrice instead of maxFeePerGas and maxPriorityFeePerGas');
    return hash('a');
  } };
  const journal = {
    loadFreshActivation: async () => structuredClone(saved),
    saveFreshActivation: async (next: FreshActivationRecord) => { saved = structuredClone(next); },
    freshActivationCredentialStatus: async () => ({ credentialVerified: true, gasWallet }),
    assertCurrentArtifact: async () => { if (artifactOutage) throw new Error('artifact unavailable'); },
    readCurrentNonce: async () => ({ latest: nonce, pending: nonce }),
  } as unknown as ServerJournal;
  const genesis = { id: saved.deploymentId, account: hardware } as DeploymentSnapshot;
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
});
