import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servedArtifactDigest } from '../server/artifact-digest.mjs';

const DEPLOY = fileURLToPath(new URL('../', import.meta.url));
const TREES = ['dist', 'server', 'shared'];
// journal-api statically imports this read-only helper. Never include keeper CLIs.
const RUNTIME_SCRIPTS = ['scripts/official-market-discovery.mjs', 'scripts/budget-official-discovery.mjs', 'scripts/budget-multicall-read.mjs'];
const RUNTIME_SOURCES = ['src/firsto-purchase.mjs'];
const EXACT_FILES = ['package.json', 'package-lock.json', 'public/deployment-artifacts.json', ...RUNTIME_SCRIPTS, ...RUNTIME_SOURCES];
const SOURCE_EXTENSIONS = new Set(['.mjs', '.mts', '.json', '.md']);
const DIST_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.txt']);
const HASH = /^[a-f\d]{40,64}$/i;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const inside = (parent, child) => {
  if (process.platform === 'win32') { parent = parent.toLowerCase(); child = child.toLowerCase(); }
  return child === parent || child.startsWith(parent + sep);
};
const forbidden = name => name.split('/').some(part => part.startsWith('.') || /^(?:node_modules|private|secrets?|credentials?|wallets?|id_rsa|id_ed25519)$/i.test(part))
  || /\.(?:env|sqlite|sqlite3|db|wal|shm|pem|key|p12|pfx|keystore)(?:[-.]|$)/i.test(name)
  || /(?:^|\/)(?:journal|wallet|credentials|secrets|private[-_]?key)(?:[-.].*)?\.(?:json|txt|bak|log)$/i.test(name);

function regularFile(path, name) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `Only regular release files are allowed: ${name}`);
  assert(!forbidden(name), `Private or unsupported file is not allowed: ${name}`);
  const data = readFileSync(path);
  assert(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(data.toString('utf8')), `Private-key material is not allowed: ${name}`);
  return data;
}

function collectTree(source, folder, files) {
  const path = join(source, folder), stat = lstatSync(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && !forbidden(folder), `Invalid release directory: ${folder}`);
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${folder}/${entry.name}`;
    assert(!entry.isSymbolicLink() && !forbidden(name), `Private or linked release entry is not allowed: ${name}`);
    if (entry.isDirectory()) collectTree(source, name, files);
    else {
      const extensions = folder.split('/')[0] === 'dist' ? DIST_EXTENSIONS : SOURCE_EXTENSIONS;
      assert(extensions.has(extname(name)), `Unsupported release extension: ${name}`);
      files.set(name, regularFile(join(source, name), name));
    }
  }
}

/** Check packaged runtime imports without executing any service, keeper, notification or RPC. */
function checkRuntimeImports(files) {
  for (const [name, data] of files) {
    if (!/^(?:server|shared|scripts|src)\//.test(name) || !name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    const source = data.toString('utf8');
    const imports = [...source.matchAll(/\b(?:import|export)\s+(?:(?:[^;]*?\s+from\s+)?)["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)];
    for (const [, specifier] of imports) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolve('/', dirname(name), specifier);
      const target = relative(resolve('/'), resolved).split(sep).join('/');
      assert(files.has(target), `Missing packaged runtime dependency: ${name} -> ${specifier}`);
    }
  }
}

/** Produce an explicit new directory only; no SSH, archive extraction, installation or activation. */
export function packageRelease({ deployDir = DEPLOY, outDir, sourceHead } = {}) {
  assert(typeof outDir === 'string' && isAbsolute(outDir), '--out must be an absolute, new release-directory path.');
  const source = realpathSync(deployDir), output = resolve(outDir);
  const sourceRoot = realpathSync(join(source, '..'));
  assert(!inside(sourceRoot, output), 'Release output must be outside the source checkout.');
  // Parent must already exist and be real, preventing a symlink from redirecting output into source/data.
  const parent = realpathSync(dirname(output));
  assert(parent === resolve(dirname(output)) && !inside(sourceRoot, parent), 'Output parent must be canonical and outside the source checkout.');
  try { lstatSync(output); assert.fail('Release output already exists; it will never be overwritten.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(HASH.test(sourceHead ?? ''), 'A source Git commit is required.');
  const files = new Map();
  for (const folder of TREES) collectTree(source, folder, files);
  for (const name of EXACT_FILES) files.set(name, regularFile(join(source, name), name));
  assert(files.get('dist/deployment-artifacts.json')?.equals(files.get('public/deployment-artifacts.json')),
    'Served dist artifact must match public artifact byte for byte. Build first.');
  const artifact = JSON.parse(files.get('public/deployment-artifacts.json').toString('utf8'));
  assert(HASH.test(artifact.sourceCommit ?? ''), 'Artifact source commit is missing.');
  const artifactDigest = servedArtifactDigest(join(source, 'public/deployment-artifacts.json'));
  assert([...files].some(([name, bytes]) => name.startsWith('dist/assets/') && name.endsWith('.js') && bytes.toString('utf8').includes(artifactDigest)),
    'Compiled browser bundle does not contain the current artifact digest. Rebuild the deployment page.');
  for (const name of ['FirstoSale', 'AtomicDeployment', 'BudgetPortfolioFactory', 'BudgetPortfolioVault'])
    assert(artifact.artifacts?.[name], `Integrated deployment artifact is missing: ${name}`);
  checkRuntimeImports(files);
  const ordered = [...files].sort(([a], [b]) => a.localeCompare(b));
  const manifest = { schemaVersion: 1, kind: 'integrated-v2', createdAt: new Date().toISOString(),
    sourceCommit: artifact.sourceCommit, sourceHead, artifactDigest, artifactSha256: sha256(files.get('public/deployment-artifacts.json')),
    chainId: 56, transactionCount: 16, installation: 'npm ci --omit=dev --ignore-scripts', entrypoint: 'node server/index.mjs',
    runtimeScripts: RUNTIME_SCRIPTS, runtimeSources: RUNTIME_SOURCES, includedTrees: TREES, explicitFiles: EXACT_FILES,
    files: Object.fromEntries(ordered.map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.length }])),
    activation: 'Not activated. Independent host/port/journal/HTTPS proxy configuration is required.' };
  mkdirSync(output, { recursive: false });
  for (const [name, bytes] of ordered) { const target = join(output, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 }); }
  writeFileSync(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  return { directory: output, files: files.size, artifactDigest, sourceCommit: manifest.sourceCommit, sourceHead,
    manifestSha256: sha256(readFileSync(join(output, 'release-manifest.json'))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 2 && args[0] === '--out', 'Usage: node scripts/package-release.mjs --out <absolute-new-directory>');
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEPLOY, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src', 'server', 'shared',
      ...RUNTIME_SCRIPTS, 'package.json', 'package-lock.json', '../contracts/src', '../contracts/foundry.toml', 'vite.config.ts', 'scripts/build-artifacts.mjs'], { cwd: DEPLOY, encoding: 'utf8' });
    assert(!dirty.trim(), 'Commit the reviewed runtime and contract sources before packaging. Generated artifact/dist may differ.');
    console.log(JSON.stringify(packageRelease({ outDir: args[1], sourceHead }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
