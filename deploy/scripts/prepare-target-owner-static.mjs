import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildDigest, evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
import { validateTargetOwnerUpgradeReview } from '../shared/target-owner-upgrade-plan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = resolve(root, 'deploy/.target-owner-release');
// Independent reviewer-approved roots. Do not derive approval from a supplied JSON file.
export const targetOwnerReleasePins = Object.freeze({
  trustedGenesisRecordDigest: '0x4aeef3a06351f9dc6b18a85c4a8e34899792bebb38886e0d050bbf3695e41d00',
  trustedGenesisManifestDigest: '0x3870f0f8c06092b6418c2bd2ab522414ee4091bb937215b6ea97f4283bd25196',
  trustedGenesisArtifactDigest: '0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927',
  trustedUpgradeArtifactDigest: '0xc9be5208ec97a0513d29c5f1d35a9e89f54c998b5994d2a291c09e5e496881e5',
});
const approvedPaths = {
  genesisRecord: '/private/tmp/bemine-new-formal-20261003/genesis.json',
  genesisBundle: '/private/tmp/bemine-new-formal-20261003/backend/public/deployment-artifacts.json',
  trustedGenesisManifest: '/private/tmp/bemine-new-formal-20261003/frontend-manifest.json',
  upgradeBundle: '/private/tmp/bemine-funding-owner-candidate-20261004/deployment-artifacts.json',
};
const gasEvidenceDigest = '0x7f2f154c2c2d6814716273294240826f76a5c027aa37d4445016b74dbadbf48e';
const liveReviewEvidenceDigest = '0x9bb299f4580f4705bade2527bd83a67432ed765d9c90225601fb292b1034191b';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
export async function prepareTargetOwnerStatic({ reviewCatalogPath, trustedReviewCatalogDigest }) {
  need(/^0x[\da-f]{64}$/i.test(trustedReviewCatalogDigest ?? ''), 'An independent current review catalog digest is required.');
  const paths = { ...approvedPaths, reviewCatalog: resolve(reviewCatalogPath),
    gasEvidence: resolve(root, 'deploy/evidence/target-owner-create-gas-20261004.json'),
    liveReview: '/private/tmp/bemine-funding-owner-candidate-20261004/formal-target-owner-live-preflight.json' }, values = {}, files = {};
  const bodies = {};
  for (const [name, path] of Object.entries(paths)) {
    const bytes = await readFile(path); need(bytes.length > 0 && bytes.length <= 12_000_000, `Invalid public JSON size: ${name}.`);
    values[name] = JSON.parse(bytes.toString('utf8')); bodies[name] = bytes;
    files[name] = { path: `data/${name}.json`, sha256: sha256(bytes) };
  }
  need(buildDigest(values.genesisBundle) === targetOwnerReleasePins.trustedGenesisArtifactDigest, 'Genesis artifact root differs.');
  need(evidenceDigest(values.reviewCatalog).toLowerCase() === trustedReviewCatalogDigest.toLowerCase(), 'Current catalog differs from its operator-approved pin.');
  need(values.reviewCatalog.profile === 'formal', 'Standalone production upgrade page requires a formal current graph.');
  need(evidenceDigest(values.gasEvidence) === gasEvidenceDigest, 'Offline CREATE Gas evidence differs from its measured pin.');
  need(Object.entries({ ...targetOwnerReleasePins, trustedReviewCatalogDigest }).every(([key, pin]) => values.gasEvidence.pins[key] === pin),
    'Offline Gas evidence belongs to another graph or candidate.');
  need(evidenceDigest(values.liveReview) === liveReviewEvidenceDigest && values.liveReview.readOnly === true
    && values.liveReview.chainActionsPerformed === false && values.liveReview.phase === 'prepared'
    && values.liveReview.baselineVerified === true && values.liveReview.codeUpgradeComplete === false
    && values.liveReview.replacementDeploymentVerified === false && values.liveReview.verifiedDeploymentNames.length === 0
    && values.liveReview.candidateArtifactDigest === targetOwnerReleasePins.trustedUpgradeArtifactDigest
    && values.liveReview.reviewCatalogDigest === trustedReviewCatalogDigest,
  'Published read-only baseline evidence differs from the independently verified report.');
  validateTargetOwnerUpgradeReview({ ...values, ...targetOwnerReleasePins, trustedReviewCatalogDigest });
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const sourceHashes = {};
  const sources = ['deploy/src/TargetOwnerUpgradeStandalone.tsx', 'deploy/src/target-owner-upgrade-ui.ts',
    'deploy/src/target-owner-upgrade.css', 'deploy/src/wallet.ts', 'deploy/src/upgrade-transactions.ts',
    'deploy/vite.target-owner.config.ts', 'deploy/target-owner-upgrade.html', 'deploy/scripts/prepare-target-owner-static.mjs',
    'deploy/scripts/package-target-owner-static.mjs', 'deploy/scripts/measure-target-owner-gas.mjs', 'deploy/evidence/target-owner-create-gas-20261004.json'];
  for (const file of await readdir(resolve(root, 'deploy/shared'))) if (file.endsWith('.mjs') && !file.endsWith('.test.mjs')) sources.push(`deploy/shared/${file}`);
  for (const file of sources.sort()) sourceHashes[file] = sha256(await readFile(resolve(root, file)));
  const config = { kind: 'target-owner-upgrade-static-release-v1', schemaVersion: 1,
    sourceCommit, sourceDiffDigest: sha256(JSON.stringify(sourceHashes)), sourceHashes,
    candidateSourceCommit: values.upgradeBundle.sourceCommit,
    pins: { ...targetOwnerReleasePins, trustedReviewCatalogDigest }, gasEvidenceDigest, liveReviewEvidenceDigest,
    liveReviewAnchor: { blockNumber: values.liveReview.blockNumber, blockHash: values.liveReview.blockHash, checkedAt: values.liveReview.checkedAt },
    files, rpcPath: 'api/rpc',
    entryPath: '/pinkuang-target-owner-upgrade/', chainActionsPerformed: false, candidateDeployed: false };
  await rm(base, { recursive: true, force: true }); await mkdir(resolve(base, 'public/data'), { recursive: true });
  for (const [name, body] of Object.entries(bodies)) await writeFile(resolve(base, 'public', files[name].path), body);
  await writeFile(resolve(base, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  need(args.length === 4 && value('--review-catalog') && value('--review-catalog-digest'),
    'Usage: node scripts/prepare-target-owner-static.mjs --review-catalog /absolute/review.json --review-catalog-digest 0x...');
  const config = await prepareTargetOwnerStatic({ reviewCatalogPath: value('--review-catalog'), trustedReviewCatalogDigest: value('--review-catalog-digest') });
  process.stdout.write(`${JSON.stringify({ kind: config.kind, sourceCommit: config.sourceCommit, sourceDiffDigest: config.sourceDiffDigest,
    candidateArtifactDigest: config.pins.trustedUpgradeArtifactDigest, catalogDigest: config.pins.trustedReviewCatalogDigest }, null, 2)}\n`);
}
