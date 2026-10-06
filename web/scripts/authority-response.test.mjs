import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, concat, getAddress, keccak256 } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { authorityAction, authorityCommandData, authorityOperationId,
  authorityStatusForRequest, submitAuthorityAction } from '../lib/authority-client.mjs';
import { authorityPreviousFailureNotice, authorityRejectionResult } from '../lib/transaction-result.mjs';

test('accepted new request displays the archived old failure independently without claiming creation', () => {
  const previousFailure = { status: 'reverted', hash: hash(2393), operationId: hash(2394), archived: true };
  const notice = authorityPreviousFailureNotice({ accepted: true, hash: hash(42), previousFailure });
  assert.equal(notice.hash, hash(2393)); assert.match(notice.message, /旧交易执行已回滚/);
  assert.match(notice.message, /新请求已单独接受/); assert.match(notice.message, /尚不代表项目创建成功/);
  assert.equal(notice.projectAddress, undefined);
  for (const value of [{ accepted: false, previousFailure }, { accepted: true, previousFailure: { ...previousFailure, archived: false } },
    { accepted: true, previousFailure: { ...previousFailure, hash: 'invalid' } }])
    assert.equal(authorityPreviousFailureNotice(value), null);
});
import { prepareAuthorityCall } from '../../deploy/scripts/authority-relay.mjs';

const administrator = new Wallet('0x' + '11'.repeat(32));
const otherAdministrator = new Wallet('0x' + '22'.repeat(32));
const address = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const authority = address(21), factory = address(22), portfolio = address(23);
const market = address(24), pool = address(25), config = { journalBase: '/api/journal/' };
const params = { circuits: address(26), circuitId: 123n, targetRaise: 100000n, priceCap: 90000n,
  directSeller: address(27), directPrice: 80000n, fundingDeadline: 1800001000n, purchaseDeadline: 1800002000n };
const createArgs = { target: factory, data: abi.PoolFactory.encodeFunctionData('createPool', [params]) };

async function signed(kind = 'executeApprovedOperation', args = createArgs,
  { signer = administrator, nonce = '7', deadline = '1900000000' } = {}) {
  const typed = authorityAction(authority, kind, args, nonce, deadline);
  return { authority, kind, args, nonce, deadline,
    signature: await signer.signTypedData(typed.domain, typed.types, typed.message) };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function accepted(command, overrides = {}) {
  const operationId = authorityOperationId(command);
  return { status: 'pending', hash: hash(1), kind: command.kind,
    requestId: operationId, operationId, accepted: true, ...overrides };
}

function fakeFetch(t, result) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    requests.push(args);
    if (result instanceof Error) throw result;
    return result;
  });
  return requests;
}

test('all seven administrator selectors have the same complete calldata and operation ID as the relay', async () => {
  const commands = [
    ['executeApprovedOperation', createArgs],
    ['reviewSale', { market, pool, proposalId: '2', priceWei: '12345', approved: true }],
    ['reviewChildSale', { portfolio, proposalId: '3', approved: false }],
    ['setSaleReference', { market, pool, priceWei: '54321', observedAt: '1800000000', digest: hash(2) }],
    ['claimFees', { markets: [market], pools: [pool], recipient: administrator.address }],
    ['buyBudgetOfficial', { portfolio, child: pool, listingId: '8', maxCost: '1000' }],
    ['buyBudgetFirsto', { portfolio, child: pool, encodedOrder: '0x1234', maxCost: '1000' }],
  ];
  const selectors = new Set();
  for (const [kind, args] of commands) {
    const command = await signed(kind, args), prepared = prepareAuthorityCall(command);
    const data = authorityCommandData(command);
    assert.equal(data, prepared.data, kind);
    assert.equal(authorityOperationId(command), keccak256(concat([prepared.authority, prepared.data])), kind);
    assert.equal(abi.PlatformAuthority.parseTransaction({ data }).name, kind);
    selectors.add(data.slice(0, 10));
    assert.notEqual(authorityOperationId({ ...command, authority: address(99) }), authorityOperationId(command));
  }
  assert.equal(selectors.size, 7);
});

test('a matching accepted pending response binds its hash to this POST', async t => {
  const command = await signed(), reply = accepted(command), requests = fakeFetch(t, response(reply));
  assert.deepEqual(await submitAuthorityAction(config, administrator.address, command), reply);
  assert.equal(requests.length, 1);
  const [url, options] = requests[0];
  assert.equal(url, '/api/journal/authority-relay');
  assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers['X-Pinkuang-Account'], administrator.address);
  assert.deepEqual(JSON.parse(options.body), { command });
});

test('a matching rejected POST preserves the old failed operation as metadata, never as the new hash', async t => {
  const command = await signed(), oldCommand = await signed(undefined, undefined, { deadline: '1899999999' });
  const reply = accepted(command, { accepted: false, status: 'failed', hash: hash(2393),
    operationId: authorityOperationId(oldCommand), reason: 'previous-operation-failed-review-required',
    raw: 'private-signed-transaction', signature: command.signature, command });
  fakeFetch(t, response(reply));
  await assert.rejects(submitAuthorityAction(config, administrator.address, command), error => {
    assert.equal(error.submissionRejected, true); assert.equal(error.httpStatus, 200);
    assert.equal(error.relayResult.status, 'failed'); assert.equal(error.relayResult.hash, hash(2393));
    assert.equal(error.relayResult.operationId, reply.operationId);
    assert.equal(error.relayResult.reason, reply.reason);
    for (const field of ['raw', 'signature', 'command']) assert.equal(Object.hasOwn(error.relayResult, field), false);
    return true;
  });
});

