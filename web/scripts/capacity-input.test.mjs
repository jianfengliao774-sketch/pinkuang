import test from 'node:test';
import assert from 'node:assert/strict';
import { inputPriceWei, fixedPrice, linkedPrice, validCapacityQuote, purchaseReference } from '../lib/capacity-input.mjs';

test('linked whole-miner and daily capacity prices use BEM eight decimals and BNB eighteen', () => {
  assert.equal(linkedPrice('3', 'sale', 200000000n), '1.5000');
  assert.equal(linkedPrice('1.5', 'capacity', 200000000n), '3.0000');
  assert.equal(linkedPrice('0.04', 'sale', 497450n), '8.0410');
  assert.equal(linkedPrice('8.0410', 'capacity', 497450n), '0.0400');
  assert.equal(linkedPrice('1', 'sale', 300000000n), '0.3333');
  assert.equal(linkedPrice('1.23455', 'capacity', 100000000n), '1.2346');
  assert.equal(linkedPrice('', 'sale', 100000000n), '');
});

test('normalization pads four decimals with exact half-up rounding, no floating point drift', () => {
  assert.equal(fixedPrice(inputPriceWei('0.04')), '0.0400');
  assert.equal(fixedPrice(inputPriceWei('1.')), '1.0000');
  assert.equal(fixedPrice(inputPriceWei('0002.3')), '2.3000');
  assert.equal(fixedPrice(inputPriceWei('1.99995')), '2.0000');
  assert.equal(linkedPrice('9007199254740993.1234', 'sale', 100000000n), '9007199254740993.1234');
  assert.equal(fixedPrice(497450n, 8, 8), '0.00497450');
});

test('unavailable output and malformed prices cannot fabricate a linked value', () => {
  for (const bad of ['-1', 'Infinity', 'NaN', '1e3', '1,2', '1.0000000000000000001']) {
    assert.throws(() => inputPriceWei(bad));
  }
  assert.throws(() => inputPriceWei('9'.repeat(79)));
  assert.throws(() => linkedPrice('1', 'sale', 0n));
  assert.throws(() => linkedPrice('1', 'sale', -1n));
});

test('current output is bound to the selected pool and expires', () => {
  const quote = { available: true, pool: '0xABC', estimated24hAtomic: 497450n, observedAt: 100000, validUntil: 400000 };
  assert.equal(validCapacityQuote(quote, '0xabc', 200000), quote);
  assert.equal(validCapacityQuote(quote, '0xdef', 200000), null);
  assert.equal(validCapacityQuote(quote, '0xabc', 400000), null);
  assert.equal(validCapacityQuote(quote, '0xabc', 99999), null);
  assert.equal(validCapacityQuote({ ...quote, estimated24hAtomic: 0n }, '0xabc', 200000), null);
});

test('reference preserves verified whole-miner purchase cost and does not require a market quote', () => {
  const reference = purchaseReference({ purchaseCost: 40000000000000000n, timestamp: 1700000000n });
  assert.deepEqual(reference, { refPriceWei: '40000000000000000', refAt: '1700000000' });
  assert.notEqual(reference.refPriceWei, inputPriceWei('8.0410').toString());
  assert.throws(() => purchaseReference({ purchaseCost: 0n, timestamp: 1700000000n }));
  assert.throws(() => purchaseReference({ purchaseCost: 1n, timestamp: 1n << 64n }));
});
