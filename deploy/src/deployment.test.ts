import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserProvider, Contract, Interface, ZeroAddress, getAddress, keccak256 } from 'ethers';
import {
  DeploymentEngine, LIBRARY_NAMES, PROTOCOL_ADDRESSES, artifactDigest, libraryDeploymentOrder, linkBytecode,
  normalizeInput, preflight, runtimeMatches, validateArtifacts,
  type ArtifactBundle, type DeploymentInput, type DeploymentSnapshot, type Eip1193Provider,
} from './deployment';

// All signing below uses Anvil's disposable unlocked account on a loopback-only chain.
// It never reads a wallet secret, contacts BSC, or sends a real-chain transaction.
const bundle: ArtifactBundle = JSON.parse(await readFile(new URL('../public/deployment-artifacts.json', import.meta.url), 'utf8'));
let processHandle: ReturnType<typeof spawn>;
let rpcUrl: string;
let account: string;
let input: DeploymentInput;
let rpcId = 0;
let baseline: string;
let snapshot: DeploymentSnapshot | undefined;
let sends = 0;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const result = await response.json() as { error?: { code: number; message: string }; result?: unknown };
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.result;
}
const wallet: Eip1193Provider = {
  async request({ method, params }) {
    if (method === 'eth_sendTransaction') sends++;
    return rpc(method, params as unknown[] | undefined);
  },
};
function engine(provider: Eip1193Provider = wallet) {
  return new DeploymentEngine(provider, bundle, { persist: state => { snapshot = structuredClone(state); } });
}

before(async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rpcUrl = `http://127.0.0.1:${port}`;
  processHandle = spawn(fileURLToPath(new URL('../node_modules/.bin/anvil', import.meta.url)), ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '56', '--block-time', '1', '--silent'], { stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { await rpc('eth_chainId'); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, 'disposable Anvil should start');
  account = getAddress((await rpc('eth_accounts') as string[])[0]);
  input = { governanceMode: 'single', ownerMultisig: account, operator: account, treasury: account, maxGasBudgetBnb: '0.1', gasPriceCapGwei: '10', governanceReviewed: true, protocolReviewed: true };
  for (const address of Object.values(PROTOCOL_ADDRESSES)) await rpc('anvil_setCode', [address, '0x00']);
  baseline = await rpc('evm_snapshot') as string;
});
after(() => { processHandle?.kill('SIGTERM'); });

test('build is deployable and every linked library resolves; corrupt code is rejected', () => {
  validateArtifacts(bundle);
  const order = libraryDeploymentOrder(bundle);
  assert.equal(order.length, LIBRARY_NAMES.length);
  assert(order.indexOf('PoolFunds') < order.indexOf('FlexiblePurchase'));
  assert(order.indexOf('PurchaseValidation') < order.indexOf('FlexiblePurchase'));
  const libraries = Object.fromEntries(order.map((name, index) => [name, `0x${(index + 1).toString(16).padStart(40, '0')}`]));
  const linked = linkBytecode(bundle.artifacts.PoolVault.bytecode, bundle.artifacts.PoolVault.linkReferences, libraries);
  assert.match(linked, /^0x[0-9a-f]+$/i);
  assert.match(linkBytecode(bundle.artifacts.FlexiblePurchase.bytecode, bundle.artifacts.FlexiblePurchase.linkReferences, libraries), /^0x[0-9a-f]+$/i);
  assert.throws(() => linkBytecode(bundle.artifacts.PoolVault.bytecode, bundle.artifacts.PoolVault.linkReferences, {}));
  const artifact = bundle.artifacts.PoolFactory;
  const runtime = linkBytecode(artifact.deployedBytecode, artifact.deployedLinkReferences, libraries);
  assert.equal(runtimeMatches(artifact, runtime, libraries, account), true);
  assert.equal(runtimeMatches(artifact, `0xff${runtime.slice(4)}`, libraries, account), false);
  assert.equal(artifactDigest(bundle), keccak256(new TextEncoder().encode(JSON.stringify(bundle))));
});

