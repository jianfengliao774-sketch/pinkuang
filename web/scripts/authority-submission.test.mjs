import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { prepareAuthoritySubmission, signAuthorityAction } from '../lib/authority-client.mjs';

const signer = new Wallet('0x' + '11'.repeat(32));
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const authority = addr(21), core = addr(22), nonceAbi = new Interface(['function nonces(address) view returns(uint256)']);
const config = { displayOnly: true, status: 'ready', stage: 'fresh-active', authority,
  freshAuthority: { address: authority, codehash: '0x' + 'aa'.repeat(32) } };
const args = { target: core, data: abi.PoolFactory.encodeFunctionData('createPool', [{ circuits: addr(23),
  circuitId: 7, targetRaise: 11000, priceCap: 10000, directSeller: addr(0), directPrice: 0,
  fundingDeadline: 1800001000, purchaseDeadline: 1800002000 }]) };
function fixture() {
  const events = [];
  const readProvider = { request: async ({ method, params }) => {
    events.push('read:' + method); assert.equal(method, 'eth_call');
    assert.equal(params[0].to, authority); assert.equal(params[1], 'latest');
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
  assert.deepEqual(f.events, ['read:eth_call', 'wallet:eth_signTypedData_v4', 'authenticate']);
  releaseLogin();
  const command = await work;
  assert.equal(command.nonce, '9'); assert.deepEqual(command.args, args);
});

test('a slow nonce read fails before signature; its late response cannot open a wallet request', async () => {
  const f = fixture(); let finish;
  const work = signAuthorityAction({ ...f.input, readTimeoutMs: 20,
    readProvider: { request: () => new Promise(resolve => { finish = resolve; }) } });
  await assert.rejects(work, error => error.code === 'read_timeout');
  finish(nonceAbi.encodeFunctionResult('nonces', [9]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, []);
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
  const f = fixture(); let finish, current = true;
  const work = signAuthorityAction({ ...f.input, isCurrent: () => current,
    readProvider: { request: () => new Promise(resolve => { finish = resolve; }) } });
  await new Promise(resolve => setImmediate(resolve)); current = false;
  finish(nonceAbi.encodeFunctionResult('nonces', [9]));
  await assert.rejects(work, error => error.code === 'read_cancelled');
  assert.deepEqual(f.events, []);
  await assert.rejects(prepareAuthoritySubmission({ ...f.input, authenticate: async () => { throw Error('session offline'); } }), /session offline/);
});
