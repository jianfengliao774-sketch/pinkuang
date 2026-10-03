import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeToolchain } from './foundry.mjs';

// Future rehearsal only. Requires archive state and the production-advertised
// runtime pin; the currently observed code mismatch is intentionally NOT relaxed.
const root = fileURLToPath(new URL('../', import.meta.url));
const block = '125506634';
assert(process.env.BSC_RPC_URL, 'BSC_RPC_URL archive endpoint is required.');
assert.equal(process.env.FIRSTO_BATCH_FORK_BLOCK, block,
  `Explicit FIRSTO_BATCH_FORK_BLOCK=${block} is required; never use current state for the historical order.`);
const evidence = resolve(process.env.VALIDATION_EVIDENCE_ROOT ?? join(root, 'docs/logs/firsto-batch-fork'));
mkdirSync(evidence, { recursive: true });
const paths = readdirSync(join(root, 'contracts'), { recursive: true })
  .filter(path => /\.(sol|toml|txt|json|hex)$/.test(path) && !/^(out|cache|broadcast)[/\\]/.test(path)).sort();
writeFileSync(join(evidence, 'source-sha256.json'), JSON.stringify(Object.fromEntries(paths.map(path => [
  path.replaceAll('\\', '/'), createHash('sha256').update(readFileSync(join(root, 'contracts', path))).digest('hex'),
])), null, 2) + '\n');
const { executable, env } = forgeToolchain(root, { env: { ...process.env, FOUNDRY_PROFILE: 'ci', NO_COLOR: '1' } });
const args = ['test', '--root', join(root, 'contracts'), '--match-path', 'test/fork/FirstoBatchPoolFork.t.sol',
  '--fork-url', 'bsc', '--fork-block-number', block, '--threads', '1', '--compute-units-per-second', '50',
  '--fork-retries', '1', '--fork-retry-backoff', '2000', '-vv'];
const startedAt = new Date().toISOString();
const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const output = ((result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? ''))
  .replaceAll(process.env.BSC_RPC_URL, '[BSC_RPC_URL]');
const passed = result.status === 0 && /(?<!\d)1 tests passed, 0 failed, 0 skipped/.test(output) && !/\[SKIP/.test(output);
writeFileSync(join(evidence, 'firsto-batch-fork.log'), output);
writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
  status: passed ? 'passed' : 'failed', exitCode: result.status ?? 1, chainId: 56, forkBlock: Number(block),
  expected: { passed: 1, failed: 0, skipped: 0 }, runtimePinRelaxed: false,
  scope: 'Historical public per-leaf batch purchase into a local project; requires verified protocol runtime and archive state.',
}, null, 2) + '\n');
console.log(output);
if (!passed) process.exitCode = 1;
