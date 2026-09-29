import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiContext, sameUnsignedIntent } from '../lib/ui-context.mjs';

test('pool A read and preview cannot overwrite pool B after selection or account changes', () => {
  const context = createUiContext();
  const poolA = context.begin();
  context.invalidate();
  const poolB = context.begin();
  assert.equal(context.current(poolA), false);
  assert.equal(context.current(poolB), true);
  context.invalidate();
  assert.equal(context.current(poolB), false);
});
test('later read wins even when requests complete in the opposite order', async () => {
  const context = createUiContext(); let visible = null, finishA, finishB;
  const a = context.begin();
  const first = new Promise(resolve => { finishA = resolve; }).then(value => { if (context.current(a)) visible = value; });
  const b = context.begin();
  const second = new Promise(resolve => { finishB = resolve; }).then(value => { if (context.current(b)) visible = value; });
  finishB('B'); await second; finishA('A'); await first;
  assert.equal(visible, 'B');
});
test('confirmation binding rejects changed pool, wallet, call or whole-miner payment', () => {
  const tx = { from: '0x1234', to: '0xabcd', chainId: '0x38', data: '0x5678', value: '0x64' };
  assert.equal(sameUnsignedIntent(tx, { ...tx, value: '100' }), true);
  for (const change of [{ from: '0x1235' }, { to: '0xabce' }, { data: '0x5679' }, { value: '0x65' }, { chainId: '0x1' }])
    assert.equal(sameUnsignedIntent(tx, { ...tx, ...change }), false);
});
