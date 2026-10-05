import test from 'node:test';
import assert from 'node:assert/strict';
import { getCreateAddress,keccak256 } from 'ethers';
import {newPortfolioDustJournal,parsePortfolioDustJournal,portfolioDustJournalKey,verifyPortfolioDustReceipt,assertPortfolioDustConfirmedState} from './portfolio-dust-journal.mjs';
const a=n=>`0x${String(n).padStart(40,'0')}`,h=n=>`0x${String(n).padStart(64,'0')}`;
const config={deployer:a(1),proposer:a(2),candidateArtifactDigest:h(3)};
const intent={status:'submitted',from:a(1),nonce:'7',dataHash:keccak256('0x1234'),txHash:h(5)};
test('journal is isolated by candidate, graph and salt policy',()=>{
  const journal=newPortfolioDustJournal(config,h(9),172800);
  assert.deepEqual(parsePortfolioDustJournal(journal,config),journal);
  assert.notEqual(portfolioDustJournalKey(config),portfolioDustJournalKey({...config,candidateArtifactDigest:h(8)}));
  assert.throws(()=>parsePortfolioDustJournal({...journal,kind:'target-owner-upgrade'},config));
  assert.throws(()=>newPortfolioDustJournal(config,h(0),172800));
  assert.throws(()=>newPortfolioDustJournal(config,h(9),60));
});
test('pending original cannot masquerade as confirmed or be skipped by schedule',()=>{
  const journal=newPortfolioDustJournal(config,h(9),172800);
  assert.throws(()=>parsePortfolioDustJournal({...journal,transactions:{deploy:{...intent,status:'confirmed'}}},config));
  assert.throws(()=>parsePortfolioDustJournal({...journal,transactions:{schedule:{...intent,from:a(2)}}},config));
  assert.throws(()=>parsePortfolioDustJournal({...journal,transactions:{execute:intent}},config));
});
function provider(changes={}) { const tx={hash:h(5),chainId:56n,from:a(1),to:null,nonce:7,value:0n,data:'0x1234',blockNumber:10,blockHash:h(10)};
  const receipt={hash:h(5),status:1,index:0,blockNumber:10,blockHash:h(10),contractAddress:getCreateAddress({from:a(1),nonce:7})};
  return {getTransaction:async()=>({...tx,...changes.tx}),getTransactionReceipt:async()=>({...receipt,...changes.receipt}),
    getBlock:async(tag)=>tag==='finalized'?{number:11}:{hash:changes.blockHash??h(10),transactions:[h(5)]}}; }
test('recovery verifies exact nonce/data/canonical inclusion and final failures',async()=>{
  const receipt=await verifyPortfolioDustReceipt(provider(),h(5),intent);assert.equal(receipt.success,true);
  assert.equal((await verifyPortfolioDustReceipt(provider({receipt:{status:0,contractAddress:null}}),h(5),intent)).success,false);
  await assert.rejects(verifyPortfolioDustReceipt(provider({tx:{nonce:8}}),h(5),intent));
  await assert.rejects(verifyPortfolioDustReceipt(provider({tx:{data:'0x1235'}}),h(5),intent));
  await assert.rejects(verifyPortfolioDustReceipt(provider({blockHash:h(11)}),h(5),intent));
  await assert.rejects(verifyPortfolioDustReceipt(provider({receipt:{contractAddress:a(3)}}),h(5),intent));
});
test('confirmed schedule cannot hide cancellation or a state node behind its receipt',()=>{
  const receipt={success:true,blockNumber:10},proof={replacementVerified:true,blockNumber:11,operation:'waiting'};
  assert.doesNotThrow(()=>assertPortfolioDustConfirmedState('schedule',receipt,proof));
  assert.throws(()=>assertPortfolioDustConfirmedState('schedule',receipt,{...proof,operation:'unscheduled'}));
  assert.throws(()=>assertPortfolioDustConfirmedState('schedule',receipt,{...proof,blockNumber:9}));
  assert.throws(()=>assertPortfolioDustConfirmedState('deploy',receipt,{...proof,replacementVerified:false}));
});
