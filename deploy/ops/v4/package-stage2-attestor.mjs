import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relativeImports } from '../../scripts/package-fresh-console.mjs';

const SOURCE=fileURLToPath(new URL('../../',import.meta.url));
const ENTRY='server/authority-signer.mjs';
const COMMIT=/^[0-9a-f]{40}$/i;
export const STAGE2_SIGNER_MODULES=Object.freeze([
  "scripts/authority-relay.mjs",
  "scripts/budget-multicall-read.mjs",
  "scripts/keeper-credential.mjs",
  "scripts/official-market-discovery.mjs",
  "scripts/purchase-keeper.mjs",
  "server/authority-ipc.mjs",
  "server/authority-relay-api.mjs",
  "server/authority-role.mjs",
  "server/authority-signer.mjs",
  "server/fresh-activation-journal.mjs",
  "server/fresh-machine-readiness.mjs",
  "server/journal-store.mjs",
  "server/product-graph.mjs",
  "server/request-limiter.mjs",
  "shared/authority-typed.mjs",
  "shared/firsto-upgrade-proof.mjs",
  "shared/fresh-activation-chain-proof.mjs",
  "shared/fresh-activation-execution.mjs",
  "shared/fresh-runtime-identity.mjs",
  "shared/gas-signer-attestation.mjs",
  "shared/integrated-upgrade-plan.mjs",
  "shared/original-gas-wallet.mjs",
  "src/firsto-purchase.mjs"
]);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Exact static import closure, so a newly added signer dependency cannot be silently omitted. */
export function verifyStage2SignerClosure(files) {
  const allowed=new Set(STAGE2_SIGNER_MODULES),seen=new Set(),pending=[ENTRY];
  assert.equal(allowed.size,STAGE2_SIGNER_MODULES.length,'Duplicate signer allowlist entry.');
  while(pending.length){
    const name=pending.pop();
    if(seen.has(name))continue;
    assert(allowed.has(name),`Missing signer allowlist entry: ${name}`);
    const bytes=files.get(name);
    assert(bytes,`Missing signer module: ${name}`);
    seen.add(name);
    for(const specifier of relativeImports(bytes.toString('utf8'))){
      const child=posix.normalize(posix.join(posix.dirname(name),specifier));
      assert(!child.startsWith('../') && child.endsWith('.mjs'),`Unsafe signer import: ${specifier}`);
      pending.push(child);
    }
  }
  assert.equal(seen.size,allowed.size,'Signer package includes unreachable runtime modules.');
  return seen.size;
}

/** Creates a separate, credential-free signer release; it does not install or start a service. */
export function packageStage2Attestor({sourceDir=SOURCE,outDir,sourceCommit,verifyGit=true}){
  assert(typeof outDir==='string' && isAbsolute(outDir),'A new absolute output directory is required.');
  assert(COMMIT.test(sourceCommit??''),'A reviewed 40-hex source commit is required.');
  const source=realpathSync(sourceDir),output=resolve(outDir),sourceParent=realpathSync(join(source,'..'));
  assert(!output.startsWith(sourceParent+sep),'The signer release must be outside the source checkout.');
  assert.equal(realpathSync(dirname(output)),resolve(dirname(output)),'Output parent must be canonical.');
  try{lstatSync(output);assert.fail('The signer release already exists.');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(verifyGit){
    const head=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
    assert.equal(head,sourceCommit,'Signer release source commit differs from HEAD.');
    const status=spawnSync('git',['status','--porcelain','--',...STAGE2_SIGNER_MODULES,
      'package.json','package-lock.json'],{cwd:source,encoding:'utf8'});
    assert.equal(status.status,0,'Cannot inspect signer release source.');
    assert.equal(status.stdout,'','Signer release source contains uncommitted changes.');
  }
  const names=[...STAGE2_SIGNER_MODULES,'package.json','package-lock.json'];
  const files=new Map(names.map(name=>{
    const path=join(source,name),stat=lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(),`Signer file must be regular: ${name}`);
    const bytes=readFileSync(path);
    assert(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(bytes.toString('utf8')),
      `Private key material in signer release: ${name}`);
    return [name,bytes];
  }));
  verifyStage2SignerClosure(files);
  // Code contains no credential. Root can install the release read-only for
  // the signer, which should never own or be able to modify its executable.
  mkdirSync(output,{mode:0o755});
  chmodSync(output,0o755);
  for(const [name,bytes] of files){
    const target=join(output,name);
    mkdirSync(dirname(target),{recursive:true,mode:0o755});
    chmodSync(dirname(target),0o755);
    writeFileSync(target,bytes,{flag:'wx',mode:0o644});
    chmodSync(target,0o644);
  }
  const manifest={schemaVersion:1,kind:'fresh-v4-stage2-attestor',chainId:56,
    sourceCommit,entrypoint:`node ${ENTRY}`,
    installation:'npm ci --omit=dev --ignore-scripts',
    activation:'Attestation only; Authority relay and automatic purchase are disabled.',
    files:Object.fromEntries([...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>
      [name,{sha256:sha256(bytes),bytes:bytes.length}]))};
  writeFileSync(join(output,'stage2-attestor-manifest.json'),`${JSON.stringify(manifest,null,2)}\n`,
    {flag:'wx',mode:0o644});
  chmodSync(join(output,'stage2-attestor-manifest.json'),0o644);
  return {directory:output,fileCount:files.size+1,sourceCommit,
    manifestSha256:sha256(readFileSync(join(output,'stage2-attestor-manifest.json')))};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    assert(process.argv.length===4 && process.argv[2]==='--out',
      'Usage: node ops/v4/package-stage2-attestor.mjs --out <new-absolute-directory>');
    const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:SOURCE,encoding:'utf8'}).trim();
    console.log(JSON.stringify(packageStage2Attestor({outDir:process.argv[3],sourceCommit}),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
