import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, getAddress, ZeroAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { prepareAuthoritySubmission, signAuthorityAction, prepareAuthoritySignature,
  signPreparedAuthorityAction, authorityCommandData, authorityOperationId, authorityStatusForRequest,
  submitAuthorityAction, prefetchAuthorityNonce, invalidateAuthorityNonce, AUTHORITY_NONCE_CACHE_MS } from '../lib/authority-client.mjs';
import { prepareAuthorityCall } from '../../deploy/scripts/authority-relay.mjs';
import { boundedReadPreview } from '../lib/bounded-read-preview.mjs';

const signer = new Wallet('0x' + '11'.repeat(32));
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const authority = addr(21), core = addr(22), nonceAbi = new Interface(['function nonces(address) view returns(uint256)']);
const registryAbi = new Interface(['function machinePool(address,uint256) view returns(address)']);
const config = { displayOnly: true, status: 'ready', stage: 'fresh-active', authority,
  factory: core,
  freshAuthority: { address: authority, codehash: '0x' + 'aa'.repeat(32) } };
const args = { target: core, data: abi.PoolFactory.encodeFunctionData('createPool', [{ circuits: addr(23),
  circuitId: 7, targetRaise: 11000, priceCap: 10000, directSeller: addr(0), directPrice: 0,
  fundingDeadline: 1800001000, purchaseDeadline: 1800002000 }]) };
function fixture({ pool = ZeroAddress } = {}) {
  const events = [], payloads = [];
  const readProvider = { request: async ({ method, params }) => {
    assert.equal(method, 'eth_call'); assert.equal(params[1], 'latest');
    if (params[0].to === core) {
      const call = registryAbi.parseTransaction(params[0]);
      events.push('read:machinePool'); assert.equal(call.name, 'machinePool');
      assert.equal(call.args[0], addr(23)); assert.equal(call.args[1], 7n);
      return registryAbi.encodeFunctionResult('machinePool', [pool]);
    }
    events.push('read:nonces'); assert.equal(params[0].to, authority);
    assert.equal(nonceAbi.parseTransaction(params[0]).name, 'nonces');
    return nonceAbi.encodeFunctionResult('nonces', [9]);
  } };
  const provider = { request: async ({ method, params }) => {
    events.push('wallet:' + method); assert.equal(method, 'eth_signTypedData_v4');
    const payload = JSON.parse(params[1]), { EIP712Domain, ...types } = payload.types;
    payloads.push(payload);
    return signer.signTypedData(payload.domain, types, payload.message);
  } };
  return { events, payloads, input: { provider, readProvider, config, account: signer.address,
    kind: 'executeApprovedOperation', args } };
}

test('wallet receives the exact signature before any slow session request; no simulation or status preflight', async () => {
  const f = fixture(); let releaseLogin;
  const loginWait = new Promise(resolve => { releaseLogin = resolve; });
  let loginStarted;
  const started = new Promise(resolve => { loginStarted = resolve; });
  const work = prepareAuthoritySubmission({ ...f.input, authenticate: async () => {
    f.events.push('authenticate'); loginStarted(); await loginWait;
  } });
  await started;
  assert.deepEqual(f.events, ['read:nonces', 'wallet:eth_signTypedData_v4', 'authenticate']);
  releaseLogin();
  const command = await work;
  assert.equal(command.nonce, '9'); assert.deepEqual(command.args, args);
});

test('a slow nonce read fails before signature; its late response cannot open a wallet request', async () => {
  const f = fixture(); const finishes = [];
  const work = signAuthorityAction({ ...f.input, readTimeoutMs: 20,
    readProvider: { request: input => new Promise(resolve => { finishes.push(() => f.input.readProvider.request(input).then(resolve)); }) } });
  await assert.rejects(work, error => error.code === 'read_timeout');
  finishes.forEach(finish => finish());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, ['read:nonces']);
});

