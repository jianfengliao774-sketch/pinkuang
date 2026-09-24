import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows solc 0.8.24 cannot reliably resolve non-ASCII dependency paths.
// Compile an identical snapshot in an ASCII directory, preserving all logs at source.
const root = fileURLToPath(new URL('../', import.meta.url));
let buildRoot = root;
if (process.platform === 'win32' && /[^\x00-\x7f]/.test(root)) {
  if (/[^\x00-\x7f]/.test(tmpdir())) throw new Error('Set TEMP to an ASCII path before checking.');
  buildRoot = mkdtempSync(join(tmpdir(), 'tapeout-t01-'));
  for (const path of ['contracts', 'node_modules', 'scripts', 'package.json', 'package-lock.json']) {
    cpSync(join(root, path), join(buildRoot, path), {
      recursive: true,
      filter: source => !['contracts/out', 'contracts/cache', 'contracts/broadcast'].some(
        part => source.replaceAll('\\', '/').includes(`/${part}`),
      ),
    });
  }
}
const logRoot = join(root, 'docs/logs/T0.1');
mkdirSync(logRoot, { recursive: true });
const paths = readdirSync(join(root, 'contracts'), { recursive: true })
  .filter(path => /\.(sol|toml|txt)$/.test(path) && !/^(out|cache|broadcast)[/\\]/.test(path)).sort();
const manifest = Object.fromEntries(paths.map(path => {
  const source = readFileSync(join(root, 'contracts', path));
  const copy = readFileSync(join(buildRoot, 'contracts', path));
  if (!source.equals(copy)) throw new Error(`Staged source differs: ${path}`);
  return [path.replaceAll('\\', '/'), createHash('sha256').update(source).digest('hex')];
}));
writeFileSync(join(logRoot, 'source-sha256.json'), JSON.stringify(manifest, null, 2) + '\n');
const localForge = join(root, '.tools/forge/package/bin/forge.exe');
const forge = process.platform === 'win32' && existsSync(localForge) ? localForge : 'forge';
const env = { ...process.env, FOUNDRY_PROFILE: 'ci', NO_COLOR: '1' };
if (forge === localForge) env.PATH = join(root, '.tools/forge/package/bin') + delimiter + env.PATH;
const summary = { buildRoot, node: process.version, profile: 'ci', results: [] };
function run(name, executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? `${result.error.message}\n` : '');
  writeFileSync(join(logRoot, `${name}.log`), output);
  summary.results.push({ name, executable, args, exitCode: result.status ?? 1 });
  writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`${name}: exit ${result.status ?? 1}`);
  console.log(output);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('toolchain', forge, ['--version'], buildRoot);
run('forge-fmt', forge, ['fmt', '--check'], join(buildRoot, 'contracts'));
run('forge-build-sizes', forge, ['build', '--sizes'], join(buildRoot, 'contracts'));
run('forge-test', forge, ['test', '--no-match-path', 'test/fork/**', '-vv'], join(buildRoot, 'contracts'));
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
run('upgrade-validation', process.execPath, ['scripts/validate-upgrades.mjs'], buildRoot);
console.log(`Logs saved under ${logRoot}`);
