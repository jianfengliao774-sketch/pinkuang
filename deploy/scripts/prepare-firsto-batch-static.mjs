import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildDigest, evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
import { validateFirstoBatchUpgradeReview } from '../shared/firsto-batch-upgrade-plan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = resolve(root, 'deploy/.firsto-batch-release');
// Independent roots from the reviewed formal predecessor, compiled candidate,
// exact protocol source and current mixed graph. Supplied JSON cannot approve itself.
export const firstoBatchReleasePins = Object.freeze({
  trustedGenesisRecordDigest: '0x4aeef3a06351f9dc6b18a85c4a8e34899792bebb38886e0d050bbf3695e41d00',
  trustedGenesisManifestDigest: '0x3870f0f8c06092b6418c2bd2ab522414ee4091bb937215b6ea97f4283bd25196',
  trustedGenesisArtifactDigest: '0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927',
  trustedPriorCoreCatalogDigest: '0x86b6b453a87948e1d7b53463512ebcedbe727a952367e0704e8a16ba576347bc',
  trustedUpgradeArtifactDigest: '0x53eb55a2d538c138b1d0334498431c04a3c435384f13a788112cd73493aaeea9',
  trustedProtocolReviewDigest: '0xc5f021f196c478b03cb1ff4ffb40a205b1f8a1d3603a9353a5c4ef48e08f20e0',
  trustedReviewCatalogDigest: '0x71d98bcd7314d23d18c1d9c057a8a0a9ba587fd349a72f5471f7e138e834ce33',
});
export const gasEvidenceDigest = '0x5b35987ae2c66ed4c5c7571c6677104cbe45a70fa0e71da4db0735015e0f0e11';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const need = (ok, reason) => { if (!ok) throw new Error(reason); };

export async function prepareFirstoBatchStatic({ inputPath, liveReviewPath, trustedLiveReviewDigest }) {
  need(/^0x[\da-f]{64}$/i.test(trustedLiveReviewDigest ?? ''), 'An independently verified live report digest is required.');
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  for (const [key, pin] of Object.entries(firstoBatchReleasePins)) {
    if (key !== 'trustedGenesisArtifactDigest') need(input[key] === pin, `Input root differs: ${key}.`);
  }
  need(buildDigest(input.genesisBundle) === firstoBatchReleasePins.trustedGenesisArtifactDigest, 'Genesis artifacts differ.');
  validateFirstoBatchUpgradeReview(input);
  need(input.reviewCatalog.profile === 'formal', 'Only the reviewed formal graph can be published.');
  const gasEvidence = JSON.parse(await readFile(resolve(root, 'deploy/evidence/firsto-batch-create-gas-20261007.json'), 'utf8'));
  need(evidenceDigest(gasEvidence) === gasEvidenceDigest, 'Measured offline CREATE Gas evidence differs.');
  for (const [key, pin] of Object.entries(firstoBatchReleasePins)) {
    if (key !== 'trustedGenesisArtifactDigest') need(gasEvidence.pins[key] === pin, `Gas evidence root differs: ${key}.`);
  }
  const liveReview = JSON.parse(await readFile(resolve(liveReviewPath), 'utf8'));
  need(evidenceDigest(liveReview) === trustedLiveReviewDigest && liveReview.readOnly === true
    && liveReview.chainActionsPerformed === false && liveReview.phase === 'prepared'
    && liveReview.baselineVerified === true && liveReview.codeUpgradeComplete === false
    && liveReview.replacementDeploymentVerified === false && liveReview.verifiedDeploymentNames.length === 0
    && liveReview.candidateArtifactDigest === firstoBatchReleasePins.trustedUpgradeArtifactDigest
    && liveReview.reviewCatalogDigest === firstoBatchReleasePins.trustedReviewCatalogDigest,
  'The published live baseline must be independently verified before deployment.');
  const names = ['genesisRecord', 'genesisBundle', 'trustedGenesisManifest', 'priorCoreCatalog', 'priorCoreBundle',
    'upgradeBundle', 'reviewCatalog', 'protocolReview'];
  const values = Object.fromEntries(names.map(name => [name, input[name]]));
  Object.assign(values, { gasEvidence, liveReview });
  const files = {}, bodies = {};
  for (const [name, value] of Object.entries(values)) {
    const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    need(body.length > 0 && body.length <= 12_000_000, `Invalid public JSON size: ${name}.`);
    bodies[name] = body; files[name] = { path: `data/${name}.json`, sha256: sha256(body) };
  }
  const sourceHashes = {};
  const sources = ['deploy/src/FirstoBatchUpgradeStandalone.tsx', 'deploy/src/firsto-batch-upgrade-ui.ts',
    'deploy/src/target-owner-upgrade.css', 'deploy/src/wallet.ts', 'deploy/src/upgrade-transactions.ts',
    'deploy/vite.firsto-batch.config.ts', 'deploy/firsto-batch-upgrade.html',
    'deploy/scripts/prepare-firsto-batch-static.mjs', 'deploy/scripts/package-firsto-batch-static.mjs',
    'deploy/scripts/measure-firsto-batch-gas.mjs', 'deploy/evidence/firsto-batch-create-gas-20261007.json'];
  for (const file of await readdir(resolve(root, 'deploy/shared'))) {
    if (file.endsWith('.mjs') && !file.endsWith('.test.mjs')) sources.push(`deploy/shared/${file}`);
  }
  for (const file of sources.sort()) sourceHashes[file] = sha256(await readFile(resolve(root, file)));
  const config = { kind: 'firsto-batch-upgrade-static-release-v1', schemaVersion: 1,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceDiffDigest: sha256(JSON.stringify(sourceHashes)), sourceHashes,
    candidateSourceCommit: input.upgradeBundle.sourceCommit,
    pins: firstoBatchReleasePins, gasEvidenceDigest, liveReviewEvidenceDigest: trustedLiveReviewDigest,
    liveReviewAnchor: { blockNumber: liveReview.blockNumber, blockHash: liveReview.blockHash, checkedAt: liveReview.checkedAt },
    files, rpcPath: 'api/rpc', entryPath: '/pinkuang-firsto-batch-upgrade/',
    chainActionsPerformed: false, candidateDeployed: false };
  await rm(base, { recursive: true, force: true }); await mkdir(resolve(base, 'public/data'), { recursive: true });
  for (const [name, body] of Object.entries(bodies)) await writeFile(resolve(base, 'public', files[name].path), body);
  await writeFile(resolve(base, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  need(args.length === 6 && value('--input') && value('--live-review') && value('--live-review-digest'),
    'Usage: --input /absolute/input.json --live-review /absolute/live.json --live-review-digest 0x...');
  const config = await prepareFirstoBatchStatic({ inputPath: value('--input'), liveReviewPath: value('--live-review'),
    trustedLiveReviewDigest: value('--live-review-digest') });
  process.stdout.write(`${JSON.stringify({ kind: config.kind, sourceCommit: config.sourceCommit,
    sourceDiffDigest: config.sourceDiffDigest, candidateArtifactDigest: config.pins.trustedUpgradeArtifactDigest })}\n`);
}
