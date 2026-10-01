import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyFullTestSenderIsolation} from './sender-isolation.mjs';
const gasWallet='0x0C14b1008cFFe78711d65b13C8Ce5ca9B944252C';
const blockHash='0x'+'1'.repeat(64);
const proof={schemaVersion:1,profile:'full-test',chainId:56,gasWallet,initialLatestNonce:0,
 initialPendingNonce:0,separateCredential:true,blockNumber:12345,blockHash};
const options={requireFunding:true,readProof:()=>proof};
const provider={getNetwork:async()=>({chainId:56n}),getBalance:async()=>10_000_000_000_000_000n,
 getBlock:async()=>({hash:blockHash}),getTransactionCount:async(_wallet,tag)=>{
  assert.ok(['latest','pending'].includes(tag),'current readiness must not depend on archive state');return 2;
 }};
test('root-recorded initial nonce evidence remains usable after archive state is pruned',async()=>{
 const result=await verifyFullTestSenderIsolation(provider,{gasWallet},options);
 assert.equal(result.currentNonce,2);assert.equal(result.independentSender,true);
});
test('canonical birth header and recorded zero nonces still bind the isolated sender',async()=>{
 await assert.rejects(verifyFullTestSenderIsolation({...provider,getBlock:async()=>({hash:'0x'+'2'.repeat(64)})},{gasWallet},options),/canonical/);
 await assert.rejects(verifyFullTestSenderIsolation(provider,{gasWallet},{...options,readProof:()=>({...proof,initialLatestNonce:1})}),/isolation differs/);
});
test('current pending nonce and Gas funding remain required',async()=>{
 await assert.rejects(verifyFullTestSenderIsolation({...provider,getTransactionCount:async(_wallet,tag)=>tag==='pending'?3:2},{gasWallet},options),/nonce is unresolved/);
 await assert.rejects(verifyFullTestSenderIsolation({...provider,getBalance:async()=>0n},{gasWallet},options),/at least 0.003/);
});
