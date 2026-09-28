import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayDecimal, displayUnits } from './display';

test('amounts and capacity prices round half up to exactly three decimals without floating point', () => {
  assert.equal(displayUnits('8024042950513538748'), '8.024');
  assert.equal(displayUnits('13343616000000000000'), '13.344');
  assert.equal(displayUnits('13477052160000000000'), '13.477');
  assert.equal(displayUnits('562896000', 8), '5.629');
  assert.equal(displayUnits('999500000000000000'), '1.000');
  assert.equal(displayUnits('499999999999999'), '0.000');
  assert.equal(displayUnits('500000000000000'), '0.001');
  assert.equal(displayUnits('-1500000000000000'), '-0.002');
  assert.equal(displayUnits(null), '—');
  assert.equal(displayUnits(0n), '0.000');
  assert.equal(displayUnits('123456789012345678901234567890'), '123456789012.346');
});

test('decimal wallet and budget strings are display-only and counts retain their own units', () => {
  assert.equal(displayDecimal('0.05'), '0.050');
  assert.equal(displayDecimal('0.164517'), '0.165');
  assert.equal(displayDecimal('9.9995'), '10.000');
  assert.equal(displayDecimal('1'), '1.000');
  assert.equal(displayDecimal(''), '—');
});
