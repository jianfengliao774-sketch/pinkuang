import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';
import { getAddress, id } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { viewPool } from '../lib/live-view.mjs';
import { publishedProjectIntent, readPublishedProject, readPublishedPoolDisplay, mergePublishedProjects } from '../lib/published-project.mjs';
import { createLiveBrowserFixture } from './live-browser-fixture.mjs';
import * as transactionResult from '../lib/transaction-result.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const f = createLiveBrowserFixture(), row = f.rows[0], account = f.account;
  const config = { ...f.manifest, authority: address(10), gasWallet: address(11), portfolioFactory: address(12) };
  const transaction = { from: account, to: config.factory, value: '0x0', chainId: '0x38',
    data: abi.PoolFactory.encodeFunctionData('createPool', [row.params]) };
  const command = { kind: 'executeApprovedOperation', nonce: '7', args: { target: config.factory, data: transaction.data } };
  const intent = publishedProjectIntent(config, transaction, { account, command });
  const log = (contract, target, name, args) => ({ address: target,
    ...contract.encodeEventLog(contract.getEvent(name), args), transactionHash: hash(20), blockHash: hash(100) });
  const receipt = { transactionHash: hash(20), from: config.gasWallet, to: config.authority,
    blockNumber: '0x64', blockHash: hash(100), status: '0x1', logs: [
      log(abi.PlatformAuthority, config.authority, 'AdminAction', [account, id('APPROVED_OPERATION'), config.factory, 7]),
      log(abi.PoolFactory, config.factory, 'PoolCreated', [row.pool, row.params.circuits, row.params.circuitId,
        row.params.targetRaise, row.params.priceCap, config.authority]),
    ] };
  const reads = [], provider = { request: async request => { reads.push(request);
    if (request.method === 'eth_getTransactionReceipt') return receipt;
    return f.request(request); } };
  return { f, row, account, config, transaction, command, intent, receipt, reads, provider };
}

test('only the confirmed exact administrator creation returns its genuine Factory address', async () => {
  const f = fixture();
  assert.equal(await readPublishedProject({ provider: f.provider, intent: f.intent,
    status: { status: 'pending', hash: hash(20) } }), null);
  assert.equal(f.reads.length, 0, 'A submitted hash is never a successful creation.');
  const result = await readPublishedProject({ provider: f.provider, intent: f.intent,
    status: { status: 'confirmed', hash: hash(20) } });
  assert.equal(result.poolAddress, f.row.pool); assert.equal(result.finalized, true);
  assert.equal(result.receipt.status, 1); assert.equal(f.reads.length, 1);
  await assert.rejects(readPublishedProject({ provider: f.provider, intent: { ...f.intent, nonce: '8' },
    status: { status: 'confirmed', hash: hash(20) } }), /不属于本次/);
  f.receipt.logs[1].address = address(30);
  await assert.rejects(readPublishedProject({ provider: f.provider, intent: f.intent,
    status: { status: 'confirmed', hash: hash(20) } }), /PoolCreated/);
});

test('confirmed creation can read one registered latest Lens row while the directory is older', async () => {
  const f = fixture(), confirmation = await readPublishedProject({ provider: f.provider,
    intent: f.intent, status: { status: 'confirmed', hash: hash(20) } });
  const client = { manifest: f.f.manifest, provider: f.provider,
    readDisplayPool: async () => { throw Object.assign(Error('not yet indexed'), { code: 'http_unavailable' }); } };
  const result = await readPublishedPoolDisplay(client, confirmation, f.intent, f.account);
  assert.equal(result.item.trusted, true); assert.equal(result.item.pool, confirmation.poolAddress);
  assert.equal(result.item.totalSupply, 65n);
  assert.deepEqual(f.reads.map(read => read.method), ['eth_getTransactionReceipt', 'eth_call']);
  assert.equal(f.reads[1].params[0].to, f.f.manifest.lens); assert.equal(f.reads[1].params[1], 'latest');
  assert.equal(mergePublishedProjects([], [viewPool(result.item)]).length, 1);
  const ended = { ...viewPool(result.item), status: 'Closed' };
  assert.equal(mergePublishedProjects([ended], [viewPool(result.item)])[0].status, 'Closed', 'Newer catalog business state wins.');
  await assert.rejects(readPublishedPoolDisplay(client, confirmation,
    { ...f.intent, expected: { ...f.intent.expected, circuitId: 999n } }, f.account), /可信/);
});

test('a reverted creation reports failure only for the matching original signed operation', async () => {
  const f = fixture(); f.receipt.status = '0x0'; f.receipt.logs = [];
  const tx = { hash: hash(20), from: f.config.gasWallet, to: f.config.authority,
    input: abi.PlatformAuthority.encodeFunctionData('executeApprovedOperation',
      [f.config.factory, f.transaction.data, 7n, 1000000n, '0x']) };
  const provider = { request: async request => request.method === 'eth_getTransactionReceipt' ? f.receipt : tx };
  const result = await readPublishedProject({ provider, intent: f.intent, status: { status: 'failed', hash: hash(20) } });
  assert.equal(result.status, 'failed'); assert.equal(result.poolAddress, undefined);
  await assert.rejects(readPublishedProject({ provider, intent: { ...f.intent, nonce: '8' },
    status: { status: 'failed', hash: hash(20) } }), /不属于本次/);
});

