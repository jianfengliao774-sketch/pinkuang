import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Wallet, getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { AUTHORITY_NONCE_CACHE_MS, prefetchAuthorityNonce, invalidateAuthorityNonce,
  prepareAuthoritySignature, signPreparedAuthorityAction, signAuthorityAction } from '../lib/authority-client.mjs';

const admin = new Wallet('0x' + '11'.repeat(32)); // Public offline fixture only.
const address = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const nonceAbi = new Interface(['function nonces(address) view returns(uint256)']);
const config = { displayOnly: true, status: 'ready', stage: 'fresh-active', chainId: 56,
  authority: address(1), factory: address(2), portfolioFactory: address(3),
  freshAuthority: { address: address(1), codehash: '0x' + 'aa'.repeat(32) } };
const args = { target: config.factory, data: abi.PoolFactory.encodeFunctionData('createPool', [{
  circuits: address(4), circuitId: 7223n, targetRaise: 11000n, priceCap: 10000n,
  directSeller: address(0), directPrice: 0n, fundingDeadline: 1800001000n, purchaseDeadline: 1800002000n }]) };
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const events = [];
  const provider = { request: async ({ method, params }) => {
    events.push('wallet:' + method); assert.equal(method, 'eth_signTypedData_v4');
    const payload = JSON.parse(params[1]), { EIP712Domain, ...types } = payload.types;
    return admin.signTypedData(payload.domain, types, payload.message);
  } };
  const readProvider = { request: async ({ method, params }) => {
    events.push('nonce'); assert.equal(method, 'eth_call'); assert.equal(params[1], 'latest');
    assert.equal(nonceAbi.parseTransaction(params[0]).name, 'nonces');
    return nonceAbi.encodeFunctionResult('nonces', [9n]);
  } };
  return { events, input: { provider, readProvider, config, account: admin.address, kind: 'executeApprovedOperation', args } };
}

test('one workbench prefetch makes later preview and signing independent of a hung RPC', async () => {
  const f = fixture(); assert.equal(await prefetchAuthorityNonce(f.input), 9n);
  f.events.length = 0;
  const input = { ...f.input, readProvider: { request: () => new Promise(() => {}) } };
  const prepared = await prepareAuthoritySignature(input), work = signPreparedAuthorityAction({ ...input, prepared });
  assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4'], 'Wallet request happens synchronously at confirmation.');
  assert.equal((await work).nonce, '9');
});

test('nonce prefetch has a 30-second TTL and performs no timer-based refresh', async t => {
  let clock = 1800000000000; t.mock.method(Date, 'now', () => clock);
  const f = fixture(); await prefetchAuthorityNonce(f.input);
  clock += AUTHORITY_NONCE_CACHE_MS - 1; await prefetchAuthorityNonce(f.input);
  assert.deepEqual(f.events, ['nonce']);
  clock++; await turn(); assert.deepEqual(f.events, ['nonce'], 'Expiry alone never reads the paid API.');
  await prefetchAuthorityNonce(f.input); assert.deepEqual(f.events, ['nonce', 'nonce']);
});

test('in-flight prefetch and preview share a single nonce request', async () => {
  const f = fixture(), gate = deferred(); let reads = 0;
  const input = { ...f.input, readProvider: { request: async call => { reads++; await gate.promise; return f.input.readProvider.request(call); } } };
  const warm = prefetchAuthorityNonce(input), preview = prepareAuthoritySignature(input);
  await turn(); assert.equal(reads, 1); gate.resolve(); await warm; await preview;
  assert.deepEqual(f.events, ['nonce']);
});

test('wallet provider, selected account, factory and Authority pins cannot reuse another cache', async () => {
  const f = fixture(); await prefetchAuthorityNonce(f.input);
  for (const changed of [
    { provider: { request: f.input.provider.request } }, { account: address(99) },
    { config: { ...config, factory: address(99) } },
    { config: { ...config, freshAuthority: { ...config.freshAuthority, codehash: '0x' + 'bb'.repeat(32) } } },
  ]) {
    await assert.rejects(prefetchAuthorityNonce({ ...f.input, ...changed,
      readProvider: { request: async () => { throw Error('new identity must read its own nonce'); } } }), /own nonce/);
  }
  assert.deepEqual(f.events, ['nonce']);
});

test('opening one wallet request consumes sibling prepared tokens and invalidates cached nonce even on rejection', async () => {
  const f = fixture(), input = { ...f.input, provider: { request: async () => { f.events.push('wallet'); throw Error('denied'); } } };
  const first = await prepareAuthoritySignature(input), second = await prepareAuthoritySignature(input);
  await assert.rejects(signPreparedAuthorityAction({ ...input, prepared: first }), /denied/);
  await assert.rejects(signPreparedAuthorityAction({ ...input, prepared: second }), /序号已发起/);
  assert.deepEqual(f.events, ['nonce', 'wallet']);
  await prefetchAuthorityNonce(input); assert.deepEqual(f.events, ['nonce', 'wallet', 'nonce']);
});

test('explicit invalidation retires prepared tokens and a late unfinished prefetch cannot refill them', async () => {
  const f = fixture(), prepared = await prepareAuthoritySignature(f.input);
  invalidateAuthorityNonce(f.input);
  await assert.rejects(signPreparedAuthorityAction({ ...f.input, prepared }), /序号已发起/);
  const gate = deferred(), input = { ...f.input, readProvider: { request: async call => { await gate.promise; return f.input.readProvider.request(call); } } };
  const pending = prefetchAuthorityNonce(input); await turn(); invalidateAuthorityNonce(input); gate.resolve();
  await assert.rejects(pending, /序号已改变/); assert(!f.events.some(value => value.startsWith('wallet:')));
});

test('a canceled prefetch cannot cache a late nonce or open the wallet', async () => {
  const f = fixture(), controller = new AbortController(), gate = deferred();
  const input = { ...f.input, signal: controller.signal,
    readProvider: { request: async call => { await gate.promise; return f.input.readProvider.request(call); } } };
  const work = prefetchAuthorityNonce(input); await turn(); controller.abort();
  await assert.rejects(work, error => error.code === 'read_cancelled'); gate.resolve(); await turn();
  await prefetchAuthorityNonce(f.input); assert.deepEqual(f.events, ['nonce', 'nonce']);
});

test('approvals use a prefetched nonce without waiting for a status check or new read', async () => {
  const f = fixture(); await prefetchAuthorityNonce(f.input); f.events.length = 0;
  const work = signAuthorityAction({ ...f.input, kind: 'reviewSale',
    args: { market: address(5), pool: address(6), proposalId: '1', priceWei: '1000', approved: true },
    readProvider: { request: () => assert.fail('review must reuse the nonce') } });
  await turn(); assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4']); assert.equal((await work).nonce, '9');
});
