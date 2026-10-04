import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as ethers from 'ethers';
import * as ui from './target-owner-upgrade-ui';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const names = ui.TARGET_OWNER_DEPLOYMENTS;
const context = { factory: a(1), genesisRecordDigest: h(2), genesisManifestDigest: h(3), candidateArtifactDigest: h(4), catalogDigest: h(5) };
const pins = { trustedGenesisRecordDigest: h(2), trustedGenesisManifestDigest: h(3), trustedUpgradeArtifactDigest: h(4), trustedReviewCatalogDigest: h(5) };
const common = { genesisRecord: { addresses: { factory: a(1) } }, reviewCatalog: { profile: 'formal', deployer: a(6), bindings: { proposer: a(6), beacon: a(7), timelock: a(8) } }, ...pins };
const compiled = ts.transpileModule(readFileSync(new URL('./TargetOwnerUpgradeStandalone.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
type Options = { source?: ui.TargetOwnerJournal; recoveryHash?: string; deniedLock?: boolean; jump48h?: boolean;
  beforeSendRead?: (f: any) => Promise<void>; afterBroadcast?: (f: any, hash: string) => void;
  preflight?: (f: any) => Promise<void>; receiptStatus?: 0 | 1; pendingNonce?: number };
// Execute the actual component with deterministic hooks, wallet and read-only RPC adapters.
// No browser, network, wallet extension or live chain is used by this test.
function fixture(options: Options = {}) {
  const rows = new Map<string, any>(), storage = new Map<string, string>(), events = new Map<string, Set<(...args: any[]) => void>>();
  const state: any[] = [], refs: any[] = [], effects: (() => any)[] = [], cleanup: (() => void)[] = [];
  let stateIndex = 0, refIndex = 0, first = true, sent = 0, receiptReads = 0, storageFailure = false;
  const phases: string[] = [], sends: any[] = [], key = ui.targetOwnerJournalKey(context);
  if (options.source) storage.set(key, JSON.stringify(options.source));
  const dispatch = (event: string, ...args: any[]) => { for (const fn of events.get(event) ?? []) fn(...args); };
  const add = (event: string, fn: (...args: any[]) => void) => { if (!events.has(event)) events.set(event, new Set()); events.get(event)!.add(fn); };
  const remove = (event: string, fn: (...args: any[]) => void) => events.get(event)?.delete(fn);
  const register = (hash: string, data: string, to: string | null, status = 1) => {
    const nonce = rows.size, blockNumber = 21 + nonce, address = to ? null : ethers.getCreateAddress({ from: a(6), nonce });
    rows.set(hash, { transaction: { hash, from: a(6), to, chainId: 56n, value: 0n, data, nonce, blockNumber, blockHash: h(blockNumber) },
      receipt: { hash, from: a(6), to, blockNumber, blockHash: h(blockNumber), index: 0, status, contractAddress: address, gasUsed: 20000n } });
  };
  const provider = { timestamp: 0n, send: async (method: string) => { assert.equal(method, 'eth_chainId'); return '0x38'; },
    getTransaction: async (hash: string) => rows.get(hash)?.transaction ?? null,
    getTransactionReceipt: async (hash: string) => { receiptReads++; return rows.get(hash)?.receipt ?? null; },
    getBlock: async (tag: any) => { const number = tag === 'finalized' ? 20 + rows.size : Number(tag);
      return { number, hash: h(number), timestamp: options.jump48h ? 300000 : 1000,
        transactions: [...rows.values()].filter(row => row.transaction.blockNumber === number).map(row => row.transaction.hash) }; }, destroy: () => {} };
  let f: any;
  const wallet = { request: async ({ method, params }: any) => {
    if (method === 'eth_requestAccounts') return [a(6)];
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_accounts') { await options.beforeSendRead?.(f); return [a(6)]; }
    if (method === 'eth_getTransactionCount') { const tag = params[1];
      const count = tag === 'pending' && options.pendingNonce !== undefined ? options.pendingNonce : tag === 'latest' || tag === 'pending' ? rows.size
        : [...rows.values()].filter(row => row.transaction.blockNumber <= Number(tag)).length;
      return `0x${count.toString(16)}`;
    }
    if (method === 'eth_getBlockByNumber') { assert.equal(params[1], true); const block = await provider.getBlock(Number(params[0]));
      return { ...block, number: `0x${block.number.toString(16)}`, transactions: block.transactions.map(hash => {
        const tx = rows.get(hash).transaction; return { ...tx, nonce: `0x${tx.nonce.toString(16)}`, value: '0x0',
          chainId: '0x38', input: tx.data, blockNumber: `0x${tx.blockNumber.toString(16)}` }; }) };
    }
    assert.equal(method, 'eth_sendTransaction'); const intent = JSON.parse(storage.get(key)!);
    assert(ui.targetOwnerPending(intent), 'uncertain intent must exist before the wallet send');
    const transaction = params[0], hash = h(1000 + ++sent); sends.push(transaction);
    register(hash, transaction.data, transaction.to ?? null, options.receiptStatus ?? 1);
    if (transaction.data === '0x7000') provider.timestamp = 173800n;
    if (transaction.data === '0x7001') provider.timestamp = 1n;
    options.afterBroadcast?.(f, hash); return hash;
  }, on: add, removeListener: remove };
  const walletOption = { id: 'mock-wallet', name: 'Test wallet', provider: wallet };
  const initial = new Map<number, any>([[0, common], [2, { PoolFunds: '2500000', FlexiblePurchase: '3590000', PoolVault: '6460000' }],
    [3, [walletOption]], [4, walletOption], [5, { address: a(6), chainId: 56 }], [6, options.source ?? null], [14, options.recoveryHash ?? '']]);
  const react = { useState: (value: any) => { const index = stateIndex++; if (!(index in state)) state[index] = initial.has(index) ? initial.get(index) : value;
    return [state[index], (next: any) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; },
  useRef: (value: any) => { const index = refIndex++; return refs[index] ??= { current: value }; },
  useMemo: (factory: () => any) => factory(), useEffect: (effect: () => any) => { if (first) effects.push(effect); } };
  const prepare = (name: string, _common: any, { deploymentsPrefix }: any) => { const index = names.indexOf(name as any); assert(index >= 0);
    assert.deepEqual(Object.keys(deploymentsPrefix).filter(key => key !== name), names.slice(0, index)); return { data: `0x60${index.toString(16).padStart(2, '0')}` }; };
  const build = ({ replacements }: any) => { assert.equal(Object.keys(replacements).length, 3); return { timelock: a(8), operationId: h(50), scheduleData: '0x7000', executeData: '0x7001' }; };
  const proof = async (_provider: any, _common: any, proofOptions: any) => {
    phases.push(proofOptions.phase); await options.preflight?.(f);
    assert.equal(Object.keys(proofOptions.deployments).length, names.filter(name => proofOptions.deployments[name]).length);
    return { blockNumber: 20, blockHash: h(20), operation: proofOptions.phase === 'prepared' ? null
      : proofOptions.phase === 'unscheduled' ? 'unscheduled' : proofOptions.phase === 'done' ? 'done'
        : options.jump48h ? 'ready' : 'waiting', readyAt: proofOptions.phase === 'scheduled' ? 173800 : null };
  };
  const jsx = { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'fragment' };
  const modules: Record<string, any> = { react, 'react/jsx-runtime': jsx, 'react-dom/client': { createRoot: () => ({ render: () => {} }) },
    ethers: { ...ethers, JsonRpcProvider: class { constructor() { return provider; } }, Contract: class { getTimestamp = async () => provider.timestamp; } },
    '../shared/target-owner-upgrade-plan.mjs': { buildTargetOwnerUpgradePlan: build, prepareTargetOwnerUpgradeDeployment: prepare, validateTargetOwnerUpgradeReview: () => {} },
    '../shared/target-owner-upgrade-proof.mjs': { validateTargetOwnerUpgradePreflight: proof }, './target-owner-upgrade-ui': ui,
    './wallet': { discoverWallets: () => () => {}, readWallet: async () => ({ address: a(6), chainId: 56 }), messageOf: (error: any) => error?.message ?? String(error) },
    './target-owner-upgrade.css': {} };
  const exports: any = {};
  new Function('require', 'exports', '__TARGET_OWNER_RELEASE__', 'window', 'navigator', 'localStorage', 'document', 'crypto', compiled)(
    (id: string) => { assert(id in modules, id); return modules[id]; }, exports,
    { pins, files: { liveReview: { path: '/evidence.json' } }, rpcPath: '/api/rpc', sourceCommit: 'a'.repeat(40), candidateSourceCommit: 'b'.repeat(40) },
    { location: { href: 'https://example.test/' }, addEventListener: add, removeEventListener: remove },
    { locks: { request: async (_key: string, _opts: any, callback: any) => callback(options.deniedLock ? null : {}) } },
    { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, value: string) => { if (storageFailure) throw new Error('storage full'); storage.set(k, value); } },
    { getElementById: () => ({}) }, { getRandomValues: (bytes: Uint8Array) => { bytes.fill(9); return bytes; } });
  const walk = (node: any, predicate: (node: any) => boolean): any => {
    if (!node || typeof node !== 'object') return null; if (predicate(node)) return node;
    for (const child of [node.props?.children].flat(Infinity)) { const found = walk(child, predicate); if (found) return found; } return null;
  };
  const render = () => { stateIndex = 0; refIndex = 0; const tree = exports.TargetOwnerUpgradeStandalone();
    if (first) { first = false; effects.forEach((effect, index) => { if (index !== 1) { const fn = effect(); if (typeof fn === 'function') cleanup.push(fn); } }); } return tree; };
  f = { provider, storage, key, state, phases, sends, dispatch, register, render,
    failWrites: () => { storageFailure = true; }, allowWrites: () => { storageFailure = false; }, setUnknownHash: (hash: string) => { state[14] = hash; },
    journal: () => storage.has(key) ? ui.parseTargetOwnerJournal(JSON.parse(storage.get(key)!), context) : null,
    click: async () => { const button = walk(render(), node => node.type === 'button' && node.props.className === 'to-primary'); assert(button); await button.props.onClick(); },
    resumeLegacy: async (acknowledged = true) => { const box = walk(render(), node => node.type === 'input' && node.props.type === 'checkbox'); assert(box); box.props.onChange({ target: { checked: acknowledged } });
      const button = walk(render(), node => node.type === 'button' && node.props.children === '保留旧记录并恢复部署'); assert(button); await button.props.onClick(); },
    recover: async () => { const button = walk(render(), node => node.type === 'button' && node.props.children === '核对当前交易'); assert(button); await button.props.onClick(); },
    import: async (journal: ui.TargetOwnerJournal) => { const input = walk(render(), node => node.type === 'input' && node.props.type === 'file'); assert(input);
      input.props.onChange({ target: { files: [{ size: 1000, text: async () => JSON.stringify({ journal }) }], value: 'record.json' } });
      for (let i = 0; i < 50 && (state[11] || i === 0); i++) await new Promise(resolve => setImmediate(resolve)); },
    unmount: () => cleanup.forEach(fn => fn()), receiptReads: () => receiptReads, find: (predicate: any) => walk(render(), predicate) };
  return f;
}
test('actual component automatically crosses confirmed PoolVault into schedule without duplicate full-graph reads', async () => {
  const f = fixture(); await f.click(); const item = f.journal();
  assert.equal(f.sends.length, 4); assert.equal(item.schedule.status, 'confirmed'); assert.equal(item.execute, undefined);
  assert.deepEqual(f.phases, ['prepared', 'prepared', 'prepared', 'unscheduled', 'scheduled']);
  assert.equal(f.sends[2].data, '0x6002'); assert.equal(f.sends[3].data, '0x7000');
  assert.equal(f.state[11], ''); f.unmount();
});
test('actual component stops after schedule confirmation even when its finalized clock jumped 48 hours', async () => {
  const f = fixture({ jump48h: true }); await f.click(); assert.equal(f.sends.length, 4); assert.equal(f.journal().execute, undefined);
  await f.click(); assert.equal(f.sends.length, 5); assert.equal(f.journal().execute.status, 'confirmed'); f.unmount();
});
test('actual component stops when wallet account event arrives during a pre-send wallet read', async () => {
  const f = fixture({ beforeSendRead: async current => current.dispatch('accountsChanged', [a(99)]) });
  await f.click(); assert.equal(f.sends.length, 0); assert.equal(ui.targetOwnerPending(f.journal()), null); f.unmount();
});
test('broadcast hash remains durable after wallet context cancellation; no following candidate is sent', async () => {
  const f = fixture({ afterBroadcast: current => current.dispatch('chainChanged', '0x1') });
  await f.click(); assert.equal(f.sends.length, 1); assert.equal(f.journal().deployments.PoolFunds.status, 'submitted');
  assert.equal(f.journal().deployments.PoolFunds.txHash, h(1001)); f.unmount();
});
test('storage conflict after broadcast preserves changed record and exposes original hash for copying', async () => {
  const f = fixture({ afterBroadcast: current => current.storage.set(current.key, 'changed in other tab') });
  await f.click(); assert.equal(f.sends.length, 1); assert.equal(f.storage.get(f.key), 'changed in other tab');
  assert.equal(f.find((node: any) => node.props?.['aria-label'] === '未保存的原交易哈希').props.value, h(1001)); f.unmount();
});
test('write failure after broadcast keeps uncertain intent and exposes its returned hash', async () => {
  const f = fixture({ afterBroadcast: current => current.failWrites() }); await f.click();
  assert.equal(f.sends.length, 1); assert.equal(f.journal().deployments.PoolFunds.status, 'uncertain');
  assert.equal(f.state[15], h(1001)); f.unmount();
});
test('another tab holding Web Lock, or a storage event during preflight, prevents every wallet send', async () => {
  const locked = fixture({ deniedLock: true }); await locked.click(); assert.equal(locked.sends.length, 0); assert.equal(locked.journal(), null); locked.unmount();
  const f = fixture({ preflight: async current => current.dispatch('storage', { key: current.key }) }); await f.click(); assert.equal(f.sends.length, 0); f.unmount();
});
test('older identical-initcode successful or failed CREATE cannot clear a hashless unknown intent or send any next transaction', async () => {
  for (const status of [0, 1]) {
    const source = ui.newTargetOwnerJournal(context, h(8)); source.deployments.PoolFunds = { status: 'uncertain', from: a(6), dataHash: ethers.keccak256('0x6000') };
    const f = fixture({ source, recoveryHash: h(90) }); f.register(h(90), '0x6000', null, status);
    await f.click(); assert.equal(f.sends.length, 0); assert.deepEqual(f.journal(), source);
    assert.match(f.state[12], /不能证明/); assert.equal(f.journal().failedTransactions, undefined); f.unmount();
  }
});
test('known matching failed transaction is archived but retry requires a later fresh click', async () => {
  const source = ui.newTargetOwnerJournal(context, h(8)); source.deployments.PoolFunds = { status: 'submitted', from: a(6), dataHash: ethers.keccak256('0x6000'), txHash: h(90) };
  const f = fixture({ source }); f.register(h(90), '0x6000', null, 0); await f.click();
  assert.equal(f.sends.length, 0); assert.equal(f.journal().failedTransactions.length, 1); assert.equal(ui.targetOwnerPending(f.journal()), null); f.unmount();
});
test('a hash returned by the wallet can be saved and verified after storage becomes writable, without another send', async () => {
  const f = fixture({ afterBroadcast: current => current.failWrites() }); await f.click();
  assert.equal(f.sends.length, 1); assert.equal(f.state[15], h(1001)); f.allowWrites(); await f.recover();
  assert.equal(f.sends.length, 1); assert.equal(f.journal().deployments.PoolFunds.status, 'confirmed');
  assert.equal(f.journal().deployments.FlexiblePurchase, undefined); assert.equal(f.state[15], ''); f.unmount();
});
test('actual component recovers a lost wallet response by its persisted nonce and canonical block without another send', async () => {
  const f = fixture({ afterBroadcast: () => { throw new Error('wallet callback timeout'); } }); await f.click();
  assert.equal(f.sends.length, 1); assert.equal(f.journal().deployments.PoolFunds.status, 'uncertain');
  assert.equal(f.journal().deployments.PoolFunds.intent.nonce, 0); assert.equal(f.sends[0].nonce, '0x0');
  await f.recover(); assert.equal(f.sends.length, 1); assert.equal(f.journal().deployments.PoolFunds.status, 'confirmed');
  assert.equal(f.journal().deployments.FlexiblePurchase, undefined); f.unmount();
});
test('new hashless matching failure is located and archived, and readonly recovery does not retry', async () => {
  const f = fixture({ receiptStatus: 0, afterBroadcast: () => { throw new Error('wallet callback timeout'); } }); await f.click();
  await f.recover(); assert.equal(f.sends.length, 1); assert.equal(f.journal().failedTransactions.length, 1);
  assert.equal(f.journal().deployments.PoolFunds, undefined); f.unmount();
});
test('readonly legacy hashless recovery never creates a new transaction', async () => {
  const source = ui.newTargetOwnerJournal(context, h(8)); source.deployments.PoolFunds = { status: 'uncertain', from: a(6), dataHash: ethers.keccak256('0x6000') };
  const f = fixture({ source }); await f.recover(); assert.equal(f.sends.length, 0); assert.deepEqual(f.journal(), source); f.unmount();
});
test('import enriches only the same nonce-bound pending row after canonical proof, without advancing or sending', async () => {
  const source = ui.newTargetOwnerJournal(context, h(8)); source.deployments.PoolFunds = { status: 'uncertain', from: a(6), dataHash: ethers.keccak256('0x6000'),
    intent: { schemaVersion: 1, chainId: 56, nonce: 0, anchor: { blockNumber: 20, blockHash: h(20) } } };
  const imported = structuredClone(source); imported.deployments.PoolFunds = { ...imported.deployments.PoolFunds!, status: 'submitted', txHash: h(90) };
  const f = fixture({ source }); f.register(h(90), '0x6000', null); await f.import(imported);
  assert.equal(f.sends.length, 0); assert.equal(f.journal().deployments.PoolFunds.txHash, h(90));
  assert.equal(f.journal().deployments.PoolFunds.status, 'submitted'); assert.equal(f.journal().deployments.FlexiblePurchase, undefined); f.unmount();
});
test('import cannot overwrite a legacy unknown send, alter the salt, or adopt an unrelated nonce', async () => {
  for (const change of ['legacy', 'salt', 'nonce']) {
    const source = ui.newTargetOwnerJournal(context, h(8)); source.deployments.PoolFunds = { status: 'uncertain', from: a(6), dataHash: ethers.keccak256('0x6000'),
      ...(change === 'legacy' ? {} : { intent: { schemaVersion: 1 as const, chainId: 56 as const, nonce: 0, anchor: { blockNumber: 20, blockHash: h(20) } } }) };
    const imported = structuredClone(source); imported.deployments.PoolFunds = { ...imported.deployments.PoolFunds!, status: 'submitted', txHash: h(90) };
    if (change === 'salt') imported.salt = h(99);
    if (change === 'nonce') imported.deployments.PoolFunds.intent!.nonce = 1;
    const f = fixture({ source }); f.register(h(90), '0x6000', null); await f.import(imported);
    assert.equal(f.sends.length, 0); assert.deepEqual(f.journal(), source); assert.match(f.state[12], /不能证明/); f.unmount();
  }
});
test('returned hash recovery refuses to overwrite a record changed in another tab', async () => {
  const f = fixture({ afterBroadcast: current => current.failWrites() }); await f.click(); f.allowWrites();
  const changed = f.journal(); changed.salt = h(123); delete changed.deployments.PoolFunds.intent;
  f.storage.set(f.key, JSON.stringify(changed)); await f.recover();
  assert.equal(f.sends.length, 1); assert.deepEqual(f.journal(), changed); f.unmount();
});
test('empty storage import re-proves nonce-bound archived failures using wallet readonly RPC, with zero sends', async () => {
  const source = ui.newTargetOwnerJournal(context, h(8)); source.failedTransactions = [{ step: 'PoolFunds',
    transaction: { status: 'submitted', from: a(6), dataHash: ethers.keccak256('0x6000'), txHash: h(90),
      intent: { schemaVersion: 1, chainId: 56, nonce: 0, anchor: { blockNumber: 20, blockHash: h(20) } } },
    evidence: { kind: 'target-owner-finalized-failed-transaction-v1', chainId: 56, status: 0, txHash: h(90), from: a(6), to: null,
      value: '0', dataHash: ethers.keccak256('0x6000'), blockNumber: 21, blockHash: h(21), gasUsed: '20000', checkedAt: new Date().toISOString() } }];
  const f = fixture(); f.register(h(90), '0x6000', null, 0); await f.import(source);
  assert.equal(f.sends.length, 0); assert.deepEqual(f.journal(), source); assert.equal(f.state[12], ''); f.unmount();
});

function legacySource() { const source = ui.newTargetOwnerJournal(context, h(8)); source.deployments.PoolFunds = { status: 'uncertain', from: a(6), dataHash: ethers.keccak256('0x6000') }; return source; }
test('legacy page exposes explicit recovery and disables the misleading continue button', () => {
  const f = fixture({ source: legacySource() }); const button = f.find((node: any) => node.props?.className === 'to-primary');
  assert.equal(button.props.disabled, true); assert.equal(button.props.children, '请先处理下方旧记录');
  assert(f.find((node: any) => node.props?.['data-testid'] === 'legacy-deployment-recovery')); f.unmount();
});
test('acknowledged legacy recovery archives the unchanged unknown row, sends zero transactions, then fresh click resumes', async () => {
  const source = legacySource(), f = fixture({ source }); await f.resumeLegacy(); const saved = f.journal();
  assert.equal(f.sends.length, 0); assert.equal(saved.deployments.PoolFunds, undefined);
  assert.deepEqual(saved.abandonedUnknownDeployments[0].transaction, source.deployments.PoolFunds);
  assert.equal(saved.failedTransactions, undefined); assert.match(f.state[13], /本次没有发送交易/);
  await f.click(); assert.equal(f.sends.length, 4); assert.equal(f.sends[0].nonce, '0x0');
  assert.equal(f.journal().schedule.status, 'confirmed'); assert.equal(f.journal().abandonedUnknownDeployments.length, 1); f.unmount();
});
test('legacy recovery cannot archive without acknowledgement or with wallet pending nonce', async () => {
  for (const opts of [{}, { pendingNonce: 1 }]) {
    const source = legacySource(), f = fixture({ source, ...opts }); await f.resumeLegacy('pendingNonce' in opts);
    assert.equal(f.sends.length, 0); assert.deepEqual(f.journal(), source); assert(f.state[12]); f.unmount();
  }
});
test('legacy recovery stops at failed preflight, wallet context change, lock conflict or persistence failure', async () => {
  for (const opts of [ { preflight: async () => { throw new Error('graph changed'); } },
    { preflight: async (f: any) => f.dispatch('accountsChanged', [a(99)]) }, { deniedLock: true },
    { preflight: async (f: any) => f.failWrites() } ]) {
    const source = legacySource(), f = fixture({ source, ...opts }); await f.resumeLegacy();
    assert.equal(f.sends.length, 0); assert.deepEqual(f.journal(), source); assert(f.state[12] || f.state[13]); f.unmount();
  }
});
test('imported abandoned legacy payload cannot bypass reviewed initcode or deployer verification', async () => {
  const source = legacySource(), f = fixture({ source }); await f.resumeLegacy(); const saved = f.journal(); f.unmount();
  for (const field of ['dataHash', 'from']) {
    const changed = structuredClone(saved); changed.abandonedUnknownDeployments[0].transaction[field] = field === 'from' ? a(99) : h(99);
    const fresh = fixture(); await fresh.import(changed); assert.equal(fresh.journal(), null); assert.equal(fresh.sends.length, 0); fresh.unmount();
  }
});
test('legacy recovery refuses mismatched sender or initcode before archiving', async () => {
  for (const field of ['from', 'dataHash']) {
    const source = legacySource(); (source.deployments.PoolFunds as any)[field] = field === 'from' ? a(99) : h(99);
    const f = fixture({ source }); await f.resumeLegacy();
    assert.deepEqual(f.journal(), source); assert.equal(f.sends.length, 0); assert.match(f.state[12], /发送者或部署字节码/); f.unmount();
  }
});
