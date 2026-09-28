import { firstoProvider } from '../../deploy/scripts/fixtures/firsto-order.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, Interface, getAddress, keccak256 } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { createLiveApi } from './live-api.mjs';

const addr = number => getAddress(`0x${number.toString(16).padStart(40, '0')}`);
const factory = addr(1), lens = addr(2), market = addr(3), pool = addr(4), beacon = addr(5), timelock = addr(6);
const poolFactoryImpl = addr(7), marketImpl = addr(8), poolVaultImpl = addr(9);
const beaconAbi = new Interface(['function implementation() view returns(address)', 'function owner() view returns(address)']);
const origin = 'http://127.0.0.1:3000';
const hexHash = value => `0x${value.toString(16).padStart(64, '0')}`;

function rpc() {
  const transactions = new Map(), receipts = new Map();
  const orders = new Map();
  const proposals = new Map();
  let nonce = 0, finalizedNumber = 0, chain = 56, timestamp = 1000, poolState = 2n, buyerFeeBps = 100n;
  let salePrice = 10000n, saleExpiry = 1000100n, listedProposalId = 2n;
  return { transactions, receipts, orders, proposals, setNonce(value) { nonce = value; },
    setFinalized(value) { finalizedNumber = value; }, setChain(value) { chain = value; },
    setTimestamp(value) { timestamp = value; }, setPoolState(value) { poolState = value; },
    setBuyerFeeBps(value) { buyerFeeBps = value; },
    setSale({ price = salePrice, expiry = saleExpiry, proposalId = listedProposalId }) {
      salePrice = price; saleExpiry = expiry; listedProposalId = proposalId;
    },
    async send(method, params = []) {
      if(method === 'eth_chainId') return `0x${chain.toString(16)}`;
      if(method === 'eth_call' && params[0].data === abi.PoolVault.encodeFunctionData('controlledFirstoSaleVersion')) return abi.PoolVault.encodeFunctionResult('controlledFirstoSaleVersion',[1]);
      return firstoProvider({account:addr(1)}).provider.request({method,params});
    },
    async getNetwork() { return { chainId: 56n }; },
    async getCode() { return '0x6000'; },
    async getStorage(target) { return `0x${(target === factory ? poolFactoryImpl : marketImpl).slice(2).padStart(64, '0')}`; },
    async getTransactionCount() { return nonce; },
    async getTransaction(hash) { return transactions.get(hash) ?? null; },
    async getTransactionReceipt(hash) { return receipts.get(hash) ?? null; },
    async getBlock(tag) { return tag === 'finalized' ? { number: finalizedNumber, hash: hexHash(finalizedNumber) }
      : tag === 'latest' ? { number: 10, hash: hexHash(10), timestamp }
        : { number: tag, hash: hexHash(tag), timestamp }; },
    async estimateGas() { return 100000n; },
    async call(tx) {
      const contract = tx.to === factory ? abi.PoolFactory : tx.to === lens ? abi.PoolLens
        : tx.to === market ? abi.ShareMarket : tx.to === beacon ? beaconAbi : abi.PoolVault;
      const parsed = contract.parseTransaction(tx);
      if (!parsed) throw new Error('Unknown call.');
      if (parsed.name === 'buyerFeeBps' && buyerFeeBps === null) throw new Error('Old ShareMarket has no buyer fee getter.');
      if (parsed.name === 'orders') {
        const order = orders.get(parsed.args[0].toString()) ?? { seller: addr(99), pool, remaining: 0n, pricePerUnit: 0n, active: false };
        return contract.encodeFunctionResult(parsed.name, [[order.seller, order.pool, order.remaining, order.pricePerUnit, order.active]]);
      }
      if (parsed.name === 'orderExpiresAt') return contract.encodeFunctionResult(parsed.name, [orders.get(parsed.args[0].toString())?.expiresAt ?? 0n]);
      if (parsed.name === 'getProposal') {
        const proposal = proposals.get(parsed.args[0].toString()) ?? { proposer: addr(55), snapshotTs: 999900n,
          endsAt: 1086300n, refAt: 999800n, price: 10000n, refPrice: 10000n,
          snapshotMemberCount: 1n, snapshotTotalShares: 100n, yesCount: 1n, yesShares: 100n, executed: false };
        return contract.encodeFunctionResult(parsed.name, [[proposal.proposer, proposal.snapshotTs,
          proposal.endsAt, proposal.refAt, proposal.price, proposal.refPrice, proposal.snapshotMemberCount,
          proposal.snapshotTotalShares, proposal.yesCount, proposal.yesShares, proposal.executed]]);
      }
      const value = { lens, shareMarket: market, beacon, timelock, isPool: true, factory, VERSION: 1n,
        unitPriceWei: 100n, implementation: poolVaultImpl, owner: timelock, OFFICIAL_FACTORY: factory,
        feeBps: 100n, buyerFeeBps, nextOrderId: 100n, bnbOwed: 500n, state: poolState, shareTradingAllowed: true,
        availableShares: 100n, lockedShares: 100n, balanceOf: 100n, activatedAt: 1n,
        activeProposalId: 1n, nextProposalId: 3n, hasVoted: false, proposalPassed: true,
        listedProposalId, expiresAt: saleExpiry, salePrice }[parsed.name];
      return value === undefined ? '0x' : contract.encodeFunctionResult(parsed.name, [value]);
    },
    destroy() {},
  };
}

