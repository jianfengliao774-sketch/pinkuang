import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validate as validateCompilerOutput, solcInputOutputDecoder, getContractVersion,
  getStorageLayout, getStorageUpgradeReport,
} from '@openzeppelin/upgrades-core';
import prepareUpgradeBuildInfo from './prepare-upgrade-build-info.mjs';

const repo = resolve(fileURLToPath(new URL('..',import.meta.url)));
const deployedCommit = '8c5598cf44fe8fb6174969eba12b3baa13f7942b';
const deployedArtifactDigest = '0x7617c81d718e2127be6b1878abad81d7a3c8bf9c4f8cb35bf85755e42df049d7';
const names = ['PoolFactory','PoolVault','ShareMarket','BudgetPortfolioFactory','BudgetPortfolioVault'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateIntegratedStorage({buildRoot=repo,outputPath}={}) {
  const prepared = prepareUpgradeBuildInfo(buildRoot);
  const infoFiles = readdirSync(prepared).filter(name => name.endsWith('.json'));
  const compilations = infoFiles.map(name => {
    const info = JSON.parse(readFileSync(join(prepared,name)));
    assert.equal(info.solcVersion,'0.8.24','Integrated compilation must use deployed solc version');
    assert.equal(info.input.settings.optimizer.enabled,true);
    assert.equal(info.input.settings.optimizer.runs,1,'New implementation profile must be runs=1');
    assert.equal(info.input.settings.evmVersion,'shanghai');
    return {name,info,data:validateCompilerOutput(info.output,
      solcInputOutputDecoder(info.input,info.output),info.solcVersion,info.input)};
  });
  const results = [];
  for (const name of names) {
    const contract = `src/${name}.sol:${name}`;
    const path = join(repo,'docs','storage',`Integrated-v2-deployed-${name}.json`);
    const baselineBytes = readFileSync(path), baseline = JSON.parse(baselineBytes);
    assert.equal(baseline.schemaVersion,1);
    assert.equal(baseline.contract,contract);
    assert.equal(baseline.provenance.kind,'integrated-v2-mainnet-genesis');
    assert.equal(baseline.provenance.commit,deployedCommit);
    assert.equal(baseline.provenance.deployedArtifactDigest,deployedArtifactDigest);
    assert.equal(baseline.provenance.compiler,'0.8.24');
    assert.equal(baseline.provenance.optimizerRuns,200);
    const deployedSource = execFileSync('git',['show',`${deployedCommit}:contracts/src/${name}.sol`],
      {cwd:repo,maxBuffer:10_000_000});
    assert.equal(sha256(deployedSource),baseline.provenance.sourceSha256,
      `Deployed source baseline changed: ${name}`);
    const checkoutSource=readFileSync(join(buildRoot,'contracts','src',`${name}.sol`),'utf8');
    const matching=compilations.filter(c=>c.data[contract]
      && c.info.input.sources[`src/${name}.sol`]?.content===checkoutSource);
    assert(matching.length>0,`No current compiler output matches checkout source for ${name}`);
    // Forge can emit the same contract into multiple build-info files with
    // different AST type identifiers. Check every compiler output rather than
    // treating those internal identifiers as a storage-layout change.
    const layouts=matching.map(({data})=>getStorageLayout(data,getContractVersion(data,contract)));
    const reports=layouts.map(current=>getStorageUpgradeReport(baseline.layout,current,{}));
    const currentSource=checkoutSource,current=layouts[0];
    const report=reports[0];
    const result = {contract,baseline: `docs/storage/Integrated-v2-deployed-${name}.json`,
      baselineSha256:sha256(baselineBytes),deployedCommit,deployedArtifactDigest,
      deployedImplementation:baseline.provenance.deployedImplementation,
      deployedCodehash:baseline.provenance.verifiedCodehash,
      currentBuildInfoFiles:matching.map(({name:buildInfoFile})=>buildInfoFile),
      currentSourceSha256:sha256(currentSource),
      priorFields:baseline.layout.storage.length,currentFields:current.storage.length,
      priorNamespaces:Object.keys(baseline.layout.namespaces??{}),
      currentNamespaces:Object.keys(current.namespaces??{}),
      storageLayoutOk:reports.every(item=>item.ok)};
    results.push(result);
    const failed=reports.findIndex(item=>!item.ok);
    if (failed>=0) throw new Error(`${name} is incompatible with integrated-v2 deployed storage in ${matching[failed].name}: ${reports[failed].explain(false)}`);
  }
  const evidence={schemaVersion:1,kind:'integrated-v2-deployed-storage-validation',
    checkedAt:new Date().toISOString(),buildRoot:resolve(buildRoot)===repo ? '.' : buildRoot,results};
  if (outputPath) writeFileSync(outputPath,`${JSON.stringify(evidence,null,2)}\n`);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = key => { const i=process.argv.indexOf(key); return i<0 ? undefined : process.argv[i+1]; };
  const evidence=validateIntegratedStorage({buildRoot:arg('--build-root') ?? repo,
    outputPath:arg('--output')});
  for (const result of evidence.results) console.log(`${result.contract}: deployed -> new storage PASS`);
}