test('the read deadline never abandons or duplicates an outstanding wallet signature', async () => {
  const f = fixture(); let releaseSignature, opened;
  const opening = new Promise(resolve => { opened = resolve; });
  const signatureWait = new Promise(resolve => { releaseSignature = resolve; });
  let calls = 0, done = false;
  const work = signAuthorityAction({ ...f.input, readTimeoutMs: 20, provider: { request: async input => {
    calls++; opened(); await signatureWait; return f.input.provider.request(input);
  } } }).then(result => { done = true; return result; });
  await opening;
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(done, false); assert.equal(calls, 1);
  releaseSignature(); await work;
});

test('wallet changes before the read finishes prevent a late signature, and session failure returns no command', async () => {
  const f = fixture(); const finishes = []; let current = true;
  const work = signAuthorityAction({ ...f.input, isCurrent: () => current,
    readProvider: { request: input => new Promise(resolve => { finishes.push(() => f.input.readProvider.request(input).then(resolve)); }) } });
  await new Promise(resolve => setImmediate(resolve)); current = false;
  finishes.forEach(finish => finish());
  await assert.rejects(work, error => error.code === 'read_cancelled');
  assert.deepEqual(f.events, ['read:nonces']);
  await assert.rejects(prepareAuthoritySubmission({ ...f.input, authenticate: async () => { throw Error('session offline'); } }), /session offline/);
});

test('all core creation selectors skip browser reservation reads and keep exact signed calldata', async () => {
  const params = abi.PoolFactory.parseTransaction({ data: args.data }).args[0];
  const flexible = { minVerifiedWeight: 12n, referencePriceWei: 70000n,
    targetDailyYieldAtomic: 456n, extraBps: 800n, referenceObservedAt: 1800000000n,
    referenceBlock: 123456n, referenceDigest: '0x' + 'ab'.repeat(32) };
  for (const [name, values] of [['createPool', [params]], ['createPoolWithExpiry', [params, false]],
    ['createBudgetChildPool', [params, addr(25)]], ['createFlexiblePool', [params, flexible]],
    ['createFlexiblePoolChecked', [params, flexible, 42, 12]]]) {
    const f = fixture({ pool: addr(24) });
    const exactArgs = { target: core, data: abi.PoolFactory.encodeFunctionData(name, values) };
    const command = await signAuthorityAction({ ...f.input, args: exactArgs });
    assert.equal(command.args.data, exactArgs.data);
    assert.deepEqual(f.events, ['read:nonces', 'wallet:eth_signTypedData_v4']);
  }
});

test('noncreation approvals read only the nonce and no miner registry', async () => {
  const f = fixture();
  await signAuthorityAction({ ...f.input, kind: 'claimFees',
    args: { markets: [], pools: [], recipient: signer.address } });
  assert.deepEqual(f.events, ['read:nonces', 'wallet:eth_signTypedData_v4']);
});

test('preview prepares an opaque exact payload; confirmation signs with zero read RPC and agrees with the relay', async () => {
  const f = fixture(), prepared = await prepareAuthoritySignature(f.input);
  assert(Object.isFrozen(prepared)); assert.deepEqual(Object.keys(prepared), []);
  assert.deepEqual(f.events, ['read:nonces']);
  f.events.length = 0;
  const command = await prepareAuthoritySubmission({ ...f.input, prepared,
    config: structuredClone(config), args: { data: args.data, target: args.target },
    readProvider: { request: () => assert.fail('confirmation must not read') },
    authenticate: async () => { f.events.push('authenticate'); } });
  assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4', 'authenticate']);
  assert.equal(command.nonce, '9'); assert.deepEqual(command.args, args);
  const relay = prepareAuthorityCall(command);
  assert.equal(relay.signer, signer.address);
  assert.deepEqual(relay.domain, f.payloads[0].domain);
  assert.equal(relay.primaryType, f.payloads[0].primaryType);
  assert.deepEqual(relay.value, f.payloads[0].message);
  assert.equal(f.payloads[0].message.params.circuitId, '7');
  assert.equal(f.payloads[0].message.params.targetRaise, '11000');
});