async function fixture({ badHash = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bemine-live-test-'));
  const provider = rpc();
  const code = Object.fromEntries(Object.entries({ factory, shareMarket: market, lens, beacon, timelock,
    PoolFactory: poolFactoryImpl, ShareMarket: marketImpl, PoolVault: poolVaultImpl })
    .map(([name, address]) => [name, { address, hash: keccak256('0x6000') }]));
  if (badHash) code.PoolVault.hash = hexHash(999);
  const config = { factory, expected: { artifactDigest: ARTIFACT_DIGEST, code }, origin,
    rpc: 'https://example.invalid', index: 'https://example.invalid', dbPath: join(directory, 'private', 'live.sqlite') };
  const options = { provider, onError: error => console.error(error), fetchImpl: async () => ({ ok: true, async json() { return { source: { complete: true, chainId: 56, factory, market }, data: { items: [] } }; } }) };
  let service = createLiveApi(config, options);
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${service.server.address().port}`;
  async function request(path, method = 'GET', body, cookie, account) {
    const response = await fetch(`${base}/api/live${path}`, { method, headers: {
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(account ? { 'X-Bemine-Account': account } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function signIn(wallet) {
    const challenge = await request('/challenge', 'POST', { account: wallet.address });
    assert.equal(challenge.status, 200);
    const signed = await request('/session', 'POST', { account: wallet.address, nonce: challenge.body.nonce,
      signature: await wallet.signMessage(challenge.body.message) });
    assert.equal(signed.status, 200);
    return signed.cookie;
  }
  return { provider, request, signIn, async reopen() {
    await new Promise(resolve => service.server.close(resolve)); service.close();
    service = createLiveApi(config, options);
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${service.server.address().port}`;
  }, async close() {
    await new Promise(resolve => service.server.close(resolve));
    service.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

test('exact wallet session, server index identity and one durable 100-share intent', async () => {
  const f = await fixture(), alice = Wallet.createRandom(), bob = Wallet.createRandom();
  try {
    const config = await f.request('/config');
    assert.equal(config.body.factory, factory);
    assert.equal((await f.request('/index/v1/pools?limit=20')).status, 200);
    const cookie = await f.signIn(alice);
    assert.equal((await f.request('/intent', 'GET', undefined, cookie, bob.address)).status, 403);
    assert.equal((await f.request('/intent', 'GET', undefined, cookie, alice.address)).body.intent, null);
    const data = abi.PoolVault.encodeFunctionData('deposit', [100n]);
    const tx = { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST, nonce: 0, pool, data, value: '10000' };
    assert.equal((await f.request('/intent', 'POST', { ...tx, value: '10001' }, cookie, alice.address)).status, 400);
    const saved = await f.request('/intent', 'POST', tx, cookie, alice.address);
    assert.equal(saved.status, 201); assert.equal(saved.body.intent.action, 'deposit');
    assert.equal(saved.body.intent.value, '10000'); assert.equal(saved.body.intent.gasEstimate, '100000');
    assert.equal((await f.request('/intent', 'POST', tx, cookie, alice.address)).status, 409);
    assert.equal((await f.request('/intent', 'GET', undefined, cookie, alice.address)).body.intent.id, saved.body.intent.id);
    const bobCookie = await f.signIn(bob);
    assert.equal((await f.request('/intent', 'GET', undefined, bobCookie, bob.address)).body.intent, null);
  } finally { await f.close(); }
});

test('only a canonical finalized original or cancellation retires an intent', async () => {
  const f = await fixture(), alice = Wallet.createRandom();
  try {
    const cookie = await f.signIn(alice), data = abi.PoolVault.encodeFunctionData('claim');
    const saved = await f.request('/intent', 'POST', { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST, nonce: 0, pool, data, value: '0' }, cookie, alice.address);
    assert.equal(saved.status, 201);
    const id = saved.body.intent.id, hash = hexHash(100);
    assert.equal((await f.request('/arm', 'POST', { id }, cookie, alice.address)).body.intent.status, 'armed');
    assert.equal((await f.request('/hash', 'POST', { id, hash }, cookie, alice.address)).body.intent.active, true);
    f.provider.transactions.set(hash, { hash, from: alice.address, nonce: 0, chainId: 56n, to: pool, data, value: 0n,
      blockNumber: 12, blockHash: hexHash(12) });
    f.provider.receipts.set(hash, { hash, from: alice.address, blockNumber: 12, blockHash: hexHash(12), status: 1 });
    f.provider.setFinalized(11);
    assert.equal((await f.request('/intent', 'GET', undefined, cookie, alice.address)).body.intent.active, true);
    f.provider.setFinalized(12);
    f.provider.setChain(97);
    assert.equal((await f.request('/intent', 'GET', undefined, cookie, alice.address)).status, 503);
    f.provider.setChain(56);
    const finished = await f.request('/intent', 'GET', undefined, cookie, alice.address);
    assert.equal(finished.body.intent.status, 'complete'); assert.equal(finished.body.intent.active, false);
    assert.equal(finished.body.history[0].completedHash, hash);
    f.provider.setNonce(1);
    const next = await f.request('/intent', 'POST', { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST, nonce: 1, pool, data, value: '0' }, cookie, alice.address);
    assert.equal(next.status, 201);
    assert.equal((await f.request('/arm', 'POST', { id: next.body.intent.id }, cookie, alice.address)).body.intent.status, 'armed');
    const cancelHash = hexHash(101);
    f.provider.transactions.set(cancelHash, { hash: cancelHash, from: alice.address, nonce: 1, chainId: 56n,
      to: alice.address, data: '0x', value: 0n, blockNumber: 13, blockHash: hexHash(13) });
    f.provider.receipts.set(cancelHash, { hash: cancelHash, from: alice.address, blockNumber: 13, blockHash: hexHash(13), status: 1 });
    f.provider.setFinalized(13);
    assert.equal((await f.request('/hash', 'POST', { id: next.body.intent.id, hash: cancelHash }, cookie, alice.address)).body.intent.status, 'cancelled');
  } finally { await f.close(); }
});

test('wrong Origin and foreign nonce or hash never authorize transaction completion', async () => {
  const f = await fixture(), alice = Wallet.createRandom();
  try {
    const cookie = await f.signIn(alice), data = abi.PoolVault.encodeFunctionData('claim');
    assert.equal((await f.request('/intent', 'POST', { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST, nonce: 1, pool, data, value: '0' }, cookie, alice.address)).status, 409);
    const saved = await f.request('/intent', 'POST', { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST, nonce: 0, pool, data, value: '0' }, cookie, alice.address);
    assert.equal((await f.request('/arm', 'POST', { id: saved.body.intent.id }, cookie, alice.address)).status, 200);
    const hash = hexHash(200);
    f.provider.transactions.set(hash, { hash, from: addr(9), nonce: 0, chainId: 56n, to: pool, data, value: 0n,
      blockNumber: 12, blockHash: hexHash(12) });
    f.provider.receipts.set(hash, { hash, from: addr(9), blockNumber: 12, blockHash: hexHash(12), status: 1 });
    f.provider.setFinalized(12);
    assert.equal((await f.request('/hash', 'POST', { id: saved.body.intent.id, hash }, cookie, alice.address)).status, 409);
    assert.equal((await f.request('/intent', 'GET', undefined, cookie, alice.address)).body.intent.active, true);
  } finally { await f.close(); }
});

test('a changed implementation code hash blocks live config and all signatures', async () => {
  const f = await fixture({ badHash: true }), alice = Wallet.createRandom();
  try {
    assert.equal((await f.request('/config')).status, 503);
    const cookie = await f.signIn(alice);
    const data = abi.PoolVault.encodeFunctionData('deposit', [1n]);
    assert.equal((await f.request('/intent', 'POST', { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST, nonce: 0,
      pool, data, value: '100' }, cookie, alice.address)).status, 503);
    assert.equal((await f.request('/intent', 'GET', undefined, cookie, alice.address)).body.intent, null);
  } finally { await f.close(); }
});

test('raw RPC chain ID change blocks config and transaction intents even with reviewed bytecode', async () => {
  const f = await fixture(), alice = Wallet.createRandom();
  try {
    assert.equal((await f.request('/config')).status, 200);
    const cookie = await f.signIn(alice);
    f.provider.setChain(97);
    assert.equal((await f.request('/config')).status, 200, 'read-only config may remain cached for 10 seconds');
    const data = abi.PoolVault.encodeFunctionData('deposit', [1n]);
    assert.equal((await f.request('/intent', 'POST', { account: alice.address, chainId: 56,
      artifactDigest: ARTIFACT_DIGEST, nonce: 0, pool, data, value: '100' }, cookie, alice.address)).status, 503);
    f.provider.setChain(56);
    assert.equal((await f.request('/intent', 'GET', undefined, cookie, alice.address)).body.intent, null);
  } finally { await f.close(); }
});

test('pending transaction is restored from SQLite after server restart and new wallet login', async () => {
  const f = await fixture(), alice = Wallet.createRandom();
  try {
    const cookie = await f.signIn(alice), data = abi.PoolVault.encodeFunctionData('withdrawBnb');
    const saved = await f.request('/intent', 'POST', { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST, nonce: 0,
      pool, data, value: '0' }, cookie, alice.address);
    assert.equal(saved.status, 201);
    await f.reopen();
    assert.equal((await f.request('/intent', 'GET', undefined, cookie, alice.address)).status, 401);
    const newCookie = await f.signIn(alice);
    const restored = await f.request('/intent', 'GET', undefined, newCookie, alice.address);
    assert.equal(restored.body.intent.id, saved.body.intent.id);
    assert.equal(restored.body.intent.status, 'prepared');
  } finally { await f.close(); }
});

test('prepared intent can be abandoned without a wallet transaction; armed intent cannot', async () => {
  const f = await fixture(), alice = Wallet.createRandom();
  try {
    const cookie = await f.signIn(alice), data = abi.PoolVault.encodeFunctionData('claim');
    const input = { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST,
      nonce: 0, pool, data, value: '0' };
    const first = await f.request('/intent', 'POST', input, cookie, alice.address);
    assert.equal(first.status, 201);
    assert.equal((await f.request('/hash', 'POST', { id: first.body.intent.id, hash: hexHash(1) }, cookie, alice.address)).status, 409);
    assert.equal((await f.request('/abandon', 'POST', { id: first.body.intent.id }, cookie, alice.address)).body.intent.status, 'abandoned');
    const second = await f.request('/intent', 'POST', input, cookie, alice.address);
    assert.equal(second.status, 201);
    assert.equal((await f.request('/arm', 'POST', { id: second.body.intent.id }, cookie, alice.address)).status, 200);
    assert.equal((await f.request('/abandon', 'POST', { id: second.body.intent.id }, cookie, alice.address)).status, 409);
  } finally { await f.close(); }
});

test('ShareMarket listing uses the same wallet journal and only its exact target receipt completes it', async () => {
  const f = await fixture(), alice = Wallet.createRandom();
  try {
    const cookie = await f.signIn(alice), data = abi.ShareMarket.encodeFunctionData('list', [pool, 100n, 20n]);
    const input = { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST,
      target: market, pool, nonce: 0, data, value: '0' };
    const saved = await f.request('/intent', 'POST', input, cookie, alice.address);
    assert.equal(saved.status, 201); assert.equal(saved.body.intent.action, 'market:list');
    assert.equal(saved.body.intent.target, market.toLowerCase());
    const poolData = abi.PoolVault.encodeFunctionData('deposit', [1n]);
    assert.equal((await f.request('/intent', 'POST', { ...input, target: pool, data: poolData, value: '100' }, cookie, alice.address)).status, 409);
    assert.equal((await f.request('/arm', 'POST', { id: saved.body.intent.id }, cookie, alice.address)).status, 200);
    const hash = hexHash(900);
    f.provider.transactions.set(hash, { hash, from: alice.address, nonce: 0, chainId: 56n,
      to: pool, data, value: 0n, blockNumber: 12, blockHash: hexHash(12) });
    f.provider.receipts.set(hash, { hash, from: alice.address, blockNumber: 12, blockHash: hexHash(12), status: 1 });
    f.provider.setFinalized(12);
    assert.equal((await f.request('/hash', 'POST', { id: saved.body.intent.id, hash }, cookie, alice.address)).body.intent.status, 'replaced');
    f.provider.setNonce(1);
    const next = await f.request('/intent', 'POST', { ...input, nonce: 1 }, cookie, alice.address);
    assert.equal(next.status, 201);
    assert.equal((await f.request('/arm', 'POST', { id: next.body.intent.id }, cookie, alice.address)).status, 200);
    const marketHash = hexHash(901);
    f.provider.transactions.set(marketHash, { hash: marketHash, from: alice.address, nonce: 1, chainId: 56n,
      to: market, data, value: 0n, blockNumber: 13, blockHash: hexHash(13) });
    f.provider.receipts.set(marketHash, { hash: marketHash, from: alice.address, blockNumber: 13, blockHash: hexHash(13), status: 1 });
    f.provider.setFinalized(13);
    assert.equal((await f.request('/hash', 'POST', { id: next.body.intent.id, hash: marketHash }, cookie, alice.address)).body.intent.status, 'complete');
  } finally { await f.close(); }
});

test('ShareMarket fill binds order, seller, unit price, pool, quantity and exact BNB', async () => {
  const f = await fixture(), buyer = Wallet.createRandom(), seller = Wallet.createRandom();
  try {
    f.provider.orders.set('7', { seller: seller.address, pool, remaining: 20n, pricePerUnit: 10n, active: true, expiresAt: 2000n });
    const cookie = await f.signIn(buyer), data = abi.ShareMarket.encodeFunctionData('fill', [7n, 10n]);
    const input = { account: buyer.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST,
      target: market, pool, nonce: 0, data, value: '101', expected: { seller: seller.address, pricePerUnitWei: '10' } };
    assert.equal((await f.request('/intent', 'POST', { ...input, value: '100' }, cookie, buyer.address)).status, 400);
    assert.equal((await f.request('/intent', 'POST', { ...input, value: '102' }, cookie, buyer.address)).status, 400);
    assert.equal((await f.request('/intent', 'POST', { ...input, pool: addr(50) }, cookie, buyer.address)).status, 409);
    assert.equal((await f.request('/intent', 'POST', { ...input, expected: { ...input.expected, pricePerUnitWei: '11' } }, cookie, buyer.address)).status, 409);
    assert.equal((await f.request('/intent', 'POST', { ...input, expected: { ...input.expected, seller: buyer.address } }, cookie, buyer.address)).status, 409);
    assert.equal((await f.request('/intent', 'POST', { ...input, data: abi.ShareMarket.encodeFunctionData('fill', [7n, 21n]), value: '212' }, cookie, buyer.address)).status, 400);
    const saved = await f.request('/intent', 'POST', input, cookie, buyer.address);
    assert.equal(saved.status, 201); assert.equal(saved.body.intent.action, 'market:fill');
    f.provider.orders.get('7').remaining = 9n;
    assert.equal((await f.request('/arm', 'POST', { id: saved.body.intent.id }, cookie, buyer.address)).status, 400);
    assert.equal((await f.request('/abandon', 'POST', { id: saved.body.intent.id }, cookie, buyer.address)).body.intent.status, 'abandoned');
  } finally { await f.close(); }
});

test('legacy live API rejects new listings and fills when the buyer fee version is absent', async () => {
  const f = await fixture(), buyer = Wallet.createRandom(), seller = Wallet.createRandom();
  try {
    f.provider.orders.set('7', { seller: seller.address, pool, remaining: 20n, pricePerUnit: 10n, active: true, expiresAt: 2000n });
    const cookie = await f.signIn(buyer);
    const base = { account: buyer.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST,
      target: market, pool, nonce: 0 };
    const listing = { ...base, data: abi.ShareMarket.encodeFunctionData('list', [pool, 1n, 10n]), value: '0' };
    const fill = { ...base, data: abi.ShareMarket.encodeFunctionData('fill', [7n, 10n]), value: '101',
      expected: { seller: seller.address, pricePerUnitWei: '10' } };
    f.provider.setBuyerFeeBps(null);
    assert.equal((await f.request('/intent', 'POST', listing, cookie, buyer.address)).status, 503);
    assert.equal((await f.request('/intent', 'POST', fill, cookie, buyer.address)).status, 503);
    f.provider.setBuyerFeeBps(200n);
    assert.equal((await f.request('/intent', 'POST', fill, cookie, buyer.address)).status, 503);
  } finally { await f.close(); }
});

test('ShareMarket cancel, expiry and BNB credit each enforce exact current eligibility', async () => {
  const f = await fixture(), seller = Wallet.createRandom(), other = Wallet.createRandom();
  try {
    f.provider.orders.set('8', { seller: seller.address, pool, remaining: 2n, pricePerUnit: 10n, active: true, expiresAt: 2000n });
    const sellerCookie = await f.signIn(seller), otherCookie = await f.signIn(other);
    const base = { chainId: 56, artifactDigest: ARTIFACT_DIGEST, target: market, pool, nonce: 0, value: '0' };
    const cancel = abi.ShareMarket.encodeFunctionData('cancel', [8n]);
    assert.equal((await f.request('/intent', 'POST', { ...base, account: other.address, data: cancel }, otherCookie, other.address)).status, 403);
    const saved = await f.request('/intent', 'POST', { ...base, account: seller.address, data: cancel }, sellerCookie, seller.address);
    assert.equal(saved.status, 201); assert.equal(saved.body.intent.action, 'market:cancel');
    assert.equal((await f.request('/abandon', 'POST', { id: saved.body.intent.id }, sellerCookie, seller.address)).status, 200);
    const expire = abi.ShareMarket.encodeFunctionData('expire', [8n]);
    assert.equal((await f.request('/intent', 'POST', { ...base, account: other.address, data: expire }, otherCookie, other.address)).status, 409);
    f.provider.orders.get('8').expiresAt = 900n;
    const expired = await f.request('/intent', 'POST', { ...base, account: other.address, data: expire }, otherCookie, other.address);
    assert.equal(expired.status, 201); assert.equal(expired.body.intent.action, 'market:expire');
    const withdrawal = await f.request('/intent', 'POST', { ...base, account: seller.address, pool: market,
      data: abi.ShareMarket.encodeFunctionData('withdrawBnb') }, sellerCookie, seller.address);
    assert.equal(withdrawal.status, 201); assert.equal(withdrawal.body.intent.action, 'market:withdrawBnb');
  } finally { await f.close(); }
});

test('sale governance journal admits only exact current proposal, vote and execution calldata', async () => {
  const f = await fixture(), alice = Wallet.createRandom();
  try {
    f.provider.setTimestamp(1000000);
    const cookie = await f.signIn(alice);
    const base = { account: alice.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST,
      target: pool, pool, nonce: 0, value: '0' };
    const propose = abi.PoolVault.encodeFunctionData('propose', [10000n, 10000n, 999900n]);
    assert.equal((await f.request('/intent', 'POST', { ...base, data: propose, value: '1' }, cookie, alice.address)).status, 409);
    assert.equal((await f.request('/intent', 'POST', { ...base,
      data: abi.PoolVault.encodeFunctionData('propose', [10000n, 10000n, 1000001n]) }, cookie, alice.address)).status, 409);
    const proposal = await f.request('/intent', 'POST', { ...base, data: propose }, cookie, alice.address);
    assert.equal(proposal.status, 201); assert.equal(proposal.body.intent.action, 'governance:propose');
    assert.equal((await f.request('/abandon', 'POST', { id: proposal.body.intent.id }, cookie, alice.address)).status, 200);
    const vote = await f.request('/intent', 'POST', { ...base,
      data: abi.PoolVault.encodeFunctionData('vote', [2n, true]) }, cookie, alice.address);
    assert.equal(vote.status, 201); assert.equal(vote.body.intent.action, 'governance:vote');
    assert.equal((await f.request('/abandon', 'POST', { id: vote.body.intent.id }, cookie, alice.address)).status, 200);
    const execute = await f.request('/intent', 'POST', { ...base,
      data: abi.PoolVault.encodeFunctionData('executeSale', [2n]) }, cookie, alice.address);
    assert.equal(execute.status, 201); assert.equal(execute.body.intent.action, 'governance:executeSale');
    assert.equal((await f.request('/abandon', 'POST', { id: execute.body.intent.id }, cookie, alice.address)).status, 200);
    assert.equal((await f.request('/intent', 'POST', { ...base,
      data: abi.PoolVault.encodeFunctionData('vote', [3n, true]) }, cookie, alice.address)).status, 409);
  } finally { await f.close(); }
});

test('whole-miner completion requires exact sale BNB; expiry unlock is a separate zero-value action', async () => {
  const f = await fixture(), buyer = Wallet.createRandom();
  try {
    f.provider.setTimestamp(1000000); f.provider.setPoolState(3n);
    f.provider.proposals.set('2', { proposer: addr(55), snapshotTs: 999900n,
      endsAt: 1086300n, refAt: 999800n, price: 10000n, refPrice: 10000n,
      snapshotMemberCount: 1n, snapshotTotalShares: 100n, yesCount: 1n, yesShares: 100n, executed: true });
    const cookie = await f.signIn(buyer);
    const base = { account: buyer.address, chainId: 56, artifactDigest: ARTIFACT_DIGEST,
      target: pool, pool, nonce: 0 };
    const finish = abi.PoolVault.encodeFunctionData('completeFirstoSale', [2,10000,100,1]);
    assert.equal((await f.request('/intent', 'POST', { ...base, data: finish, value: '9999' }, cookie, buyer.address)).status, 409);
    const saved = await f.request('/intent', 'POST', { ...base, data: finish, value: '10100' }, cookie, buyer.address);
    assert.equal(saved.status, 201); assert.equal(saved.body.intent.action, 'governance:completeFirstoSale');
    f.provider.setSale({ price: 10001n });
    assert.equal((await f.request('/arm', 'POST', { id: saved.body.intent.id }, cookie, buyer.address)).status, 409);
    assert.equal((await f.request('/abandon', 'POST', { id: saved.body.intent.id }, cookie, buyer.address)).status, 200);
    f.provider.setTimestamp(1000101);
    const cancel = await f.request('/intent', 'POST', { ...base,
      data: abi.PoolVault.encodeFunctionData('cancelExpired'), value: '0' }, cookie, buyer.address);
    assert.equal(cancel.status, 201); assert.equal(cancel.body.intent.action, 'governance:cancelExpired');
  } finally { await f.close(); }
});
