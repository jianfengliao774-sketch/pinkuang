import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifiedFullTestBuildDigest } from './build-artifacts.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicOrigin = 'https://tapeout.cc.cd', basePath = '/bemine-full-test';
const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
const sourcePath = name => name.startsWith('web/') || name.startsWith('deploy/src/')
  || name.startsWith('deploy/shared/') || name === 'deploy/package.json';
const relevant = name => sourcePath(name) && !/(?:^|\/)(?:\.env[^/]*|AGENTS\.md|CLAUDE\.md)$/.test(name);
const run = (args, cwd, env = process.env) => {
  const outcome = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
  if (outcome.error || outcome.status !== 0) throw new Error(`Full test build failed: ${outcome.status ?? outcome.error?.message}`);
};

/** Copy current source into a disposable checkout; production manifests and outputs are untouched. */
export function buildFullTestSite({ output, allowDirty = false } = {}) {
  const artifactDigest = verifiedFullTestBuildDigest();
  const sourceHead = git(['rev-parse', 'HEAD']).trim();
  const dirty = git(['status', '--porcelain', '--untracked-files=all']).trim().split(/\r?\n/)
    .filter(line => relevant(line.slice(3)) || line.slice(3).startsWith('scripts/full-test/'));
  if (dirty.length && !allowDirty) throw new Error('Commit the full-test sources before a release build, or use --allow-dirty for a local preview.');
  const destination = resolve(output || join(repository, 'full-test', `site-${Date.now()}`));
  if (existsSync(destination)) throw new Error('Full test output must be a new directory.');
  mkdirSync(dirname(destination), { recursive: true });
  const taskTempRoot = realpathSync(tmpdir());
  const scratch = realpathSync(mkdtempSync(join(taskTempRoot, 'bemine-full-test-build-')));
  const checkout = join(scratch, 'checkout');
  mkdirSync(checkout);
  try {
    const files = git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(relevant);
    for (const name of new Set(files)) {
      const from = join(repository, name), to = join(checkout, name);
      if (!existsSync(from)) continue;
      if (relative(checkout, to).startsWith('..') || !lstatSync(from).isFile()) throw new Error(`Unsafe source file: ${name}`);
      mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { errorOnExist: true, force: false });
    }
    for (const area of ['web', 'deploy']) {
      const dependencyRoot = realpathSync(join(repository, area, 'node_modules'));
      symlinkSync(dependencyRoot, join(checkout, area, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const web = join(checkout, 'web');
    cpSync(join(repository, 'full-test/public/contracts.generated.json'), join(web, 'lib/contracts.generated.json'));
    // Static import exists for the formal family only; a neutral root prevents an accidental test fallback.
    writeFileSync(join(web, 'public/data/frontend-manifest.json'), `${JSON.stringify({ artifactDigest })}\n`);
    for (const name of ['frontend-manifest.v4.json', 'fresh-product-manifest.json']) {
      const target = join(web, 'public/data', name); if (existsSync(target)) rmSync(target);
    }
    run(['node_modules/typescript/bin/tsc', '--noEmit'], join(repository, 'deploy'));
    run(['node_modules/vite/bin/vite.js', 'build', '--mode', 'full-test'], join(repository, 'deploy'));
    run(['node_modules/next/dist/bin/next', 'build', '--webpack'], web, { ...process.env,
      NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY: 'full-test',
      NEXT_PUBLIC_BEMINE_PUBLIC_ORIGIN: publicOrigin, NEXT_PUBLIC_BEMINE_PUBLIC_URL: `${publicOrigin}${basePath}/`,
      NEXT_PUBLIC_DEPLOY_CONSOLE_URL: `${publicOrigin}${basePath}/deploy/`, NEXT_TELEMETRY_DISABLED: '1' });
    const exported = join(web, 'out');
    if (!existsSync(join(exported, 'index.html'))) throw new Error('Full test static export is incomplete.');
    const retiredRoot = join(exported, 'data/frontend-manifest.json'); if (existsSync(retiredRoot)) rmSync(retiredRoot);
    cpSync(exported, destination, { recursive: true, errorOnExist: true, force: false });
    cpSync(join(repository, 'deploy/dist-full-test'), join(destination, 'deploy'), { recursive: true, errorOnExist: true, force: false });
    // Offline exports have an unavailable placeholder. The live deployment
    // maps this exact URL to the independent public PancakeSwap price cache.
    writeFileSync(join(destination, 'data/bem-price.json'), `${JSON.stringify({ status: 'unavailable',
      priceUsdt: null, quoteCurrency: 'USDT', updatedAt: null, checkedAt: null,
      lastSuccessAt: null, refreshSeconds: 15 })}\n`, { flag: 'wx' });
    // Full-test Vite disables publicDir to exclude retired deployment records.
    cpSync(join(repository, 'deploy/public/favicon.svg'), join(destination, 'deploy/favicon.svg'),
      { errorOnExist: true, force: false });
    const metadata = { schemaVersion: 1, kind: 'bemine-full-test-static-site', profile: 'full-test',
      chainId: 56, sourceHead, sourceBound: dirty.length === 0, artifactDigest, basePath,
      publicUrl: `${publicOrigin}${basePath}/`, deployConsoleUrl: `${publicOrigin}${basePath}/deploy/`,
      productionManifestIncluded: false, generatedAt: new Date().toISOString() };
    writeFileSync(join(destination, 'full-test-site.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    return { ...metadata, output: destination };
  } finally {
    // Check the absolute directory before removing the managed temporary checkout, including junctions.
    if (!scratch.startsWith(`${taskTempRoot}${sep}bemine-full-test-build-`)) throw new Error('Unsafe temporary cleanup path.');
    for (const area of ['web', 'deploy']) {
      const link = join(checkout, area, 'node_modules');
      if (existsSync(link) && lstatSync(link).isSymbolicLink()) rmSync(link);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), allowDirty = args.includes('--allow-dirty'), outputIndex = args.indexOf('--output');
  const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
  if (outputIndex >= 0 && (!output || !isAbsolute(output))) throw new Error('--output requires an absolute new directory.');
  if (args.some((arg, i) => arg !== '--allow-dirty' && arg !== '--output' && !(outputIndex >= 0 && i === outputIndex + 1))) throw new Error('Usage: build-site.mjs [--allow-dirty] [--output absolute-new-directory]');
  console.log(JSON.stringify(buildFullTestSite({ output, allowDirty }), null, 2));
}
