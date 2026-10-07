import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateGovernance24ReleaseInputs } from './prepare-governance24-static.mjs';
test('candidate self-approval cannot create a public governance release without independent roots',()=>{
  const hash=`0x${'12'.repeat(32)}`;
  const candidate={trustedPredecessorInputDigest:hash,trustedUpgradeArtifactDigest:hash,trustedReviewCatalogDigest:hash,
    reviewCatalog:{profile:'formal',deployer:'0x042B23288E2316DFb6503488292FD0Ad2F811Ae7',approved:true},
    predecessorInput:{},upgradeBundle:{approved:true}};
  assert.throws(()=>validateGovernance24ReleaseInputs(candidate,{approved:true},{approved:true}),/root|reviewed|required|differs/i);
});
test('publication roots are source-owned literals, and all five public inputs are an exact whitelist',async()=>{
  const source=await readFile(new URL('./prepare-governance24-static.mjs',import.meta.url),'utf8');
  assert(source.includes("from './governance24-release-roots.mjs'"));
  assert(!source.includes('--live-review-digest'));assert(!source.includes('--artifact-digest'));
  for(const field of ['trustedGenesisRecordDigest','trustedGenesisManifestDigest','trustedPredecessorInputDigest','trustedUpgradeArtifactDigest','trustedReviewCatalogDigest'])
    assert(source.includes(field) || (await readFile(new URL('./governance24-release-roots.mjs',import.meta.url),'utf8')).includes(field));
  assert(source.includes('productActive:false'));
  assert(source.includes("rpcPath:'/pinkuang-governance24-read/api/rpc'"));
});
