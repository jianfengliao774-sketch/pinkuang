import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servedArtifactDigest } from '../server/artifact-digest.mjs';

const DEPLOY = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(DEPLOY, 'dist-upgrade');
const GENESIS_RECORD = 'upgrade-genesis/genesis-record.json';
const GENESIS_ARTIFACTS = 'upgrade-genesis/genesis-artifacts.json';
const GENESIS_RECORD_SHA256 = '39f567de5a23661db1bcd31638b536598cb58f5bb738a1b7a101e97ea54dfdf5';
const GENESIS_ARTIFACT_SHA256 = '22e4fb90b537c3f2bfb864ee43e7be5005dfa864640be641a476adb7681b867b';
const GENESIS_MANIFEST_SHA256 = '5bf6596502e966de526e899c31d4bc71ef2a9a176e365bf75c0603a12c1b10ae';
const sha256 = data => createHash('sha256').update(data).digest('hex');

function collect(root, name = '', files = new Map()) {
  const directory = join(root, name);
  assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), `Unsafe directory: ${name}`);
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const child = name ? `${name}/${item.name}` : item.name;
    assert(!item.isSymbolicLink() && !item.name.startsWith('.'), `Unsafe static entry: ${child}`);
    if (item.isDirectory()) collect(root, child, files);
    else {
      assert(item.isFile(), `Unsupported static entry: ${child}`);
      assert(child === 'upgrade.html' || child === 'favicon.svg' || child === 'deployment-artifacts.json'
        || child === GENESIS_RECORD || child === GENESIS_ARTIFACTS
        || /^assets\/[A-Za-z0-9_-]+\.(?:js|css|svg|png|webp|woff2)$/.test(child),
      `Unexpected file in the upgrade-only build: ${child}`);
      const bytes = readFileSync(join(root, child));
      assert(bytes.length > 0 && bytes.length <= 8_000_000, `Invalid static file size: ${child}`);
      files.set(child, bytes);
    }
  }
  return files;
}

export function verifyUpgradeBuild() {
  const files = collect(DIST);
  for (const name of ['upgrade.html', 'deployment-artifacts.json', GENESIS_RECORD, GENESIS_ARTIFACTS])
    assert(files.has(name), `Missing static file: ${name}`);
  assert([...files].some(([name]) => /^assets\/upgrade-[A-Za-z0-9_-]+\.js$/.test(name)),
    'Missing standalone upgrade entry JavaScript.');
  assert(sha256(files.get(GENESIS_RECORD)) === GENESIS_RECORD_SHA256
    && sha256(files.get(GENESIS_ARTIFACTS)) === GENESIS_ARTIFACT_SHA256,
  'Pinned genesis release files differ from the verified server originals.');
  const manifestBytes = readFileSync(join(DEPLOY, '../web/public/data/frontend-manifest.json'));
  assert(sha256(manifestBytes) === GENESIS_MANIFEST_SHA256, 'Embedded genesis manifest changed.');
  const genesisManifest = JSON.parse(manifestBytes), genesisRecord = JSON.parse(files.get(GENESIS_RECORD));
  const genesisBundle = JSON.parse(files.get(GENESIS_ARTIFACTS));
  assert(genesisRecord.kind === 'integrated-v2' && genesisRecord.status === 'complete'
    && genesisRecord.artifactDigest?.toLowerCase() === genesisManifest.artifactDigest.toLowerCase()
    && genesisBundle.sourceCommit === genesisManifest.sourceCommit,
  'Pinned genesis record/bundle does not identify the published graph.');
  assert(files.get('deployment-artifacts.json').equals(readFileSync(join(DEPLOY, 'public/deployment-artifacts.json'))),
    'Candidate static artifact differs from the reviewed build input.');
  const candidateDigest = servedArtifactDigest(join(DIST, 'deployment-artifacts.json'));
  assert(candidateDigest !== genesisManifest.artifactDigest, 'Upgrade artifact must differ from the deployed genesis.');
  const html = files.get('upgrade.html').toString('utf8');
  assert(html.includes('./assets/') && !html.includes('/src/') && !html.includes('src/main.tsx'),
    'Standalone HTML must refer only to built relative assets.');
  const script = [...files].filter(([name]) => name.endsWith('.js')).map(([,bytes]) => bytes.toString('utf8')).join('\n');
  assert(script.includes(candidateDigest) && script.includes(genesisManifest.artifactDigest),
    'Candidate and genesis trust digests must both be embedded in the upgrade page.');
  // The public product graph is a GET-only release proof. No journal signing,
  // mutation or session API belongs in the standalone hardware-wallet page.
  const publicProductGraphPath = '/api/journal/product-graph';
  assert(script.includes(publicProductGraphPath), 'Upgrade page must read the public product graph proof.');
  assert(!/\/?api\/journal(?:\/|\b)/.test((html + script).replaceAll(publicProductGraphPath, '')),
    'Standalone page must not contain journal signing API calls.');
  assert(!files.has('index.html') && ![...files].some(([name]) => /(?:server|node_modules|\.env|\.sqlite)/i.test(name)),
    'Standalone build contains server or private runtime files.');
  return { files, candidateDigest, genesisDigest: genesisManifest.artifactDigest,
    genesisManifestSha256: GENESIS_MANIFEST_SHA256 };
}

