#!/usr/bin/env node
/** Build a reviewable v2 static release locally. This script never connects to a server. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, '../../..');
const web = path.join(repo, 'web');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const releaseId = value => /^v2-product-[a-z0-9][a-z0-9-]{1,70}$/.test(value);
const sha256Hex = value => /^[0-9a-f]{64}$/.test(value);

function relativeFile(name) {
  assert(typeof name === 'string' && name.length && !name.includes('\\') && !name.includes(':'));
  const parts = name.split('/');
  assert(parts.every(part => part && part !== '.' && part !== '..' && !part.startsWith('.')),
    `Unsafe product path: ${name}`);
  assert(parts.every(part => !['journal.sqlite', '.env', 'id_rsa', 'id_ed25519'].includes(part.toLowerCase())
    && !/\.(?:key|pem|sqlite|sqlite-wal|sqlite-shm)$/i.test(part)), `Private product path: ${name}`);
  return name;
}

async function staticFiles(outDir) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = relativeFile(prefix ? `${prefix}/${entry.name}` : entry.name);
      const full = path.join(dir, entry.name);
      const stat = await lstat(full);
      assert(!stat.isSymbolicLink(), `Symlink in static export: ${name}`);
      if (stat.isDirectory()) await walk(full, name);
      else {
        assert(stat.isFile(), `Unsupported static export entry: ${name}`);
        files.push(name);
      }
    }
  }
  await walk(outDir);
  files.sort();
  assert(files.length >= 2 && files.length <= 2000, 'Static export file count out of range');
  assert(files.includes('index.html') && files.includes('data/frontend-manifest.json'),
    'Static export lacks product HTML or contract manifest');
  return files;
}

/** Package only an already-built export; the CLI performs the pinned build first. */
export async function packageStaticOutput({ outDir, releaseDir, sourceHead, previousFrontendBytes,
  expectedFrontendSha256 }) {
  assert(path.isAbsolute(outDir) && path.isAbsolute(releaseDir), 'Use absolute paths');
  assert(releaseId(path.basename(releaseDir)), 'Invalid v2 product release ID');
  assert(/^[0-9a-f]{40}$/.test(sourceHead), 'Source must be an exact Git commit');
  assert(sha256Hex(expectedFrontendSha256), 'Expected prior frontend SHA256 is required');
  assert(Buffer.isBuffer(previousFrontendBytes)
    && sha256(previousFrontendBytes) === expectedFrontendSha256, 'Previous frontend bytes do not match server evidence');
  const fileNames = await staticFiles(outDir);
  const frontend = await readFile(path.join(outDir, 'data/frontend-manifest.json'));
  assert(frontend.equals(previousFrontendBytes), 'Static update must retain the previous contract manifest byte for byte');
  const parsed = JSON.parse(frontend.toString('utf8'));
  assert(parsed.kind === 'integrated-v2' && parsed.chainId === 56
    && /^0x[0-9a-f]{64}$/.test(parsed.artifactDigest), 'Unexpected v2 contract manifest');
  const html = await readFile(path.join(outDir, 'index.html'));
  assert(html.includes('"/bemine-v2/_next/static/') && !html.includes('"/_next/static/'),
    'Build with NEXT_PUBLIC_BASE_PATH=/bemine-v2');
  await access(releaseDir).then(() => { throw new Error('Release directory already exists'); }, error => {
    if (error.code !== 'ENOENT') throw error;
  });
  const staging = path.join(path.dirname(releaseDir), `.${path.basename(releaseDir)}.staging-${process.pid}-${randomBytes(6).toString('hex')}`);
  const files = {};
  let total = 0;
  await mkdir(staging, { mode: 0o755 });
  try {
    for (const name of fileNames) {
      const source = path.join(outDir, name);
      const bytes = await readFile(source);
      assert(bytes.length <= 128 * 1024 * 1024 && total + bytes.length <= 128 * 1024 * 1024,
        'Static package exceeds the 128 MiB server guard');
      total += bytes.length;
      const destination = path.join(staging, 'public', 'bemine-v2', name);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
      await chmod(destination, 0o644);
      files[`public/bemine-v2/${name}`] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
    const manifest = { schemaVersion: 1, sourceHead, artifactDigest: parsed.artifactDigest,
      chainId: 56, basePath: '/bemine-v2', files };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const manifestPath = path.join(staging, 'product-release-manifest.json');
    await writeFile(manifestPath, manifestBytes, { flag: 'wx', mode: 0o644 });
    await chmod(manifestPath, 0o644);
    await rename(staging, releaseDir);
    return { releaseDir, sourceHead, manifestSha256: sha256(manifestBytes),
      frontendManifestSha256: sha256(frontend), artifactDigest: parsed.artifactDigest,
      fileCount: fileNames.length, totalBytes: total };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert(result.status === 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    assert(['--release', '--previous-frontend', '--expected-frontend-sha256'].includes(key)
      && args[index + 1] && !Object.hasOwn(values, key), 'Usage: --release ABS --previous-frontend ABS --expected-frontend-sha256 SHA256');
    values[key] = args[index + 1];
  }
  assert(Object.keys(values).length === 3 && path.isAbsolute(values['--release'])
    && path.isAbsolute(values['--previous-frontend']), 'All inputs are required and paths must be absolute');
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const releaseDir = args['--release'];
  assert(!releaseDir.startsWith(`${repo}${path.sep}`), 'Stage the release outside the source repository');
  const sourceHead = git('rev-parse', 'HEAD');
  assert(/^[0-9a-f]{40}$/.test(sourceHead), 'No exact source commit');
  assert(!git('status', '--porcelain', '--untracked-files=all'), 'Commit all source changes before release build');
  const previousFrontendBytes = await readFile(args['--previous-frontend']);
  const expectedFrontendSha256 = args['--expected-frontend-sha256'];
  assert(sha256(previousFrontendBytes) === expectedFrontendSha256, 'Prior manifest evidence changed');
  const result = spawnSync('pnpm', ['build'], { cwd: web,
    env: { ...process.env, NEXT_PUBLIC_BASE_PATH: '/bemine-v2' }, stdio: 'inherit' });
  assert(result.status === 0, 'v2 static build failed');
  assert(git('rev-parse', 'HEAD') === sourceHead && !git('status', '--porcelain', '--untracked-files=all'),
    'Source changed during the build');
  const builtFrontend = await readFile(path.join(web, 'out/data/frontend-manifest.json'));
  const sourceFrontend = await readFile(path.join(web, 'public/data/frontend-manifest.json'));
  assert(builtFrontend.equals(sourceFrontend), 'Static export contract manifest differs from committed source');
  const metadata = await packageStaticOutput({ outDir: path.join(web, 'out'), releaseDir, sourceHead,
    previousFrontendBytes, expectedFrontendSha256 });
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