test('read-only preflight permits unchecked review, but signing requires review', async () => {
  const unchecked = { ...input, governanceReviewed: false, protocolReviewed: false };
  const count = sends;
  const report = await preflight(wallet, bundle, unchecked);
  assert.equal(report.transactionCount, LIBRARY_NAMES.length + 5);
  assert.equal(report.account, account);
  assert.equal(sends, count);
  await assert.rejects(engine().start(unchecked), /核对治理/);
  assert.equal(sends, count);
  assert.throws(() => normalizeInput({ ...input, ownerMultisig: '0x0000000000000000000000000000000000000000' }), /零地址/);
  await assert.rejects(preflight(wallet, bundle, { ...input, governanceMode: 'multisig' }), /不同/);
  const wrongChain: Eip1193Provider = { request: req => req.method === 'eth_chainId' ? Promise.resolve('0x61') : wallet.request(req) };
  await assert.rejects(preflight(wrongChain, bundle, input), /Chain ID 56/);
});

test('low gas budget pauses before any signature; rejection is persisted and uncertain broadcasts are never retried', async () => {
  const count = sends;
  await assert.rejects(engine().start({ ...input, maxGasBudgetBnb: '0.00000001' }), /总 Gas 预算/);
  assert.equal(sends, count);
  const rejecting: Eip1193Provider = { request: req => req.method === 'eth_sendTransaction' ? Promise.reject(Object.assign(new Error('user rejected'), { code: 4001 })) : wallet.request(req) };
  await assert.rejects(engine(rejecting).start(input));
  assert.equal(snapshot?.steps[0].status, 'rejected');
  let attempts = 0;
  const ambiguous: Eip1193Provider = { request: req => {
    if (req.method === 'eth_sendTransaction') { attempts++; return Promise.reject(new Error('connection disappeared after submitting')); }
    return wallet.request(req);
  } };
  await assert.rejects(engine(ambiguous).start(input));
  assert.equal(snapshot?.steps[0].status, 'uncertain');
  const paused = await engine(ambiguous).resume(snapshot!);
  assert.equal(paused.status, 'paused');
  assert.equal(attempts, 1);
});

test('failure to durably write intent prevents any wallet signature', async () => {
  const count = sends;
  const failingStorage = new DeploymentEngine(wallet, bundle, { persist: state => {
    if (state.steps.some(step => step.status === 'signing')) throw new Error('storage full');
  } });
  await assert.rejects(failingStorage.start(input), /无法保存部署进度/);
  assert.equal(sends, count);
});

test('resuming after rejection verifies and skips the already confirmed library', { timeout: 30_000 }, async () => {
  let attempts = 0;
  const oneThenReject: Eip1193Provider = { request: req => {
    if (req.method === 'eth_sendTransaction' && ++attempts > 1) return Promise.reject(Object.assign(new Error('user rejected'), { code: 4001 }));
    return wallet.request(req);
  } };
  await assert.rejects(engine(oneThenReject).start(input));
  assert.equal(snapshot?.steps[0].status, 'confirmed');
  assert.equal(snapshot?.steps[1].status, 'rejected');
  const firstHash = snapshot!.steps[0].txHash;
  const count = sends;
  await assert.rejects(engine(oneThenReject).resume(snapshot!));
  assert.equal(snapshot!.steps[0].txHash, firstHash);
  assert.equal(snapshot!.steps[0].status, 'confirmed');
  assert.equal(sends, count);
  assert.equal(attempts, 3);
});

