import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingAmount } from '../lib/funding-amount.mjs';

test('fundraising BNB uses four display decimals and exact positive half-up rounding', () => {
  for (const [input, expected] of [['0.0054', '0.0054'], ['0.005449999999999999', '0.0054'], ['0.00545', '0.0055'],
    ['0.99995', '1.0000'], ['0.00005', '0.0001'], ['0.000049999999999999', '0.0000'], ['.005', '0.0050'],
    ['1.', '1.0000'], ['0', '0.0000'], ['9007199254740993.99995', '9007199254740994.0000']])
    assert.equal(fundingAmount(input).rounded, expected, input);
});

test('quoted display marks every hidden Wei without altering the exact input', () => {
  const raw = '2.2000000000000001', result = fundingAmount(raw);
  assert.equal(result.display, '≈ 2.2000'); assert.equal(raw, '2.2000000000000001'); assert.equal(result.approximate, true);
  assert.deepEqual(fundingAmount('0.005000000000000000'), { rounded: '0.0050', approximate: false, display: '0.0050' });
  assert.equal(fundingAmount('0.000000000000000001').display, '≈ <0.0001');
});

test('invalid amounts are not silently coerced to a different payment', () => {
  for (const value of ['', ' ', '-', '-1', '1e-3', '0,005', 'NaN', Infinity, 0.005, null, '0.0050000000000000001'])
    assert.throws(() => fundingAmount(value));
});
