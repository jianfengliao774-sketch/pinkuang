import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareGenesisTargetOwnerReview} from './target-owner-review.mjs';
import {createTargetOwnerFixture} from '../shared/target-owner-upgrade-test-fixture.mjs';
import {evidenceDigest} from '../shared/firsto-upgrade-proof.mjs';

test('unchanged-genesis review derives complete exact old links without asserting current chain readiness',()=>{
  const {input}=createTargetOwnerFixture({aliases:false});
  const review=prepareGenesisTargetOwnerReview(input);
  assert.equal(Object.keys(review.catalog.nodes).length,23);
  assert.equal(review.catalogDigest,evidenceDigest(review.catalog));
  assert.equal(review.currentChainStateVerified,false);assert.equal(review.unsigned,true);
  assert.equal(review.catalog.nodes.FirstoSale.links.PoolFunds,input.genesisRecord.addresses.PoolFunds);
  for(const [name,node] of Object.entries(review.catalog.nodes))
    assert.equal(node.codehash,input.genesisRecord.verification.code[name].codehash);
});
test('genesis review refuses stale independent pins or a claimed runtime differing from exact compiled bytes',()=>{
  const {input}=createTargetOwnerFixture({aliases:false});
  assert.throws(()=>prepareGenesisTargetOwnerReview({...input,trustedUpgradeArtifactDigest:'0x'+'f'.repeat(64)}),/artifact pin/);
  const record=structuredClone(input.genesisRecord);record.verification.code.FirstoSale.codehash='0x'+'f'.repeat(64);
  assert.throws(()=>prepareGenesisTargetOwnerReview({...input,genesisRecord:record,
    trustedGenesisRecordDigest:evidenceDigest(record)}),/FirstoSale runtime/);
});
