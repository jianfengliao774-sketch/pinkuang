/** Audit probes for ee8c809. They demonstrate existing recovery gaps, not corrected behavior.
 * Run: node node_modules/tsx/dist/cli.mjs --test audit/recovery.audit.ts
 * Disposable unlocked Anvil accounts, loopback only; no real wallet or external RPC.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonRpcProvider, getAddress } from 'ethers';
import { DeploymentEngine, PROTOCOL_ADDRESSES, type ArtifactBundle, type DeploymentSnapshot, type Eip1193Provider } from '../src/deployment';
import { recoverMarketReceipt, sendMarketAction, PENDING_MARKET_KEY, type PendingMarketTransaction, type MarketQuote } from '../src/market';
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
  for (let n = 0; n < 50; n++) {
    try { accounts = (await provider.send('eth_accounts', [])).map(getAddress); break; } catch { await delay(100); }
  }
  assert(accounts?.length);
  for (const address of Object.values(PROTOCOL_ADDRESSES)) await provider.send('anvil_setCode', [address, '0x00']);
});
after(() => { provider?.destroy(); node?.kill('SIGTERM'); });
const wallet: Eip1193Provider = { request: request => provider.send(request.method, request.params as unknown[] ?? []) };
async function mine(n = 1) { for (let i = 0; i < n; i++) await provider.send('evm_mine', []); }

test('AUDIT: mined deployment whose hash response is lost stays unrecoverable through UI engine methods', async () => {
  let snapshot: DeploymentSnapshot | undefined, actualHash = '', sends = 0;
  const persist = (value: DeploymentSnapshot) => { snapshot = structuredClone(value); };
  const lostResponse: Eip1193Provider = { async request(request) {
    if (request.method !== 'eth_sendTransaction') return wallet.request(request);
    sends++; actualHash = await wallet.request(request) as string;
    await mine(3);
    throw new Error('Simulated RPC response lost after actual local transaction acceptance');
  } };
  const input = { governanceMode: 'single' as const, ownerMultisig: accounts[0], operator: accounts[0], treasury: accounts[0],
    maxGasBudgetBnb: '0.1', gasPriceCapGwei: '10', governanceReviewed: true, protocolReviewed: true };
  await assert.rejects(new DeploymentEngine(lostResponse, bundle, { persist }).start(input));
  assert(actualHash);
  const receipt = await provider.getTransactionReceipt(actualHash);
  assert.equal(receipt?.status, 1);
  assert.notEqual(await provider.getCode(receipt!.contractAddress!), '0x');
  assert.equal(snapshot!.steps[0].txHash, undefined);
  assert.equal(snapshot!.steps[0].status, 'uncertain');
  const engine = new DeploymentEngine(wallet, bundle, { persist });
  const reconciled = await engine.reconcile(snapshot!);
  const resumed = await engine.resume(reconciled);
  assert.equal(resumed.steps[0].status, 'uncertain');
  assert.equal(resumed.status, 'paused');
  assert.equal(resumed.spentWei, '0', 'actual mined deployment cost cannot be recovered without its hash');
  assert.equal(sends, 1);
  console.log(JSON.stringify({ finding: 'deployment-lost-hash', mined: true, actualFeeWei: receipt!.fee.toString(),
    savedStatus: resumed.status, savedStepStatus: resumed.steps[0].status, savedSpentWei: resumed.spentWei }));
});

test('AUDIT: same-nonce wallet cancellation is final but market journal still blocks all new transactions', async () => {
  const account = accounts[1], market = accounts[2], factory = accounts[3];
  const nonce = await provider.getTransactionCount(account);
  const original = await provider.send('eth_sendTransaction', [{ from: account, to: market, data: '0x1234',
    value: '0x0', gas: '0x186a0', gasPrice: '0x3b9aca00', nonce: `0x${nonce.toString(16)}` }]);
  const cancellation = await provider.send('eth_sendTransaction', [{ from: account, to: account, data: '0x',
    value: '0x0', gas: '0x5208', gasPrice: '0x77359400', nonce: `0x${nonce.toString(16)}` }]);
  await mine(66);
  assert.equal((await provider.getTransactionReceipt(cancellation))?.status, 1);
  assert.equal(await provider.getTransactionReceipt(original), null);
  assert.equal(await provider.getTransactionCount(account, 'finalized'), nonce + 1);
  const pending: PendingMarketTransaction = { version: 1, chainId: 56, account, factory, market, nonce,
    action: { kind: 'withdraw' }, data: '0x1234', value: '0', hash: original, submittedAt: new Date().toISOString() };
  const unresolved = await recoverMarketReceipt(provider, pending).catch(error => ({ error: String(error) }));
  assert('error' in unresolved || unresolved.receipt === null);
  await assert.rejects(recoverMarketReceipt(provider, pending, cancellation), /不匹配/);
  const saved = JSON.stringify(pending); let walletCalls = 0, writes = 0;
  const storage = { getItem: (key: string) => key === PENDING_MARKET_KEY ? saved : null,
    setItem: () => { writes++; }, removeItem: () => { writes++; } } as unknown as Storage;
  await assert.rejects(sendMarketAction({ request: async () => { walletCalls++; throw new Error('Unexpected wallet request'); } },
    {} as MarketQuote, storage, () => {}), /待确认/);
  assert.equal(walletCalls, 0); assert.equal(writes, 0);
  console.log(JSON.stringify({ finding: 'market-finalized-cancel', originalReceipt: null, cancellationFinalized: true,
    newActionBlocked: true, journalChanged: false }));
});

test('AUDIT: market recovery exposes a one-block receipt that can be orphaned, without checking finality', async () => {
  const account = accounts[4], market = accounts[5], factory = accounts[3];
  const checkpoint = await provider.send('evm_snapshot', []);
  const nonce = await provider.getTransactionCount(account);
  const hash = await provider.send('eth_sendTransaction', [{ from: account, to: market, data: '0x1234', value: '0x0',
    gas: '0x186a0', gasPrice: '0x3b9aca00', nonce: `0x${nonce.toString(16)}` }]);
  await mine(1);
  const pending: PendingMarketTransaction = { version: 1, chainId: 56, account, factory, market, nonce,
    action: { kind: 'withdraw' }, data: '0x1234', value: '0', hash, submittedAt: new Date().toISOString() };
  const recovered = await recoverMarketReceipt(provider, pending);
  assert.equal(recovered.receipt?.status, 1);
  assert.equal(await recovered.receipt!.confirmations(), 1);
  // MarketPage.checkPending clears the journal for any 0/1 receipt (lines 128-130).
  const finalized = await provider.getBlock('finalized');
  assert(finalized!.number < recovered.receipt!.blockNumber);
  await provider.send('evm_revert', [checkpoint]);
  assert.equal(await provider.getTransactionReceipt(hash), null);
  console.log(JSON.stringify({ finding: 'market-unfinalized-receipt', acceptedConfirmations: 1, receiptGoneAfterLocalReorg: true }));
});