test('complete single-wallet graph deploys, records receipts/runtime, and recovers without rebroadcast', { timeout: 120_000 }, async () => {
  const beforeBudgetCheck = sends;
  await assert.rejects(engine().start({ ...input, maxGasBudgetBnb: '0.00000001' }), /总 Gas 预算/);
  const lowBudget = structuredClone(snapshot!);
  const adjusted = await engine().adjustLimits(lowBudget, { maxGasBudgetBnb: input.maxGasBudgetBnb, gasPriceCapGwei: input.gasPriceCapGwei });
  assert.equal(adjusted.status, 'paused');
  assert.equal(adjusted.input.ownerMultisig, lowBudget.input.ownerMultisig);
  assert.equal(adjusted.input.operator, lowBudget.input.operator);
  assert.equal(adjusted.input.treasury, lowBudget.input.treasury);
  assert.equal(sends, beforeBudgetCheck, 'adjusting limits must never request signatures');
  await assert.rejects(engine().adjustLimits(adjusted, { maxGasBudgetBnb: '0.00000001', gasPriceCapGwei: input.gasPriceCapGwei }), /只能提高/);
  const complete = await engine().resume(adjusted);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.steps.length, LIBRARY_NAMES.length + 5);
  assert.ok(complete.steps.every(step => step.status === 'confirmed' && step.receipt?.status === 1));
  assert.ok(complete.verification!.checks.every(check => check.passed));
  assert.equal(complete.verification!.checks.find(check => check.label === '升级最小延迟')?.actual, '172800');
  assert.ok(BigInt(complete.spentWei) > 0n);
  assert.equal(Object.keys(complete.verification!.code).length, LIBRARY_NAMES.length + 8);
  const initialize = complete.steps.at(-1)!;
  const tx = await rpc('eth_getTransactionByHash', [initialize.txHash]) as { input: string; value: string };
  assert.equal(tx.input.slice(0, 10), new Interface(bundle.artifacts.AtomicDeployment.abi).getFunction('deploySingleOwner')!.selector);
  assert.equal(BigInt(tx.value), 0n);
  assert.equal(complete.verification!.checks.find(check => check.label === '初始池子数量')?.actual, '0');
  // Create a real pool on the disposable chain. Subsequent deployment reconciliation
  // must accept legitimate business activity rather than insist the factory stays empty.
  const provider = new BrowserProvider(wallet);
  const deployedFactory = new Contract(complete.addresses.factory, bundle.artifacts.PoolFactory.abi, await provider.getSigner(account));
  const latest = await provider.getBlock('latest');
  assert(latest);
  await (await deployedFactory.createPool({ circuits: PROTOCOL_ADDRESSES.TAPEOUT_CIRCUITS, circuitId: 1n,
    targetRaise: 10000n, priceCap: 10000n, directSeller: ZeroAddress, directPrice: 0n,
    fundingDeadline: latest.timestamp + 3600, purchaseDeadline: latest.timestamp + 7200 })).wait();
  assert.equal(await deployedFactory.poolCount(), 1n);
  const count = sends;
  const recovered = await engine().reconcile(complete);
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.verification!.checks.find(check => check.label === '当前池子数量')?.actual, '1');
  assert.equal(sends, count);
  const stale = structuredClone(complete);
  stale.status = 'paused';
  stale.steps = stale.steps.map((step, index) => index === 0 ? step : { id: step.id, label: step.label, status: index === 1 ? 'rejected' : 'waiting' });
  let latestJournal = structuredClone(complete);
  const otherTab = new DeploymentEngine(wallet, bundle, {
    readLatest: () => structuredClone(latestJournal),
    persist: state => { latestJournal = structuredClone(state); },
  });
  const fromLatest = await otherTab.resume(stale);
  assert.equal(fromLatest.status, 'complete');
  assert.equal(sends, count, 'stale tab must read latest journal inside the lock and never redeploy');
  await assert.rejects(otherTab.start(input), /已有部署记录/);
  assert.equal(sends, count);
  await assert.rejects(otherTab.adjustLimits(fromLatest, { maxGasBudgetBnb: '0.2', gasPriceCapGwei: '10' }), /部署已完成/);
  assert.equal(sends, count);
  const tampered = structuredClone(complete);
  tampered.input.operator = getAddress('0x0000000000000000000000000000000000000001');
  await assert.rejects(engine().reconcile(tampered), /交易内容/);
  assert.equal(sends, count);
  await rpc('evm_revert', [baseline]);
});
