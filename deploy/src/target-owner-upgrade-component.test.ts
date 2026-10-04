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
  preflight?: (f: any) => Promise<void>; receiptStatus?: 0 | 1 };
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
    const index = rows.size; const address = to ? null : a(100 + index);
    rows.set(hash, { transaction: { hash, from: a(6), to, chainId: 56n, value: 0n, data, blockNumber: 10, blockHash: h(10) },
      receipt: { hash, from: a(6), to, blockNumber: 10, blockHash: h(10), index, status, contractAddress: address, gasUsed: 20000n } });
  };
  const provider = { timestamp: 0n, send: async (method: string) => { assert.equal(method, 'eth_chainId'); return '0x38'; },
    getTransaction: async (hash: string) => rows.get(hash)?.transaction ?? null,
    getTransactionReceipt: async (hash: string) => { receiptReads++; return rows.get(hash)?.receipt ?? null; },
    getBlock: async (tag: any) => tag === 'finalized' || tag === 20
      ? { number: 20, hash: h(20), timestamp: options.jump48h ? 300000 : 1000, transactions: [] }
      : { number: 10, hash: h(10), timestamp: 900, transactions: [...rows.keys()] }, destroy: () => {} };
  let f: any;
  const wallet = { request: async ({ method, params }: any) => {
    if (method === 'eth_requestAccounts') return [a(6)];
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_accounts') { await options.beforeSendRead?.(f); return [a(6)]; }
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
    failWrites: () => { storageFailure = true; }, setUnknownHash: (hash: string) => { state[14] = hash; },
    journal: () => storage.has(key) ? ui.parseTargetOwnerJournal(JSON.parse(storage.get(key)!), context) : null,
    click: async () => { const button = walk(render(), node => node.type === 'button' && node.props.className === 'to-primary'); assert(button); await button.props.onClick(); },
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
