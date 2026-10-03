import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE2_SIGNER_MODULES, packageStage2Attestor,
  verifyStage2SignerClosure } from './package-stage2-attestor.mjs';

const source=fileURLToPath(new URL('../../',import.meta.url));

test('the separate Stage 2 signer release contains the exact import closure and no credential',()=>{
  const parent=realpathSync(mkdtempSync(join(tmpdir(),'pinkuang-stage2-attestor-')));
  const outDir=join(parent,'release'),sourceCommit='a'.repeat(40);
  try{
    const result=packageStage2Attestor({sourceDir:source,outDir,sourceCommit,verifyGit:false});
    const manifest=JSON.parse(readFileSync(join(outDir,'stage2-attestor-manifest.json'),'utf8'));
    assert.equal(result.fileCount,STAGE2_SIGNER_MODULES.length+3);
    assert.equal(manifest.kind,'fresh-v4-stage2-attestor');
    assert.equal(manifest.activation,
      'Attestation only; Authority relay and automatic purchase are disabled.');
    assert(STAGE2_SIGNER_MODULES.every(name=>manifest.files[name]));
    assert(!Object.keys(manifest.files).some(name=>/\.key$|\.env$|\.sqlite$|private/.test(name)));
    assert.equal(statSync(outDir).mode & 0o777,0o755);
    assert.equal(statSync(join(outDir,'server/authority-signer.mjs')).mode & 0o777,0o644);
    assert.throws(()=>packageStage2Attestor({sourceDir:source,outDir,sourceCommit,verifyGit:false}),
      /already exists/);
    const files=new Map(STAGE2_SIGNER_MODULES.map(name=>[name,readFileSync(join(outDir,name))]));
    files.delete('server/authority-ipc.mjs');
    assert.throws(()=>verifyStage2SignerClosure(files),/Missing signer module/);
  }finally{rmSync(parent,{recursive:true,force:true});}
});
