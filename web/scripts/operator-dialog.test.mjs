import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';
import { formatEther, parseEther } from 'ethers';
import { createUiContext } from '../lib/ui-context.mjs';
import * as scroll from '../lib/dialog-scroll-lock.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const collection = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const source = (await readFile(new URL('../components/LiveOperator.jsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

function handlers({ prepared, prepareError, onSend, preview, autoSelection = null } = {}) {
  const state = { form: { circuits: collection, circuitId: '16736', targetRaise: '0.004444444444444444',
    priceCap: '0.004', fundingHours: '24', purchaseHours: '48' }, preview: preview ?? null, feedback: null,
    busy: false, error: '', progress: '', sendCalls: [] };
  const context = { context: { current: createUiContext() }, previewRead: { current: null }, form: state.form,
    mode: 'createPool', pool: '', listingId: '', key: 'factory:account', autoSelection, direct: true,
    config: { productFamily: 'fresh-v4', displayOnly: true }, account: 'account', readProvider: { name: 'display' },
    wallet: { request: () => assert.fail('Draft feedback cannot request wallet transactions.') },
    formatEther, parseEther, errorText: error => error.message, preview: state.preview,
    recheckSelection: async () => autoSelection.draft,
    parseOperatorImport: () => assert.fail('Manual imports are not used by this fixture.'),
    boundedReadPreview: async (fn, options) => { assert.equal(options.provider.name, 'display');
      return fn({ provider: options.provider, signal: options.signal, check: () => assert(options.isCurrent()) }); },
    prepareAdminAction: async input => { state.prepareInput = input; if (prepareError) throw prepareError;
      return prepared instanceof Promise ? prepared : prepared ?? { kind: 'createPool', transaction: {}, request: input }; },
    onSend: async value => { state.sendCalls.push(value); return onSend?.(value) ?? { status: 'pending' }; } };
  for (const field of ['Form', 'Preview', 'Feedback', 'Busy', 'Error', 'Progress', 'AutoSelection', 'Imported'])
    context['set' + field] = value => { const name = field[0].toLowerCase() + field.slice(1);
      state[name] = typeof value === 'function' ? value(state[name]) : value; };
  const applyStart = source.indexOf('  function applyQuote('), applyEnd = source.indexOf('  async function recheckSelection(', applyStart);
  const prepareStart = source.indexOf('  async function prepare('), sendStart = source.indexOf('  async function send(', prepareStart);
  const end = source.indexOf('  return <section', sendStart);
  assert(applyStart > 0 && applyEnd > applyStart && prepareStart > 0 && end > sendStart);
  const functions = new Function(...Object.keys(context), source.slice(applyStart, applyEnd) + source.slice(prepareStart, end)
    + '\nreturn { applyQuote, prepare, cancelPreviewRead, send };')(...Object.values(context));
  return { ...functions, state, context };
}

test('draft fill opens explicit unpublished feedback, preserves exact amounts and does not prepare or submit', () => {
  const f = handlers(), selection = { draft: { params: { circuits: collection, circuitId: '16736',
    targetRaiseWei: '4444444444444444', priceCapWei: '4000000000000000' } } };
  f.applyQuote(selection);
  assert.equal(f.state.form.targetRaise, '0.004444444444444444');
  assert.equal(f.state.feedback.kind, 'filled'); assert.match(f.state.feedback.message, /尚未发布/);
  assert.equal(f.state.preview, null); assert.equal(f.state.prepareInput, undefined); assert.equal(f.state.sendCalls.length, 0);
});

test('actual preview callback shows progress until the read completes and read failure opens an error without success', async () => {
  const pending = deferred(), f = handlers({ prepared: pending.promise });
  const reading = f.prepare(); await turn();
  assert.equal(f.state.feedback.kind, 'preparing'); assert.equal(f.state.busy, true);
  assert.equal(f.state.preview, null); assert.equal(f.state.sendCalls.length, 0);
  const prepared = { kind: 'createPool', transaction: { data: 'exact' }, request: { kind: 'createPool', params: {} } };
  pending.resolve(prepared); await reading;
  assert.equal(f.state.feedback, null); assert.equal(f.state.preview.transaction, prepared.transaction); assert.equal(f.state.busy, false);
  assert.equal(f.state.prepareInput.params.targetRaiseWei, '4444444444444444');
  const failed = handlers({ prepareError: Error('报价无法读取') }); await failed.prepare();
  assert.equal(failed.state.feedback.kind, 'preview-error'); assert.match(failed.state.feedback.message, /报价无法读取/);
  assert.equal(failed.state.preview, null); assert.equal(failed.state.busy, false); assert.equal(failed.state.sendCalls.length, 0);
});

