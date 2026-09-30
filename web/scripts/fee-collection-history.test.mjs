import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, keccak256, toQuantity, toUtf8Bytes } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { createReadOnlyHttpProvider } from '../lib/live-config.mjs';
import { readFeeCollectionHistory } from '../lib/fee-collection-history.mjs';

const address = value => getAddress(`0x${value.toString(16).padStart(40, '0')}`);
const digest = value => keccak256(toUtf8Bytes(String(value)));
const authority = address(501), gasWallet = address(502), first = address(503), second = address(504), rotated = address(505);
const token = getAddress('0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a');
const code = '0x60006000', event = abi.PlatformAuthority.getEvent('FeesClaimed');
const blockHash = number => digest(`block-${number}`);
const timestamp = number => 1800000000n + number;

function fixture(options = {}) {
  const keys = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock', 'portfolioFactory',
    'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation', 'portfolioFactoryImplementation'];
  const deploymentHash = digest('authority-deployment');
  const manifest = { schemaVersion: 1, chainId: 56, kind: 'integrated-v2',
    ...Object.fromEntries(keys.map((key, index) => [key, address(index + 100)])),
    codehash: Object.fromEntries(keys.map(key => [key, keccak256(code)])),
    sourceCommit: 'a'.repeat(40), artifactDigest: ARTIFACT_DIGEST, verifiedAt: '2026-09-30T10:00:00.000Z',
    verifiedBlockNumber: 200, deployment: { txHash: digest('factory-deployment'), blockHash: blockHash(200n), blockNumber: 200 },
    authority, gasWallet, freshAuthority: { address: authority, gasWallet, administratorOne: first,
      administratorTwo: second, codehash: keccak256(code), deploymentTxHash: deploymentHash } };
  const state = { finalized: 50000n, origin: 100n, chain: '0x38', logChain: '0x38', ...options };
  const definitions = options.events ?? [
    { block: 49995n, recipient: first, bnb: 1000000000000000001n, bem: 123456789n, txIndex: 2n, logIndex: 3n },
    { block: 49990n, recipient: second, bnb: 2n, bem: 3n, txIndex: 4n, logIndex: 7n },
  ];
  const logs = definitions.map((definition, index) => {
    const encoded = abi.PlatformAuthority.encodeEventLog(event, [definition.recipient ?? first, definition.bnb ?? 1n, definition.bem ?? 2n]);
    return { address: authority, topics: encoded.topics, data: encoded.data, blockNumber: toQuantity(definition.block),
      transactionHash: definition.txHash ?? digest(`fee-transaction-${index}`), blockHash: blockHash(definition.block),
      transactionIndex: toQuantity(definition.txIndex ?? BigInt(index)), logIndex: toQuantity(definition.logIndex ?? BigInt(index)), removed: false };
  });
  const receipts = new Map(logs.map(log => [log.transactionHash, { status: '0x1', transactionHash: log.transactionHash,
    from: gasWallet, to: authority, contractAddress: null, blockNumber: log.blockNumber, blockHash: log.blockHash,
    transactionIndex: log.transactionIndex, logs: logs.filter(other => other.transactionHash === log.transactionHash) }]));
  const deployment = { status: '0x1', transactionHash: deploymentHash, from: address(599), to: null,
    contractAddress: authority, blockNumber: toQuantity(state.origin), blockHash: blockHash(state.origin), logs: [] };
  const config = { status: 'ready', stage: 'fresh-active', ...manifest, manifest };
  const calls = [], byMethod = new Map(); let active = 0, peak = 0;
  const perform = kind => async input => {
    calls.push({ ...input, kind }); active++; peak = Math.max(peak, active);
    const countKey = `${kind}:${input.method}`;
    byMethod.set(countKey, (byMethod.get(countKey) ?? 0) + 1);
    try {
      await state.beforeRead?.(input, kind, byMethod.get(countKey));
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      const { method, params = [] } = input;
      if (method === 'eth_chainId') return kind === 'logs' ? state.logChain : state.chain;
      if (method === 'eth_getBlockByNumber') {
        assert.equal(params[1], false);
        const number = params[0] === 'finalized' ? state.finalized : BigInt(params[0]);
        const value = { number: toQuantity(number), hash: blockHash(number), timestamp: toQuantity(timestamp(number)) };
        return state.changeBlock ? state.changeBlock(value, input, kind, byMethod.get(countKey)) : value;
      }
      if (method === 'eth_getTransactionReceipt') {
        assert.equal(kind, 'main', 'wallet supplies logs, never receipt truth');
        const receipt = params[0] === deploymentHash ? deployment : receipts.get(params[0]);
        return state.changeReceipt ? state.changeReceipt(receipt, params[0]) : receipt;
      }
      if (method === 'eth_getCode') {
        assert.equal(kind, 'main'); assert.equal(params[0], authority);
        return state.badCode ? '0x6001' : code;
      }
      if (method === 'eth_call') {
        assert.equal(kind, 'main'); assert.equal(params[0].to, authority);
        assert.equal(params[0].from, undefined, 'read-only bindings are not transaction simulations');
        const decoded = abi.PlatformAuthority.parseTransaction(params[0]);
        const values = { coreFactory: state.wrongCore ?? manifest.factory, budgetFactory: state.wrongBudget ?? manifest.portfolioFactory,
          BEM: state.wrongBem ?? token };
        assert(decoded.name in values);
        return abi.PlatformAuthority.encodeFunctionResult(decoded.name, [values[decoded.name]]);
      }
      assert.equal(method, 'eth_getLogs', 'history must never sign, send, estimate or simulate transactions');
      assert.equal(kind, 'logs');
      const filter = params[0], lower = BigInt(filter.fromBlock), upper = BigInt(filter.toBlock);
      assert.equal(filter.address, authority); assert.deepEqual(filter.topics, [event.topicHash]);
      assert(upper <= state.finalized && lower >= state.origin);
      if (state.logsFailure) throw state.logsFailure;
      if (state.maxRange && upper - lower + 1n > state.maxRange) {
        const error = new Error('RPC response error');
        error.info = { error: { message: `eth_getLogs block range is limited to ${state.maxRange} blocks` } };
        throw error;
      }
      const selected = logs.filter(log => BigInt(log.blockNumber) >= lower && BigInt(log.blockNumber) <= upper);
      return state.changeLogs ? state.changeLogs(selected, input) : selected;
    } finally { active--; }
  };
  return { config, provider: { request: perform('main') }, logsProvider: { request: perform('logs') },
    state, calls, logs, receipts, deployment, peak: () => peak, active: () => active };
}