test('prepared signatures reject forged or serialized tokens and changes to wallet, config or exact arguments', async () => {
  for (const changed of ['provider', 'account', 'authority', 'factory', 'kind', 'args']) {
    const f = fixture(), prepared = await prepareAuthoritySignature(f.input);
    const input = { ...f.input, prepared };
    if (changed === 'provider') input.provider = { request: f.input.provider.request };
    if (changed === 'account') input.account = addr(99);
    if (changed === 'authority') input.config = { ...config, authority: addr(99) };
    if (changed === 'factory') input.config = { ...config, factory: addr(99) };
    if (changed === 'kind') input.kind = 'claimFees';
    if (changed === 'args') input.args = { ...args, target: addr(99) };
    await assert.rejects(signPreparedAuthorityAction(input), /与预览不同/);
    await assert.rejects(signPreparedAuthorityAction({ ...f.input, prepared }), /失效或已使用/);
    assert.deepEqual(f.events, ['read:nonces']);
  }
  const f = fixture(), prepared = await prepareAuthoritySignature(f.input);
  for (const forged of [{}, JSON.parse(JSON.stringify(prepared)), undefined, null]) {
    await assert.rejects(signPreparedAuthorityAction({ ...f.input, prepared: forged }), /失效或已使用/);
  }
  assert.deepEqual(f.events, ['read:nonces']);
});

test('a prepared token is consumed before a pending, rejected or unknown wallet request and cannot sign twice', async () => {
  const f = fixture(); let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const input = { ...f.input, provider: { request: async request => { await gate; return f.input.provider.request(request); } } };
  const prepared = await prepareAuthoritySignature(input), signing = signPreparedAuthorityAction({ ...input, prepared });
  await assert.rejects(signPreparedAuthorityAction({ ...input, prepared }), /失效或已使用/);
  finish(); await signing;
  assert.equal(f.events.filter(event => event.startsWith('wallet:')).length, 1);
  for (const reason of [Object.assign(Error('denied'), { code: 4001 }), Error('wallet result unknown')]) {
    let calls = 0;
    const input = { ...f.input, provider: { request: async () => { calls++; throw reason; } } };
    const prepared = await prepareAuthoritySignature(input);
    await assert.rejects(signPreparedAuthorityAction({ ...input, prepared }), error => error === reason);
    await assert.rejects(signPreparedAuthorityAction({ ...input, prepared }), /失效或已使用/);
    assert.equal(calls, 1);
  }
});

test('prepared lifetime is five minutes by default, bounded by the signature deadline and ten-minute maximum', async t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(), before = await prepareAuthoritySignature(f.input);
  now += 299999;
  await signPreparedAuthorityAction({ ...f.input, prepared: before });
  const expired = await prepareAuthoritySignature(f.input);
  now += 300000;
  await assert.rejects(signPreparedAuthorityAction({ ...f.input, prepared: expired }), /过期/);
  const short = await prepareAuthoritySignature({ ...f.input, validitySeconds: 1 });
  now += 1000;
  await assert.rejects(signPreparedAuthorityAction({ ...f.input, prepared: short }), /过期/);
  await assert.rejects(prepareAuthoritySignature({ ...f.input, cacheLifetimeMs: 600001 }), /有效期/);
  assert.equal(f.events.filter(event => event.startsWith('wallet:')).length, 1);
});

test('both preview and confirmation epochs remain binding after preparation', async () => {
  for (const change of ['preview', 'confirm', 'onState']) {
    const f = fixture(), controller = new AbortController(); let previewCurrent = true, confirmCurrent = true;
    const prepared = await prepareAuthoritySignature({ ...f.input, signal: controller.signal, isCurrent: () => previewCurrent });
    if (change === 'preview') previewCurrent = false;
    if (change === 'confirm') confirmCurrent = false;
    await assert.rejects(signPreparedAuthorityAction({ ...f.input, prepared, isCurrent: () => confirmCurrent,
      onState: () => { if (change === 'onState') confirmCurrent = false; } }), /已改变/);
    assert.deepEqual(f.events, ['read:nonces']);
  }
});

