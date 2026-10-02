import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';
import * as helper from '../lib/native-sale-upgrade.mjs';

const require = createRequire(import.meta.url);
await loadBindings();
const code = (await transform(await readFile(new URL('../components/NativeFirstoUpgradePanel.jsx', import.meta.url), 'utf8'), {
  filename: 'NativeFirstoUpgradePanel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
    transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
})).code;
const address = n => '0x' + n.toString(16).padStart(40, '0'), hash = n => '0x' + n.toString(16).padStart(64, '0');
const proposer = address(4), other = address(5);
const catalog = { schemaVersion: 1, kind: 'fresh-native-firsto-sale-upgrade-v1', chainId: 56, profile: 'full-test',
  genesisArtifactDigest: hash(1), candidateArtifactDigest: hash(2), minimumDelaySeconds: '0',
  bindings: { factory: address(1), beacon: address(2), timelock: address(3), proposer },
  expectedImplementations: { PoolVault: address(20) }, libraries: {},
  artifacts: Object.fromEntries(helper.nativeUpgradeDeploymentOrder.map(name => [name,
    { abi: [], bytecode: '0x6000', deployedBytecode: name === 'PoolVault' ? '0x6000' : '0x73' + '00'.repeat(20) + '6000' }])),
  activation: { pool: address(22), proposalId: '1', priceWei: '40000000000000000', feeBps: '100', feeEpoch: '1' } };
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness({ account = proposer, ambiguousSend = false } = {}) {
  const slots = [], effects = [], saved = new Map(), urls = [], sends = [], reads = [], listeners = new Map();
  let position = 0, tree, scheduled = false, executed = false;
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  const previousProfile = process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY;
  const hooks = {
    useState(initial) { const i = position++; if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
    useRef(initial) { const i = position++; return slots[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = position++, old = slots[i];
      if (!old || deps.some((value, index) => value !== old.deps[index])) effects.push(() => {
        old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const provider = { on(event, fn) { listeners.set(event, fn); }, removeListener(event) { listeners.delete(event); },
    async request({ method }) {
      reads.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_getBlockByNumber') return { timestamp: '0x100' };
      if (method === 'eth_getCode') return '0x6000';
      assert.fail('Unexpected RPC method: ' + method);
    } };
  globalThis.window = { ethereum: provider, localStorage: {
    getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } };
  globalThis.fetch = async url => { urls.push(url); return { ok: true, json: async () => structuredClone(catalog) }; };
  process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY = 'full-test';
  const modules = { react: hooks, '../lib/native-sale-upgrade.mjs': { ...helper,
    async readNativeUpgradeStatus(_provider, _catalog, deployed) {
      return { delay: 0n, proposer: true, activated: executed, timestamp: executed ? 1n : scheduled ? 2n : 0n,
        batch: helper.nativeUpgradeDeploymentOrder.every(name => deployed[name]) ? helper.nativeUpgradeBatch(catalog, deployed) : null };
    },
    async reconcileNativeUpgradeDeployments(_provider, _catalog, steps) {
      for (const step of Object.values(steps)) if (!step.hash && ['unknown', 'awaiting-wallet'].includes(step.status))
        throw new Error('不能重复发送未知交易。');
      return { deployed: Object.fromEntries(helper.nativeUpgradeDeploymentOrder.flatMap((name, i) =>
        steps[name]?.status === 'confirmed' ? [[name, address(30 + i)]] : [])) };
    },
    async submitUpgradeTransaction(_provider, _account, transaction, persist) {
      sends.push(transaction); persist({ status: 'awaiting-wallet', hash: null });
      if (ambiguousSend) { persist({ status: 'unknown', hash: null }); throw new Error('网络结果未知。'); }
      const value = { status: 'submitted', hash: hash(sends.length + 100) }; persist(value); return value;
    },
    async confirmNativeUpgradeTransaction(_provider, _step, { batchProof }) {
      if (batchProof?.kind === 'schedule') scheduled = true;
      if (batchProof?.kind === 'execute') executed = true;
      return { contractAddress: address(29 + sends.length), blockNumber: '0x100' };
    },
    async verifyNativeUpgradeDeploymentRuntime(_provider, _catalog, _name, value) { return value; },
  } };
  const exported = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => modules[name] ?? require(name), exported, exported.exports);
  if (previousProfile == null) delete process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY;
  else process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY = previousProfile;
  const Component = exported.exports.default;
  const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value)
    ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];
  const render = () => { position = 0; tree = Component(); while (effects.length) effects.shift()(); };
  const settle = async () => { for (let i = 0; i < 8; i++) { await turn(); render(); } };
  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value)
    : !value || typeof value !== 'object' ? '' : Array.isArray(value) ? value.map(text).join('') : text(value.props?.children);
  const button = label => nodes(tree).find(node => node.type === 'button' && text(node) === label);
  render();
  return { settle, button, saved, sends, urls, reads, text: () => text(tree), nodes: () => nodes(tree),
    async connect() { button('连接部署钱包').props.onClick(); await settle(); },
    async run() { const candidate = ['开始启用', '继续启用', '同步升级状态'].map(button).find(Boolean);
      assert(candidate && !candidate.props.disabled); candidate.props.onClick(); await settle(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); globalThis.window = previousWindow; globalThis.fetch = previousFetch; } };
}

test('native upgrade renders five transactions and exact five-decimal existing price without asking the wallet on mount', async () => {
  const ui = harness(); try {
    await ui.settle(); assert.deepEqual(ui.sends, []); assert.deepEqual(ui.reads, []);
    assert.match(ui.urls[0], /\/data\/native-firsto-upgrade\.full-test\.json$/);
    assert.match(ui.text(), /共 5 笔钱包交易/); assert.match(ui.text(), /0\.04000 BNB/);
    assert.match(ui.text(), /待领取收益随矿机/); assert.match(ui.text(), /网络 Gas 不退/);
    assert.equal(ui.button('开始启用').props.disabled, true);
  } finally { ui.dispose(); }
});

test('another wallet cannot start the native upgrade or share the old sale-policy journal', async () => {
  const ui = harness({ account: other }); try {
    await ui.settle(); await ui.connect(); assert.equal(ui.button('开始启用').props.disabled, true);
    assert.deepEqual(ui.sends, []);
    assert.match(ui.text(), /当前钱包没有这次升级权限/);
    assert([...ui.saved.keys()].every(key => key.startsWith('bemine.native-firsto.v1:')));
  } finally { ui.dispose(); }
});

test('the explicit native upgrade action completes exactly three deployments and one schedule and execute batch', async () => {
  const ui = harness(); try {
    await ui.settle(); await ui.connect(); await ui.run();
    assert.equal(ui.sends.length, 5);
    assert.equal(ui.sends.slice(0, 3).every(tx => !tx.to), true);
    assert.equal(ui.sends.slice(3).every(tx => tx.to === catalog.bindings.timelock), true);
    const [key, raw] = [...ui.saved.entries()][0], progress = JSON.parse(raw);
    assert.match(key, /^bemine\.native-firsto\.v1:full-test:/);
    assert.equal(Object.keys(progress.steps).length, 5);
    assert(Object.values(progress.steps).every(step => step.status === 'confirmed'));
    assert.match(ui.text(), /Firsto 接受卖单后会显示上架/);
    assert.equal(ui.button('已启用').props.disabled, true);
  } finally { ui.dispose(); }
});

test('a wallet outcome without a hash stays saved and cannot be automatically sent again', async () => {
  const ui = harness({ ambiguousSend: true }); try {
    await ui.settle(); await ui.connect(); await ui.run(); assert.equal(ui.sends.length, 1);
    const record = JSON.parse([...ui.saved.values()][0]); assert.equal(record.steps.SaleSettlement.status, 'unknown');
    assert.match(ui.text(), /钱包结果尚未明确/);
    await ui.run(); assert.equal(ui.sends.length, 1); assert.match(ui.text(), /不能重复发送未知交易/);
  } finally { ui.dispose(); }
});
