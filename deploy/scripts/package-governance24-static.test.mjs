import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectGovernance24Static } from './package-governance24-static.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const html = '<!doctype html><html><head><script type="module" crossorigin src="./assets/app.js"></script>'
  + '<link rel="stylesheet" crossorigin href="./assets/app.css"></head><body><div id="root"></div></body></html>';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'governance24-static-test-'));
  await mkdir(join(directory, 'assets')); await mkdir(join(directory, 'data'));
  const release = { kind: 'governance24-upgrade-static-release-v1', entryPath: '/pinkuang-governance24-upgrade/', pins: Object.fromEntries(['trustedGenesisRecordDigest','trustedGenesisManifestDigest','trustedPredecessorInputDigest','trustedUpgradeArtifactDigest','trustedReviewCatalogDigest'].map((name,index)=>[name,`0x${String(index+1).repeat(64)}`])), gasEvidenceDigest:`0x${'ab'.repeat(32)}`,liveReviewEvidenceDigest:`0x${'cd'.repeat(32)}`, files:{} };
  await writeFile(join(directory, 'governance24-upgrade.html'), html);
  for (const name of ['predecessorInput','upgradeBundle','reviewCatalog','gasEvidence','liveReview']) {
    const body = JSON.stringify({ name }); release.files[name] = { path:`data/${name}.json`,sha256:sha(body) };
    await writeFile(join(directory,release.files[name].path),body);
  }
  await writeFile(join(directory,'assets/app.js'), JSON.stringify({ ...release.pins,gasEvidenceDigest:release.gasEvidenceDigest,liveReviewEvidenceDigest:release.liveReviewEvidenceDigest,kind:'governance24-upgrade-journal-v1' }));
  await writeFile(join(directory,'assets/app.css'),'body{color:white}');
  return { directory,release };
}
async function negative(change) {
  const f=await fixture();try{await change(f);await assert.rejects(inspectGovernance24Static(f.directory,f.release));}
  finally{await rm(f.directory,{recursive:true,force:true});}
}
test('fixed five public inputs and exactly referenced assets pass, including the published renamed entry',async()=>{
  const f=await fixture();try{
    assert.equal(Object.keys(await inspectGovernance24Static(f.directory,f.release)).length,8);
    await rm(join(f.directory,'governance24-upgrade.html'));await writeFile(join(f.directory,'index.html'),html);
    assert.equal(Object.keys(await inspectGovernance24Static(f.directory,f.release)).length,8);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('both HTML entries and an unreferenced asset containing dummy secret text are rejected',async()=>{
  await negative(f=>writeFile(join(f.directory,'index.html'),html));
  await negative(f=>writeFile(join(f.directory,'assets/extra.js'),'const DUMMY_SECRET="DUMMY_VALUE";'));
  await negative(f=>writeFile(join(f.directory,'assets/extra.css'),'body{}'));
});
test('nonlocal module or style, inline script, event handler and embedded execution are rejected',async()=>{
  for(const altered of [html.replace('./assets/app.js','https://invalid.example/app.js'),
    html.replace('./assets/app.css','/other/app.css'),html.replace('</script>','alert("DUMMY");</script>'),
    html.replace('<body>','<body onload="alert(1)">'),html.replace('<body>','<body><iframe src="https://invalid.example"></iframe>'),
    html.replace('type="module"','type="module" type="text/javascript"'),
    html.replace('./assets/app.js','./assets/missing.js'),html.replace('<head>','<head><script>alert(1)</script>')])
    await negative(f=>writeFile(join(f.directory,'governance24-upgrade.html'),altered));
});
test('private files, allowed-name symlinks, tampered pinned JSON, missing pins and unreviewed sender fail',async()=>{
  for(const change of [f=>writeFile(join(f.directory,'.env'),'DUMMY_PRIVATE_VALUE'),
    async f=>{await rm(join(f.directory,'data/predecessorInput.json'));await symlink('/tmp/absent-test-target',join(f.directory,'data/predecessorInput.json'));},
    f=>writeFile(join(f.directory,'data/reviewCatalog.json'),'{}'),
    f=>writeFile(join(f.directory,'assets/app.js'),'governance24-upgrade-journal-v1'),
    f=>writeFile(join(f.directory,'assets/app.js'),`${JSON.stringify(f.release.pins)} governance24-upgrade-journal-v1 configureGovernance24`)])
    await negative(change);
});

test('missing, extra or redirected public inputs and incomplete review roots are rejected',async()=>{
  for(const change of [f=>{delete f.release.files.liveReview;},f=>{f.release.files.private={path:'data/private.json',sha256:'f'.repeat(64)};},
    f=>{f.release.files.predecessorInput.path='data/reviewCatalog.json';},f=>{delete f.release.pins.trustedPredecessorInputDigest;},
    f=>{f.release.gasEvidenceDigest=null;},f=>{f.release.liveReviewEvidenceDigest=null;},f=>{f.release.kind='product-active';}])
    await negative(change);
});