test('successful outer read cleanup can abort its signal without invalidating the prepared signature', async () => {
  const f = fixture(); let readSignal;
  const prepared = await boundedReadPreview(({ provider, signal }) => {
    readSignal = signal;
    return prepareAuthoritySignature({ ...f.input, readProvider: provider, signal });
  }, { provider: f.input.readProvider });
  assert.equal(readSignal.aborted, true, 'the outer preview always aborts its read signal during cleanup');
  assert.deepEqual(f.events, ['read:nonces']);
  f.events.length = 0;
  const command = await signPreparedAuthorityAction({ ...f.input, prepared,
    readProvider: { request: () => assert.fail('confirmation must not read') } });
  assert.equal(command.nonce, '9');
  assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4']);
});

test('aborted or malformed nonce preparation never produces a token or opens the wallet', async () => {
  const f = fixture(), controller = new AbortController(), finish = [];
  const work = prepareAuthoritySignature({ ...f.input, signal: controller.signal,
    readProvider: { request: input => new Promise(resolve => finish.push(() => f.input.readProvider.request(input).then(resolve))) } });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(work, error => error.code === 'read_cancelled');
  finish.forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, ['read:nonces']);
  await assert.rejects(prepareAuthoritySignature({ ...f.input, readProvider: { request: async input =>
    input.params[0].to === authority ? '0x' : registryAbi.encodeFunctionResult('machinePool', [ZeroAddress]) } }));
  assert.equal(f.events.filter(event => event.startsWith('wallet:')).length, 0);
});

test('a failed post-signature login cannot refresh the nonce or reuse the prepared token', async () => {
  const f = fixture(), prepared = await prepareAuthoritySignature(f.input);
  f.events.length = 0;
  await assert.rejects(prepareAuthoritySubmission({ ...f.input, prepared,
    authenticate: async () => { throw Error('session unavailable'); } }), /session unavailable/);
  await assert.rejects(prepareAuthoritySubmission({ ...f.input, prepared,
    authenticate: async () => assert.fail('used token cannot authenticate') }), /失效或已使用/);
  assert.deepEqual(f.events, ['wallet:eth_signTypedData_v4']);
});

test('mutations during a preview or an open wallet cannot substitute another operation', async () => {
  const f = fixture(), mutableConfig = structuredClone(config), mutableArgs = structuredClone(args);
  await assert.rejects(prepareAuthoritySignature({ ...f.input, config: mutableConfig, args: mutableArgs,
    readProvider: { request: async request => { mutableConfig.factory = addr(99); return f.input.readProvider.request(request); } } }), /已改变/);
  const argsAtClick = structuredClone(args);
  const input = { ...f.input, args: argsAtClick, provider: { request: async request => {
    const signature = await f.input.provider.request(request); argsAtClick.target = addr(99); return signature;
  } } };
  const prepared = await prepareAuthoritySignature(input);
  await assert.rejects(signPreparedAuthorityAction({ ...input, prepared }), /与预览不同/);
  assert.equal(f.events.filter(event => event.startsWith('wallet:')).length, 1);
});

test('nonce changes after preview do not silently refresh or replace the exact cached authorization', async () => {
  const f = fixture(), prepared = await prepareAuthoritySignature(f.input);
  f.input.readProvider.request = () => assert.fail('a nonce conflict is for the relay/chain, not a second browser read');
  const command = await signPreparedAuthorityAction({ ...f.input, prepared });
  assert.equal(command.nonce, '9');
  assert.equal(f.payloads[0].message.nonce, '9');
  await assert.rejects(signPreparedAuthorityAction({ ...f.input, prepared }), /失效或已使用/);
  assert.equal(f.events.filter(event => event.startsWith('wallet:')).length, 1);
});

test('cache expiry does not abandon an open wallet, but an expired signed deadline returns no command', async t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  for (const duration of [300001, 600001]) {
    const f = fixture(); let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    const input = { ...f.input, provider: { request: async request => { await gate; return f.input.provider.request(request); } } };
    const prepared = await prepareAuthoritySignature(input), work = signPreparedAuthorityAction({ ...input, prepared });
    now += duration; finish();
    if (duration < 600000) assert.equal((await work).nonce, '9');
    else await assert.rejects(work, /签名已过期/);
    assert.equal(f.events.filter(event => event.startsWith('wallet:')).length, 1);
    await assert.rejects(signPreparedAuthorityAction({ ...input, prepared }), /失效或已使用/);
  }
});

