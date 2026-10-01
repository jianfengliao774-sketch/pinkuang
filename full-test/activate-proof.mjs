import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadFullTestRuntime } from './server.mjs';
import { validateFullTestProfile, assertTestDeployment, activationEvidence, manifestFromVerifiedGraph,
 profileDigest, readRegularJson } from './server-profile.mjs';

const state='/var/lib/bemine-full-test/';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Root uses chain facts to derive fixed service inputs; browser text is never executable configuration. */
export async function verifyFullTestActivation(){
 assert.equal(process.getuid?.(),0,'Activation provisioner must run as root.');
 const runtime=await loadFullTestRuntime();
 const path=fileURLToPath(new URL('./public/deployment-artifacts.json',import.meta.url));
 const bundle=readRegularJson(path),profile=readRegularJson(fileURLToPath(new URL('./public/runtime-profile.json',import.meta.url)));
 const digest=runtime.servedArtifactDigest(path);validateFullTestProfile(profile,bundle,digest);
 const ready=readRegularJson(state+'activation-ready.json',4096),saved=readRegularJson(state+'activation-state.json');
 assert.equal(ready.profileDigest,profileDigest(profile));assert.equal(saved.profileDigest,ready.profileDigest);
 assert.equal(ready.sourceHead,profile.sourceHead);assert.equal(ready.artifactDigest,digest);
 assert.equal(hash(readFileSync(state+'active-manifest.json')),ready.manifestSha256);
 assert.equal(hash(readFileSync(state+'index-manifest.json')),ready.indexManifestSha256);
 const {record,activationRecord}=saved;assertTestDeployment(record,activationRecord,profile);
 runtime.validateFreshActivation(activationRecord,record.account,record,profile.roles.gasWallet);
 const rpc=process.env.FULL_TEST_RPC_URL;assert(/^https:\/\//.test(rpc??''));
 const provider=runtime.createProductVerifierProvider(rpc);
 try {
  await runtime.verifyCompletedDeployment(provider,record,{trustedArtifactBundle:bundle});
  const evidence=activationEvidence(activationRecord);
  const trusted=runtime.productGraphConfiguration({record,bundle,productActivation:evidence,expectedGasWallet:profile.roles.gasWallet});
  const block=await provider.getBlock('latest');
  const graph=await runtime.verifyProductGraph(provider,record.addresses.factory,trusted,block);
  assert.equal((await provider.getBlock(block.number)).hash,block.hash);
  const manifest=manifestFromVerifiedGraph(record,evidence,graph),indexManifest=runtime.createFreshIndexManifest(manifest);
  const installed=readRegularJson(state+'active-manifest.json');
  assert.deepEqual(manifest.codehash,installed.codehash);assert.equal(manifest.factory,installed.factory);
  assert.equal(manifest.authority,installed.authority);
  assert.deepEqual(indexManifest,readRegularJson(state+'index-manifest.json'));
  for(const name of ['genesis.json','authority-activation.json'])assert(!lstatSync(state+name).isSymbolicLink());
  assert.deepEqual(record,readRegularJson(state+'genesis.json'));
  const installedEvidence=readRegularJson(state+'authority-activation.json');
  assert(Number.isFinite(Date.parse(installedEvidence.verifiedAt)));
  assert.deepEqual({...evidence,verifiedAt:installedEvidence.verifiedAt},installedEvidence);
  return {sourceHead:profile.sourceHead,artifactDigest:digest,factory:manifest.factory,authority:manifest.authority,
   gasWallet:manifest.gasWallet,indexManifestSha256:ready.indexManifestSha256};
 }finally{provider.destroy();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await verifyFullTestActivation()));}
 catch{console.error('Full-test activation proof failed; no services changed.');process.exitCode=1;}
}
