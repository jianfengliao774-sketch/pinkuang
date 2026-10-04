import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STAGE2_SIGNER_MODULES, packageStage2Attestor,
  verifyStage2SignerClosure } from './package-stage2-attestor.mjs';

const source=fileURLToPath(new URL('../../',import.meta.url));

test('the separate Stage 2 signer release contains the exact import closure and no credential',async()=>{
  const parent=realpathSync(mkdtempSync(join(tmpdir(),'pinkuang-stage2-attestor-')));
  const outDir=join(parent,'release'),sourceCommit='a'.repeat(40);
  try{
    const result=packageStage2Attestor({sourceDir:source,outDir,sourceCommit,verifyGit:false});
    const manifest=JSON.parse(readFileSync(join(outDir,'stage2-attestor-manifest.json'),'utf8'));
    assert.equal(result.fileCount,STAGE2_SIGNER_MODULES.length+3);
    assert.equal(STAGE2_SIGNER_MODULES.length,37);
    assert.equal(manifest.kind,'fresh-v4-stage2-attestor');
    assert.equal(manifest.activation,
      'Attestation only; Authority relay and automatic purchase are disabled.');
    assert(STAGE2_SIGNER_MODULES.every(name=>manifest.files[name]));
    assert(!Object.keys(manifest.files).some(name=>/\.test\.|fixture|\.key$|\.env$|\.sqlite$|private/.test(name)));
    assert.equal(statSync(outDir).mode & 0o777,0o755);
    assert.equal(statSync(join(outDir,'server/authority-signer.mjs')).mode & 0o777,0o644);
    assert.throws(()=>packageStage2Attestor({sourceDir:source,outDir,sourceCommit,verifyGit:false}),
      /already exists/);
    const files=new Map(STAGE2_SIGNER_MODULES.map(name=>[name,readFileSync(join(outDir,name))]));
    files.delete('server/authority-ipc.mjs');
    assert.throws(()=>verifyStage2SignerClosure(files),/Missing signer module/);
    symlinkSync(realpathSync(join(source,'node_modules')),join(outDir,'node_modules'),'dir');
    for(const [entry,name] of [
      ['server/authority-signer.mjs','startAuthoritySigner'],
      ['shared/target-owner-upgrade-proof.mjs','verifyTargetOwnerUpgrade'],
      ['shared/firsto-sale-reference.mjs','readFirstoSaleReference'],
      ['src/pricing.ts','fetchMineDetail'],
    ]) {
      const module=await import(pathToFileURL(join(outDir,entry)).href);
      assert.equal(typeof module[name],'function');
    }
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('Stage 2 closure includes every recursive graph, RPC and sale-reference dependency',()=>{
  const files=new Map(STAGE2_SIGNER_MODULES.map(name=>[name,readFileSync(join(source,name))]));
  assert.equal(verifyStage2SignerClosure(files),37);
  for(const missing of ['server/firsto-ask-publisher-store.mjs','server/firsto-listing-expiry-keeper.mjs',
    'server/sale-reference-publisher.mjs','server/sale-reference-status-read.mjs','shared/firsto-sale-reference.mjs',
    'shared/fresh-factory-reuse-proof.mjs','shared/fresh-native-sale-proof.mjs','shared/fresh-sale-policy-proof.mjs',
    'shared/machine-reservation.mjs','shared/read-only-rpc-fallback.mjs','shared/runtime-rpc-selection.mjs',
    'shared/target-owner-upgrade-plan.mjs','shared/target-owner-upgrade-proof.mjs','src/pricing.ts']) {
    const broken=new Map(files);broken.delete(missing);
    assert.throws(()=>verifyStage2SignerClosure(broken),/Missing signer module/);
  }
});

test('Stage 2 permits only the reviewed pricing TypeScript dependency and rejects computed runtime imports',()=>{
  for(const statement of ["import '../src/unreviewed.ts';", "import('../src/' + name);"]) {
    const files=new Map(STAGE2_SIGNER_MODULES.map(name=>[name,readFileSync(join(source,name))]));
    files.set('server/authority-signer.mjs',Buffer.concat([
      files.get('server/authority-signer.mjs'),Buffer.from(`\n${statement}\n`),
    ]));
    assert.throws(()=>verifyStage2SignerClosure(files),/Unsafe signer import|Computed dynamic import/);
  }
});