test('budget creation uses the separate Factory event and a new pool address for the same asset stays distinct', async () => {
  const f = fixture(), newPool = address(40);
  const transaction = { ...f.transaction, to: f.config.portfolioFactory,
    data: abi.BudgetPortfolioFactory.encodeFunctionData('createPortfolio', [10000n, 9000n, 20n, 10000n, 20000n]) };
  const command = { ...f.command, args: { target: transaction.to, data: transaction.data } };
  const intent = publishedProjectIntent(f.config, transaction, { account: f.account, command });
  const log = (contract, target, name, args) => ({ address: target,
    ...contract.encodeEventLog(contract.getEvent(name), args), transactionHash: hash(20), blockHash: hash(100) });
  f.receipt.logs = [log(abi.PlatformAuthority, f.config.authority, 'AdminAction',
    [f.account, id('APPROVED_OPERATION'), transaction.to, 7]),
    log(abi.BudgetPortfolioFactory, transaction.to, 'PortfolioCreated', [newPool, 10000n, 9000n, 20n])];
  const result = await readPublishedProject({ provider: f.provider, intent, status: { status: 'confirmed', hash: hash(20) } });
  assert.equal(result.poolAddress, newPool); assert.equal(result.projectKind, 'portfolio');
  assert.equal(mergePublishedProjects([{ pool: f.row.pool, tokenId: '16736', status: 'Closed' }],
    [{ pool: newPool, tokenId: '16736', status: 'Funding' }]).length, 2, 'Pool addresses, never NFT identifiers, distinguish project rounds.');
});

test('the actual LivePlatform publication effect replaces pending feedback and merges the real project after confirmation', async () => {
  const f = fixture(), source = await readFile(new URL('../components/LivePlatform.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  useEffect(() => {\n    const job = publishingProject;');
  const end = source.indexOf('  async function submitFreshAuthority', start);
  assert(start > 0 && end > start);
  const timers = [], results = [], state = { pools: [], refresh: 0, job: null };
  const client = { manifest: f.f.manifest, provider: f.provider,
    readDisplayPool: async () => { throw Object.assign(Error('missing new cache row'), { code: 'http_unavailable' }); } };
  const job = { intent: f.intent, hash: hash(20), initialStatus: { status: 'pending', hash: hash(20) },
    client, account: f.account, config: f.config, startedAt: Date.now() };
  const publishedProjects = { current: [] }, context = {
    publishingProject: job, client, config: f.config, account: f.account, same: (a, b) => a.toLowerCase() === b.toLowerCase(),
    showTransactionResult: result => results.push(result), setOperatorRefresh: () => {},
    setRefresh: fn => { state.refresh = fn(state.refresh); },
    authorityActionStatus: async () => ({ status: 'confirmed', hash: hash(20) }),
    readPublishedProject, readPublishedPoolDisplay, viewPool, publishedProjects,
    mergePublishedProjects, setPools: fn => { state.pools = fn(state.pools); },
    setPublishingProject: value => { state.job = value; },
    readPortfolioDisplayRow: () => assert.fail('Single pool creation cannot read budget data.'),
    rememberPortfolioDisplay: () => assert.fail(), publishedPortfolios: { current: [] },
    setMessage: () => {}, L: zh => zh,
  };
  let effect;
  new Function('useEffect', 'setTimeout', 'clearTimeout', ...Object.keys(context), source.slice(start, end))(
    fn => { effect = fn; }, fn => { timers.push(fn); return timers.length; }, () => {}, ...Object.values(context));
  const cleanup = effect(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(results.length, 0); assert.equal(state.pools.length, 0); assert.equal(timers.length, 1);
  await timers.shift()();
  assert.equal(results.length, 1); assert.equal(results[0].poolAddress, f.row.pool);
  assert.equal(state.pools.length, 1); assert.equal(state.pools[0].pool, f.row.pool);
  assert.equal(state.job, null); assert.equal(timers.length, 0);
  cleanup();
  // A previous account's unresolved receipt cannot erase a newer account's task.
  let release;
  job.result = null; job.initialStatus = { status: 'confirmed', hash: hash(20) };
  const newerJob = { account: address(99) }; state.job = newerJob;
  client.provider = { request: request => {
    assert.equal(request.method, 'eth_getTransactionReceipt', 'Cancelled work must not perform a new display read.');
    return new Promise(resolve => { release = resolve; });
  } };
  const stop = effect(); stop(); release(f.receipt);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(results.length, 1); assert.equal(state.job, newerJob);
});

test('the real result dialog exposes address and directory actions only after confirmed creation', async () => {
  await loadBindings();
  const require = createRequire(import.meta.url), module = { exports: {} };
  const code = (await transform(await readFile(new URL('../components/TransactionResultDialog.jsx', import.meta.url), 'utf8'), {
    filename: 'TransactionResultDialog.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
      transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
  })).code;
  new Function('require', 'module', 'exports', code)(name => name === '../lib/transaction-result.mjs'
    ? transactionResult : require(name), module, module.exports);
  const Component = module.exports.default;
  const success = renderToStaticMarkup(React.createElement(Component, { result: { kind: 'success', action: 'createPool',
    projectAddress: address(40), projectKind: 'single', hash: hash(20) } }));
  assert(success.includes(address(40))); assert(success.includes('查看项目')); assert(success.includes('前往项目大厅'));
  const pending = renderToStaticMarkup(React.createElement(Component, { result: { kind: 'pending', reason: 'publication',
    title: '项目正在发布', message: '等待链上确认', projectAddress: address(40), hash: hash(20) } }));
  assert(pending.includes('等待链上确认')); assert(!pending.includes('查看项目')); assert(!pending.includes(address(40)));
});
