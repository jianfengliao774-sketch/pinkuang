import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_BACKEND_MODULES } from '../../deploy/scripts/package-fresh-console.mjs';
import { artifactContentDigest } from '../../deploy/scripts/build-artifacts.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=body=>createHash('sha256').update(body).digest('hex');
const replacements=[
 ['/var/lib/pinkuang-v4-signer','/var/lib/bemine-full-test-signer'],
 ['/var/lib/pinkuang-index-v4','/var/lib/bemine-full-test-index'],
 ['/var/lib/pinkuang-product-v4','/var/lib/bemine-full-test'],
 ['/run/pinkuang-v4-relay','/run/bemine-full-test-relay'],
 ['/etc/pinkuang-v4/legacy-drain.json','/etc/bemine-full-test/independent-signer.json'],
 ['pinkuang-v4-purchase.service','bemine-full-test-purchase.service'],
 ['pinkuang-v4-mining.service','bemine-full-test-mining.service'],
 ['pinkuang-v4-signer.service','bemine-full-test-signer.service'],
 ['pinkuang-v4-authority-recovery.service','bemine-full-test-authority-recovery.service'],
 ['http://127.0.0.1:4184','http://127.0.0.1:4204'],
 ["env.PORT==='4187'","env.PORT==='4207'"],
 ['pinkuang_journal','bemine_full_test_journal'],
];
const exact={
 'server/product-graph.mjs':[
  ["const FRESH_ADMINS = ['0x7674fa446D42b1f7f150DC5e678cc525d275Ea53','0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb'];", "const FRESH_ADMINS = ['0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E','0x7674fa446D42b1f7f150DC5e678cc525d275Ea53'];"],
  ["['timelock','getMinDelay',172800n],['timelock','MINIMUM_DELAY',172800n]", "['timelock','getMinDelay',0n],['timelock','MINIMUM_DELAY',0n]"],
 ],
 'server/fresh-activation-journal.mjs':[
  ["export const FRESH_ADMIN_ONE = getAddress('0x7674fa446D42b1f7f150DC5e678cc525d275Ea53');", "export const FRESH_ADMIN_ONE = getAddress('0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E');"],
  ["export const FRESH_ADMIN_TWO = getAddress('0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb');", "export const FRESH_ADMIN_TWO = getAddress('0x7674fa446D42b1f7f150DC5e678cc525d275Ea53');"],
  ["'getMinDelay')<48n*60n*60n", "'getMinDelay')!==0n"],
 ],
 'shared/integrated-upgrade-plan.mjs':[['const MIN_DELAY = 172800;', 'const MIN_DELAY = 0;']],
 'shared/firsto-upgrade-proof.mjs':[['decoded.args[5] >= 172800n','decoded.args[5] >= 0n']],
 'server/chain-index/server.mjs':[
  ["!/^\\/srv\\/pinkuang-deploy-v4\\/releases\\/v4-[a-z0-9][a-z0-9-]{1,70}\\/public\\/fresh-product-manifest\\.json$/.test(manifestPath)","manifestPath!=='/etc/bemine-full-test/index-manifest.json'"],
 ],
 'server/fresh-machine-readiness.mjs':[
  ["need(/^pinkuang-[a-z0-9-]+\\.service$/.test(name),'Unreviewed readiness unit name.');","need(/^bemine-full-test-[a-z0-9-]+\\.service$/.test(name),'Unreviewed readiness unit name.');"],
  ['verifyFreshLegacyDrain(provider,identity,{unitState,...drainOptions})','verifyFreshLegacyDrain(provider,identity,{unitState,requireFunding:true,...drainOptions})'],
 ],
 'scripts/authority-relay.mjs':[
  ["  'pinkuang-purchase-v2.service', 'bemine-full-test-signer.service'", "  'bemine-full-test-signer.service'"],
  ['requireOriginalSenderDrained(ORIGINAL_GAS_WALLET, env);',"throw new Error('Use the independent full-test transaction journal for recovery; the formal recovery CLI is disabled.');"],
 ],
};
function once(content,old,next,label){assert.equal(content.split(old).length-1,1,'Runtime source fragment changed: '+label);return content.replace(old,next);}

