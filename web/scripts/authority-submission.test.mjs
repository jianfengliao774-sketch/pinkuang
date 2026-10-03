import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, getAddress, ZeroAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { prepareAuthoritySubmission, signAuthorityAction } from '../lib/authority-client.mjs';

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
  const events = [];
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
    return signer.signTypedData(payload.domain, types, payload.message);
  } };
  return { events, input: { provider, readProvider, config, account: signer.address,
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
  assert.deepEqual(f.events, ['read:nonces', 'read:machinePool', 'wallet:eth_signTypedData_v4', 'authenticate']);
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
  assert.deepEqual(f.events, ['read:nonces', 'read:machinePool']);
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
  assert.deepEqual(f.events, ['read:nonces', 'read:machinePool']);
  await assert.rejects(prepareAuthoritySubmission({ ...f.input, authenticate: async () => { throw Error('session offline'); } }), /session offline/);
});

test('an occupied miner never requests a signature or authentication', async () => {
  const f = fixture({ pool: addr(24) }); let authenticated = false;
  await assert.rejects(prepareAuthoritySubmission({ ...f.input,
    authenticate: async () => { authenticated = true; } }), error =>
    error.code === 'MachineAlreadyReserved' && error.pool === addr(24));
  assert.equal(authenticated, false);
  assert.deepEqual(f.events, ['read:nonces', 'read:machinePool']);
});

test('the exact signed miner is checked afresh for all five core creation selectors', async () => {
  const params = abi.PoolFactory.parseTransaction({ data: args.data }).args[0];
  const flexible = { minVerifiedWeight: 12n, referencePriceWei: 70000n,
    targetDailyYieldAtomic: 456n, extraBps: 800n, referenceObservedAt: 1800000000n,
    referenceBlock: 123456n, referenceDigest: '0x' + 'ab'.repeat(32) };
  for (const [name, values] of [['createPool', [params]], ['createPoolWithExpiry', [params, false]],
    ['createBudgetChildPool', [params, addr(25)]], ['createFlexiblePool', [params, flexible]],
    ['createFlexiblePoolChecked', [params, flexible, 42, 12]]]) {
    const f = fixture({ pool: addr(24) });
    const exactArgs = { target: core, data: abi.PoolFactory.encodeFunctionData(name, values) };
    await assert.rejects(signAuthorityAction({ ...f.input, args: exactArgs }),
      error => error.code === 'MachineAlreadyReserved');
    assert.deepEqual(f.events, ['read:nonces', 'read:machinePool']);
  }
  // A prior available read is never retained as permission for a later click.
  const f = fixture(); await signAuthorityAction(f.input);
  let checks = 0;
  await assert.rejects(signAuthorityAction({ ...f.input, readProvider: { request: input => {
    if (input.params[0].to === core) { checks++; return registryAbi.encodeFunctionResult('machinePool', [addr(24)]); }
    return f.input.readProvider.request(input);
  } } }), error => error.code === 'MachineAlreadyReserved');
  assert.equal(checks, 1); assert.equal(f.events.filter(event => event.startsWith('wallet:')).length, 1);
});

test('nonce and reservation start in parallel and a failed reservation never opens the wallet', async () => {
  const f = fixture(); const started = []; let finishNonce;
  const work = signAuthorityAction({ ...f.input, readProvider: { request: async input => {
    started.push(input.params[0].to);
    if (input.params[0].to === authority) return new Promise(resolve => { finishNonce = resolve; });
    throw Error('registry unavailable');
  } } });
  await assert.rejects(work, /registry unavailable/);
  assert.deepEqual(started, [authority, core]); assert.deepEqual(f.events, []);
  finishNonce(nonceAbi.encodeFunctionResult('nonces', [9]));
});

test('noncreation approvals read only the nonce and no miner registry', async () => {
  const f = fixture();
  await signAuthorityAction({ ...f.input, kind: 'claimFees',
    args: { markets: [], pools: [], recipient: signer.address } });
  assert.deepEqual(f.events, ['read:nonces', 'wallet:eth_signTypedData_v4']);
});
