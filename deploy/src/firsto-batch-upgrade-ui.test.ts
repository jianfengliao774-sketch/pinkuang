import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore The shared canonical evidence digest is validated at runtime.
import { evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
import { TARGET_OWNER_DEPLOYMENTS, targetOwnerJournalKey } from './target-owner-upgrade-ui';
import { FIRSTO_BATCH_DEPLOYMENTS, newFirstoBatchJournal, parseFirstoBatchJournal, firstoBatchJournalKey,
  firstoBatchPending, firstoBatchReviewedGas, runFirstoBatchUpgradeSequence, type FirstoBatchStep } from './firsto-batch-upgrade-ui';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const context={factory:a(1),genesisRecordDigest:h(2),genesisManifestDigest:h(3),candidateArtifactDigest:h(4),catalogDigest:h(5),
  priorCoreCatalogDigest:h(16),protocolReviewDigest:h(17)};
const initial=()=>newFirstoBatchJournal(context,h(8));
const row=(n:number)=>({status:'confirmed' as const,from:a(6),dataHash:h(7),txHash:h(n),address:a(n)});
test('batch journal is independent of every old core record and pins the reviewed predecessor and protocol',()=>{
  assert.deepEqual(FIRSTO_BATCH_DEPLOYMENTS,['FlexiblePurchase','PoolVault']);assert.equal(TARGET_OWNER_DEPLOYMENTS.length,3);
  assert.notEqual(firstoBatchJournalKey(context),targetOwnerJournalKey(context));
  const source=initial();assert.throws(()=>parseFirstoBatchJournal({...source,kind:'target-owner-upgrade-journal-v1'},context));
  for(const key of ['genesisRecordDigest','genesisManifestDigest','candidateArtifactDigest','catalogDigest','priorCoreCatalogDigest','protocolReviewDigest'])
    assert.throws(()=>parseFirstoBatchJournal(source,{...context,[key]:h(99)}));
});
test('only a sequential pair of distinct CREATE receipts may unlock schedule; unknown and execute claims stay closed',()=>{
  const source=initial();assert.throws(()=>parseFirstoBatchJournal({...source,deployments:{PoolFunds:row(20)}},context));
  assert.throws(()=>parseFirstoBatchJournal({...source,deployments:{PoolVault:row(21)}},context));
  source.deployments.FlexiblePurchase={status:'uncertain',from:a(6),dataHash:h(7)};
  assert.equal(firstoBatchPending(parseFirstoBatchJournal(source,context)),'FlexiblePurchase');
  assert.throws(()=>parseFirstoBatchJournal({...source,deployments:{...source.deployments,PoolVault:row(21)}},context));
  const full={...initial(),deployments:{FlexiblePurchase:row(20),PoolVault:row(21)}};
  assert.throws(()=>parseFirstoBatchJournal({...full,execute:{...row(22),address:undefined}},context));
  assert.throws(()=>parseFirstoBatchJournal({...full,deployments:{FlexiblePurchase:row(20),PoolVault:row(20)}},context));
});
test('one click deploys exactly two components then schedule, and never executes after a suspended 48-hour tab',async()=>{
  const sent:FirstoBatchStep[]=[];
  const result=await runFirstoBatchUpgradeSequence({journal:initial(),assertCurrent:()=>{},
    inspect:async source=>({operation:source.schedule?'ready':'unscheduled'}),
    submit:async(source,step)=>{sent.push(step);const tx={...row(20+sent.length),status:'submitted' as const,address:undefined};
      return step==='schedule'||step==='execute'?{...source,[step]:tx}:{...source,deployments:{...source.deployments,[step]:tx}};},
    recover:async(source,step)=>{const tx={...row(20+sent.length),...(step==='schedule'||step==='execute'?{address:undefined}:{})};
      return {journal:step==='schedule'||step==='execute'?{...source,[step]:tx}:{...source,deployments:{...source.deployments,[step]:tx}},outcome:'confirmed'};}});
  assert.deepEqual(sent,['FlexiblePurchase','PoolVault','schedule']);assert.equal(result.outcome,'waiting');assert.equal(result.journal.execute,undefined);
});
const pinNames=['trustedGenesisRecordDigest','trustedGenesisManifestDigest','trustedUpgradeArtifactDigest','trustedReviewCatalogDigest',
  'trustedPriorCoreCatalogDigest','trustedProtocolReviewDigest'];
const pins=Object.fromEntries(pinNames.map((name,index)=>[name,h(index+50)]));
function gas(){return {kind:'firsto-batch-offline-create-gas-review-v1',schemaVersion:1,pins,
  environment:{disposableLoopbackEvm:true,forked:false,productionTransactions:false,chainId:56,ethEstimateGasCalls:0},
  fixedCeilingsTested:true,margin:{percent:20,absoluteGas:50000,roundUpGas:10000},
  deployments:[{name:'FlexiblePurchase',gasUsed:'4132701',gasLimit:'5010000'},{name:'PoolVault',gasUsed:'5340989',gasLimit:'6460000'}]};}
test('two CREATE gas ceilings bind the exact six independently reviewed graph and protocol pins',()=>{
  const value=gas();assert.deepEqual(firstoBatchReviewedGas(value,pins,evidenceDigest(value)),{FlexiblePurchase:'5010000',PoolVault:'6460000'});
  for(const name of pinNames)assert.throws(()=>firstoBatchReviewedGas(value,{...pins,[name]:h(99)},evidenceDigest(value)));
  for(const alter of [(v:any)=>v.kind='target-owner-offline-create-gas-review-v1',(v:any)=>v.deployments.reverse(),
    (v:any)=>v.deployments.push({name:'PoolFunds',gasUsed:'1',gasLimit:'60000'}),
    (v:any)=>v.deployments[0].gasLimit='9000000',(v:any)=>v.environment.productionTransactions=true]){
    const changed=gas();alter(changed);assert.throws(()=>firstoBatchReviewedGas(changed,pins,evidenceDigest(changed)));}
});
