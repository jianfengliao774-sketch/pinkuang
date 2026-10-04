import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, openSync, closeSync, writeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeToolchain } from './foundry.mjs';
import { reviewSlither } from './review-slither.mjs';

// Windows solc 0.8.24 cannot reliably resolve non-ASCII dependency paths.
// Compile an identical snapshot in an ASCII directory, preserving all logs at source.
const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.argv[2] ?? process.env.VALIDATION_TASK ?? 'T1e';
if (!/^T\d+(?:[a-z]|\.\d+)?$/i.test(task)) throw new Error('Invalid validation task name');
const logRoot = resolve(process.env.VALIDATION_EVIDENCE_ROOT ?? join(root, 'docs/logs', task, 'contracts'));
mkdirSync(logRoot, { recursive: true });
let buildRoot = root;
if (process.platform === 'win32' && /[^\x00-\x7f]/.test(root)) {
  if (/[^\x00-\x7f]/.test(tmpdir())) throw new Error('Set TEMP to an ASCII path before checking.');
  buildRoot = mkdtempSync(join(tmpdir(), 'tapeout-check-'));
  for (const path of ['contracts', 'node_modules', 'scripts', 'docs/storage',
    'docs/audits/2026-10-04/create-failed-recovery-slither', 'package.json', 'package-lock.json']) {
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
  ...readdirSync(join(root, 'docs/storage')).filter(path => path.endsWith('.json')).map(path => `docs/storage/${path}`),
  'docs/audits/2026-10-04/create-failed-recovery-slither/reviewed-findings.json',
  'docs/audits/2026-10-04/create-failed-recovery-slither/review.md'].sort();
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
const summary = { task, stage: 'contracts', startedAt: new Date().toISOString(), status: 'running',
  sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
  ci: process.env.GITHUB_ACTIONS === 'true' ? { runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB, sha: process.env.GITHUB_SHA } : null,
  buildRoot, node: process.version, profile: 'ci', results: [] };
writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
async function run(name, executable, args, cwd, review = null) {
  const logPath = join(logRoot, `${name}.log`), startedAt = new Date().toISOString();
  const fd = openSync(logPath, 'w');
  console.log(`::group::${name}`);
  const outcome = await new Promise(resolveRun => {
    let runnerError = null;
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = stream => stream.on('data', chunk => {
      writeSync(fd, chunk);
      if (!process.stdout.write(chunk)) {
        stream.pause(); process.stdout.once('drain', () => stream.resume());
      }
    });
    relay(child.stdout); relay(child.stderr);
    child.on('error', error => {
      runnerError = { code: error.code ?? null, message: error.message };
      writeSync(fd, `${error.message}\n`);
    });
    child.on('close', (code, signal) => resolveRun({ code, signal, runnerError }));
  });
  closeSync(fd);
  const exitCode = Number.isInteger(outcome.code) && outcome.code >= 0 && outcome.code <= 255 ? outcome.code : 1;
  const result = { name, executable, args, exitCode, signal: outcome.signal, runnerError: outcome.runnerError,
    startedAt, finishedAt: new Date().toISOString(), logPath };
  let effectiveExitCode = exitCode;
  if (review) {
    try {
      if (outcome.signal || outcome.runnerError) throw new Error('Scanner process did not complete normally.');
      result.review = review(exitCode);
      effectiveExitCode = 0;
    } catch (error) {
      result.review = { status: 'failed', error: error.message };
      effectiveExitCode = exitCode || 1;
      console.error(`Slither review rejected: ${error.message}`);
    }
  }
  summary.results.push(result);
  if (effectiveExitCode !== 0) { summary.status = 'failed'; summary.finishedAt = new Date().toISOString(); }
  writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n${name}: exit ${exitCode}${outcome.signal ? ` (${outcome.signal})` : ''} — ${logPath}`);
  console.log('::endgroup::');
  if (effectiveExitCode !== 0) throw Object.assign(new Error(`${name} failed; inspect ${logPath}`), { exitCode: effectiveExitCode });
}
try {
await run('toolchain', forge, ['--version'], buildRoot);
await run('forge-fmt', forge, ['fmt', '--check'], join(buildRoot, 'contracts'));
await run('forge-build-sizes', forge, ['build', '--sizes', '--force'], join(buildRoot, 'contracts'));
await run('forge-test', forge, ['test', '--no-match-path', 'test/fork/**', '-vv'], join(buildRoot, 'contracts'));
await run('firsto-fork-evidence-regressions', process.execPath, ['--test', 'scripts/firsto-fork-evidence.test.mjs'], root);
await run('upgrade-validation', process.execPath, ['scripts/validate-upgrades.mjs'], buildRoot);
const businessSources = readdirSync(join(buildRoot, 'contracts/src'), { recursive: true }).filter(p => p.endsWith('.sol'));
if (businessSources.length) {
  const localSlither = join(root, '.venv/Scripts/slither.exe');
  await run('slither-review-regressions', process.execPath, ['--test', 'scripts/review-slither.test.mjs'], root);
  const slitherJson = join(logRoot, 'slither.json');
  if (existsSync(slitherJson)) throw new Error(`Use a new evidence directory; Slither report already exists: ${slitherJson}`);
  await run('slither', existsSync(localSlither) ? localSlither : 'slither', [
    '.', '--filter-paths', '../node_modules/|test/|script/', '--fail-medium', '--json', slitherJson,
  ], join(buildRoot, 'contracts'), exitCode => {
    const reviewed = reviewSlither(JSON.parse(readFileSync(slitherJson, 'utf8')), { root: buildRoot, exitCode });
    writeFileSync(join(logRoot, 'slither-review.json'), JSON.stringify(reviewed, null, 2) + '\n');
    console.log(`Reviewed ${reviewed.acceptedMediumFindings.length} exact existing findings; no unreviewed High/Medium. Raw scanner exit ${exitCode} and all findings are retained.`);
    return reviewed;
  });
} else {
  const message = 'NOT APPLICABLE (T0.1): no business Solidity sources for Slither.\n';
  writeFileSync(join(logRoot, 'slither.log'), message);
  console.log(message);
}
summary.status = 'passed';
summary.finishedAt = new Date().toISOString();
writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Logs saved under ${logRoot}`);

} catch (error) {
  summary.status = 'failed';
  summary.finishedAt = new Date().toISOString();
  summary.runnerError = { message: error.message };
  writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.error(error.message);
  // Do not process.exit(): it truncates buffered CI stdout precisely on failure.
  process.exitCode = error.exitCode ?? 1;
}
