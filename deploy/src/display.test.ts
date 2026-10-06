import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayDecimal, displayUnits } from './display';

test('amounts and capacity prices round half up to exactly five decimals without floating point', () => {
  assert.equal(displayUnits('8024042950513538748'), '8.02404');
  assert.equal(displayUnits('13343616000000000000'), '13.34362');
  assert.equal(displayUnits('13477052160000000000'), '13.47705');
  assert.equal(displayUnits('562896000', 8), '5.62896');
  assert.equal(displayUnits('999500000000000000'), '0.99950');
  assert.equal(displayUnits('499999999999999'), '0.00050');
  assert.equal(displayUnits('500000000000000'), '0.00050');
  assert.equal(displayUnits('-1500000000000000'), '-0.00150');
  assert.equal(displayUnits(null), '—');
  assert.equal(displayUnits(0n), '0.00000');
  assert.equal(displayUnits('123456789012345678901234567890'), '123456789012.34568');
});

test('decimal wallet and budget strings are display-only and counts retain their own units', () => {
  assert.equal(displayDecimal('0.05'), '0.05000');
  assert.equal(displayDecimal('0.164517'), '0.16452');
  assert.equal(displayDecimal('9.9995'), '9.99950');
  assert.equal(displayDecimal('1'), '1.00000');
  assert.equal(displayDecimal(''), '—');
});
