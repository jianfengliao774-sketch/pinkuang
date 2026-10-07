import { readFile, writeFile, readdir, mkdir, lstat, copyFile, rm } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
export async function inspectGovernance24Static(directory, release) {
  const expectedInputs = ['predecessorInput', 'upgradeBundle', 'reviewCatalog', 'gasEvidence', 'liveReview'];
  need(release.kind === 'governance24-upgrade-static-release-v1' && release.entryPath === '/pinkuang-governance24-upgrade/'
    && release.rpcPath === '/pinkuang-governance24-read/api/rpc'
    && Object.keys(release.files ?? {}).sort().join(',') === expectedInputs.sort().join(','), 'The exact independently prepared release input set is required.');
  const requiredPins = ['trustedGenesisRecordDigest', 'trustedGenesisManifestDigest', 'trustedPredecessorInputDigest',
    'trustedUpgradeArtifactDigest', 'trustedReviewCatalogDigest'];
  need(Object.keys(release.pins ?? {}).sort().join(',') === requiredPins.sort().join(',')
    && Object.values(release.pins).every(pin => typeof pin === 'string' && /^0x[\da-f]{64}$/i.test(pin))
    && [release.gasEvidenceDigest, release.liveReviewEvidenceDigest].every(pin => typeof pin === 'string' && /^0x[\da-f]{64}$/i.test(pin)),
    'All independent artifact, graph, genesis, measured gas and live roots are required.');
  for (const name of expectedInputs) need(release.files[name]?.path === `data/${name}.json`
    && /^[\da-f]{64}$/i.test(release.files[name].sha256), 'Public input paths and digests must exactly match the reviewed schema.');
  const files = {}, scripts = [], entries = [];
  const directoryStat = await lstat(directory);
  need(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'Public release root must be a real directory.');
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = resolve(path, entry.name), name = relative(directory, absolute).replaceAll('\\', '/');
      const stat = await lstat(absolute); need(!stat.isSymbolicLink(), `Symlink is prohibited in public release: ${name}.`);
      if (entry.isDirectory()) { need(name === 'assets' || name === 'data', `Unexpected public directory: ${name}.`); await visit(absolute); continue; }
      need(entry.isFile() && (name === 'governance24-upgrade.html' || name === 'index.html'
        || /^assets\/[\w.-]+\.(js|css)$/.test(name) || /^data\/(predecessorInput|upgradeBundle|reviewCatalog|gasEvidence|liveReview)\.json$/.test(name)),
      `Unexpected public file: ${name}.`);
      const bytes = await readFile(absolute); files[name] = { bytes: bytes.length, sha256: hash(bytes) };
      if (name.endsWith('.js')) scripts.push(bytes.toString('utf8'));
      if (name === 'governance24-upgrade.html' || name === 'index.html') entries.push(bytes.toString('utf8'));
    }
  }
  await visit(directory);
  need(entries.length === 1, 'Exactly one standalone HTML entry is required.');
  const html = entries[0], referenced = new Set();
  // This standalone build has one module and one stylesheet. A second entry
  // could overwrite index.html during publication; unreferenced chunks could
  // otherwise smuggle extra public files through the broad asset extension gate.
  const attributes = raw => {
    const result = new Map();
    while (raw.trim()) {
      const field = /^\s+([a-z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/i.exec(raw);
      need(field, 'Malformed standalone HTML attributes.');
      const key = field[1].toLowerCase(); need(!result.has(key), 'Duplicate standalone HTML attribute.');
      result.set(key, field[2] ?? field[3] ?? field[4] ?? ''); raw = raw.slice(field[0].length);
    }
    return result;
  };
  need(!/<\s*(?:base|iframe|object|embed|style)\b/i.test(html)
    && !/\son[a-z]+\s*=/i.test(html) && !/(?:javascript|data)\s*:/i.test(html)
    && !/<meta\b[^>]*http-equiv\s*=/i.test(html), 'Inline execution or embedded content is prohibited.');
  const moduleTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  need(moduleTags.length === 1 && (html.match(/<script\b/gi) ?? []).length === 1,
    'Exactly one local module script is required.');
  const module = attributes(moduleTags[0][1]);
  need(!moduleTags[0][2].trim() && module.get('type') === 'module'
    && [...module.keys()].every(key => ['type', 'src', 'crossorigin'].includes(key))
    && /^\.\/assets\/[\w.-]+\.js$/.test(module.get('src') ?? ''), 'Module script must reference a local asset without inline execution.');
  referenced.add(module.get('src').slice(2));
  const links = [...html.matchAll(/<link\b([^>]*)>/gi)];
  need(links.length === 1, 'Exactly one local stylesheet is required.');
  const stylesheet = attributes(links[0][1]);
  need(stylesheet.get('rel') === 'stylesheet'
    && [...stylesheet.keys()].every(key => ['rel', 'href', 'crossorigin'].includes(key))
    && /^\.\/assets\/[\w.-]+\.css$/.test(stylesheet.get('href') ?? ''), 'Stylesheet must reference a local asset.');
  referenced.add(stylesheet.get('href').slice(2));
  const assets = Object.keys(files).filter(name => name.startsWith('assets/'));
  need(assets.length === referenced.size && assets.every(name => referenced.has(name))
    && [...referenced].every(name => files[name]), 'Public assets must exactly match the HTML references.');
  for (const file of Object.values(release.files)) need(files[file.path]?.sha256 === file.sha256, `Public input digest differs: ${file.path}.`);
  need(Object.keys(files).length === 8, 'The standalone public release must contain exactly eight files.');
  const bundled = scripts.join('\n');
  for (const pin of Object.values(release.pins)) need(bundled.includes(pin), 'Compiled UI is missing an independently pinned evidence root.');
  if (release.gasEvidenceDigest) need(bundled.includes(release.gasEvidenceDigest), 'Compiled UI is missing its measured Gas evidence pin.');
  if (release.liveReviewEvidenceDigest) need(bundled.includes(release.liveReviewEvidenceDigest), 'Compiled UI is missing its reviewed live baseline evidence pin.');
  need(bundled.includes('governance24-upgrade-journal-v1') && bundled.includes('configureGovernance24') === false,
    'Bundle is missing its journal gate or includes an unreviewed legacy migration sender.');
  return files;
}
export async function packageGovernance24Static({ source = resolve(root, 'dist-governance24'), destination = resolve(root, 'release-governance24') } = {}) {
  const release = JSON.parse(await readFile(resolve(root, '.governance24-release/config.json'), 'utf8'));
  const sourceFiles = await inspectGovernance24Static(source, release);
  for (const [file, expected] of Object.entries(release.sourceHashes)) need(hash(await readFile(resolve(root, '..', file))) === expected, `Source changed after review preparation: ${file}.`);
  await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true });
  for (const name of Object.keys(sourceFiles)) {
    const publicName = name === 'governance24-upgrade.html' ? 'index.html' : name;
    await mkdir(dirname(resolve(destination, publicName)), { recursive: true }); await copyFile(resolve(source, name), resolve(destination, publicName));
  }
  const files = await inspectGovernance24Static(destination, release);
  const manifest = { schemaVersion: 1, kind: 'governance24-upgrade-static-package-v1', preparedAt: new Date().toISOString(),
    sourceCommit: release.sourceCommit, sourceDiffDigest: release.sourceDiffDigest, pins: release.pins, gasEvidenceDigest: release.gasEvidenceDigest,
    liveReviewEvidenceDigest: release.liveReviewEvidenceDigest, liveReviewAnchor: release.liveReviewAnchor,
    entryPath: release.entryPath, files, chainActionsPerformed: false, deployedOrActivated: false,
    governanceMigrationIncluded: true, productActive: false, rpcProxyRequired: '/pinkuang-governance24-read/api/rpc -> isolated loopback read service 4230' };
  await writeFile(resolve(dirname(destination), `${destination.split('/').at(-1)}-manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return { destination, manifest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await packageGovernance24Static(); process.stdout.write(`${JSON.stringify({ directory: result.destination,
    files: Object.keys(result.manifest.files).length, sourceDiffDigest: result.manifest.sourceDiffDigest }, null, 2)}\n`);
}
