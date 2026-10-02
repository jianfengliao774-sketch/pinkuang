import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {transformFullTestModule} from './build-runtime.mjs';
import {createFreshIndexManifest as formalManifest} from '../../deploy/server/chain-index/fresh-manifest.mjs';

test('single administrator can pass the complete test index manifest normalization',async()=>{
 const directory=mkdtempSync(fileURLToPath(new URL('../../deploy/.runtime-validation-',import.meta.url)));
 try{
  const name='server/chain-index/fresh-manifest.mjs';
  const original=readFileSync(new URL('../../deploy/'+name,import.meta.url),'utf8');
  const path=join(directory,'fresh-manifest.mjs');writeFileSync(path,transformFullTestModule(original,name));
  const {createFreshIndexManifest,freshIndexManifestBytes}=await import(pathToFileURL(path));
  const names=['factory','shareMarket','lens','beacon','timelock','portfolioFactory',
   'portfolioMarket','portfolioBeacon','portfolioImplementation','portfolioFactoryImplementation'];
  const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
  const source={schemaVersion:1,kind:'integrated-v2',chainId:56,artifactDigest:hash(1),
   deployment:{txHash:hash(2),blockNumber:115,blockHash:hash(3)},verifiedBlockNumber:206,verifiedBlockHash:hash(4),
   ...Object.fromEntries(names.map((name,i)=>[name,addr(i+1)])),codehash:Object.fromEntries(names.map(name=>[name,hash(5)])),
   authority:addr(20),gasWallet:addr(21),freshAuthority:{address:addr(20),gasWallet:addr(21),codehash:hash(6),
    deploymentTxHash:hash(7),administratorOne:addr(22),administratorTwo:addr(22)}};
  assert.throws(()=>formalManifest(source),/administrators/);
  const manifest=createFreshIndexManifest(source);
  assert.equal(manifest.freshAuthority.administratorOne,manifest.freshAuthority.administratorTwo);
  assert.equal(JSON.parse(freshIndexManifestBytes(manifest)).kind,'fresh-v4-index');
  for(const administratorTwo of [addr(23),addr(20),addr(21)])
   assert.throws(()=>createFreshIndexManifest({...source,freshAuthority:{...source.freshAuthority,administratorTwo}}),/administrators/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('standalone test index reads miner quotes through its own product cache',()=>{
 const original=readFileSync(new URL('../../deploy/server/chain-index/overview-stats.mjs',import.meta.url),'utf8');
 const installed=transformFullTestModule(original,'server/chain-index/overview-stats.mjs');
 assert.match(installed,/http:\/\/127\.0\.0\.1:4207\/firsto-api/);
 assert.doesNotMatch(installed,/http:\/\/127\.0\.0\.1:4187/);
});

test('test supervisors select their fixed RPC before loading a wallet and preserve BSC single-request settings',()=>{
 for(const name of ['purchase-supervisor','mining-supervisor']){
  const original=readFileSync(new URL('../../deploy/scripts/'+name+'.mjs',import.meta.url),'utf8');
  const installed=transformFullTestModule(original,'scripts/'+name+'.mjs');
  assert.match(installed,/await createRuntimeRpcProvider\(request, \{ network: 56, providerOptions: \{ staticNetwork: true, batchMaxCount: 1 \} \}\)/);
  assert.match(installed,/shared\/runtime-rpc-selection\.mjs/);
  const main=installed.slice(installed.indexOf('export async function main('));
  assert(main.indexOf('await createRuntimeRpcProvider(')<main.indexOf('new Wallet('));
  assert.doesNotMatch(main,/new JsonRpcProvider\(request/);
 }
});
