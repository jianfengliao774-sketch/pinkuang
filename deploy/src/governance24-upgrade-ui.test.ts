import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore Canonical shared digest is runtime checked.
import { evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
import { firstoBatchJournalKey } from './firsto-batch-upgrade-ui';
import { governance24Transaction, withGovernance24Transaction, confirmedGovernance24Cancellations, governance24Next, governance24ActionReady, GOVERNANCE24_DEPLOYMENTS, newGovernance24Journal, parseGovernance24Journal, governance24JournalKey,
  governance24ReviewedGas, governance24Pending, runGovernance24UpgradeSequence, type Governance24Step } from './governance24-upgrade-ui';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const context={factory:a(1),genesisRecordDigest:h(2),genesisManifestDigest:h(3),candidateArtifactDigest:h(4),catalogDigest:h(5),predecessorInputDigest:h(16)};
const initial=()=>newGovernance24Journal(context,h(8));
const row=(n:number)=>({status:'confirmed' as const,from:a(6),dataHash:h(7),txHash:h(n),address:a(n)});
test('governance journal has a distinct namespace and pins its entire approved current mixed graph',()=>{
  assert.equal(GOVERNANCE24_DEPLOYMENTS.length,13);assert(GOVERNANCE24_DEPLOYMENTS.includes('Governance24Validation'));
  assert.notEqual(governance24JournalKey(context),firstoBatchJournalKey({...context,priorCoreCatalogDigest:h(20),protocolReviewDigest:h(21)}));
  const source=initial();assert.throws(()=>parseGovernance24Journal({...source,kind:'firsto-batch-upgrade-journal-v1'},context));
  for(const key of ['genesisRecordDigest','genesisManifestDigest','candidateArtifactDigest','catalogDigest','predecessorInputDigest'])
    assert.throws(()=>parseGovernance24Journal(source,{...context,[key]:h(99)}));
});
test('every distinct CREATE must be confirmed in exact order before the original timelock can open',()=>{
  const source=initial();assert.throws(()=>parseGovernance24Journal({...source,deployments:{PoolFunds:row(20)}},context));
  assert.throws(()=>parseGovernance24Journal({...source,deployments:{PoolVault:row(21)}},context));
  source.deployments.FlexiblePurchase={status:'uncertain',from:a(6),dataHash:h(7)};
  assert.equal(governance24Pending(parseGovernance24Journal(source,context)),'FlexiblePurchase');
  assert.throws(()=>parseGovernance24Journal({...source,deployments:{...source.deployments,PoolVault:row(21)}},context));
  const full={...initial(),deployments:Object.fromEntries(GOVERNANCE24_DEPLOYMENTS.map((name,index)=>[name,row(40+index)]))};
  assert.throws(()=>parseGovernance24Journal({...full,execute:{...row(90),address:undefined}},context));
  const duplicate={...full,deployments:{...full.deployments,PoolVault:full.deployments.FlexiblePurchase}};
  assert.throws(()=>parseGovernance24Journal(duplicate,context));
  for(const missing of GOVERNANCE24_DEPLOYMENTS){
    const partial=structuredClone(full);delete partial.deployments[missing];
    assert.throws(()=>parseGovernance24Journal({...partial,schedule:{...row(91),address:undefined}},context));
  }
});
test('one click deploys the complete ordered 13-component ledger and schedules, then needs a new click even after 48h',async()=>{
  const sent:Governance24Step[]=[];
  const result=await runGovernance24UpgradeSequence({journal:initial(),assertCurrent:()=>{},
    inspect:async source=>({operation:source.schedule?'ready':'unscheduled'}),
    submit:async(source,step)=>{sent.push(step);const tx={...row(40+sent.length),status:'submitted' as const,address:undefined};
      return step==='schedule'||step==='execute'?{...source,[step]:tx}:{...source,deployments:{...source.deployments,[step]:tx}};},
    recover:async(source,step)=>{const tx={...row(40+sent.length),...(step==='schedule'||step==='execute'?{address:undefined}:{})};
      return {journal:step==='schedule'||step==='execute'?{...source,[step]:tx}:{...source,deployments:{...source.deployments,[step]:tx}},outcome:'confirmed'};}});
  assert.deepEqual(sent,[...GOVERNANCE24_DEPLOYMENTS,'schedule']);assert.equal(result.outcome,'waiting');assert.equal(result.journal.execute,undefined);
});
const pins=Object.fromEntries(['trustedGenesisRecordDigest','trustedGenesisManifestDigest','trustedUpgradeArtifactDigest','trustedReviewCatalogDigest','trustedPredecessorInputDigest'].map((name,index)=>[name,h(50+index)]));
function gas(){return {kind:'governance24-offline-create-gas-review-v1',schemaVersion:1,pins,
  environment:{disposableLoopbackEvm:true,forked:false,productionTransactions:false,chainId:56,ethEstimateGasCalls:0},
  fixedCeilingsTested:true,margin:{percent:20,absoluteGas:50000,roundUpGas:10000},
  deployments:GOVERNANCE24_DEPLOYMENTS.map(name=>({name,gasUsed:'5000000',gasLimit:'6050000'}))};}
test('all measured CREATE ceilings bind independently reviewed current graph/genesis/candidate roots',()=>{
  const value=gas();assert.deepEqual(Object.keys(governance24ReviewedGas(value,pins,evidenceDigest(value))),GOVERNANCE24_DEPLOYMENTS);
  for(const name of Object.keys(pins))assert.throws(()=>governance24ReviewedGas(value,{...pins,[name]:h(99)},evidenceDigest(value)));
  for(const alter of [(v:any)=>v.kind='firsto-batch-offline-create-gas-review-v1',(v:any)=>v.deployments.reverse(),
    (v:any)=>v.deployments.pop(),(v:any)=>v.deployments.push({name:'Unknown',gasUsed:'1',gasLimit:'60000'}),
    (v:any)=>v.deployments[8].name='AnotherLibrary',(v:any)=>v.deployments[0].gasLimit='9000000',
    (v:any)=>v.environment.productionTransactions=true,(v:any)=>v.fixedCeilingsTested=false]){
    const changed=gas();alter(changed);assert.throws(()=>governance24ReviewedGas(changed,pins,evidenceDigest(changed)));}
});

const cancelIds=[`cancel-${h(2000)}`,`cancel-${h(2001)}`] as const;
const cancelContext={...context,cancellationIds:cancelIds};
function deployed(){const source=newGovernance24Journal(cancelContext,h(8));
  source.deployments=Object.fromEntries(GOVERNANCE24_DEPLOYMENTS.map((name,index)=>[name,row(40+index)]));return source;}
test('cancellation identity and exactprefix are independently bound to the journal key and record schema',()=>{
  const full=deployed();assert.notEqual(governance24JournalKey(cancelContext),governance24JournalKey(context));
  assert.throws(()=>parseGovernance24Journal(full,{...context,cancellationIds:[...cancelIds].reverse()}));
  assert.throws(()=>newGovernance24Journal({...context,cancellationIds:[cancelIds[0],cancelIds[0]]},h(8)));
  assert.throws(()=>newGovernance24Journal({...context,cancellationIds:['cancel-invalid']},h(8)));
  assert.throws(()=>parseGovernance24Journal({...full,cancellations:{[cancelIds[1]]:{...row(70),address:undefined}}},cancelContext));
  assert.throws(()=>parseGovernance24Journal({...full,cancellations:{[`cancel-${h(99)}`]:{...row(70),address:undefined}}},cancelContext));
  assert.throws(()=>parseGovernance24Journal({...full,schedule:{...row(71),address:undefined}},cancelContext));
  const early=newGovernance24Journal(cancelContext,h(8));early.cancellations[cancelIds[0]]={...row(70),address:undefined};
  assert.throws(()=>parseGovernance24Journal(early,cancelContext));
  const uncertain=withGovernance24Transaction(full,cancelIds[0],{status:'uncertain',from:a(6),dataHash:h(7)});
  assert.equal(governance24Pending(parseGovernance24Journal(uncertain,cancelContext)),cancelIds[0]);assert.equal(governance24Next(uncertain),null);
  assert.throws(()=>parseGovernance24Journal(withGovernance24Transaction(uncertain,cancelIds[1],{...row(71),address:undefined}),cancelContext));
  const first=withGovernance24Transaction(full,cancelIds[0],{...row(70),address:undefined});
  assert.deepEqual(confirmedGovernance24Cancellations(first),{[cancelIds[0]]:h(70)});assert.equal(governance24Next(first),cancelIds[1]);
  const both=withGovernance24Transaction(first,cancelIds[1],{...row(71),address:undefined});
  const scheduled={...both,schedule:{...row(72),address:undefined}};assert.deepEqual(parseGovernance24Journal(scheduled,cancelContext),JSON.parse(JSON.stringify(scheduled)));
});
test('sequence signs cancels only after deploymentprefix, preserves unknown cancels, then schedules with noautomatic execute',async()=>{
  const sent:any[]=[];const start=newGovernance24Journal(cancelContext,h(8));
  const advanced=await runGovernance24UpgradeSequence({journal:start,assertCurrent:()=>{},
    inspect:async source=>({operation:source.schedule?'ready':'unscheduled'}),
    submit:async(source,step)=>{sent.push(step);return withGovernance24Transaction(source,step,{...row(40+sent.length),status:'submitted',address:undefined});},
    recover:async(source,step)=>({journal:withGovernance24Transaction(source,step,{...row(40+sent.length),
      ...(!GOVERNANCE24_DEPLOYMENTS.includes(step as any)?{address:undefined}:{})}),outcome:'confirmed'})});
  assert.deepEqual(sent,[...GOVERNANCE24_DEPLOYMENTS,...cancelIds,'schedule']);assert.equal(advanced.outcome,'waiting');assert.equal(advanced.journal.execute,undefined);
  const unknown=withGovernance24Transaction(deployed(),cancelIds[0],{status:'uncertain',from:a(6),dataHash:h(99)});
  assert.equal(governance24Transaction(unknown,cancelIds[0])?.status,'uncertain');
  const blocked=await runGovernance24UpgradeSequence({journal:unknown,assertCurrent:()=>{},inspect:async()=>assert.fail(),submit:async()=>assert.fail(),recover:async()=>assert.fail()});
  assert.equal(blocked.outcome,'unknown');assert.deepEqual(blocked.journal,unknown);
});
test('schedule/action readiness requires every cancellation in addition to13 confirmed deployments',()=>{
  const base={onBsc:true,signerAuthorized:true,pending:false,graphVerified:true,prefixVerified:true,completedDeployments:13,
    operation:'unscheduled' as const,scheduleConfirmed:false,cancellationTotal:2,confirmedCancellations:1};
  assert.equal(governance24ActionReady({...base,action:'schedule'}),false);assert.equal(governance24ActionReady({...base,action:'cancel'}),true);
  assert.equal(governance24ActionReady({...base,action:'schedule',confirmedCancellations:2}),true);
  assert.equal(governance24ActionReady({...base,action:'cancel',confirmedCancellations:2}),false);
});
