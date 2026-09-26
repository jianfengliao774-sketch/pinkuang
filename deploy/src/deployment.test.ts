import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserProvider, Contract, Interface, ZeroAddress, getAddress } from 'ethers';
import {
  DeploymentEngine, LIBRARY_NAMES, PROTOCOL_ADDRESSES, artifactDigest, libraryDeploymentOrder, linkBytecode,
  normalizeInput, preflight, runtimeMatches, validateArtifacts, verifyArtifactIntegrity,
  type ArtifactBundle, type DeploymentInput, type DeploymentSnapshot, type Eip1193Provider,
} from './deployment';
import { deploymentManifest } from './manifest';

// @ts-expect-error Independently compile the reviewed source for the Node test build constant.
import { artifactContentDigest, compileDeploymentArtifacts } from '../scripts/build-artifacts.mjs';

const compiledDigest = artifactContentDigest(compileDeploymentArtifacts());
(globalThis as unknown as Record<string, unknown>).__DEPLOYMENT_ARTIFACT_DIGEST__ = compiledDigest;

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
  assert.equal(artifactDigest(bundle), compiledDigest);
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

test('recent reviewed configuration skips duplicate code reads but refreshes wallet, nonce, fee and balance', async () => {
  const calls: string[] = [];
  const rejecting: Eip1193Provider = { request: request => {
    calls.push(request.method);
    if (request.method === 'eth_sendTransaction') return Promise.reject(Object.assign(new Error('user rejected'), { code: 4001 }));
    return wallet.request(request);
  } };
  const reviewed = await preflight(rejecting, bundle, { ...input, governanceReviewed: false, protocolReviewed: false });
  assert(calls.includes('eth_getCode'));
  calls.length = 0;
  await assert.rejects(engine(rejecting).start(input, reviewed), /user rejected/);
  assert(!calls.includes('eth_getCode'), 'a recent static inspection should not be repeated');
  for (const method of ['eth_chainId', 'eth_accounts', 'eth_getBalance', 'eth_getTransactionCount', 'eth_sendTransaction']) {
    assert(calls.includes(method), `${method} must still run before the wallet request`);
  }
  calls.length = 0;
  await assert.rejects(engine(rejecting).start({ ...input, gasPriceCapGwei: '11' }, reviewed), /user rejected/);
  assert(calls.includes('eth_getCode'), 'changing a reviewed setting must run a full preflight');
  calls.length = 0;
  await assert.rejects(engine(rejecting).start(input, structuredClone(reviewed)), /user rejected/);
  assert(calls.includes('eth_getCode'), 'a copied or forged report must not bypass the static inspection');
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

test('mined deployment with a lost RPC hash is recovered only from the exact on-chain transaction', { timeout: 60_000 }, async () => {
  let minedHash = '';
  const lostResponse: Eip1193Provider = { request: async request => {
    if (request.method !== 'eth_sendTransaction') return wallet.request(request);
    minedHash = await wallet.request(request) as string;
    await rpc('evm_mine'); await rpc('evm_mine');
    throw new Error('local RPC response lost after broadcast');
  } };
  const before = sends;
  await assert.rejects(engine(lostResponse).start(input), /response lost/);
  const stalled = structuredClone(snapshot!);
  const receipt = await new BrowserProvider(wallet).getTransactionReceipt(minedHash);
  assert(receipt?.contractAddress && receipt.status === 1);
  assert.equal(stalled.steps[0].status, 'uncertain');
  assert.equal(stalled.steps[0].txHash, undefined);
  assert.equal(stalled.spentWei, '0');
  assert.equal(sends, before + 1);

  await assert.rejects(engine().recoverMinedTransaction(stalled, 'not-a-hash'), /完整的 0x/);
  await assert.rejects(engine().recoverMinedTransaction(stalled, `0x${'f'.repeat(64)}`), /暂未同时查到/);
  const otherAccount = getAddress((await rpc('eth_accounts') as string[])[1]);
  const unrelatedHash = await rpc('eth_sendTransaction', [{ from: otherAccount, to: account, value: '0x0' }]) as string;
  await rpc('evm_mine'); await rpc('evm_mine');
  await assert.rejects(engine().recoverMinedTransaction(stalled, unrelatedHash), /发送者/);

  const tamperedIntent = structuredClone(stalled);
  tamperedIntent.steps[0].dataHash = `0x${'0'.repeat(64)}`;
  await assert.rejects(engine().recoverMinedTransaction(tamperedIntent, minedHash), /签名前保存的部署计划/);
  const tamperedNonce = structuredClone(stalled);
  tamperedNonce.steps[0].nonce = stalled.steps[0].nonce! + 1;
  await assert.rejects(engine().recoverMinedTransaction(tamperedNonce, minedHash), /nonce/);
  const tamperedGasLimit = structuredClone(stalled);
  tamperedGasLimit.steps[0].gasLimit = '1';
  await assert.rejects(engine().recoverMinedTransaction(tamperedGasLimit, minedHash), /Gas 设置/);
  const tooSmallBudget = structuredClone(stalled);
  tooSmallBudget.input.maxGasBudgetBnb = '0.000000000000000001';
  await rpc('anvil_mine', ['0x44']);
  const isolated = new DeploymentEngine(wallet, bundle, { persist: () => {} });
  const accounted = await isolated.recoverMinedTransaction(tooSmallBudget, minedHash);
  assert.equal(accounted.spentWei, receipt.fee.toString(), 'mined Gas is recorded even when the saved budget is exceeded');
  assert.equal(accounted.steps[0].status, 'confirmed');
  assert.match(accounted.error || '', /实际 Gas 已达到或超过总预算/);
  await assert.rejects(isolated.resume(accounted), /总 Gas 预算已耗尽/);
  const originalCode = await rpc('eth_getCode', [receipt.contractAddress, 'latest']) as string;
  await rpc('anvil_setCode', [receipt.contractAddress, '0x00']);
  try {
    await assert.rejects(engine().recoverMinedTransaction(stalled, minedHash), /链上运行代码/);
  } finally {
    await rpc('anvil_setCode', [receipt.contractAddress, originalCode]);
  }
  assert.equal(snapshot?.steps[0].txHash, undefined, 'an invalid candidate cannot be saved into the journal');
  assert.equal(sends, before + 1, 'recovery must never broadcast');

  const recovered = await engine().recoverMinedTransaction(stalled, minedHash);
  assert.equal(recovered.steps[0].status, 'confirmed');
  assert.equal(recovered.steps[0].txHash, minedHash);
  assert.equal(recovered.steps[0].address?.toLowerCase(), receipt.contractAddress.toLowerCase());
  assert.equal(recovered.spentWei, receipt.fee.toString());
  assert.equal(sends, before + 1);
  const checked = await engine().reconcile(recovered);
  assert.equal(checked.steps[0].status, 'confirmed');
  assert.equal(checked.spentWei, receipt.fee.toString());
  assert.equal(sends, before + 1);
});

test('failure to durably write intent prevents any wallet signature', async () => {
  const count = sends;
  const failingStorage = new DeploymentEngine(wallet, bundle, { persist: state => {
    if (state.steps.some(step => step.status === 'signing')) throw new Error('storage full');
  } });
  await assert.rejects(failingStorage.start(input), /无法保存部署进度/);
  assert.equal(sends, count);
});

test('prepared transaction goes straight to the wallet after durable intent and final identity check', async () => {
  const calls: string[] = [];
  let submitted: Record<string, string> | undefined;
  let statusAtSend: string | undefined;
  const rejecting: Eip1193Provider = { request: async request => {
    calls.push(request.method);
    if (request.method === 'eth_sendTransaction') {
      statusAtSend = snapshot?.steps[0].status;
      submitted = (request.params as Record<string, string>[])[0];
      throw Object.assign(new Error('user rejected'), { code: 4001 });
    }
    return wallet.request(request);
  } };
  await assert.rejects(engine(rejecting).start(input), /user rejected/);
  assert.equal(statusAtSend, 'signing', 'the journal intent must be saved before opening the wallet');
  assert.deepEqual(calls.slice(-3), ['eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
  assert.equal(calls.filter(method => method === 'eth_accounts').length, 3, 'only preflight and the final pre-sign identity check query the account');
  assert.equal(submitted?.from.toLowerCase(), account.toLowerCase());
  assert.equal(submitted?.chainId, '0x38');
  assert.equal(submitted?.value, '0x0');
  assert.equal(BigInt(submitted?.nonce ?? '-1'), BigInt(snapshot?.steps[0].nonce ?? -1));
  assert.match(submitted?.data ?? '', /^0x[0-9a-f]+$/i);
  assert.match(submitted?.gas ?? '', /^0x[0-9a-f]+$/i);
  assert.match(submitted?.gasPrice ?? '', /^0x[0-9a-f]+$/i);
  assert.equal(submitted?.to, undefined, 'first step is contract creation');
  assert.equal(snapshot?.steps[0].status, 'rejected');
});

test('wallet change after the saved intent still blocks the signature', async () => {
  const other = getAddress((await rpc('eth_accounts') as string[])[1]);
  let switched = false;
  let broadcasts = 0;
  const switching: Eip1193Provider = { request: request => {
    if (request.method === 'eth_accounts' && switched) return Promise.resolve([other]);
    if (request.method === 'eth_sendTransaction') broadcasts++;
    return wallet.request(request);
  } };
  const guarded = new DeploymentEngine(switching, bundle, { persist: state => {
    snapshot = structuredClone(state);
    if (state.steps[0].status === 'signing') switched = true;
  } });
  await assert.rejects(guarded.start(input), /钱包账户已改变/);
  assert.equal(broadcasts, 0);
  assert.equal(snapshot?.steps[0].status, 'waiting');
});

test('wallet account change after broadcast still verifies that receipt and blocks the next signature', { timeout: 30_000 }, async () => {
  const other = getAddress((await rpc('eth_accounts') as string[])[1]);
  let sent = false;
  let sendsFromThisWallet = 0;
  const switching: Eip1193Provider = { request: request => {
    if (request.method === 'eth_accounts' && sent) return Promise.resolve([other]);
    if (request.method === 'eth_sendTransaction') { sent = true; sendsFromThisWallet++; }
    return wallet.request(request);
  } };
  await assert.rejects(engine(switching).start(input), /钱包账户已改变/);
  assert.equal(snapshot?.steps[0].status, 'confirmed');
  assert.equal(snapshot?.steps[1].status, 'waiting');
  assert.equal(sendsFromThisWallet, 1, 'the changed wallet must never sign a second step');
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
  let graphPhase = false;
  let activeCodeReads = 0;
  let maxConcurrentCodeReads = 0;
  const graphCodeReads = new Map<string, number>();
  const countedWallet: Eip1193Provider = { request: async request => {
    if (graphPhase && request.method === 'eth_getCode') {
      const address = String((request.params as string[])[0]).toLowerCase();
      graphCodeReads.set(address, (graphCodeReads.get(address) ?? 0) + 1);
      activeCodeReads++;
      maxConcurrentCodeReads = Math.max(maxConcurrentCodeReads, activeCodeReads);
      try { await delay(5); return await wallet.request(request); }
      finally { activeCodeReads--; }
    }
    return wallet.request(request);
  } };
  const countedEngine = new DeploymentEngine(countedWallet, bundle, { persist: state => {
    snapshot = structuredClone(state);
    if (state.steps.every(step => step.status === 'confirmed')) graphPhase = true;
  } });
  const complete = await countedEngine.resume(adjusted);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.steps.length, LIBRARY_NAMES.length + 5);
  assert.ok(complete.steps.every(step => step.status === 'confirmed' && step.receipt?.status === 1));
  assert.ok(complete.verification!.checks.every(check => check.passed));
  assert.equal(complete.verification!.checks.find(check => check.label === '升级最小延迟')?.actual, '172800');
  assert.ok(BigInt(complete.spentWei) > 0n);
  assert.equal(Object.keys(complete.verification!.code).length, LIBRARY_NAMES.length + 9);
  assert.equal(graphCodeReads.size, Object.keys(complete.addresses).length);
  assert([...graphCodeReads.values()].every(count => count === 1), 'graph audit reads each runtime only once');
  assert(maxConcurrentCodeReads > 1, 'independent code reads should run concurrently');
  assert.equal(complete.verification!.checks.find(check => check.label === 'Lens.factory')?.actual.toLowerCase(), complete.addresses.factory.toLowerCase());
  assert.ok(complete.verification!.checks.find(check => check.label === 'lens 运行代码匹配')?.passed);
  await rpc('anvil_mine', ['0x44']); // Advance Anvil's finalized tag past the initialize receipt.
  const originalComplete = structuredClone(complete);
  const taggedReads: Array<{ method: string; tag: unknown }> = [];
  let manifestWrites = 0;
  let manifestBroadcasts = 0;
  const inspectingWallet: Eip1193Provider = { request: request => {
    const params = request.params as unknown[] | undefined;
    if (request.method === 'eth_call' || request.method === 'eth_getCode') taggedReads.push({ method: request.method, tag: params?.[1] });
    if (request.method === 'eth_getStorageAt') taggedReads.push({ method: request.method, tag: params?.[2] });
    if (request.method === 'eth_sendTransaction') manifestBroadcasts++;
    return wallet.request(request);
  } };
  const inspector = new DeploymentEngine(inspectingWallet, bundle, { persist: () => { manifestWrites++; throw new Error('manifest inspection must be read-only'); } });
  const inspected = await inspector.inspectGraphForManifest(complete);
  assert(inspected.verification?.checks.every(check => check.passed));
  assert.deepEqual(complete, originalComplete, 'manifest inspection must not mutate the saved record');
  assert.equal(manifestWrites, 0);
  assert.equal(manifestBroadcasts, 0);
  assert.deepEqual(new Set(taggedReads.map(read => read.method)), new Set(['eth_call', 'eth_getCode', 'eth_getStorageAt']));
  assert(taggedReads.every(read => read.tag !== undefined && BigInt(String(read.tag)) === BigInt(inspected.verification!.blockNumber)),
    'every graph state read must use the recorded block number');
  const wrongHash = structuredClone(complete);
  wrongHash.steps.at(-1)!.txHash = complete.steps[0].txHash;
  await assert.rejects(inspector.inspectGraphForManifest(wrongHash), /nonce/);
  const forgedReceipt = structuredClone(complete);
  forgedReceipt.steps.at(-1)!.receipt!.blockHash = `0x${'0'.repeat(64)}`;
  await assert.rejects(inspector.inspectGraphForManifest(forgedReceipt), /保存的原子初始化回执与链上不一致/);
  await assert.rejects(inspector.inspectGraphForManifest({ ...complete, artifactDigest: `0x${'0'.repeat(64)}` }), /构建产物已改变/);
  const otherAccount = getAddress((await rpc('eth_accounts') as string[])[1]);
  await assert.rejects(inspector.inspectGraphForManifest({ ...complete, account: otherAccount }), /管理地址不匹配/);
  const wrongWallet: Eip1193Provider = { request: request => request.method === 'eth_accounts' ? Promise.resolve([otherAccount]) : wallet.request(request) };
  await assert.rejects(new DeploymentEngine(wrongWallet, bundle, { persist: () => { manifestWrites++; } }).inspectGraphForManifest(complete), /钱包账户已改变/);
  assert.equal(manifestWrites, 0);
  assert.equal(manifestBroadcasts, 0);
  const publicManifest = deploymentManifest(complete, bundle);
  assert.equal(publicManifest.factory, complete.addresses.factory);
  assert.equal(publicManifest.lens, complete.addresses.lens);
  assert.equal(publicManifest.deployment.txHash, complete.steps.at(-1)!.txHash);
  const initialize = complete.steps.at(-1)!;
  const tx = await rpc('eth_getTransactionByHash', [initialize.txHash]) as { input: string; value: string };
  assert.equal(tx.input.slice(0, 10), new Interface(bundle.artifacts.AtomicDeployment.abi).getFunction('deploySingleOwner')!.selector);
  assert.equal(BigInt(tx.value), 0n);
  assert.equal(complete.verification!.checks.find(check => check.label === '初始池子数量')?.actual, '0');
  // Create a real pool on the disposable chain. Subsequent deployment reconciliation
  // must accept legitimate business activity rather than insist the factory stays empty.
  const provider = new BrowserProvider(wallet);
  const deployedFactory = new Contract(complete.addresses.factory, bundle.artifacts.PoolFactory.abi, await provider.getSigner(account));
  assert.equal((await deployedFactory.lens()).toLowerCase(), complete.addresses.lens.toLowerCase());
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
  // A registered address alone is insufficient: recoveries also check the Lens
  // factory immutable and exact compiled runtime before accepting the graph.
  await rpc('anvil_setCode', [complete.addresses.lens, '0x600060005260206000f3']);
  await rpc('evm_mine');
  await assert.rejects(engine().reconcile(complete), /部署后校验失败/);
  assert.equal(sends, count, 'invalid Lens identity must never trigger a replacement deployment');
  await rpc('evm_revert', [baseline]);
});


test('a fetched bundle cannot authorize itself by changing bytecode, ABI, source hashes or its own claimed digest', async () => {
  const before = sends;
  for (const mutate of [
    (item: ArtifactBundle) => { item.artifacts.PoolFactory.bytecode += '00'; },
    (item: ArtifactBundle) => { item.artifacts.PoolVault.abi = []; },
    (item: ArtifactBundle) => { item.sourceHashes['src/PoolVault.sol'] = 'a'.repeat(64); },
  ]) {
    const changed = structuredClone(bundle); mutate(changed);
    (changed as ArtifactBundle & { claimedDigest: string }).claimedDigest = artifactDigest(changed);
    assert.throws(() => verifyArtifactIntegrity(changed), /独立编译/);
    await assert.rejects(preflight(wallet, changed, input), /独立编译/);
    assert.throws(() => new DeploymentEngine(wallet, changed, { persist() {} }), /独立编译/);
  }
  assert.equal(sends, before);
  const laterCommit = structuredClone(bundle); laterCommit.sourceCommit = 'f'.repeat(40);
  assert.doesNotThrow(() => verifyArtifactIntegrity(laterCommit));
});
