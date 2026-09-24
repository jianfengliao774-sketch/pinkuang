import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pinnedBlock = '123728000';
if (!process.env.BSC_RPC_URL || process.env.FORK_BLOCK !== pinnedBlock) {
  console.error(`BSC_RPC_URL and FORK_BLOCK=${pinnedBlock} are required. A different block requires new fixtures/evidence.`);
  process.exit(1);
}
let buildRoot = root;
// Native solc 0.8.24 on Windows cannot resolve this workspace's Unicode paths.
if (process.platform === 'win32' && /[^\x00-\x7f]/.test(root)) {
  if (/[^\x00-\x7f]/.test(tmpdir())) throw new Error('Set TEMP to an ASCII path before running.');
  buildRoot = mkdtempSync(join(tmpdir(), 'tapeout-t02-'));
  for (const path of ['contracts', 'node_modules', 'scripts', 'package.json', 'package-lock.json']) {
    cpSync(join(root, path), join(buildRoot, path), {
      recursive: true,
      filter: source => !['contracts/out', 'contracts/cache', 'contracts/broadcast'].some(
        part => source.replaceAll('\\', '/').includes(`/${part}`),
      ),
    });
  }
}
const logRoot = join(root, 'docs/logs/T0.2');
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
const env = { ...process.env, FOUNDRY_PROFILE: 'ci', NO_COLOR: '1' };
const summary = { forkBlock: Number(pinnedBlock), chainId: 56, buildRoot, node: process.version, profile: 'ci', results: [] };
function run(name, args) {
  console.log(`Running ${name} at BSC block ${pinnedBlock}...`);
  const result = spawnSync(forge, args, {
    cwd: join(buildRoot, 'contracts'), env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? `${result.error.message}\n` : '');
  writeFileSync(join(logRoot, `${name}.log`), output.replaceAll(process.env.BSC_RPC_URL, '[BSC_RPC_URL]'));
  summary.results.push({ name, args, exitCode: result.status ?? 1 });
  writeFileSync(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(output.replaceAll(process.env.BSC_RPC_URL, '[BSC_RPC_URL]'));
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('toolchain', ['--version']);
run('forge-fmt', ['fmt', '--check']);
run('forge-build-sizes', ['build', '--sizes']);
run('forge-test', ['test', '--match-path', 'test/fork/**', '--fork-url', 'bsc', '--fork-block-number', pinnedBlock, '-vv']);
console.log(`Fork evidence saved in ${logRoot}`);