test('missing or mismatched successful response identity remains ambiguous', async t => {
  const command = await signed(), reply = accepted(command), requests = fakeFetch(t, null);
  const bodies = [
    { status: 'failed', hash: hash(2393) },
    { ...reply, requestId: hash(99) },
    { ...reply, operationId: hash(99) },
    { ...reply, requestId: null, accepted: false, status: 'failed' },
    { ...reply, accepted: undefined },
    { ...reply, hash: null },
    null,
  ];
  for (const body of bodies) {
    globalThis.fetch.mock.mockImplementation(async (...args) => { requests.push(args); return response(body); });
    await assert.rejects(submitAuthorityAction(config, administrator.address, command), error => {
      assert.notEqual(error.submissionRejected, true, 'An unidentified journal is not proof that this POST was rejected.');
      return true;
    });
  }
  assert.equal(requests.length, bodies.length, 'No automatic retry is allowed.');
});

test('explicit 400 and 409 reject only the submitted request without adopting a journal hash', async t => {
  const command = await signed(), requests = fakeFetch(t, null);
  for (const status of [400, 409]) {
    globalThis.fetch.mock.mockImplementation(async (...args) => {
      requests.push(args); return response({ error: 'Request rejected', hash: hash(2393) }, status);
    });
    await assert.rejects(submitAuthorityAction(config, administrator.address, command), error => {
      assert.equal(error.httpStatus, status); assert.equal(error.submissionRejected, true);
      assert.notEqual(error.hash, hash(2393)); return true;
    });
  }
  assert.equal(requests.length, 2);
});

test('a lost POST response remains uncertain and is never retried', async t => {
  const command = await signed(), timeout = new Error('POST response timed out');
  timeout.name = 'TimeoutError';
  const requests = fakeFetch(t, timeout);
  await assert.rejects(submitAuthorityAction(config, administrator.address, command), error => {
    assert.notEqual(error.submissionRejected, true); return true;
  });
  assert.equal(requests.length, 1);
});

test('an unavailable relay does not prove rejection or identify the current command', async t => {
  const command = await signed(), requests = fakeFetch(t,
    response({ error: 'Relay unavailable', status: 'failed', hash: hash(2393) }, 503));
  await assert.rejects(submitAuthorityAction(config, administrator.address, command), error => {
    assert.equal(error.httpStatus, 503); assert.notEqual(error.submissionRejected, true);
    assert.notEqual(error.hash, hash(2393)); return true;
  });
  assert.equal(requests.length, 1);
});

test('status matching rejects old signatures, old deadlines and a different known transaction hash', async () => {
  const command = await signed(), operationId = authorityOperationId(command);
  const status = { status: 'pending', hash: hash(1), operationId };
  assert.equal(authorityStatusForRequest(status, operationId), status);
  assert.equal(authorityStatusForRequest(status, operationId, hash(1)), status);
  assert.equal(authorityStatusForRequest(status, operationId, hash(2)), null);
  for (const oldCommand of [await signed(undefined, undefined, { deadline: '1899999999' }),
    await signed(undefined, undefined, { signer: otherAdministrator })]) {
    assert.deepEqual(oldCommand.args, command.args); assert.equal(oldCommand.nonce, command.nonce);
    const oldStatus = { status: 'failed', hash: hash(2393), operationId: authorityOperationId(oldCommand) };
    assert.notEqual(oldStatus.operationId, operationId);
    assert.equal(authorityStatusForRequest(oldStatus, operationId), null);
  }
  for (const malformed of [null, {}, { ...status, operationId: '0x1234' }, { ...status, operationId: null }])
    assert.equal(authorityStatusForRequest(malformed, operationId), null);
  assert.equal(authorityStatusForRequest(status, '0x1234'), null);
});

test('archived old failure explains that the new creation was not sent and preserves the old hash', () => {
  const input = { submissionRejected: true, relayResult: { accepted: false, status: 'failed',
    requestId: hash(2), operationId: hash(1), hash: hash(2393), reason: 'transaction-reverted', archived: true } };
  const result = authorityRejectionResult(input, { action: 'createPool' });
  assert.equal(result.kind, 'failed'); assert.equal(result.action, 'createPool');
  assert.equal(result.hash, hash(2393)); assert.equal(result.key, `${hash(2)}:rejected`);
  assert.match(result.title, /旧操作失败.*本次创建未发送/);
  assert.match(result.message, /旧失败已核验并归档/);
  assert.match(result.message, /本次创建请求未发送/);
  assert.match(result.message, /重新预览后再签名创建/);
  assert.equal(result.poolAddress, undefined); assert.equal(result.projectKind, undefined);
  const english = authorityRejectionResult(input, { locale: 'en', action: 'createPool' });
  assert.match(english.title, /Earlier operation failed.*creation was not sent/);
  assert.match(english.message, /verified and archived/);
});

test('unknown old operation remains pending with no retry guidance or invented project address', () => {
  const input = { submissionRejected: true, relayResult: { accepted: false, status: 'pending',
    requestId: hash(2), operationId: hash(1), hash: hash(2393), reason: 'unknown-broadcast',
    archived: false, recoveryRequired: true, poolAddress: address(99) } };
  const result = authorityRejectionResult(input, { action: 'createPool' });
  assert.equal(result.kind, 'pending'); assert.equal(result.hash, hash(2393));
  assert.match(result.title, /本次请求未被接受/);
  assert.match(result.message, /结果仍需核对/); assert.match(result.message, /结果不明时不要重复创建/);
  assert.doesNotMatch(result.message, /重新预览后再签名创建/);
  assert.equal(result.poolAddress, undefined); assert.equal(result.projectKind, undefined);
  assert.equal(authorityRejectionResult({ ...input, submissionRejected: false }), null);
  assert.equal(authorityRejectionResult({ ...input, relayResult: { ...input.relayResult, accepted: true } }), null);
});
