import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync,readFileSync } from 'node:fs';
import { FRESH_RUNTIME,FRESH_WORKER_ROOT,FRESH_WORKER_UNITS,FRESH_LEGACY_DRAIN_PATH, freshRuntimeSource,
  freshGraphIdentity,validateFreshWorker,need,same,HASH } from '../shared/fresh-runtime-identity.mjs';

const execute=promisify(execFile);
export async function freshUnitState(name) {
  need(/^pinkuang-[a-z0-9-]+\.service$/.test(name),'Unreviewed readiness unit name.');
  const {stdout}=await execute('/usr/bin/systemctl',['show',name,
    '--property=LoadState,ActiveState,SubState,MainPID,InvocationID,UnitFileState'],{timeout:3000,maxBuffer:8192});
  return Object.fromEntries(stdout.trim().split('\n').filter(row=>row.includes('=')).map(row=>row.split(/=(.*)/s).slice(0,2)));
}
function privateJson(path,rootOwned=false) {
  const stat=lstatSync(path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size>0 && stat.size<=65536
    && !(stat.mode&0o022) && (rootOwned?stat.uid===0:stat.uid===process.getuid()),'Untrusted machine readiness file.');
  return JSON.parse(readFileSync(path,'utf8'));
}

/** A root-reviewed terminal ledger plus currently disabled old units, never a checkbox. */
export async function verifyFreshLegacyDrain(provider,identity,{readDrain=()=>privateJson(FRESH_LEGACY_DRAIN_PATH,true),
  unitState=freshUnitState,allowCurrentPending=false}={}) {
  const proof=readDrain();
  need(proof?.schemaVersion===1 && proof.chainId===56 && same(proof.gasWallet,identity.gasWallet)
    && Number.isSafeInteger(proof.cutoverNonce) && proof.cutoverNonce>=0
    && proof.latestNonce===proof.cutoverNonce && proof.pendingNonce===proof.cutoverNonce
    && Array.isArray(proof.units) && proof.units.includes('pinkuang-purchase-v2.service')
    && new Set(proof.units).size===proof.units.length && proof.units.length<=16
    && Array.isArray(proof.journals) && proof.journals.length<=1000,
  'The root-reviewed old Gas sender drain proof is incomplete.');
  for(const name of proof.units){
    need(/^pinkuang-[a-z0-9-]+\.service$/.test(name) && !name.includes(`-v${FRESH_RUNTIME.version}-`),'Invalid old sender unit.');
    const unit=await unitState(name);
    need(unit.ActiveState==='inactive' && Number(unit.MainPID)===0
      && (unit.LoadState==='not-found' || ['disabled','masked'].includes(unit.UnitFileState)),
    'An old Gas sender remains active or enabled.');
  }
  const [latest,pending,finalized]=await Promise.all([provider.getTransactionCount(identity.gasWallet,'latest'),
    provider.getTransactionCount(identity.gasWallet,'pending'),provider.getBlock('finalized')]);
  need(finalized?.hash && latest>=proof.cutoverNonce && (allowCurrentPending ? pending>=latest : latest===pending),'Gas nonce drain is not current.');
  need(proof.cutoverNonce===0 ? proof.journals.length===0 : proof.journals.length>0
    && Math.max(...proof.journals.map(row=>row.nonce))+1===proof.cutoverNonce,'Old terminal nonce coverage differs.');
  for(const row of proof.journals){
    need(/^[0-9a-f]{64}$/i.test(row.journalSha256 ?? '') && HASH.test(row.txHash)
      && HASH.test(row.blockHash) && Number.isSafeInteger(row.nonce) && row.nonce>=0
      && Number.isSafeInteger(row.blockNumber) && row.blockNumber>0
      && ['confirmed','reverted','cancelled','cancel-reverted'].includes(row.phase),'An old journal is not terminal.');
    const [tx,receipt,block]=await Promise.all([provider.getTransaction(row.txHash),
      provider.getTransactionReceipt(row.txHash),provider.getBlock(row.blockNumber)]);
    need(tx?.chainId===56n && same(tx.from,identity.gasWallet) && tx.nonce===row.nonce
      && receipt && receipt.status===(['confirmed','cancelled'].includes(row.phase)?1:0) && same(receipt.hash,row.txHash) && same(tx.hash,row.txHash) && receipt.blockNumber===row.blockNumber
      && same(receipt.blockHash,row.blockHash) && same(block?.hash,row.blockHash)
      && row.blockNumber<=finalized.number && row.nonce<proof.cutoverNonce,
    'An old Gas journal lacks canonical finalized transaction proof.');
  }
  return {cutoverNonce:proof.cutoverNonce,currentNonce:latest,oldSendersDisabled:true};
}

export function createFreshMachineReadiness({provider,verifyGraph,sourceHead=freshRuntimeSource(),
  readWorker=role=>privateJson(FRESH_WORKER_ROOT+'/'+role+'.json'),unitState=freshUnitState,
  drainOptions,now=Date.now}={}) {
  let task=null;
  return async()=>{
    if(task)return task;
    task=(async()=>{
      const graph=await verifyGraph(),identity=freshGraphIdentity(graph);
      const workers={};
      for(const role of Object.keys(FRESH_WORKER_UNITS)){
        const pulse=validateFreshWorker(readWorker(role),{role,sourceHead,identity,
          unit:await unitState(FRESH_WORKER_UNITS[role]),now:now()});
        const block=await provider.getBlock(pulse.blockNumber);
        need(same(block?.hash,pulse.blockHash),'Worker readiness block changed.');
        workers[role]={...pulse};
      }
      const drain=await verifyFreshLegacyDrain(provider,identity,{unitState,...drainOptions});
      need(same((await provider.getBlock(graph.blockNumber))?.hash,graph.blockHash),'Readiness graph block changed.');
      return {schemaVersion:1,ready:true,relayEnabled:true,attestOnly:false,sourceHead,
        identity,checkedAt:now(),workers,drain};
    })();
    try{return await task;}finally{task=null;}
  };
}
