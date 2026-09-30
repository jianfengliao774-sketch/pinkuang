import { lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FRESH_WORKER_ROOT, FRESH_WORKER_UNITS, freshRuntimeSource, freshGraphIdentity, need } from '../shared/fresh-runtime-identity.mjs';

/** A heartbeat is published only by a send-enabled worker after a complete graph and scan. */
export function createFreshWorkerReadiness(role,{env=process.env,root=FRESH_WORKER_ROOT,sourceHead,
  now=Date.now,pid=process.pid,allowTestPath=false}={}) {
  need(Object.hasOwn(FRESH_WORKER_UNITS,role),'Unknown worker readiness role.');
  need(allowTestPath || root===FRESH_WORKER_ROOT,'Unreviewed worker readiness directory.');
  need(/^[0-9a-f]{32}$/i.test(env.INVOCATION_ID ?? ''),'Fresh workers must run as systemd services.');
  sourceHead ??= freshRuntimeSource();
  mkdirSync(root,{recursive:true,mode:0o700});
  const info=lstatSync(root);
  need(info.isDirectory() && !info.isSymbolicLink() && !(info.mode&0o077),'Worker readiness directory must be private.');
  const path=join(root,role+'.json');
  const clear=()=>{try{unlinkSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}};
  clear();
  return { clear, publish(graph,block,result) {
    need(['scanned','no-registered-pools'].includes(result?.status) && !result.quarantinedCount && !result.results?.some(row=>row.walletBlocked
      || /unknown|review-required|cycle-error|nonce-or-chain-changed|gas-budget|gas-price|balance-exceeded|pending-transaction/.test(row.status ?? '')),
    'A failed, ambiguous or incomplete worker scan cannot authorize product readiness.');
    need(graph.blockNumber===block.number,'Worker graph and block differ.');
    const value={schemaVersion:1,role,ready:true,sendEnabled:true,sourceHead,pid,
      invocationId:env.INVOCATION_ID,checkedAt:now(),blockNumber:block.number,blockHash:block.hash,
      identity:freshGraphIdentity(graph)};
    const temporary=path+'.'+pid+'.tmp';
    writeFileSync(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
    try { renameSync(temporary,path); } catch(error) {try{unlinkSync(temporary);}catch{}throw error;}
  }};
}
