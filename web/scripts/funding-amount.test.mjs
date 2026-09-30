import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingAmount } from '../lib/funding-amount.mjs';

test('fundraising BNB uses five display decimals and exact positive half-up rounding', () => {
  for (const [input, expected] of [['0.0054', '0.00540'], ['0.005494999999999999', '0.00549'], ['0.005495', '0.00550'],
    ['0.999995', '1.00000'], ['0.000005', '0.00001'], ['0.000004999999999999', '0.00000'], ['.005', '0.00500'],
    ['1.', '1.00000'], ['0', '0.00000'], ['9007199254740993.999995', '9007199254740994.00000']])
    assert.equal(fundingAmount(input).rounded, expected, input);
});

test('quoted display marks every hidden Wei without altering the exact input', () => {
  const raw = '2.2000000000000001', result = fundingAmount(raw);
  assert.equal(result.display, '≈ 2.20000'); assert.equal(raw, '2.2000000000000001'); assert.equal(result.approximate, true);
  assert.deepEqual(fundingAmount('0.005000000000000000'), { rounded: '0.00500', approximate: false, display: '0.00500' });
  assert.equal(fundingAmount('0.000000000000000001').display, '≈ <0.00001');
});

test('invalid amounts are not silently coerced to a different payment', () => {
  for (const value of ['', ' ', '-', '-1', '1e-3', '0,005', 'NaN', Infinity, 0.005, null, '0.0050000000000000001'])
    assert.throws(() => fundingAmount(value));
});