export function buildFullTestRuntime({outDir,profilePath}={}) {
 const out=resolve(outDir);assert(!existsSync(out),'Use a new runtime build directory.');mkdirSync(out,{recursive:true});
 const bundle=JSON.parse(readFileSync(join(root,'full-test/public/deployment-artifacts.json'),'utf8'));
 const sourceHead=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 assert.equal(bundle.sourceCommit,sourceHead,'Rebuild the test bundle after committing.');
 const roles={deployer:'0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E',administratorOne:'0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E',
  administratorTwo:'0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',gasWallet:'0xaD95dFf16FE0e09C47bADe687aB549929AC66c80'};
 const deny=JSON.parse(readFileSync(profilePath,'utf8'));
 assert(Array.isArray(deny.forbiddenContracts)&&deny.forbiddenContracts.length>=20,'Explicit formal graph denylist is required.');
 const profile={schemaVersion:1,profile:'full-test',chainId:56,sourceHead,artifactDigest:artifactContentDigest(bundle),
  roles,timings:bundle.metadata.timings,forbiddenContracts:deny.forbiddenContracts};
 const modules=[...PRODUCT_BACKEND_MODULES];
 const inventory={};
 for(const name of modules){
  const original=readFileSync(join(root,'deploy',name),'utf8');let content=original;
  for(const [old,next] of replacements)content=content.split(old).join(next);
  for(const [old,next] of exact[name]??[])content=once(content,old,next,name);
  if(name==='server/fresh-machine-readiness.mjs'){
   content=once(content,'export async function verifyFreshLegacyDrain(','async function unusedFormalLegacyDrain(',name);
   content="import { verifyFullTestSenderIsolation as verifyFreshLegacyDrain } from './full-test-sender-isolation.mjs';\nexport { verifyFreshLegacyDrain };\n"+content;
  }
  const path=join(out,'runtime/deploy',name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);
  inventory['runtime/deploy/'+name]={originalSha256:sha(original),installedSha256:sha(content)};
 }
 for(const name of ['server.mjs','server-profile.mjs','activate-proof.mjs','ops/activate.py']){
  const body=readFileSync(join(root,'full-test',name));mkdirSync(dirname(join(out,name)),{recursive:true});writeFileSync(join(out,name),body);inventory[name]={installedSha256:sha(body)};
 }
 const isolation=readFileSync(join(root,'scripts/full-test/sender-isolation.mjs'));
 writeFileSync(join(out,'runtime/deploy/server/full-test-sender-isolation.mjs'),isolation);
 inventory['runtime/deploy/server/full-test-sender-isolation.mjs']={installedSha256:sha(isolation)};
 mkdirSync(join(out,'public'),{recursive:true});mkdirSync(join(out,'runtime/deploy/public'),{recursive:true});
 for(const name of ['deployment-artifacts.json','gas-plan.json'])writeFileSync(join(out,'public',name),readFileSync(join(root,'full-test/public',name)));
 writeFileSync(join(out,'runtime/deploy/public/deployment-artifacts.json'),readFileSync(join(root,'full-test/public/deployment-artifacts.json')));
 writeFileSync(join(out,'public/runtime-profile.json'),JSON.stringify(profile,null,2)+'\n');
 const release={kind:'fresh-v4-product-backend-draft',chainId:56,profile:'full-test',sourceHead,artifactDigest:profile.artifactDigest,files:inventory};
 writeFileSync(join(out,'runtime/deploy/public/fresh-release-manifest.json'),JSON.stringify(release,null,2)+'\n');
 writeFileSync(join(out,'runtime-source-manifest.json'),JSON.stringify(release,null,2)+'\n');
 const packageJson=JSON.parse(readFileSync(join(root,'deploy/package.json'),'utf8'));
 writeFileSync(join(out,'package.json'),JSON.stringify(packageJson,null,2)+'\n');
 writeFileSync(join(out,'package-lock.json'),readFileSync(join(root,'deploy/package-lock.json')));
 return {out,sourceHead,artifactDigest:profile.artifactDigest,moduleCount:modules.length,profile};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert(process.argv.length===6&&process.argv[2]==='--out'&&process.argv[4]==='--denylist');
 console.log(JSON.stringify(buildFullTestRuntime({outDir:process.argv[3],profilePath:process.argv[5]})));
}
