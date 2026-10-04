import { readFile, writeFile, readdir, mkdir, lstat, copyFile, rm } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
export async function inspectTargetOwnerStatic(directory, release) {
  const files = {}, scripts = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = resolve(path, entry.name), name = relative(directory, absolute).replaceAll('\\', '/');
      const stat = await lstat(absolute); need(!stat.isSymbolicLink(), `Symlink is prohibited in public release: ${name}.`);
      if (entry.isDirectory()) { need(name === 'assets' || name === 'data', `Unexpected public directory: ${name}.`); await visit(absolute); continue; }
      need(entry.isFile() && (name === 'target-owner-upgrade.html' || name === 'index.html'
        || /^assets\/[\w.-]+\.(js|css)$/.test(name) || /^data\/(genesisRecord|genesisBundle|trustedGenesisManifest|upgradeBundle|reviewCatalog|gasEvidence|liveReview)\.json$/.test(name)),
      `Unexpected public file: ${name}.`);
      const bytes = await readFile(absolute); files[name] = { bytes: bytes.length, sha256: hash(bytes) };
      if (name.endsWith('.js')) scripts.push(bytes.toString('utf8'));
    }
  }
  await visit(directory);
  need(files['target-owner-upgrade.html'] || files['index.html'], 'Missing standalone HTML entry.');
  for (const file of Object.values(release.files)) need(files[file.path]?.sha256 === file.sha256, `Public input digest differs: ${file.path}.`);
  const bundled = scripts.join('\n');
  for (const pin of Object.values(release.pins)) need(bundled.includes(pin), 'Compiled UI is missing an independently pinned evidence root.');
  if (release.gasEvidenceDigest) need(bundled.includes(release.gasEvidenceDigest), 'Compiled UI is missing its measured Gas evidence pin.');
  if (release.liveReviewEvidenceDigest) need(bundled.includes(release.liveReviewEvidenceDigest), 'Compiled UI is missing its reviewed live baseline evidence pin.');
  need(bundled.includes('target-owner-upgrade-journal-v1') && bundled.includes('configureTargetOwner') === false,
    'Bundle is missing its journal gate or includes an unreviewed legacy migration sender.');
  return files;
}
export async function packageTargetOwnerStatic({ source = resolve(root, 'dist-target-owner'), destination = resolve(root, 'release-target-owner') } = {}) {
  const release = JSON.parse(await readFile(resolve(root, '.target-owner-release/config.json'), 'utf8'));
  const sourceFiles = await inspectTargetOwnerStatic(source, release);
  for (const [file, expected] of Object.entries(release.sourceHashes)) need(hash(await readFile(resolve(root, '..', file))) === expected, `Source changed after review preparation: ${file}.`);
  await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true });
  for (const name of Object.keys(sourceFiles)) {
    const publicName = name === 'target-owner-upgrade.html' ? 'index.html' : name;
    await mkdir(dirname(resolve(destination, publicName)), { recursive: true }); await copyFile(resolve(source, name), resolve(destination, publicName));
  }
  const files = await inspectTargetOwnerStatic(destination, release);
  const manifest = { schemaVersion: 1, kind: 'target-owner-upgrade-static-package-v1', preparedAt: new Date().toISOString(),
    sourceCommit: release.sourceCommit, sourceDiffDigest: release.sourceDiffDigest, pins: release.pins, gasEvidenceDigest: release.gasEvidenceDigest,
    liveReviewEvidenceDigest: release.liveReviewEvidenceDigest, liveReviewAnchor: release.liveReviewAnchor,
    entryPath: release.entryPath, files, chainActionsPerformed: false, deployedOrActivated: false,
    legacyOwnerMigrationIncluded: false, rpcProxyRequired: '/pinkuang-target-owner-upgrade/api/rpc -> existing read-only RPC service' };
  await writeFile(resolve(destination, 'static-release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { destination, manifest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await packageTargetOwnerStatic(); process.stdout.write(`${JSON.stringify({ directory: result.destination,
    files: Object.keys(result.manifest.files).length, sourceDiffDigest: result.manifest.sourceDiffDigest }, null, 2)}\n`);
}
