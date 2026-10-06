import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { freshManifestDigest, loadFreshDisplayConfig } from '../lib/fresh-product-config.mjs';
import { directMemberTransaction, sendMemberWalletTransaction, readMemberReceipt,
  readMemberTransactions, saveMemberTransactions } from '../lib/member-wallet-transactions.mjs';
const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const keys = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock', 'portfolioFactory',
  'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation', 'portfolioFactoryImplementation'];
const authority = { address: address(30), administratorOne: address(31), administratorTwo: address(32),
  gasWallet: address(33), codehash: hash(99), deploymentTxHash: hash(98) };
const rawManifest = { schemaVersion: 1, kind: 'integrated-v2', chainId: 56,
  ...Object.fromEntries(keys.map((key, index) => [key, address(index + 10)])),
  codehash: Object.fromEntries(keys.map(key => [key, hash(50)])),
  authority: authority.address, gasWallet: authority.gasWallet, freshAuthority: authority,
  deployment: { txHash: hash(40), blockNumber: 90, blockHash: hash(41) },
  artifactDigest: ARTIFACT_DIGEST, sourceCommit: 'a'.repeat(40),
  verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBlockNumber: 100 };
const config = await loadFreshDisplayConfig({ basePath: '/bemine-v4', origin: 'https://example.test',
  pinnedManifest: rawManifest, manifestSha256: freshManifestDigest(rawManifest),
  fetcher: async () => assert.fail('Compiled display boot must stay local.') });
const account = address(1), pool = address(100), portfolio = address(200);

const transaction = { chainId: '0x38', from: account, to: config.manifest.shareMarket,
  data: abi.ShareMarket.encodeFunctionData('fill', [9n, 10n]), value: '10100000000000000' };

test('buy opens wallet as its first and only external request, with exact payment; no login or preflight', async () => {
  const calls = [], stages = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Sending must not access session, journal or other HTTP services.');
  try {
    const result = await sendMemberWalletTransaction({ config, transaction, action: { kind: 'fill' },
      onState: state => stages.push(state.status), provider: { request: async request => {
        calls.push(request);
        assert.equal(request.method, 'eth_sendTransaction');
        const sent = request.params[0];
        assert.equal(BigInt(sent.value), 10100000000000000n);
        assert.equal(sent.chainId, '0x38'); assert.equal(sent.from, account); assert.equal(sent.to, config.manifest.shareMarket);
        assert.equal(sent.data, transaction.data.toLowerCase());
        assert.equal(BigInt(sent.gas), 3000000n);
        for (const key of ['nonce', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'type']) assert.equal(key in sent, false);
        return hash(7);
      } } });
    assert.equal(calls.length, 1); assert.deepEqual(stages, ['awaiting-signature']);
    assert.equal(result.walletOnly, true); assert.equal(result.status, 'pending');
    assert.equal(result.record.value, transaction.value);
  } finally { globalThis.fetch = previousFetch; }
});

test('wallet rejection and lost responses never cause automatic resend', async () => {
  for (const error of [Object.assign(new Error('Cancelled'), { code: 4001 }), new Error('Response lost')]) {
    let sends = 0;
    const provider = { request: async request => { assert.equal(request.method, 'eth_sendTransaction'); sends++; throw error; } };
    await assert.rejects(sendMemberWalletTransaction({ provider, config, transaction, action: { kind: 'fill' } }), error);
    assert.equal(sends, 1);
  }
});

test('duplicate click cannot open a second wallet request while confirmation is open', async () => {
  let release, sends = 0;
  const provider = { request: () => { sends++; return new Promise(resolve => { release = resolve; }); } };
  const first = sendMemberWalletTransaction({ provider, config, transaction, action: { kind: 'fill' } });
  await assert.rejects(sendMemberWalletTransaction({ provider, config, transaction, action: { kind: 'fill' } }), /窗口已打开/);
  release(hash(8)); await first; assert.equal(sends, 1);
});

test('wrong chain, mismatched calldata and administrator operations are excluded locally', async () => {
  const provider = { request: () => assert.fail('Invalid intents must never reach wallet.') };
  await assert.rejects(sendMemberWalletTransaction({ provider, config, transaction: { ...transaction, chainId: '0x1' }, action: { kind: 'fill' } }));
  await assert.rejects(sendMemberWalletTransaction({ provider, config, transaction, action: { kind: 'list' } }));
  assert.equal(directMemberTransaction(config, { ...transaction, to: config.manifest.portfolioFactory, value: '0',
    data: abi.BudgetPortfolioFactory.encodeFunctionData('createPortfolio', [100n, 100n, 1n, 1000n, 2000n]) }, { kind: 'createPortfolio', targetType: 'portfolioFactory' }), false);
});

test('background receipts distinguish no receipt, reorganization, success and revert without wallet calls', async () => {
  const record = { hash: hash(7), account, target: config.manifest.shareMarket };
  const receipt = { transactionHash: record.hash, from: account, to: record.target,
    status: '0x1', blockNumber: '0x64', blockHash: hash(20) };
  for (const [returned, canonical, expected] of [[null, null, 'pending'], [receipt, hash(21), 'pending'],
    [receipt, hash(20), 'confirmed'], [{ ...receipt, status: '0x0' }, hash(20), 'failed']]) {
    const result = await readMemberReceipt({ request: async ({ method }) => {
      if (method === 'eth_getTransactionReceipt') return returned;
      assert.equal(method, 'eth_getBlockByNumber'); return { hash: canonical };
    } }, record);
    assert.equal(result.status, expected);
  }
  await assert.rejects(readMemberReceipt({ request: async () => ({ ...receipt, from: address(2) }) }, record), /回执不匹配/);
});

test('pending hashes survive reload and stay isolated by deployment and wallet', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const records = [{ hash: hash(7), account, target: config.manifest.shareMarket, status: 'pending' }];
  saveMemberTransactions(config, account, records, storage);
  assert.deepEqual(readMemberTransactions(config, account, storage), records);
  assert.deepEqual(readMemberTransactions(config, address(2), storage), []);
  assert.deepEqual(readMemberTransactions({ ...config, factory: address(3) }, account, storage), []);
  assert.deepEqual(readMemberTransactions(config, account, { getItem: () => { throw new Error('Storage blocked'); } }), []);
});
