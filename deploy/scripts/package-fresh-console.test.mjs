import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPinnedSourceUnchanged, packageFreshConsole, RUNTIME_MODULES,
  verifyRuntimeClosure } from './package-fresh-console.mjs';
import { servedArtifactDigest } from '../server/artifact-digest.mjs';

const deploy = fileURLToPath(new URL('../', import.meta.url));

test('artifact source pin tolerates later packaging commits, but rejects changed runtime code', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pinkuang-source-pin-test-')));
  const source = join(root, 'deploy');
  mkdirSync(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', '-q', root]);
    git('config', 'user.name', 'Source Pin Test');
    git('config', 'user.email', 'source-pin@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(source, 'src'));
    writeFileSync(join(source, 'src/app.ts'), 'export const version = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'audited code');
    const audited = git('rev-parse', 'HEAD');
    writeFileSync(join(source, 'README.md'), 'Packaging notes\n');
    git('add', '.');
    git('commit', '-qm', 'documentation only');
    assert.doesNotThrow(() => assertPinnedSourceUnchanged(source, audited, git('rev-parse', 'HEAD')));
    writeFileSync(join(source, 'src/app.ts'), 'export const version = 2;\n');
    git('add', '.');
    git('commit', '-qm', 'runtime changed');
    assert.throws(() => assertPinnedSourceUnchanged(source, audited, git('rev-parse', 'HEAD')),
      /source changed since the artifact commit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fresh console runtime allowlist includes the complete static import closure', () => {
  const files = new Map(RUNTIME_MODULES.map(name =>
    [name, readFileSync(join(deploy, name))]));
  assert.equal(verifyRuntimeClosure(files), RUNTIME_MODULES.length);
  const missing = new Map(files);
  missing.delete('server/authority-ipc.mjs');
  assert.throws(() => verifyRuntimeClosure(missing), /Missing packaged runtime module/);
  assert.throws(() => verifyRuntimeClosure(files, [...RUNTIME_MODULES, 'scripts/treasury-collector.mjs']),
    /unreachable modules/);
});

test('pre-genesis package contains only fresh dist and required runtime files', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pinkuang-fresh-package-test-'));
  try {
    const root = realpathSync(temp), source = join(root, 'source/deploy');
    const write = (name, body) => {
      const path = join(source, name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, body);
    };
    for (const name of RUNTIME_MODULES) write(name, readFileSync(join(deploy, name)));
    const artifact = JSON.stringify({ sourceCommit: '0'.repeat(40), artifacts: {
      FreshPoolFactory: {}, PlatformAuthority: {}, AtomicDeployment: {},
      BudgetPortfolioFactory: {}, BudgetPortfolioVault: {},
    } });
    write('public/deployment-artifacts.json', artifact);
    write('dist/deployment-artifacts.json', artifact);
    write('dist/assets/app.js', `const digest=${JSON.stringify(servedArtifactDigest(join(source,
      'public/deployment-artifacts.json')))};`);
    write('dist/assets/app.css', 'body { color: black; }');
    write('dist/index.html', '<script src="./assets/app.js"></script>');
    write('dist/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    write('package.json', '{"type":"module"}');
    write('package-lock.json', '{}');
    const target = join(root, 'release');
    const result = await packageFreshConsole({ deployDir: source, outDir: target,
      sourceHead: '0'.repeat(40), verifyGit: false });
    const manifest = JSON.parse(readFileSync(join(target, 'public/fresh-release-manifest.json')));
    assert.equal(manifest.kind, 'fresh-console-pre-genesis');
    assert.equal(result.fileCount, Object.keys(manifest.files).length + 1);
    assert.equal(readdirSync(join(target, 'dist')).sort().join(','),
      'assets,deployment-artifacts.json,favicon.svg,index.html');
    assert.equal(readFileSync(join(target, 'dist/deployment-artifacts.json')).equals(
      readFileSync(join(target, 'public/deployment-artifacts.json'))), true);
    assert(RUNTIME_MODULES.every(name => manifest.files[name]));
    assert(!Object.keys(manifest.files).some(name =>
      (name.startsWith('dist/') && /upgrade/i.test(name))
      || /\.test\.|fixture|\.env|\.key/.test(name)));
    assert(!manifest.files['src/UpgradeConsole.tsx']);
    assert(!manifest.files['scripts/build-artifacts.mjs']);
    // Manual recovery belongs to the private signer installation, not the
    // public pre-genesis console release.
    for (const name of ['scripts/authority-relay-recovery.mjs',
      'scripts/authority-relay.mjs', 'scripts/purchase-keeper.mjs',
      'scripts/keeper-credential.mjs']) assert(!manifest.files[name]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
