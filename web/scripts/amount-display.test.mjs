import test from 'node:test';
import assert from 'node:assert/strict';
import { displayAmount, displayDecimal, displayGasFee, displayPreciseAmount } from '../lib/amount-display.mjs';
import { shareListingView } from '../lib/share-listing-view.mjs';
test('monetary and capacity display rounds exact atoms, including carry and sub-half-unit values',()=>{
  assert.equal(displayAmount(49999999999999n),'<0.0001');
  assert.equal(displayAmount(50000000000000n),'0.0001');
  assert.equal(displayAmount(999950000000000000n),'1.0000');
  assert.equal(displayAmount(-50000000000000n),'-0.0001');
  assert.equal(displayAmount(123456789n,8),'1.2346');
  assert.equal(displayAmount(123456789n,10),'0.0123');
  assert.equal(displayAmount(7n,0),'7.0000');
  assert.equal(displayAmount(null),'—');
  assert.equal(displayAmount(900719925474099312345999999999999999n),'900,719,925,474,099,312.3460');
  assert.equal(displayAmount(1n),'<0.0001');
  assert.equal(displayAmount(500000000000n),'<0.0001');
  assert.equal(displayAmount(495000000000000000n),'0.4950');
});
test('decimal presentation never rounds the stored or transaction source',()=>{
  const original='0.005499999999999999';
  assert.equal(displayDecimal(original),'0.0055');assert.equal(original,'0.005499999999999999');
  assert.equal(displayDecimal('0.005500000000000001'),'0.0055');
  assert.equal(displayDecimal(1e-7),'<0.0001');assert.equal(displayDecimal('1.25e3'),'1,250.0000');
  assert.equal(displayDecimal('Infinity'),'—');assert.equal(displayDecimal(undefined),'—');
});
test('Gas upper bound uses four decimal places and never understates a positive fee',()=>{
  assert.equal(displayGasFee('0'),'0.0000');
  assert.equal(displayGasFee('1'),'0.0001');
  assert.equal(displayGasFee('123456789000000'),'0.0002');
  assert.equal(displayGasFee('1000000000000000000'),'1.0000');
  assert.throws(()=>displayGasFee('-1'));
});
test('four-place pool prices do not render small positive shares as zero',()=>{
  assert.equal(displayPreciseAmount(444400000000000n),'0.0004');
  assert.equal(displayPreciseAmount(432000n,8),'0.0043');
  assert.equal(displayPreciseAmount(8100000000000000000n),'8.1000');
  assert.equal(displayPreciseAmount(1n),'<0.0001');
  assert.equal(displayPreciseAmount(null),'—');
});
test('the directory two-place exception rounds the source directly, avoiding double rounding',()=>{
  const source = 1234999999999999999n;
  assert.equal(displayAmount(source),'1.2350');
  assert.equal(displayPreciseAmount(source,18,2),'1.23');
  assert.equal(displayPreciseAmount(9995000000000000000n,18,2),'10.00');
  assert.equal(displayDecimal('1.234999999999999999',2),'1.23');
  assert.equal(displayDecimal('45.43002'),'45.4300');
});
test('listing uses an ordinary holder position and subtracts existing locks; unknown/frozen positions are disabled',()=>{
  const pool={pool:'0x0000000000000000000000000000000000000001',status:'Active',shareTradingAllowed:true,shares:35n,lockedShares:5n,availableShares:30n};
  assert.deepEqual(shareListingView(pool),{allowed:true,shares:35n,locked:5n,available:30n,defaultQuantity:'30'});
  for(const changes of [{status:'Funding'},{shareTradingAllowed:false},{availableShares:35n},{shares:null},{shares:0n,lockedShares:0n,availableShares:0n}])assert.equal(shareListingView({...pool,...changes}).allowed,false);
});