const read = (f, options = {}) => readFeeCollectionHistory({ config: f.config, provider: f.provider,
  logsProvider: f.logsProvider, ...options });
const logCalls = f => f.calls.filter(call => call.method === 'eth_getLogs');

test('attributes both administrators to finalized events, not the Gas sender, preserving exact amounts and times', async () => {
  const huge = (1n << 255n) + 123n;
  const f = fixture({ events: [
    { block: 49995n, recipient: first, bnb: huge, bem: huge - 1n, txIndex: 1n, logIndex: 9n },
    { block: 49990n, recipient: second, bnb: 2n, bem: 3n },
  ] });
  const value = await read(f);
  assert.deepEqual(value.rows.map(row => row.administrator), [first, second]);
  assert.equal(value.rows[0].bnbAmountWei, huge); assert.equal(value.rows[0].bemAmountWei, huge - 1n);
  assert.equal(value.rows[0].timestamp, timestamp(49995n)); assert.equal(value.rows[0].logIndex, 9n);
  assert.equal(value.safeBlockNumber, 50000n); assert.equal(value.safeBlockHash, blockHash(50000n));
  assert.equal(value.fromBlock, 20001n); assert.equal(value.toBlock, 50000n);
  assert.equal(value.complete, false); assert(value.nextCursor); assert.equal(logCalls(f).length, 6);
  assert(f.calls.filter(call => call.method === 'eth_call').every(call => call.params[1] === '0xc350'));
  assert(Object.isFrozen(value) && Object.isFrozen(value.rows[0]));
});