test('prepared command retains the production operation ID and exact-request recovery binding', async () => {
  const f = fixture(), prepared = await prepareAuthoritySignature(f.input);
  const command = await signPreparedAuthorityAction({ ...f.input, prepared });
  assert.equal(authorityCommandData(command), prepareAuthorityCall(command).data);
  const id = authorityOperationId(command), hash = '0x' + '31'.repeat(32);
  const status = { operationId: id, hash, status: 'confirmed' };
  assert.equal(authorityStatusForRequest(status, id, hash), status);
  assert.equal(authorityStatusForRequest(status, '0x' + '32'.repeat(32)), null);
  assert.equal(authorityStatusForRequest(status, id, '0x' + '33'.repeat(32)), null);
  assert.equal(authorityStatusForRequest({ hash, status: 'confirmed' }, id), null);
  // A retry can reuse an on-chain nonce after a reverted execution. It must not inherit the prior request's result.
  for (const changed of [{ nonce: '10' }, { deadline: String(BigInt(command.deadline) + 1n) },
    { authority: addr(99) }, { signature: '0x' + '12'.repeat(65) }])
    assert.notEqual(authorityOperationId({ ...command, ...changed }), id);
});

test('relay success must acknowledge this complete signed request, accepted=true and its exact operation/hash', async t => {
  const f = fixture(), prepared = await prepareAuthoritySignature(f.input);
  const command = await signPreparedAuthorityAction({ ...f.input, prepared });
  const requestId = authorityOperationId(command), hash = '0x' + '41'.repeat(32);
  const accepted = { requestId, operationId: requestId, accepted: true, hash, status: 'broadcast' };
  let body = accepted, requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++; assert.equal(url, '/api/journal/authority-relay'); assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { command });
    return { ok: true, status: 200, json: async () => body };
  });
  assert.deepEqual(await submitAuthorityAction(config, signer.address, command), accepted);
  for (const changed of [{ requestId: '0x' + '42'.repeat(32) }, { operationId: '0x' + '43'.repeat(32) },
    { operationId: undefined }, { hash: undefined }, { hash: 'invalid' }, { accepted: undefined }]) {
    body = { ...accepted, ...changed };
    await assert.rejects(submitAuthorityAction(config, signer.address, command), error =>
      error.submissionRejected !== true && /本次/.test(error.message));
  }
  assert.equal(requests, 7, 'one POST per explicit call, without retries');
});

test('production relay rejection metadata survives without exposing signed command and does not cause re-signing', async t => {
  const f = fixture(), prepared = await prepareAuthoritySignature(f.input);
  const command = await signPreparedAuthorityAction({ ...f.input, prepared });
  const requestId = authorityOperationId(command), hash = '0x' + '51'.repeat(32);
  let status = 200, requests = 0;
  const body = { requestId, operationId: requestId, accepted: false, status: 'rejected', rawStatus: 'nonce-conflict',
    reason: 'nonce-used', message: 'Cached nonce already consumed', hash, archived: false, recoveryRequired: true,
    blockNumber: 123, command, signature: command.signature, secretField: 'must not leak' };
  t.mock.method(globalThis, 'fetch', async () => { requests++;
    return { ok: status === 200, status, json: async () => body }; });
  for (status of [200, 409, 500]) {
    await assert.rejects(submitAuthorityAction(config, signer.address, command), error => {
      assert.equal(error.httpStatus, status);
      assert.equal(error.submissionRejected, status !== 500);
      assert.deepEqual(error.relayResult, { status: 'rejected', rawStatus: 'nonce-conflict', reason: 'nonce-used',
        message: body.message, hash, requestId, operationId: requestId, accepted: false, archived: false,
        recoveryRequired: true, blockNumber: 123 });
      return true;
    });
  }
  await assert.rejects(signPreparedAuthorityAction({ ...f.input, prepared }), /失效或已使用/);
  assert.equal(requests, 3);
  assert.equal(f.events.filter(event => event.startsWith('wallet:')).length, 1);
});
