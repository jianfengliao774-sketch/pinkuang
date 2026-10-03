import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';
import { abi } from '../lib/chain-client.mjs';
import { operatorCreateInput } from '../lib/operator-create-input.mjs';
import { prepareAdminAction } from '../lib/live-admin.mjs';
import * as quotes from '../lib/operator-quotes.mjs';
import { dataFixture } from './operator-quotes-fixture.mjs';

const require = createRequire(import.meta.url), turn = () => new Promise(resolve => setImmediate(resolve));
const address = number => `0x${number.toString(16).padStart(40, '0')}`;
const collection = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', account = address(1);
await loadBindings();
const { code } = await transform(await readFile(new URL('../components/LiveOperator.jsx', import.meta.url), 'utf8'), {
  filename: 'LiveOperator.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
    transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
});
const elements = tree => tree == null || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(elements)
  : [tree, ...elements(tree.props?.children)];
const text = tree => tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree) ? tree.map(text).join('')
  : typeof tree === 'object' ? text(tree.props?.children) : String(tree);
const QuotePicker = () => null, Dialog = () => null;

function fixture(overrides = {}) {
  const slots = [], effects = [], reads = [], prepared = [], results = []; let position = 0, tree;
  const hooks = {
    useState(initial) { const index = position++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useRef(initial) { return slots[position++] ??= { current: initial }; },
    useEffect(fn, deps) { const index = position++, old = slots[index];
      if (!old || deps.some((dep, at) => dep !== old.deps[at])) effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; }); },
  };
  const provider = { request: () => assert.fail('Local form validation and direct previews cannot read RPC or request a wallet.') };
  const props = { config: { status: 'ready', chainId: 56, factory: address(2), authority: address(3), portfolioFactory: address(4),
    displayOnly: true, productFamily: 'fresh-v4', stage: 'fresh-active', freshAuthority: { administratorOne: account, administratorTwo: address(5) } },
  account, wallet: provider, readProvider: provider, operator: { isOperator: true, creationPaused: false }, disabled: false,
  onSend: () => assert.fail('Preview cannot submit a transaction.'), onRefresh() {}, ...overrides };
  const modules = { react: hooks, '../app/live-operator.css': {}, './OperatorQuotePicker': { __esModule: true, default: QuotePicker },
    './OperatorDialog': { __esModule: true, default: Dialog }, '../lib/operator-create-input.mjs': { operatorCreateInput },
    '../lib/operator-quotes.mjs': { ...quotes, loadOperatorQuote: () => assert.fail('Form validation cannot fetch a quote.') },
    '../lib/bounded-read-preview.mjs': { boundedReadPreview: async (fn, options) => { reads.push(options);
      return fn({ provider: options.provider, check: () => assert(options.isCurrent()), signal: options.signal }); } },
    '../lib/live-admin.mjs': { prepareAdminAction: async input => { prepared.push(input); const result = await prepareAdminAction(input);
      results.push(result); return result; } } };
  const exported = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => modules[name] ?? require(name), exported, exported.exports);
  const render = () => { position = 0; tree = exported.exports.default(props); while (effects.length) effects.shift()(); return tree; };
  const button = label => { const node = elements(tree).find(node => node.type === 'button' && text(node) === label);
    assert(node, `Missing button ${label}`); return node.props; };
  const field = label => { const node = elements(tree).find(node => node.type === 'label' && text(node).startsWith(label));
    assert(node, `Missing field ${label}`); return elements(node).find(child => ['input', 'select', 'textarea'].includes(child.type)).props; };
  const input = (label, value) => { field(label).onChange({ target: { value } }); render(); };
  const settle = async () => { for (let i = 0; i < 4; i++) { await turn(); render(); } };
  render(); render();
  return { render, button, field, input, settle, props, reads, prepared, results, get tree() { return tree; },
    apply(selection) { elements(tree).find(node => node.type === QuotePicker).props.onApply(selection); render(); } };
}
function fill(ui, { id = '16736', target = '0.005', cap = '0.004' } = {}) {
  ui.input('矿机编号', id); ui.input('募集总额', target); ui.input('购机价格上限', cap);
}

test('actual empty form shows each missing field, disables preview, and even a stale click never enters preview reads', async () => {
  const ui = fixture();
  assert.equal(ui.button('预览创建矿池').disabled, true);
  for (const label of ['矿机编号', '募集总额', '购机价格上限']) {
    assert.equal(ui.field(label)['aria-invalid'], true); assert(ui.field(label)['aria-describedby']);
    assert.match(text(ui.tree), new RegExp(`请填写${label}。`));
  }
  await ui.button('预览创建矿池').onClick(); await ui.settle();
  assert.equal(ui.reads.length, 0); assert.equal(ui.prepared.length, 0);
  assert(!elements(ui.tree).some(node => node.type === Dialog), 'Invalid input does not open the old ethers error dialog.');
});