test('retains former administrators and complete BNB-only/BEM-only/direct fee history', async () => {
  const f = fixture({ finalized: 300n, events: [
    { block: 280n, recipient: rotated, bnb: 0n, bem: 12345678n },
    { block: 270n, recipient: second, bnb: 9n, bem: 0n },
    { block: 150n, recipient: first, bnb: 1n, bem: 2n },
  ] });
  const value = await read(f);
  assert.deepEqual(value.rows.map(row => row.administrator), [rotated, second, first]);
  assert.equal(value.fromBlock, 100n, 'scan begins at actual Authority creation, before formal activation');
  assert.equal(value.complete, true); assert.equal(value.nextCursor, null);
  assert.deepEqual(logCalls(f)[0].params[0], { address: authority, topics: [event.topicHash], fromBlock: '0x64', toBlock: '0x12c' });
});

test('fee history remains readable when an unrelated mining worker is not operational', async () => {
  const f = fixture({ finalized: 300n });
  f.config.operationalReady = false;
  const value = await read(f);
  assert.equal(value.complete, true); assert.equal(value.nextCursor, null);
});

test('deduplicates identical unordered events and orders transactions and logs within a block', async () => {
  const f = fixture({ finalized: 300n, events: [
    { block: 280n, txIndex: 1n, logIndex: 2n },
    { block: 280n, txIndex: 4n, logIndex: 6n },
    { block: 290n, txIndex: 0n, logIndex: 0n },
  ], changeLogs: logs => [logs[1], logs[0], logs[2], logs[1]] });
  const value = await read(f);
  assert.deepEqual(value.rows.map(row => [row.blockNumber, row.transactionIndex]), [[290n, 0n], [280n, 4n], [280n, 1n]]);
});

test('paginates excess events in the same block without gaps or duplicates', async () => {
  const f = fixture({ finalized: 300n, events: Array.from({ length: 7 }, (_, index) => ({
    block: 280n, txIndex: BigInt(index), logIndex: BigInt(index), recipient: index % 2 ? first : second,
  })) });
  const rows = []; let cursor = null;
  for (let page = 0; page < 4; page++) {
    const value = await read(f, { cursor, limit: 2 });
    rows.push(...value.rows); cursor = value.nextCursor;
    assert.equal(value.complete, page === 3);
  }
  assert.equal(cursor, null); assert.equal(new Set(rows.map(row => row.transactionHash)).size, 7);
  assert.deepEqual(rows.map(row => row.transactionIndex), [6n, 5n, 4n, 3n, 2n, 1n, 0n]);
});

test('empty recent windows return a continuation and older data remains reachable', async () => {
  const f = fixture({ events: [{ block: 150n, recipient: first }] });
  const firstPage = await read(f);
  assert.equal(firstPage.rows.length, 0); assert.equal(firstPage.complete, false);
  assert.equal(firstPage.nextCursor.nextBlock, '20000');
  const lastPage = await read(f, { cursor: firstPage.nextCursor });
  assert.equal(lastPage.rows.length, 1); assert.equal(lastPage.rows[0].blockNumber, 150n);
  assert.equal(lastPage.complete, true); assert.equal(lastPage.nextCursor, null);
});

test('fully scanned empty history differs from unavailable data', async () => {
  const empty = fixture({ finalized: 300n, events: [] });
  const value = await read(empty);
  assert.deepEqual(value.rows, []); assert.equal(value.complete, true); assert.equal(value.nextCursor, null);
  const missing = fixture({ logsFailure: new Error('eth_getLogs is unsupported') });
  await assert.rejects(read(missing), /unsupported/);
  assert.equal(logCalls(missing).length, 1);
});

