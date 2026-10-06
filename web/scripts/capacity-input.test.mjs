import test from 'node:test';
import assert from 'node:assert/strict';
import { inputPriceWei, fixedPrice, linkedPrice, linkedPriceWei, exactPrice, proposedSalePriceWei,
  validCapacityQuote, purchaseReference } from '../lib/capacity-input.mjs';

test('Firsto NFT 16736 capacity uses its exact gross BEM output and floors the quotient in wei', () => {
  const daily = 432000n, price = inputPriceWei('0.01500');
  assert.equal(linkedPriceWei('0.01500', 'sale', daily), price * 100000000n / daily);
  assert.equal(linkedPriceWei('0.01500', 'sale', daily), 3472222222222222222n);
  assert.equal(linkedPrice('0.01500', 'sale', daily), '3.47222');
});

test('capacity-edited proposals round up only to wei and never reuse the five-place linked display', () => {
  const daily = 432000n;
  assert.equal(linkedPrice('0.01000', 'capacity', daily), '0.00004');
  const exact = proposedSalePriceWei({ salePrice: '0.00004', capacityPrice: '0.01000',
    editedField: 'capacity', dailyAtomic: daily });
  assert.equal(exact, 43200000000000n);
  assert.equal(exactPrice(exact), '0.0000432');
  assert.equal(linkedPriceWei('0.000000000000000001', 'capacity', daily), 1n,
    'A positive Firsto derived ask below one wei rounds up to one wei.');
});

test('five-place zero display does not turn a positive derived proposal into a zero-price transaction', () => {
  const derived = proposedSalePriceWei({ salePrice: '0.00000', capacityPrice: '0.000000001',
    editedField: 'capacity', dailyAtomic: 432000n });
  assert.equal(derived, 4320000n);
  assert.equal(fixedPrice(derived), '0.00000');
  assert.equal(exactPrice(derived), '0.00000000000432');
});

test('sale-edited proposals preserve all eighteen entered decimals regardless of linked display precision', () => {
  const source = '0.015001234567890123';
  assert.equal(proposedSalePriceWei({ salePrice: source, capacityPrice: '3.47222', editedField: 'sale',
    dailyAtomic: 432000n }), 15001234567890123n);
  assert.equal(fixedPrice(inputPriceWei(source)), '0.01500');
  assert.equal(exactPrice(inputPriceWei(source)), source);
});

test('an expired capacity source cannot submit the previously rounded sale display', () => {
  assert.throws(() => proposedSalePriceWei({ salePrice: '0.00004', capacityPrice: '0.01', editedField: 'capacity' }), /日产/);
  assert.throws(() => linkedPriceWei('9'.repeat(78), 'capacity', (1n << 256n) - 1n), /有效范围/);
});

test('linked whole-miner and daily capacity prices use BEM eight decimals and BNB eighteen', () => {
  assert.equal(linkedPrice('3', 'sale', 200000000n), '1.50000');
  assert.equal(linkedPrice('1.5', 'capacity', 200000000n), '3.00000');
  assert.equal(linkedPrice('0.04', 'sale', 497450n), '8.04101');
  assert.equal(linkedPrice('8.0410', 'capacity', 497450n), '0.04000');
  assert.equal(linkedPrice('1', 'sale', 300000000n), '0.33333');
  assert.equal(linkedPrice('1.23455', 'capacity', 100000000n), '1.23455');
  assert.equal(linkedPrice('', 'sale', 100000000n), '');
});

test('normalization pads five decimals with exact half-up rounding, no floating point drift', () => {
  assert.equal(fixedPrice(inputPriceWei('0.04')), '0.04000');
  assert.equal(fixedPrice(inputPriceWei('1.')), '1.00000');
  assert.equal(fixedPrice(inputPriceWei('0002.3')), '2.30000');
  assert.equal(fixedPrice(inputPriceWei('1.99995')), '1.99995');
  assert.equal(linkedPrice('9007199254740993.1234', 'sale', 100000000n), '9007199254740993.12340');
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
