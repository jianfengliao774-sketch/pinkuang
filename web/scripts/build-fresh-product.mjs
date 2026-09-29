import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freshManifestDigest, validateFreshManifest } from '../lib/fresh-product-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const stagedManifest = join(webRoot, 'public/data/frontend-manifest.v4.json');
const compiledManifest = join(webRoot, 'public/data/frontend-manifest.json');
const outputRoot = join(webRoot, 'out');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };

export function prepareFreshProductBuild(manifest) {
  const manifestSha256 = freshManifestDigest(manifest);
  const checked = validateFreshManifest(manifest, manifestSha256);
  return Object.freeze({ basePath: '/bemine-v4', productFamily: 'fresh-v4',
    manifestSha256, artifactDigest: checked.artifactDigest,
    factory: checked.factory, portfolioFactory: checked.portfolioFactory,
    authority: checked.authority, deployment: checked.deployment,
    sourceCommit: checked.sourceCommit });
}

function walk(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('Static release must not contain symlinks.');
    if (entry.isDirectory()) return walk(root, target);
    if (!entry.isFile()) fail('Static release contains a non-file entry.');
    return [relative(root, target)];
  });
}

/** Build in an isolated checkout. The compiled trust root is temporarily the new graph. */
export function buildFreshProduct(manifestPath, { run = spawnSync } = {}) {
  if (existsSync(stagedManifest)) fail('v4 manifest staging path already exists; refusing to overwrite it.');
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
  const plan = prepareFreshProductBuild(manifest);
  const previousCompiledManifest = readFileSync(compiledManifest);
  mkdirSync(dirname(stagedManifest), { recursive: true });
  writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  try {
    // Several existing page modules still compile a pinned genesis JSON. For
    // this isolated v4 build, pin the fresh genesis there too; restore source
    // bytes afterward and publish only the separate .v4.json asset.
    writeFileSync(compiledManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const env = { ...process.env, NEXT_PUBLIC_BASE_PATH: plan.basePath,
      NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY: plan.productFamily,
      NEXT_PUBLIC_V4_MANIFEST_SHA256: plan.manifestSha256,
      NEXT_PUBLIC_BEMINE_PUBLIC_URL: 'https://tapeout.cc.cd/bemine-v4/',
      NEXT_PUBLIC_DEPLOY_CONSOLE_URL: 'https://tapeout.cc.cd/pinkuang-deploy-v4/' };
    for (const args of [['scripts/sync-contracts.mjs', '--check'],
      ['node_modules/next/dist/bin/next', 'build', '--webpack']]) {
      const build = run(process.execPath, args, { cwd: webRoot, stdio: 'inherit', env });
      if (build.error || build.status !== 0) fail(`v4 product build failed (${build.status ?? build.error?.message}).`);
    }
    const exportedManifest = join(outputRoot, 'data/frontend-manifest.v4.json');
    if (!existsSync(join(outputRoot, 'index.html')) || !existsSync(exportedManifest)
      || !statSync(exportedManifest).isFile()) fail('v4 product export is incomplete.');
    const exported = JSON.parse(readFileSync(exportedManifest, 'utf8'));
    if (freshManifestDigest(exported) !== plan.manifestSha256) fail('Exported v4 manifest changed during build.');
    const oldManifest = join(outputRoot, 'data/frontend-manifest.json');
    if (existsSync(oldManifest)) rmSync(oldManifest);
    const files = walk(outputRoot).sort();
    const contentSha256 = sha256(files.map(name => `${name}\0${sha256(readFileSync(join(outputRoot, name)))}\n`).join(''));
    const release = { schemaVersion: 1, kind: 'fresh-v4-product-static-candidate', chainId: 56,
      ...plan, contentSha256, fileCount: files.length,
      legacyManifestIncluded: false, activationAllowed: false };
    writeFileSync(join(outputRoot, 'fresh-product-release.json'), `${JSON.stringify(release, null, 2)}\n`,
      { flag: 'wx', mode: 0o644 });
    return release;
  } finally {
    writeFileSync(compiledManifest, previousCompiledManifest);
    rmSync(stagedManifest, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) fail('Usage: node scripts/build-fresh-product.mjs /absolute/path/to/reviewed-fresh-manifest.json');
  console.log(JSON.stringify(buildFreshProduct(process.argv[2]), null, 2));
}
