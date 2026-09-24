import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows solc 0.8.24 cannot reliably resolve non-ASCII dependency paths.
// Compile an identical snapshot in an ASCII directory, preserving all logs at source.
const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[2] ?? process.env.VALIDATION_TASK ?? 'T1d';
if (!/^T\d+(?:[a-z]|\.\d+)?$/i.test(task)) throw new Error('Invalid validation task name');
const logRoot = resolve(process.env.VALIDATION_EVIDENCE_ROOT ?? join(root, 'docs/logs', task, 'contracts'));
mkdirSync(logRoot, { recursive: true });
let buildRoot = root;
if (process.platform === 'win32' && /[^\x00-\x7f]/.test(root)) {
  if (/[^\x00-\x7f]/.test(tmpdir())) throw new Error('Set TEMP to an ASCII path before checking.');
  buildRoot = mkdtempSync(join(tmpdir(), 'tapeout-check-'));
  for (const path of ['contracts', 'node_modules', 'scripts', 'docs/storage', 'package.json', 'package-lock.json']) {
    cpSync(join(root, path), join(buildRoot, path), {
      recursive: true,
      filter: source => !['contracts/out', 'contracts/cache', 'contracts/broadcast'].some(
        part => source.replaceAll('\\', '/').includes(`/${part}`),
      ),
    });
  }
}
const paths = readdirSync(join(root, 'contracts'), { recursive: true })
  .filter(path => /\.(sol|toml|txt)$/.test(path) && !/^(out|cache|broadcast)[/\\]/.test(path)).sort();
const manifest = Object.fromEntries(paths.map(path => {
  const source = readFileSync(join(root, 'contracts', path));
  const copy = readFileSync(join(buildRoot, 'contracts', path));
  if (!source.equals(copy)) throw new Error(`Staged source differs: ${path}`);
  return [path.replaceAll('\\', '/'), createHash('sha256').update(source).digest('hex')];
}));
writeFileSync(join(logRoot, 'source-sha256.json'), JSON.stringify(manifest, null, 2) + '\n');
const verificationFiles = ['package.json', 'package-lock.json',
  ...readdirSync(join(root, 'scripts'), { recursive: true }).filter(path => path.endsWith('.mjs')).map(path => `scripts/${path}`),
  ...readdirSync(join(root, 'docs/storage')).filter(path => path.endsWith('.json')).map(path => `docs/storage/${path}`)].sort();
const verificationManifest = Object.fromEntries(verificationFiles.map(path => {
  const source = readFileSync(join(root, path));
  if (!source.equals(readFileSync(join(buildRoot, path)))) throw new Error(`Validation input differs: ${path}`);
  return [path.replaceAll('\\', '/'), createHash('sha256').update(source).digest('hex')];
}));
writeFileSync(join(logRoot, 'verification-input-sha256.json'), JSON.stringify(verificationManifest, null, 2) + '\n');
const localForge = join(root, '.tools/forge/package/bin/forge.exe');
const forge = process.platform === 'win32' && existsSync(localForge) ? localForge : 'forge';
const env = { ...process.env, FOUNDRY_PROFILE: 'ci', NO_COLOR: '1', VALIDATION_TASK: task,
  VALIDATION_EVIDENCE_ROOT: logRoot };
if (forge === localForge) env.PATH = join(root, '.tools/forge/package/bin') + delimiter + env.PATH;
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const summary = { task, stage: 'contracts', startedAt: new Date().toISOString(), status: 'running',
  sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
  ci: process.env.GITHUB_ACTIONS === 'true' ? { runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB, sha: process.env.GITHUB_SHA } : null,
  buildRoot, node: process.version, profile: 'ci', results: [] };
writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
function run(name, executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? `${result.error.message}\n` : '');
  writeFileSync(join(logRoot, `${name}.log`), output);
  summary.results.push({ name, executable, args, exitCode: result.status ?? 1 });
  if (result.status !== 0) {
    summary.status = 'failed';
    summary.finishedAt = new Date().toISOString();
  }
  writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`${name}: exit ${result.status ?? 1}`);
  console.log(output);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('toolchain', forge, ['--version'], buildRoot);
run('forge-fmt', forge, ['fmt', '--check'], join(buildRoot, 'contracts'));
run('forge-build-sizes', forge, ['build', '--sizes', '--force'], join(buildRoot, 'contracts'));
run('forge-test', forge, ['test', '--no-match-path', 'test/fork/**', '-vv'], join(buildRoot, 'contracts'));
run('upgrade-validation', process.execPath, ['scripts/validate-upgrades.mjs'], buildRoot);
const businessSources = readdirSync(join(buildRoot, 'contracts/src'), { recursive: true }).filter(p => p.endsWith('.sol'));
if (businessSources.length) {
  const localSlither = join(root, '.venv/Scripts/slither.exe');
  run('slither', existsSync(localSlither) ? localSlither : 'slither', [
    '.', '--filter-paths', '../node_modules/|test/|script/', '--fail-medium',
  ], join(buildRoot, 'contracts'));
} else {
  const message = 'NOT APPLICABLE (T0.1): no business Solidity sources for Slither.\n';
  writeFileSync(join(logRoot, 'slither.log'), message);
  console.log(message);
}
summary.status = 'passed';
summary.finishedAt = new Date().toISOString();
writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Logs saved under ${logRoot}`);
