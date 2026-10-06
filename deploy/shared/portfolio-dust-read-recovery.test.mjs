import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FetchRequest, FetchResponse, toUtf8Bytes } from 'ethers';
import { retryPortfolioDustRead, portfolioDustReadErrorMessage, confirmedScheduleStatus } from './portfolio-dust-read-recovery.mjs';
import { pacePortfolioDustRpc } from './portfolio-dust-rpc.mjs';

function httpFailure(status, body = '<html>upstream unavailable</html>', headers = {}) {
  const response = new FetchResponse(status, 'failure', headers, toUtf8Bytes(body),
    new FetchRequest('https://example.invalid/never-requested'));
  try { response.assertOk(); } catch (error) { return error; }
  throw new Error('Expected a failed HTTP response.');
}
function clock() {
  let time = 0;
  const waits = [];
  return { now: () => time, sleep: async ms => { waits.push(ms); time += ms; },
    advance: ms => { time += ms; }, waits };
}
const transport = code => Object.assign(new Error('private provider transport details'), { code });

for (const status of [502, 503, 504]) test(`real fast HTTP ${status} retries the same read exactly once`, async () => {
  const timer = clock(), calls = [], params = [{ to: '0x1234', data: '0x5678' }, '0x10'];
  const original = httpFailure(status);
  const send = retryPortfolioDustRead(async (method, received) => {
    calls.push({ method, params: received }); if (calls.length === 1) throw original;
    return '0x1234';
  }, timer);
  assert.equal(await send('eth_call', params), '0x1234');
  assert.deepEqual(calls.map(call => call.method), ['eth_call', 'eth_call']);
  assert.ok(calls.every(call => call.params === params));
  assert.deepEqual(timer.waits, [1000]);
});

for (const code of ['NETWORK_ERROR', 'TIMEOUT']) test(`fast ${code} receives at most one further read`, async () => {
  const timer = clock(), failures = [transport(code), transport(code)]; let calls = 0;
  const send = retryPortfolioDustRead(async () => { throw failures[calls++]; }, timer);
  await assert.rejects(send('eth_chainId', []), error => error === failures[1]);
  assert.equal(calls, 2); assert.deepEqual(timer.waits, [1000]);
});

test('success and a null pending result are passed through without retry or delay', async () => {
  const timer = clock(), result = { unchanged: true }; let calls = 0;
  const send = retryPortfolioDustRead(async () => { calls++; return calls === 1 ? result : null; }, timer);
  assert.equal(await send('eth_getBlockByNumber', ['finalized', false]), result);
  assert.equal(await send('eth_getTransactionReceipt', ['0x1234']), null);
  assert.equal(calls, 2); assert.deepEqual(timer.waits, []);
});

test('slow 502 and the provider 18-second timeout are preserved without another attempt', async () => {
  for (const [duration, failure] of [[2001, httpFailure(502)], [18000, transport('TIMEOUT')]]) {
    const timer = clock(); let calls = 0;
    const send = retryPortfolioDustRead(async () => { calls++; timer.advance(duration); throw failure; }, timer);
    await assert.rejects(send('eth_getCode', ['0x1234', 'finalized']), error => error === failure);
    assert.equal(calls, 1); assert.deepEqual(timer.waits, []);
  }
});

test('HTTP refusal, RPC errors, chain changes, unstructured 502 and local identity failures never retry', async () => {
  const failures = [httpFailure(429), httpFailure(403), httpFailure(404),
    Object.assign(new Error('server response 502'), { code: 'SERVER_ERROR' }),
    Object.assign(transport('NETWORK_ERROR'), { event: 'changed' }),
    Object.assign(transport('NETWORK_ERROR'), { error: { code: -32005, message: 'quota exceeded' } }),
    Object.assign(httpFailure(502), { info: { error: { code: -32005, message: 'business refusal' } } }),
    Object.assign(new Error('contract rejected'), { code: 'CALL_EXCEPTION' }),
    new Error('Canonical BSC block changed during verification.'),
    new Error('Replacement codehash does not match.'),
    httpFailure(502, JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } })),
    httpFailure(502, JSON.stringify({ error: 'Read-only RPC is not BSC mainnet.' })),
    httpFailure(502, JSON.stringify({ error: 'RPC response did not match the read request.' })),
    httpFailure(502, JSON.stringify({ error: 'Read-only RPC chain changed during request.' })),
    httpFailure(503, JSON.stringify({ error: 'Read-only RPC is not configured.' })),
    httpFailure(502, JSON.stringify({ error: 'Upstream rejected the read request.' })),
    httpFailure(502, JSON.stringify({ error: 'Read-only data service is unavailable.', code: -32005 })),
    httpFailure(502, JSON.stringify({ error: 'Read-only data service is unavailable.', jsonrpc: '2.0', id: 1 })),
    httpFailure(502, '{"jsonrpc":"2.0","error":'),
    httpFailure(502, JSON.stringify({ result: 'invalid HTTP envelope' }))];
  for (const failure of failures) {
    const timer = clock(); let calls = 0;
    const send = retryPortfolioDustRead(async () => { calls++; throw failure; }, timer);
    await assert.rejects(send('eth_call', []), error => error === failure);
    assert.equal(calls, 1); assert.deepEqual(timer.waits, []);
  }
});

