import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingAmount } from '../lib/funding-amount.mjs';

test('fundraising BNB uses three decimals and exact positive half-up rounding', () => {
  for (const [input, expected] of [['0.0054', '0.005'], ['0.005499999999999999', '0.005'], ['0.0055', '0.006'],
    ['0.9995', '1.000'], ['0.0005', '0.001'], ['0.000499999999999999', '0.000'], ['.005', '0.005'],
    ['1.', '1.000'], ['0', '0.000'], ['9007199254740993.9995', '9007199254740994.000']])
    assert.equal(fundingAmount(input).rounded, expected, input);
});

test('quoted display marks every hidden Wei without altering the exact input', () => {
  const raw = '2.2000000000000001', result = fundingAmount(raw);
  assert.equal(result.display, '≈ 2.200'); assert.equal(raw, '2.2000000000000001'); assert.equal(result.approximate, true);
  assert.deepEqual(fundingAmount('0.005000000000000000'), { rounded: '0.005', approximate: false, display: '0.005' });
  assert.equal(fundingAmount('0.000000000000000001').display, '≈ 0.000');
});

test('invalid amounts are not silently coerced to a different payment', () => {
  for (const value of ['', ' ', '-', '-1', '1e-3', '0,005', 'NaN', Infinity, 0.005, null, '0.0050000000000000001'])
    assert.throws(() => fundingAmount(value));
});
