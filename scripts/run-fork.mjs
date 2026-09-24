import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.env.VALIDATION_TASK ?? 'T1d';
if (!/^T\d+(?:[a-z]|\.\d+)?$/i.test(task)) throw new Error('Invalid VALIDATION_TASK');
const pinnedBlock = '123728000';
if (!process.env.BSC_RPC_URL || process.env.FORK_BLOCK !== pinnedBlock) {
  console.error(`BSC_RPC_URL and FORK_BLOCK=${pinnedBlock} are required. A different block requires new fixtures/evidence.`);
  process.exit(1);
}
let buildRoot = root;
// Native solc 0.8.24 on Windows cannot resolve this workspace's Unicode paths.
if (process.platform === 'win32' && /[^\x00-\x7f]/.test(root)) {
  if (/[^\x00-\x7f]/.test(tmpdir())) throw new Error('Set TEMP to an ASCII path before running.');
  buildRoot = mkdtempSync(join(tmpdir(), 'tapeout-fork-'));
  for (const path of ['contracts', 'node_modules', 'scripts', 'docs/storage', 'package.json', 'package-lock.json']) {
    cpSync(join(root, path), join(buildRoot, path), {
      recursive: true,
      filter: source => !['contracts/out', 'contracts/cache', 'contracts/broadcast'].some(
        part => source.replaceAll('\\', '/').includes(`/${part}`),
      ),
    });
  }
}
const logRoot = resolve(process.env.VALIDATION_EVIDENCE_ROOT ?? join(root, 'docs/logs', task, 'fork'));
mkdirSync(logRoot, { recursive: true });
const paths = readdirSync(join(root, 'contracts'), { recursive: true })
  .filter(path => /\.(sol|toml|txt|json)$/.test(path) && !/^(out|cache|broadcast)[/\\]/.test(path)).sort();
const manifest = Object.fromEntries(paths.map(path => {
  const source = readFileSync(join(root, 'contracts', path));
  if (!source.equals(readFileSync(join(buildRoot, 'contracts', path)))) throw new Error(`Copy differs: ${path}`);
  return [path.replaceAll('\\', '/'), createHash('sha256').update(source).digest('hex')];
}));
writeFileSync(join(logRoot, 'source-sha256.json'), JSON.stringify(manifest, null, 2) + '\n');
const bundledForge = join(root, '.tools/forge/package/bin/forge.exe');
const forge = process.platform === 'win32' && existsSync(bundledForge) ? bundledForge : 'forge';
const env = { ...process.env, FOUNDRY_PROFILE: 'ci', NO_COLOR: '1', VALIDATION_TASK: task,
  VALIDATION_EVIDENCE_ROOT: logRoot };
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const summary = { task, stage: 'fork', startedAt: new Date().toISOString(), status: 'running',
  sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
  ci: process.env.GITHUB_ACTIONS === 'true' ? { runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB, sha: process.env.GITHUB_SHA } : null,
  forkBlock: Number(pinnedBlock), chainId: 56, buildRoot, node: process.version, profile: 'ci', results: [] };
writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
function run(name, args) {
  console.log(`Running ${name} at BSC block ${pinnedBlock}...`);
  const result = spawnSync(forge, args, {
    cwd: join(buildRoot, 'contracts'), env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? `${result.error.message}\n` : '');
  writeFileSync(join(logRoot, `${name}.log`), output.replaceAll(process.env.BSC_RPC_URL, '[BSC_RPC_URL]'));
  summary.results.push({ name, args, exitCode: result.status ?? 1 });
  if (result.status !== 0) {
    summary.status = 'failed';
    summary.finishedAt = new Date().toISOString();
  }
  writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(output.replaceAll(process.env.BSC_RPC_URL, '[BSC_RPC_URL]'));
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('toolchain', ['--version']);
run('forge-fmt', ['fmt', '--check']);
run('forge-build-sizes', ['build', '--sizes', '--force']);
// Public archive RPCs throttle bursty storage reads. Serialize fork tests and
// retain Foundry's provider limiter at a conservative rate; do not skip failures.
run('forge-test', ['test', '--match-path', 'test/fork/**', '--fork-url', 'bsc', '--fork-block-number', pinnedBlock,
  '--threads', '1', '--compute-units-per-second', '50', '-vv']);
summary.status = 'passed';
summary.finishedAt = new Date().toISOString();
writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Fork evidence saved in ${logRoot}`);