test('uses finalized anchoring and never requests latest or unfinalized events', async () => {
  const f = fixture({ finalized: 300n, events: [{ block: 280n }, { block: 310n }] });
  const value = await read(f);
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].blockNumber, 280n);
  assert(!f.calls.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === 'latest'));
});

test('rejects missing finalized support instead of silently falling back', async () => {
  const f = fixture({ changeBlock: (block, input) => input.params[0] === 'finalized' ? null : block });
  await assert.rejects(read(f), /区块暂不可用/);
  assert.equal(logCalls(f).length, 0);
});

test('checks formal manifest, runtime code, deployment identity and factory/token bindings before querying', async () => {
  const changes = [
    f => { f.config.stage = 'genesis'; },
    f => { f.config.authority = address(999); },
    f => { f.config.manifest.artifactDigest = digest('wrong-artifact'); },
    f => { f.state.badCode = true; },
    f => { f.state.wrongCore = address(999); },
    f => { f.state.wrongBudget = address(999); },
    f => { f.state.wrongBem = address(999); },
    f => { f.deployment.contractAddress = address(999); },
    f => { f.deployment.status = '0x0'; },
    f => { f.deployment.blockHash = digest('forked-origin'); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(read(f)); assert.equal(logCalls(f).length, 0);
  }
});

test('wallet log provider must prove the same chain and pinned block before returning rows', async () => {
  const wrongChain = fixture({ logChain: '0x1' });
  await assert.rejects(read(wrongChain), /日志服务/); assert.equal(logCalls(wrongChain).length, 0);
  const wrongBlock = fixture({ changeBlock: (block, input, kind) => kind === 'logs' ? { ...block, hash: digest('other-chain') } : block });
  await assert.rejects(read(wrongBlock), /日志服务/); assert.equal(logCalls(wrongBlock).length, 0);
});

test('only explicit range restrictions halve windows to 1000 blocks, with no overlapping omissions', async () => {
  const f = fixture({ maxRange: 1000n, events: [] });
  const value = await read(f);
  assert.equal(value.complete, false); assert.equal(value.fromBlock, 44001n); assert.equal(value.nextCursor.nextBlock, '44000');
  const calls = logCalls(f).map(call => [BigInt(call.params[0].fromBlock), BigInt(call.params[0].toBlock)]);
  assert.deepEqual(calls.slice(0, 4).map(([lower, upper]) => upper - lower + 1n), [5000n, 2500n, 1250n, 1000n]);
  for (let index = 4; index < calls.length; index++) assert.equal(calls[index][1], calls[index - 1][0] - 1n);
  assert.equal(calls.length, 9);
});

test('timeouts and generic rate limits fail visibly and are never converted to an empty page', async () => {
  for (const message of ['block range query timed out', 'rate limit exceeded', 'limit exceeded', 'HTTP 503']) {
    const f = fixture({ logsFailure: new Error(message) });
    await assert.rejects(read(f), error => error.message === message);
    assert.equal(logCalls(f).length, 1);
  }
});

test('removed, wrong-address, out-of-range, malformed or conflicting events fail visibly', async () => {
  const mutations = [
    log => ({ ...log, removed: true }),
    log => ({ ...log, address: address(999) }),
    log => ({ ...log, blockNumber: toQuantity(50001n) }),
    log => ({ ...log, logIndex: '0x01' }),
    log => ({ ...log, topics: [...log.topics, digest('extra-topic')] }),
    log => ({ ...log, data: `${log.data}00` }),
  ];
  for (const mutate of mutations) {
    const f = fixture({ changeLogs: logs => logs.map(mutate) });
    await assert.rejects(read(f));
  }
  const conflict = fixture({ changeLogs: logs => [...logs, { ...logs[0], data: abi.PlatformAuthority.encodeEventLog(event, [first, 9n, 9n]).data }] });
  await assert.rejects(read(conflict), /重复领取事件/);
});

test('receipt failures, different targets, mismatched events and noncanonical block hashes never become history', async () => {
  const changes = [
    receipt => ({ ...receipt, status: '0x0' }),
    receipt => ({ ...receipt, to: address(999) }),
    receipt => ({ ...receipt, blockHash: digest('other-block') }),
    receipt => ({ ...receipt, transactionIndex: '0x99' }),
    receipt => ({ ...receipt, logs: [] }),
    receipt => ({ ...receipt, logs: [{ ...receipt.logs[0], removed: true }] }),
    receipt => null,
  ];
  for (const change of changes) {
    const f = fixture({ changeReceipt: (receipt, txHash) => txHash === digest('authority-deployment') ? receipt : change(receipt) });
    await assert.rejects(read(f));
  }
  const fork = fixture({ changeBlock: block => BigInt(block.number) === 49995n ? { ...block, hash: digest('forked-row') } : block });
  await assert.rejects(read(fork), /规范区块/);
});

test('canonical anchor or wallet network changes during scan reject the whole page', async () => {
  const fork = fixture({ beforeRead: input => { if (input.method === 'eth_getLogs') fork.state.reorg = true; },
    changeBlock: (block, input, kind) => fork.state.reorg && kind === 'main' && input.params[0] === '0xc350'
      ? { ...block, hash: digest('new-anchor') } : block });
  await assert.rejects(read(fork), /规范链/);
  const changedNetwork = fixture({ beforeRead: input => { if (input.method === 'eth_getLogs') changedNetwork.state.logChain = '0x1'; } });
  await assert.rejects(read(changedNetwork), /日志服务/);
});

test('invalid cursors and cursors from a different deployment cannot widen query scope', async () => {
  const f = fixture(), value = await read(f);
  for (const changes of [{ authority: address(999) }, { deploymentTxHash: digest('another') },
    { nextBlock: '50001' }, { nextBlock: '01' }, { before: undefined }, { anchorHash: digest('reorg') }]) {
    const before = logCalls(f).length;
    await assert.rejects(read(f, { cursor: { ...value.nextCursor, ...changes } }));
    assert.equal(logCalls(f).length, before);
  }
});

test('30-second cache is separated by provider identity and refresh, while still proving the canonical anchor', async () => {
  const f = fixture({ finalized: 300n }); let now = 100000;
  const one = await read(f, { now: () => now }); assert.equal(one.cached, false);
  const count = logCalls(f).length;
  now += 1000;
  const two = await read(f, { now: () => now }); assert.equal(two.cached, true);
  assert.equal(two.checkedAt, one.checkedAt); assert.equal(logCalls(f).length, count);
  assert(f.calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0x12c').length >= 2);
  await read(f, { now: () => now, refresh: true }); assert.equal(logCalls(f).length, count + 1);
  now += 30000;
  await read(f, { now: () => now }); assert.equal(logCalls(f).length, count + 2);
  const otherWallet = { request: f.logsProvider.request };
  await readFeeCollectionHistory({ config: f.config, provider: f.provider, logsProvider: otherWallet, now: () => now });
  assert.equal(logCalls(f).length, count + 3);
  f.state.logChain = '0x1';
  await assert.rejects(read(f, { now: () => now }), /日志服务/);
});

test('cache retains a valid finalized snapshot as the head advances and reorg invalidates it', async () => {
  const f = fixture({ finalized: 300n }); let now = 100000;
  const one = await read(f, { now: () => now });
  f.state.finalized = 320n; now += 1000;
  const cached = await read(f, { now: () => now });
  assert.equal(cached.cached, true); assert.equal(cached.safeBlockNumber, one.safeBlockNumber);
  f.state.changeBlock = (block, input) => input.params[0] === '0x12c' ? { ...block, hash: digest('changed-cached-anchor') } : block;
  await assert.rejects(read(f, { now: () => now }), /缓存领取记录区块/);
});

test('failed reads never poison the cache with empty history', async () => {
  const f = fixture({ finalized: 300n, logsFailure: new Error('temporary logs failure') });
  await assert.rejects(read(f), /temporary/);
  f.state.logsFailure = null;
  const value = await read(f);
  assert.equal(value.cached, false); assert.equal(value.complete, true);
  assert.equal(logCalls(f).length, 2);
});

test('actual RPC concurrency is bounded to four across both read providers', async () => {
  const f = fixture({ finalized: 300n, delay: 1, events: Array.from({ length: 20 }, (_, index) => ({
    block: 250n + BigInt(index), recipient: index % 2 ? first : second,
  })) });
  const value = await read(f); assert.equal(value.rows.length, 20); assert.equal(f.peak(), 4); assert.equal(f.active(), 0);
});

test('abort stops queued requests promptly, does not sign and does not cache incomplete reads', async () => {
  const f = fixture({ finalized: 300n }), controller = new AbortController();
  let release; const blocked = new Promise(resolve => { release = resolve; });
  f.state.beforeRead = async input => {
    if (input.method === 'eth_getTransactionReceipt') { controller.abort(); await blocked; }
  };
  await assert.rejects(read(f, { signal: controller.signal }), { name: 'AbortError' });
  const count = f.calls.length; release(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, count, 'no queued reads start after cancellation');
  f.state.beforeRead = null;
  const value = await read(f); assert.equal(value.cached, false);
  assert(!f.calls.some(call => /^(?:eth_sign|personal_sign|eth_send|eth_estimateGas)/.test(call.method)));
  const cancelled = new AbortController(); cancelled.abort();
  const before = f.calls.length;
  await assert.rejects(read(f, { signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, before);
});

test('real same-origin read provider denies logs while independent wallet logs path succeeds', async () => {
  const f = fixture({ finalized: 300n });
  const provider = createReadOnlyHttpProvider({ status: 'ready', rpcUrl: 'https://example.test/api/rpc' }, {
    fetcher: async (url, init) => {
      assert.equal(url, 'https://example.test/api/rpc');
      const body = JSON.parse(init.body), result = await f.provider.request(body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await assert.rejects(provider.request({ method: 'eth_getLogs', params: [] }), /不支持/);
  const value = await readFeeCollectionHistory({ config: f.config, provider, logsProvider: f.logsProvider });
  assert.equal(value.complete, true);
  assert(logCalls(f).every(call => call.kind === 'logs'));
});

test('formal same-origin provider reads only bounded current Authority events without a wallet RPC', async () => {
  const f = fixture({ finalized: 300n });
  let requests = 0;
  const provider = createReadOnlyHttpProvider({ ...f.config, status: 'ready', rpcUrl: 'https://example.test/api/rpc' }, {
    fetcher: async (url, init) => {
      requests++;
      const body = JSON.parse(init.body);
      const result = await (body.method === 'eth_getLogs' ? f.logsProvider : f.provider).request(body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const value = await readFeeCollectionHistory({ config: f.config, provider });
  assert.equal(value.complete, true);
  const count = requests;
  for (const filter of [{ address: f.config.authority, topics: [], fromBlock: '0x100', toBlock: '0x101' },
    { address: f.config.authority, topics: [event.topicHash], fromBlock: 'latest', toBlock: 'latest' },
    { address: f.config.authority, topics: [event.topicHash], fromBlock: '0x100', toBlock: '0x2000' }])
    await assert.rejects(provider.request({ method: 'eth_getLogs', params: [filter] }), /不支持/);
  assert.equal(requests, count, 'rejected scopes do not reach the server');
});