test('cancelling an unfinished preview prevents its late response from reopening a modal', async () => {
  const pending = deferred(), f = handlers({ prepared: pending.promise }), reading = f.prepare();
  await turn(); const controller = f.context.previewRead.current;
  f.cancelPreviewRead(); assert.equal(controller.signal.aborted, true); assert.equal(f.state.feedback, null);
  pending.resolve({ kind: 'createPool', request: {} }); await reading;
  assert.equal(f.state.preview, null); assert.equal(f.state.feedback, null); assert.equal(f.state.busy, false);
});

test('actual send callback removes preview while awaiting the parent and never converts pending or unknown failure to success', async () => {
  const pending = deferred(), preview = { identity: 'factory:account', ticket: 0, input: { params: {} } };
  const f = handlers({ preview, onSend: () => pending.promise }), sending = f.send();
  await turn(); assert.equal(f.state.preview, null); assert.equal(f.state.feedback.kind, 'submitting');
  assert.equal(f.state.sendCalls[0], preview); pending.resolve({ status: 'pending', hash: 'submitted' }); await sending;
  assert.equal(f.state.feedback, null); assert.equal(f.state.busy, false);
  const failed = handlers({ preview, onSend: () => { throw Error('提交结果暂无法确认'); } }); await failed.send();
  assert.equal(failed.state.feedback.kind, 'submission-error'); assert.equal(failed.state.feedback.title, '本次操作未完成');
  assert.equal(failed.state.preview, null); assert(!JSON.stringify(failed.state.feedback).includes('成功'));
});

test('overlapping preview and result locks restore original overflow only after both close, in either order', () => {
  for (const order of [[0, 1], [1, 0]]) {
    let overflow = 'auto'; const writes = [], style = {};
    Object.defineProperty(style, 'overflow', { get: () => overflow, set: value => { overflow = value; writes.push(value); } });
    const document = { body: { style } }, releases = [scroll.lockDialogScroll(document), scroll.lockDialogScroll(document)];
    releases[order[0]](); releases[order[0]](); assert.equal(overflow, 'hidden');
    releases[order[1]](); releases[order[1]](); assert.equal(overflow, 'auto');
    assert.equal(writes.filter(value => value === 'auto').length, 1, 'Repeated cleanup cannot unlock a surviving dialog or restore twice.');
    const next = scroll.lockDialogScroll(document); next(); assert.equal(overflow, 'auto');
  }
});

test('actual OperatorDialog stays absent during static export and renders its accessible confirmation into body', async () => {
  await loadBindings();
  const require = createRequire(import.meta.url), module = { exports: {} }, targets = [];
  const code = (await transform(await readFile(new URL('../components/OperatorDialog.jsx', import.meta.url), 'utf8'), {
    filename: 'OperatorDialog.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
      transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' } })).code;
  new Function('require', 'module', 'exports', code)(name => name === '../lib/dialog-scroll-lock.mjs' ? scroll
    : name === 'react-dom' ? { createPortal: (children, target) => { targets.push(target); return children; } }
      : require(name), module, module.exports);
  const Component = module.exports.default, props = { title: '募集方案已填入', children: '项目尚未发布' };
  assert.equal(renderToStaticMarkup(React.createElement(Component, props)), '');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), body = {};
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body } });
  try {
    const markup = renderToStaticMarkup(React.createElement(Component, props));
    assert.match(markup, /role="dialog"/); assert.match(markup, /aria-modal="true"/); assert.match(markup, /项目尚未发布/);
    assert.deepEqual(targets, [body]);
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; }
});