test('the configured ethers FetchRequest retains a real 429 and makes one HTTP request', async () => {
  const request = new FetchRequest('https://example.invalid/never-requested');
  request.timeout = 18000;
  request.setThrottleParams({ maxAttempts: 1 });
  request.retryFunc = async () => false;
  let requests = 0;
  request.getUrlFunc = async () => {
    requests++;
    return { statusCode: 429, statusMessage: 'Too Many Requests', headers: { 'Retry-After': '60' },
      body: toUtf8Bytes(JSON.stringify({ error: { code: -32005, message: 'quota exceeded' } })) };
  };
  const timer = clock();
  const send = retryPortfolioDustRead(async () => { const response = await request.send(); response.assertOk(); }, timer);
  await assert.rejects(send('eth_chainId', []), error => error.code === 'SERVER_ERROR' && error.response.statusCode === 429);
  assert.equal(requests, 1); assert.deepEqual(timer.waits, []);
});

test('only fixed transient proxy errors qualify for the HTTP retry', async () => {
  for (const message of ['Read-only data service is unavailable.', 'Read-only data service timed out.',
    'Read-only data service is busy.', 'Read-only archive retry timed out.', 'Read-only archive retry is busy.']) {
    const timer = clock(); let calls = 0;
    const send = retryPortfolioDustRead(async () => { if (++calls === 1) throw httpFailure(503, JSON.stringify({ error: message })); return 'ok'; }, timer);
    assert.equal(await send('eth_blockNumber', []), 'ok'); assert.equal(calls, 2);
  }
});

test('Retry-After respects a short bounded pause and rejects a long or malformed pause', async () => {
  for (const [header, expectedWait] of [['0', 0], ['2', 2000], ['3', null], ['invalid', null],
    ['Thu, 01 Jan 1970 00:00:02 GMT', 2000], ['Thu, 01 Jan 1970 00:00:03 GMT', null]]) {
    const timer = clock(), failure = httpFailure(503, undefined, { 'Retry-After': header }); let calls = 0;
    const send = retryPortfolioDustRead(async () => { if (++calls === 1) throw failure; return 'ok'; }, timer);
    if (expectedWait === null) await assert.rejects(send('eth_chainId', []), error => error === failure);
    else assert.equal(await send('eth_chainId', []), 'ok');
    assert.equal(calls, expectedWait === null ? 1 : 2);
    assert.deepEqual(timer.waits, expectedWait === null ? [] : [expectedWait]);
  }
});

test('write, signing, wallet and unsupported methods are rejected before the provider is called', async () => {
  let calls = 0; const send = retryPortfolioDustRead(async () => { calls++; });
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign',
    'eth_signTypedData_v4', 'eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_estimateGas', 'eth_getLogs'])
    await assert.rejects(send(method, []), TypeError);
  await assert.rejects(send('eth_call', {}), TypeError);
  assert.equal(calls, 0);
});

