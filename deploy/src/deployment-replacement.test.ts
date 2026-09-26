import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonRpcProvider, getAddress, parseUnits, toBeHex } from 'ethers';
import { DeploymentEngine, PROTOCOL_ADDRESSES, type ArtifactBundle, type DeploymentInput,
  type DeploymentSnapshot, type Eip1193Provider } from './deployment';
// @ts-expect-error The independent compiler helper is JavaScript.
import { artifactContentDigest, compileDeploymentArtifacts } from '../scripts/build-artifacts.mjs';

(globalThis as Record<string, unknown>).__DEPLOYMENT_ARTIFACT_DIGEST__ = artifactContentDigest(compileDeploymentArtifacts());
const bundle: ArtifactBundle = JSON.parse(await readFile(new URL('../public/deployment-artifacts.json', import.meta.url), 'utf8'));
let node: ReturnType<typeof spawn>, provider: JsonRpcProvider, accounts: string[];
before(async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  node = spawn(fileURLToPath(new URL('../node_modules/.bin/anvil', import.meta.url)),
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '56', '--no-mining', '--base-fee', '0', '--silent'], { stdio: 'ignore' });
  provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 });
  for (let i = 0; i < 50; i++) {
    try { accounts = (await provider.send('eth_accounts', [])).map(getAddress); break; }
    catch { await delay(100); }
  }
  assert(accounts?.length);
  for (const address of Object.values(PROTOCOL_ADDRESSES)) await provider.send('anvil_setCode', [address, '0x00']);
});
after(() => { provider?.destroy(); node?.kill('SIGTERM'); });
const wallet: Eip1193Provider = { request: request => provider.send(request.method, request.params as unknown[] ?? []) };

async function replacementScenario(index: number, kind: 'accelerate' | 'dynamic' | 'cancel' | 'different' | 'failed' | 'originalFailed') {
  const account = accounts[index];
  const selectedWallet: Eip1193Provider = { request: request =>
    request.method === 'eth_accounts' ? Promise.resolve([account]) : wallet.request(request) };
  const input: DeploymentInput = { governanceMode: 'single', ownerMultisig: account, operator: account, treasury: account,
    maxGasBudgetBnb: '0.1', gasPriceCapGwei: '10', governanceReviewed: true, protocolReviewed: true };
  let snapshot: DeploymentSnapshot | undefined, originalHash = '', replacementHash = '', sends = 0;
  const intercepted: Eip1193Provider = { async request(request) {
    if (request.method !== 'eth_sendTransaction') return selectedWallet.request(request);
    sends++;
    const transaction = (request.params as Record<string, unknown>[])[0];
    const original = kind === 'originalFailed'
      ? { ...transaction, gas: toBeHex(BigInt(String(transaction.gas)) / 2n) }
      : transaction;
    originalHash = await provider.send('eth_sendTransaction', [original]);
    if (kind === 'originalFailed') {
      replacementHash = originalHash;
      throw new Error('simulated lost RPC response after replacement');
    }
    const raisedPrice = toBeHex(parseUnits('20', 'gwei'));
    const { gasPrice: _legacyPrice, type: _legacyType, ...withoutLegacyGas } = transaction;
    const changed = kind === 'accelerate' ? { ...transaction, gasPrice: raisedPrice }
      : kind === 'dynamic' ? { ...withoutLegacyGas, type: '0x2', maxFeePerGas: raisedPrice,
        maxPriorityFeePerGas: raisedPrice }
      : kind === 'failed' ? { ...transaction, gas: toBeHex(BigInt(String(transaction.gas)) / 2n), gasPrice: raisedPrice }
      : kind === 'cancel' ? { from: account, to: account, nonce: transaction.nonce, gas: '0x5208',
        gasPrice: raisedPrice, value: '0x0', data: '0x', type: '0x0' }
      : { from: account, to: accounts[9], nonce: transaction.nonce, gas: '0x186a0',
        gasPrice: raisedPrice, value: '0x0', data: '0x1234', type: '0x0' };
    replacementHash = await provider.send('eth_sendTransaction', [changed]);
    throw new Error('simulated lost RPC response after replacement');
  } };
  const persist = (state: DeploymentSnapshot) => { snapshot = structuredClone(state); };
  await assert.rejects(new DeploymentEngine(intercepted, bundle, { persist }).start(input), /lost RPC response/);
  assert(originalHash && replacementHash);
  // The same write-ahead step with a returned original hash is the journal produced
  // by a wallet that returns the first hash before its same-nonce replacement.
  const known = structuredClone(snapshot!);
  known.steps[0].txHash = originalHash;
  known.steps[0].status = 'submitted';
  await provider.send('anvil_mine', ['0x44']);
  if (kind !== 'originalFailed') assert.equal(await provider.getTransactionReceipt(originalHash), null);
  const receipt = await provider.getTransactionReceipt(replacementHash);
  assert(receipt);
  assert((await provider.getBlock('finalized'))!.number >= receipt.blockNumber);
  const engine = new DeploymentEngine(selectedWallet, bundle, { persist });
  return { known, engine, receipt, replacementHash, originalHash, sends: () => sends };
}