test('actual JSX rejects malformed amounts, identifiers, range and deadlines before boundedReadPreview', async () => {
  const invalid = [
    ['募集总额', '1e-3', /募集总额请输入 BNB/], ['募集总额', '0,005', /募集总额请输入 BNB/],
    ['募集总额', '≈ 0.00500', /募集总额请输入 BNB/], ['募集总额', 'NaN', /募集总额请输入 BNB/],
    ['募集总额', '-1', /募集总额请输入 BNB/], ['募集总额', '0.0000000000000000001', /最多 18 位/],
    ['募集总额', '0', /募集总额必须大于 0/], ['募集总额', '0.000000000000000001', /100 份/],
    ['购机价格上限', '0.006', /不能超过募集总额/], ['购机价格上限', '9'.repeat(100), /金额超出有效范围/],
    ['矿机编号', '1.5', /非负整数/], ['矿机编号', (1n << 256n).toString(), /矿机编号超出/],
    ['募集截止', '', /请填写募集截止/], ['募集截止', '0', /必须大于 0 小时/],
    ['购机期限', '1.5', /正整数小时/], ['购机期限', '4294967296', /小时数超出/],
  ];
  for (const [field, value, message] of invalid) {
    const ui = fixture(); fill(ui); ui.input(field, value);
    assert.equal(ui.button('预览创建矿池').disabled, true, `${field}: ${value}`);
    assert.match(text(ui.tree), message); assert.equal(ui.field(field)['aria-invalid'], true);
    await ui.button('预览创建矿池').onClick(); await ui.settle();
    assert.equal(ui.reads.length, 0); assert.equal(ui.prepared.length, 0);
  }
});

test('manual normal forms accept zero NFT ID and familiar exact decimals, then produce real unsigned calldata', async () => {
  for (const [target, cap, targetWei, capWei] of [[' .005 ', '000.004', '5000000000000000', '4000000000000000'],
    ['1.', '000.5', '1000000000000000000', '500000000000000000'],
    ['0.000000000000000100', '0.000000000000000001', '100', '1']]) {
    const ui = fixture(); fill(ui, { id: ' 0000 ', target, cap });
    ui.input('募集截止', ' 024 '); assert.equal(ui.button('预览创建矿池').disabled, false);
    await ui.button('预览创建矿池').onClick(); await ui.settle();
    assert.equal(ui.reads.length, 1); assert.equal(ui.prepared.length, 1);
    assert.equal(ui.prepared[0].params.targetRaiseWei, targetWei); assert.equal(ui.prepared[0].params.priceCapWei, capWei);
    assert.equal(ui.prepared[0].params.circuitId, '0');
    assert.equal(ui.prepared[0].params.fundingHours, '24');
    const transaction = ui.results[0].transaction, decoded = abi.PoolFactory.parseTransaction(transaction);
    assert.equal(decoded.name, 'createPool'); assert.equal(decoded.args[0].targetRaise, BigInt(targetWei));
    assert.equal(decoded.args[0].priceCap, BigInt(capWei)); assert.equal(decoded.args[0].circuitId, 0n);
    assert.equal(transaction.value, '0x0');
    const dialog = elements(ui.tree).find(node => node.type === Dialog && node.props.title === '核对后前往钱包');
    assert(dialog, 'Complete form shows the unsigned preview, with no submission.');
    const submit = ui.button('发送到钱包确认'); assert.equal(submit.disabled, false);
  }
});

