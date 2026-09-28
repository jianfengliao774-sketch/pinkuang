import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeToolchain } from './foundry.mjs';

// Real SignedAsk V2 and the strict-settlement resale regressions require this
// newer protocol fixture. Never run these as skipped tests at the old baseline.
const root=fileURLToPath(new URL('../',import.meta.url)),block='124308679';
if(!process.env.BSC_RPC_URL || process.env.FIRSTO_FORK_BLOCK && process.env.FIRSTO_FORK_BLOCK!==block)
  throw new Error(`BSC_RPC_URL and the fixed Firsto block ${block} are required.`);
let buildRoot=root;
if(process.platform==='win32' && /[^\x00-\x7f]/.test(root)){
  if(/[^\x00-\x7f]/.test(tmpdir()))throw new Error('Set TEMP to an ASCII path.');
  buildRoot=mkdtempSync(join(tmpdir(),'pinkuang-firsto-fork-'));
  for(const entry of ['contracts','node_modules','scripts','package.json','package-lock.json'])
    cpSync(join(root,entry),join(buildRoot,entry),{recursive:true,
      filter:source=>!['contracts/out','contracts/cache','contracts/broadcast'].some(part=>source.replaceAll('\\','/').includes(`/${part}`))});
}
const evidence=resolve(process.env.VALIDATION_EVIDENCE_ROOT??join(root,'docs/logs/firsto-fork'));
mkdirSync(evidence,{recursive:true});
const paths=readdirSync(join(root,'contracts'),{recursive:true})
  .filter(path=>/\.(sol|toml|txt|json)$/.test(path)&& !/^(out|cache|broadcast)[/\\]/.test(path)).sort();
const hashes=Object.fromEntries(paths.map(path=>{
  const content=readFileSync(join(root,'contracts',path));
  if(!content.equals(readFileSync(join(buildRoot,'contracts',path))))throw new Error(`Snapshot differs: ${path}`);
  return[path.replaceAll('\\','/'),createHash('sha256').update(content).digest('hex')];
}));
writeFileSync(join(evidence,'source-sha256.json'),JSON.stringify(hashes,null,2)+'\n');
const {executable,env}=forgeToolchain(root,{env:{...process.env,FOUNDRY_PROFILE:'ci',NO_COLOR:'1'}});
const args=['test','--root',join(buildRoot,'contracts'),'--match-path','test/fork/{FirstoPool,PoolSale,PoolBurn,AuditMiningSettlement,BudgetPortfolio}Fork.t.sol',
  '--fork-url','bsc','--fork-block-number',block,'--threads','1','--compute-units-per-second','50',
  '--fork-retries','10','--fork-retry-backoff','2000','-vv'];
const startedAt=new Date().toISOString(),result=spawnSync(executable,args,{cwd:buildRoot,env,encoding:'utf8',maxBuffer:32*1024*1024});
const output=((result.stdout??'')+(result.stderr??'')+(result.error?.message??''))
  .replaceAll(process.env.BSC_RPC_URL,'[BSC_RPC_URL]');
// A skipped or accidentally empty suite must not become evidence that a real order executed.
const passed=result.status===0 && /(?<!\d)12 tests passed, 0 failed, 0 skipped/.test(output)
  && !/\[SKIP/.test(output);
writeFileSync(join(evidence,'firsto-fork.log'),output);
writeFileSync(join(evidence,'summary.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),
  status:passed?'passed':'failed',exitCode:result.status??1,chainId:56,forkBlock:Number(block),
  tests:['FirstoPoolForkTest','PoolSaleForkTest','PoolBurnForkTest','AuditMiningSettlementForkTest','BudgetPortfolioForkTest'],
  expected:{passed:12,failed:0,skipped:0},source:'real public SignedAsk purchase and contract-maker strict settlement sales; local project deployment only'},null,2)+'\n');
console.log(output);
if(!passed)process.exitCode=1;