test('finalized same-payload wallet acceleration restores the original deployment and records actual over-cap Gas', { timeout: 30_000 }, async () => {
  const scenario = await replacementScenario(0, 'accelerate');
  const restored = await scenario.engine.recoverMinedTransaction(scenario.known, scenario.replacementHash);
  assert.equal(restored.steps[0].status, 'confirmed');
  assert.equal(restored.steps[0].txHash, scenario.replacementHash);
  assert.deepEqual(restored.steps[0].previousTxHashes, [scenario.originalHash]);
  assert.equal(restored.spentWei, scenario.receipt.fee.toString());
  assert.equal(restored.steps[0].finalizedRecovery, true);
  assert.equal((await scenario.engine.reconcile(restored)).steps[0].status, 'confirmed');
  assert.equal(scenario.sends(), 1, 'recovery must not request another wallet signature');
});

test('a finalized type-2 acceleration uses the receipt effective Gas price and preserves the old hash', { timeout: 30_000 }, async () => {
  const scenario = await replacementScenario(3, 'dynamic');
  const restored = await scenario.engine.recoverMinedTransaction(scenario.known, scenario.replacementHash);
  assert.equal(restored.steps[0].status, 'confirmed');
  assert.equal(restored.steps[0].txHash, scenario.replacementHash);
  assert.deepEqual(restored.steps[0].previousTxHashes, [scenario.originalHash]);
  assert.equal(restored.spentWei, (scenario.receipt.gasUsed * scenario.receipt.gasPrice).toString());
  assert.equal((await scenario.engine.reconcile(restored)).steps[0].status, 'confirmed');
  assert.equal(scenario.sends(), 1);
});

test('a finalized same-payload replacement that runs out of Gas terminates and accounts for the spent fee', { timeout: 30_000 }, async () => {
  const scenario = await replacementScenario(4, 'failed');
  assert.equal(scenario.receipt.status, 0);
  const stopped = await scenario.engine.recoverMinedTransaction(scenario.known, scenario.replacementHash);
  assert.equal(stopped.status, 'aborted');
  assert.equal(stopped.steps[0].status, 'failed');
  assert.equal(stopped.spentWei, scenario.receipt.fee.toString());
  assert.match(stopped.error || '', /链上执行失败/);
  assert.equal((await scenario.engine.reconcile(stopped)).status, 'aborted');
  assert.equal(scenario.sends(), 1);
});

test('a finalized original transaction failure also terminates the old plan and records Gas', { timeout: 30_000 }, async () => {
  const scenario = await replacementScenario(5, 'originalFailed');
  assert.equal(scenario.receipt.status, 0);
  const stopped = await scenario.engine.reconcile(scenario.known);
  assert.equal(stopped.status, 'aborted');
  assert.equal(stopped.steps[0].status, 'failed');
  assert.equal(stopped.steps[0].txHash, scenario.originalHash);
  assert.equal(stopped.steps[0].replacementHash, scenario.originalHash);
  assert.equal(stopped.spentWei, scenario.receipt.fee.toString());
  assert.match(stopped.error || '', /链上执行失败/);
  await assert.rejects(scenario.engine.resume(stopped), /不能继续此计划/);
  assert.equal(scenario.sends(), 1);
});

for (const [index, kind, expected] of [[1, 'cancel', 'cancelled'], [2, 'different', 'replaced']] as const) {
  test(`finalized wallet ${kind} terminates the old plan without skipping a deployment step`, { timeout: 30_000 }, async () => {
    const scenario = await replacementScenario(index, kind);
    const stopped = await scenario.engine.recoverMinedTransaction(scenario.known, scenario.replacementHash);
    assert.equal(stopped.status, 'aborted');
    assert.equal(stopped.steps[0].status, expected);
    assert.equal(stopped.steps[0].txHash, scenario.originalHash);
    assert.equal(stopped.steps[0].replacementHash, scenario.replacementHash);
    assert.equal(stopped.spentWei, scenario.receipt.fee.toString());
    assert.equal((await scenario.engine.reconcile(stopped)).status, 'aborted');
    await assert.rejects(scenario.engine.resume(stopped), /不能继续此计划/);
    await assert.rejects(scenario.engine.adjustLimits(stopped, { maxGasBudgetBnb: '0.2', gasPriceCapGwei: '20' }), /不能提高预算/);
    assert.equal(scenario.sends(), 1);
  });
}
