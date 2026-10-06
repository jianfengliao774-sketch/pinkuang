import test from 'node:test';
import assert from 'node:assert/strict';
import {portfolioDustProofForReceipt} from './portfolio-dust-proof-reuse.mjs';
const row={delaySeconds:172800,transactions:{deploy:{address:'0x1234'}}};
const plan={target:'0xabcd',to:'0x2345',operationId:'0x9876'};
const proof={chainId:56,readOnly:true,chainActionsPerformed:false,blockNumber:20,
  replacementVerified:true,replacement:'0x1234',portfolioBeacon:plan.target,timelock:plan.to,
  operationId:plan.operationId,minDelay:'172800'};
test('reuse only covers receipts at or before the current verified anchor',()=>{
  assert.equal(portfolioDustProofForReceipt(null,row,plan,{blockNumber:10}),null);
  assert.equal(portfolioDustProofForReceipt(proof,row,plan,{blockNumber:20}),proof);
  assert.equal(portfolioDustProofForReceipt(proof,row,plan,{blockNumber:21}),null);
});
test('another operation, target, runtime, delay or non-readonly proof never substitutes',()=>{
  for(const patch of [{chainId:1},{readOnly:false},{chainActionsPerformed:true},{blockNumber:NaN},
    {replacementVerified:false},{replacement:'0x9999'},{portfolioBeacon:'0x9999'},
    {timelock:'0x9999'},{operationId:'0x9999'},{minDelay:'172801'},{minDelay:'-1'}])
    assert.throws(()=>portfolioDustProofForReceipt({...proof,...patch},row,plan,{blockNumber:10}));
});
