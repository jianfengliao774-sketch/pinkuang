import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildDigest, evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
import { validateGovernance24UpgradeReview, governance24UpgradeDeploymentOrder } from '../shared/governance24-upgrade-plan.mjs';
import { governance24PredecessorRoots, governance24ReleasePins, governance24GasEvidenceDigest,
  governance24LiveEvidenceDigest } from './governance24-release-roots.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = resolve(root, 'deploy/.governance24-release');
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const exact = (left,right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
export function validateGovernance24ReleaseInputs(input, gasEvidence, liveReview) {
  const pins = governance24ReleasePins;
  need(Object.values(pins).every(hash) && hash(governance24GasEvidenceDigest) && hash(governance24LiveEvidenceDigest),
    'Independent release roots are not reviewed; candidate JSON cannot approve itself.');
  for (const [name,pin] of Object.entries(pins)) {
    if (!name.startsWith('trustedGenesis')) need(exact(input[name],pin), `Candidate root differs: ${name}.`);
  }
  for (const [name,pin] of Object.entries(governance24PredecessorRoots)) {
    if (name !== 'trustedGenesisArtifactDigest') need(exact(input.predecessorInput?.[name],pin), `Current graph root differs: ${name}.`);
  }
  need(exact(buildDigest(input.predecessorInput.genesisBundle),governance24PredecessorRoots.trustedGenesisArtifactDigest), 'Genesis artifact root differs.');
  need(exact(evidenceDigest(input.predecessorInput),pins.trustedPredecessorInputDigest), 'Current graph input digest differs.');
  validateGovernance24UpgradeReview(input);
  need(input.reviewCatalog.profile === 'formal' && exact(input.reviewCatalog.deployer,'0x042B23288E2316DFb6503488292FD0Ad2F811Ae7'), 'Only the reviewed formal deployment wallet is permitted.');
  need(exact(evidenceDigest(gasEvidence),governance24GasEvidenceDigest)
    && gasEvidence.kind === 'governance24-offline-create-gas-review-v1' && gasEvidence.schemaVersion === 1
    && gasEvidence.environment?.disposableLoopbackEvm === true && gasEvidence.environment.forked === false
    && gasEvidence.environment.productionTransactions === false && gasEvidence.environment.chainId === 56
    && gasEvidence.environment.ethEstimateGasCalls === 0 && gasEvidence.fixedCeilingsTested === true,
    'Independently measured local CREATE evidence is required.');
  for (const [name,pin] of Object.entries(pins)) need(exact(gasEvidence.pins?.[name],pin), `Measured gas root differs: ${name}.`);
  need(Array.isArray(gasEvidence.deployments) && gasEvidence.deployments.length === governance24UpgradeDeploymentOrder.length,
    'Measured gas must cover exactly the reviewed deployment order.');
  need(gasEvidence.margin?.percent === 20 && gasEvidence.margin.absoluteGas === 50000 && gasEvidence.margin.roundUpGas === 10000, 'Measured gas margin differs.');
  for (const [index,name] of governance24UpgradeDeploymentOrder.entries()) {
    const item=gasEvidence.deployments[index];
    need(item?.name===name && /^[1-9]\d*$/.test(item.gasUsed) && /^[1-9]\d*$/.test(item.gasLimit), 'Invalid gas deployment row.');
    const used=BigInt(item.gasUsed), ceiling=((used*120n+99n)/100n+50000n+9999n)/10000n*10000n;
    need(ceiling<=9000000n && BigInt(item.gasLimit)===ceiling, 'Gas deployment limit differs.');
  }
  need(exact(evidenceDigest(liveReview),governance24LiveEvidenceDigest)
    && liveReview.readOnly===true && liveReview.chainActionsPerformed===false && liveReview.phase==='prepared'
    && liveReview.baselineVerified===true && liveReview.codeUpgradeComplete===false
    && liveReview.replacementDeploymentVerified===false && Array.isArray(liveReview.verifiedDeploymentNames)
    && liveReview.verifiedDeploymentNames.length===0 && liveReview.governanceMigrationComplete!==true
    && exact(liveReview.candidateArtifactDigest,pins.trustedUpgradeArtifactDigest)
    && exact(liveReview.reviewCatalogDigest,pins.trustedReviewCatalogDigest)
    && Number.isSafeInteger(liveReview.blockNumber) && liveReview.blockNumber>0 && hash(liveReview.blockHash)
    && Number.isFinite(Date.parse(liveReview.checkedAt)), 'Independently reviewed current live baseline is required.');
  return { predecessorInput:input.predecessorInput, upgradeBundle:input.upgradeBundle, reviewCatalog:input.reviewCatalog,gasEvidence,liveReview };
}
export async function prepareGovernance24Static({ inputPath, gasEvidencePath, liveReviewPath }) {
  const [input,gasEvidence,liveReview]=await Promise.all([inputPath,gasEvidencePath,liveReviewPath].map(async path=>JSON.parse(await readFile(resolve(path),'utf8'))));
  const values=validateGovernance24ReleaseInputs(input,gasEvidence,liveReview), files={}, bodies={};
  for (const [name,value] of Object.entries(values)) {
    const body=Buffer.from(`${JSON.stringify(value,null,2)}\n`); need(body.length>0 && body.length<=12000000, `Invalid public JSON size: ${name}.`);
    bodies[name]=body; files[name]={path:`data/${name}.json`,sha256:sha(body)};
  }
  const sources=['deploy/src/Governance24UpgradeStandalone.tsx','deploy/src/governance24-upgrade-ui.ts',
    'deploy/src/target-owner-upgrade.css','deploy/src/wallet.ts','deploy/src/upgrade-transactions.ts','deploy/src/firsto-batch-upgrade-ui.ts',
    'deploy/vite.governance24.config.ts','deploy/governance24-upgrade.html','deploy/scripts/prepare-governance24-static.mjs',
    'deploy/scripts/package-governance24-static.mjs','deploy/scripts/governance24-release-roots.mjs','deploy/scripts/measure-governance24-gas.mjs'];
  for (const file of await readdir(resolve(root,'deploy/shared'))) if(file.endsWith('.mjs') && !file.endsWith('.test.mjs')) sources.push(`deploy/shared/${file}`);
  const sourceHashes={}; for(const file of sources.sort()) sourceHashes[file]=sha(await readFile(resolve(root,file)));
  const config={schemaVersion:1,kind:'governance24-upgrade-static-release-v1',entryPath:'/pinkuang-governance24-upgrade/',rpcPath:'/pinkuang-governance24-read/api/rpc',
    sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDiffDigest:sha(JSON.stringify(sourceHashes)),sourceHashes,
    candidateSourceCommit:input.upgradeBundle.sourceCommit,pins:governance24ReleasePins,gasEvidenceDigest:governance24GasEvidenceDigest,
    liveReviewEvidenceDigest:governance24LiveEvidenceDigest,liveReviewAnchor:{blockNumber:liveReview.blockNumber,blockHash:liveReview.blockHash,checkedAt:liveReview.checkedAt},
    files,chainActionsPerformed:false,candidateDeployed:false,productActive:false};
  await rm(base,{recursive:true,force:true});await mkdir(resolve(base,'public/data'),{recursive:true});
  for(const [name,body]of Object.entries(bodies)) await writeFile(resolve(base,'public',files[name].path),body);
  await writeFile(resolve(base,'config.json'),`${JSON.stringify(config,null,2)}\n`);return config;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),value=flag=>{const index=args.indexOf(flag);return index<0?undefined:args[index+1];};
  need(args.length===6 && value('--input') && value('--gas-evidence') && value('--live-review'),
    'Usage: --input /absolute/input.json --gas-evidence /absolute/gas.json --live-review /absolute/live.json');
  const config=await prepareGovernance24Static({inputPath:value('--input'),gasEvidencePath:value('--gas-evidence'),liveReviewPath:value('--live-review')});
  process.stdout.write(`${JSON.stringify({kind:config.kind,sourceCommit:config.sourceCommit,sourceDiffDigest:config.sourceDiffDigest})}\n`);
}
