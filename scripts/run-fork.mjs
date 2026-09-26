import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeToolchain } from './foundry.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.env.VALIDATION_TASK ?? 'T1e';
if (!/^T\d+(?:[a-z]|\.\d+)?$/i.test(task)) throw new Error('Invalid VALIDATION_TASK');
const pinnedBlock = '123728000';
const rpcPolicy = { threads: 1, computeUnitsPerSecond: 50, retries: 10, initialBackoffMs: 2000 };
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
const verificationFiles = ['package.json', 'package-lock.json',
  ...readdirSync(join(root, 'scripts'), { recursive: true }).filter(path => path.endsWith('.mjs')).map(path => `scripts/${path}`),
  ...readdirSync(join(root, 'docs/storage')).filter(path => path.endsWith('.json')).map(path => `docs/storage/${path}`)].sort();
const verificationManifest = Object.fromEntries(verificationFiles.map(path => {
  const source = readFileSync(join(root, path));
  if (!source.equals(readFileSync(join(buildRoot, path)))) throw new Error(`Validation input differs: ${path}`);
  return [path.replaceAll('\\', '/'), createHash('sha256').update(source).digest('hex')];
}));
writeFileSync(join(logRoot, 'verification-input-sha256.json'), JSON.stringify(verificationManifest, null, 2) + '\n');
const { executable: forge, env } = forgeToolchain(root, { env: {
  ...process.env, FOUNDRY_PROFILE: 'ci', NO_COLOR: '1', VALIDATION_TASK: task,
  VALIDATION_EVIDENCE_ROOT: logRoot,
} });
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const summary = { task, stage: 'fork', startedAt: new Date().toISOString(), status: 'running',
  sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
  ci: process.env.GITHUB_ACTIONS === 'true' ? { runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB, sha: process.env.GITHUB_SHA,
    event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF } : null,
  forkBlock: Number(pinnedBlock), chainId: 56, rpcPolicy, buildRoot, node: process.version, profile: 'ci', results: [] };
writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
function run(name, args) {
  console.log(`Running ${name} at BSC block ${pinnedBlock}...`);
  const result = spawnSync(forge, args, {
    cwd: join(buildRoot, 'contracts'), env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? `${result.error.message}\n` : '');
  writeFileSync(join(logRoot, `${name}.log`), output.replaceAll(process.env.BSC_RPC_URL, '[BSC_RPC_URL]'));
  summary.results.push({ name, executable: forge, args, exitCode: result.status ?? 1,
    signal: result.signal, runnerError: result.error ? { code: result.error.code, message: result.error.message } : null });
  if (result.status !== 0) {
    summary.status = 'failed';
    summary.finishedAt = new Date().toISOString();
  }
  writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(output.replaceAll(process.env.BSC_RPC_URL, '[BSC_RPC_URL]'));
  if (result.status !== 0) throw Object.assign(new Error(`${name} failed; inspect ${logRoot}`), { exitCode: result.status ?? 1 });
}
try {
run('toolchain', ['--version']);
run('forge-fmt', ['fmt', '--check']);
run('forge-build-sizes', ['build', '--sizes', '--force']);
// Foundry 1.7.1 forwards these values to Alloy 2.0.1 RetryBackoffLayer: backoff
// is milliseconds, with provider hints/CU offsets; this is not exponential.
// Retries apply only to retryable RPC errors. Exhaustion/test failures still fail
// this single run; no whole-suite reruns or swallowed failures.
run('forge-test', ['test', '--match-path', 'test/fork/**', '--fork-url', 'bsc', '--fork-block-number', pinnedBlock,
  '--threads', String(rpcPolicy.threads), '--compute-units-per-second', String(rpcPolicy.computeUnitsPerSecond),
  '--fork-retries', String(rpcPolicy.retries), '--fork-retry-backoff', String(rpcPolicy.initialBackoffMs), '-vv']);
summary.status = 'passed';
summary.finishedAt = new Date().toISOString();
writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Fork evidence saved in ${logRoot}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