test('request mutations during the first attempt or retry wait do not resend changed calldata', async () => {
  for (const when of ['call', 'wait', 'cycle-call', 'cycle-wait']) {
    const timer = clock(), params = [{ data: '0x1234' }, 'finalized'], failure = httpFailure(502); let calls = 0;
    const mutate = () => { if (when.startsWith('cycle')) params.push(params); else params[0].data = '0x5678'; };
    const send = retryPortfolioDustRead(async () => { calls++; if (when.endsWith('call')) mutate(); throw failure; },
      { ...timer, sleep: async ms => { await timer.sleep(ms); if (when.endsWith('wait')) mutate(); } });
    await assert.rejects(send('eth_call', params), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('each attempt enters the pacing queue and retains its interval during concurrent proof reads', async () => {
  const timer = clock(), calls = []; let active = 0, maxActive = 0, first = true;
  const send = retryPortfolioDustRead(pacePortfolioDustRpc(async method => {
    active++; maxActive = Math.max(maxActive, active); calls.push({ method, time: timer.now() });
    await Promise.resolve(); active--;
    if (first) { first = false; throw httpFailure(502); } return method;
  }, { now: timer.now, wait: timer.sleep }), timer);
  assert.deepEqual(await Promise.all([send('eth_chainId', []), send('eth_getCode', ['0x1234', 'finalized'])]), ['eth_chainId', 'eth_getCode']);
  assert.deepEqual(calls, [{ method: 'eth_chainId', time: 0 }, { method: 'eth_getCode', time: 1100 }, { method: 'eth_chainId', time: 2200 }]);
  assert.equal(maxActive, 1);
});

test('retry settings cannot increase the fixed budgets and an invalid clock fails before reading', async () => {
  for (const settings of [{ retryDelayMs: 2501 }, { maxElapsedForRetryMs: 2001 },
    { retryDelayMs: -1 }, { maxElapsedForRetryMs: NaN }, { now: 1 }, { sleep: null }])
    assert.throws(() => retryPortfolioDustRead(async () => null, settings), TypeError);
  let calls = 0;
  await assert.rejects(retryPortfolioDustRead(async () => { calls++; }, { now: () => NaN })('eth_chainId', []), TypeError);
  assert.equal(calls, 0);
});

test('read error messages contain no URL, raw body, signature or provider details', () => {
  const privateText = 'https://example.invalid/private-key <rawbody> signature=secret';
  for (const code of ['SERVER_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'CALL_EXCEPTION', 'UNKNOWN_ERROR']) {
    const error = { code, message: privateText, info: { responseBody: privateText }, payload: { method: 'eth_call' } };
    const message = portfolioDustReadErrorMessage(error);
    assert.equal(typeof message, 'string'); assert.match(message, /原交易记录已保留/);
    assert.doesNotMatch(message, /https:|private-key|rawbody|signature|secret/);
  }
  assert.equal(portfolioDustReadErrorMessage(new Error('原排程已取消。')), null);
  assert.equal(portfolioDustReadErrorMessage({ code: 'ACTION_REJECTED' }), null);
  assert.equal(portfolioDustReadErrorMessage({ code: 'UNKNOWN_ERROR', payload: { method: 'eth_sendTransaction' } }), null);
});

const schedule = { status: 'confirmed', blockNumber: 20, verifiedReadyAt: 1791421929,
  verifiedBlockNumber: 21, verifiedBlockHash: `0x${'ab'.repeat(32)}` };
const row = entry => ({ transactions: { schedule: entry } });
test('confirmed schedule display uses stored historical proof and never claims a current chain state', () => {
  const before = JSON.stringify(schedule), message = confirmedScheduleStatus(row(schedule));
  assert.match(message, /历史核验记录/); assert.match(message, /北京时间，核验区块 #21/);
  assert.match(message, /当前链状态暂未读取完成/); assert.match(message, /无需重复部署/);
  assert.equal(JSON.stringify(schedule), before);
  assert.equal(confirmedScheduleStatus(row(schedule), { operation: 'done', readyAt: 1, chainId: 1 }), message);
});

test('pending, uncertain or missing schedule cannot gain a deadline from a fresh proof', () => {
  for (const entry of [undefined, { ...schedule, status: 'submitted' }, { ...schedule, status: 'uncertain' }])
    assert.equal(confirmedScheduleStatus(row(entry), { readyAt: schedule.verifiedReadyAt, operation: 'waiting' }), '');
});

test('old confirmed records and incomplete or unsafe historical metadata show only the preserved-record message', () => {
  for (const entry of [{ status: 'confirmed' }, { ...schedule, verifiedReadyAt: undefined },
    { ...schedule, verifiedReadyAt: '1791421929' }, { ...schedule, verifiedReadyAt: 1 },
    { ...schedule, verifiedReadyAt: Infinity }, { ...schedule, verifiedReadyAt: Number.MAX_SAFE_INTEGER },
    { ...schedule, verifiedBlockNumber: 19 }, { ...schedule, verifiedBlockHash: '0x1234' },
    { ...schedule, blockNumber: 0 }]) {
    const message = confirmedScheduleStatus(row(entry), { readyAt: schedule.verifiedReadyAt });
    assert.equal(message, '部署和升级排程的确认记录已保留。当前链状态暂未读取完成，请核对进度；无需重复部署。');
  }
});