function committedSourceHead() {
  const paths = ['src', 'upgrade.html', 'vite.config.ts', 'public/deployment-artifacts.json',
    'public/upgrade-genesis', 'scripts/package-upgrade-static.mjs', 'scripts/build-artifacts.mjs',
    '../web/public/data/frontend-manifest.json', '../contracts/src', '../contracts/foundry.toml'];
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths],
    { cwd: DEPLOY, encoding: 'utf8' });
  assert(!dirty.trim(), 'Commit reviewed upgrade sources and pinned evidence before packaging.');
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEPLOY, encoding: 'utf8' }).trim();
}

export function packageUpgradeStatic(outDir) {
  const verified = verifyUpgradeBuild();
  const sourceHead = committedSourceHead();
  assert(isAbsolute(outDir), '--out must be an absolute path.');
  const sourceRoot = realpathSync(join(DEPLOY, '..'));
  const output = resolve(outDir), manifestPath = `${output}.manifest.json`, parent = realpathSync(dirname(output));
  assert(parent === resolve(dirname(output)) && parent !== sourceRoot && !parent.startsWith(sourceRoot + sep),
    'Release parent must be real and outside the checkout.');
  for (const path of [output, manifestPath]) {
    try { lstatSync(path); assert.fail(`Release path already exists: ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  mkdirSync(output, { recursive: false });
  const entries = [...verified.files].map(([name, bytes]) => [name === 'upgrade.html' ? 'index.html' : name, bytes]);
  for (const [name, bytes] of entries) {
    const target = join(output, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
  }
  const manifest = {
    schemaVersion: 1, kind: 'pinkuang-upgrade-static', basePath: '/pinkuang-upgrade-v2',
    sourceHead, chainId: 56, candidateArtifactDigest: verified.candidateDigest,
    genesisArtifactDigest: verified.genesisDigest,
    genesisManifestSha256: verified.genesisManifestSha256,
    files: Object.fromEntries(entries.sort(([a],[b]) => a.localeCompare(b)).map(([name,bytes]) =>
      [name, { sha256: sha256(bytes), bytes: bytes.length }])),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(manifestPath, manifestBytes, { flag: 'wx', mode: 0o600 });
  return { directory: output, sourceHead, files: entries.length,
    manifestPath, manifestSha256: sha256(manifestBytes), candidateArtifactDigest: verified.candidateDigest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 1 && args[0] === '--check' || args.length === 2 && args[0] === '--out',
      'Usage: node scripts/package-upgrade-static.mjs --check | --out /absolute/new-release');
    const result = args[0] === '--check' ? (() => {
      const checked = verifyUpgradeBuild();
      return { buildVerified: true, files: checked.files.size,
        candidateArtifactDigest: checked.candidateDigest, genesisArtifactDigest: checked.genesisDigest };
    })() : packageUpgradeStatic(args[1]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