test('actual apply-quote and modal-preview callbacks preserve every quoted Wei despite rounded field presentation', async () => {
  const ui = fixture(), checked = { quote: null, chain: { collection, tokenId: '5181', displayOnly: true,
    checkedAt: Date.now(), official: { priceWei: '4000000000000001' } } };
  const selection = { checked, extraBps: 1000, draft: quotes.operatorQuoteDraft(checked) };
  ui.input('募集截止', ' 024 '); ui.input('购机期限', '0048');
  ui.apply(selection);
  const dialog = elements(ui.tree).find(node => node.type === Dialog && node.props.title === '募集方案已填入'); assert(dialog);
  const preview = elements(dialog).find(node => node.type === 'button' && text(node) === '预览创建矿池').props;
  assert.equal(preview.disabled, false);
  ui.field('募集总额').onFocus(); ui.render();
  assert.equal(ui.field('募集总额').value, '0.0044000000000001');
  ui.field('募集总额').onBlur(); ui.render(); assert.match(ui.field('募集总额').value, /0.00440/);
  ui.field('购机价格上限').onFocus(); ui.render(); assert.equal(ui.field('购机价格上限').value, '0.004000000000000001');
  ui.field('购机价格上限').onBlur(); ui.render();
  const currentDialog = elements(ui.tree).find(node => node.type === Dialog && node.props.title === '募集方案已填入');
  const currentPreview = elements(currentDialog).find(node => node.type === 'button' && text(node) === '预览创建矿池').props;
  assert.equal(currentPreview.disabled, false); await currentPreview.onClick(); await ui.settle();
  assert.equal(ui.prepared[0].params.targetRaiseWei, '4400000000000100');
  assert.equal(ui.prepared[0].params.priceCapWei, '4000000000000001');
  assert.equal(ui.prepared[0].params.fundingHours, '24'); assert.equal(ui.prepared[0].params.purchaseHours, '48');
  assert.equal(ui.reads.length, 1); assert.equal(ui.prepared.length, 1);
  assert.equal(ui.button('发送到钱包确认').disabled, false);
});

test('invalid quote duration disables both main and filled-dialog previews while permission restrictions remain', async () => {
  const ui = fixture(), checked = { quote: null, chain: { collection, tokenId: '7', displayOnly: true,
    checkedAt: Date.now(), official: { priceWei: '4000000000000000' } } };
  ui.input('募集截止', '0'); ui.apply({ checked, extraBps: 1000, draft: quotes.operatorQuoteDraft(checked) });
  for (const node of elements(ui.tree).filter(node => node.type === 'button' && text(node) === '预览创建矿池')) {
    assert.equal(node.props.disabled, true); await node.props.onClick();
  }
  assert.equal(ui.reads.length, 0); assert.match(text(ui.tree), /募集截止必须大于 0/);
  const blocked = fixture({ disabled: true, disabledReason: '交易提交中' }); fill(blocked);
  assert.equal(blocked.button('预览创建矿池').disabled, true); await blocked.button('预览创建矿池').onClick();
  assert.equal(blocked.reads.length, 0); assert.match(text(blocked.tree), /交易提交中/);
});

test('empty or malformed flexible import is rejected locally without opening a preview', async () => {
  const ui = fixture(); ui.button('单台矿机灵活替代').onClick(); ui.render();
  assert.equal(ui.button('预览创建矿池').disabled, true); assert.match(text(ui.tree), /请先在上方选择矿机/);
  await ui.button('预览创建矿池').onClick();
  ui.input('已核验矿机报价 JSON', '{}'); assert.equal(ui.button('预览创建矿池').disabled, true);
  assert.match(text(ui.tree), /完整报价参数无效/); await ui.button('预览创建矿池').onClick();
  assert.equal(ui.reads.length, 0); assert.equal(ui.prepared.length, 0);
});

test('complete flexible auto-selection and manual imports still produce exact unsigned flexible creation previews', async () => {
  const data = dataFixture(), checked = { quote: data.quote, reference: data.reference, chain: { collection: data.quote.collection,
    tokenId: data.quote.tokenId, checkedAt: Date.now(), displayOnly: true } };
  const draft = quotes.operatorQuoteDraft(checked, { mode: 'createFlexiblePoolChecked' });
  for (const imported of [false, true]) {
    const ui = fixture(); ui.button('单台矿机灵活替代').onClick(); ui.render();
    if (imported) ui.input('已核验矿机报价 JSON', JSON.stringify(draft));
    else ui.apply({ checked, extraBps: 1000, draft });
    assert(ui.button('预览创建矿池').disabled === false);
    await ui.button('预览创建矿池').onClick(); await ui.settle();
    assert.equal(ui.reads.length, 1); assert.equal(ui.prepared.length, 1);
    const decoded = abi.PoolFactory.parseTransaction(ui.results[0].transaction);
    assert.equal(decoded.name, 'createFlexiblePoolChecked');
    assert.equal(decoded.args[0].targetRaise, BigInt(draft.params.targetRaiseWei));
    assert.equal(decoded.args[0].priceCap, BigInt(draft.params.priceCapWei));
    assert.equal(decoded.args[2], BigInt(draft.expectedTaskId));
    assert.equal(decoded.args[3], BigInt(draft.expectedReferenceWeight));
    assert.equal(ui.results[0].transaction.value, '0x0');
  }
});
