import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const block = process.env.FORK_BLOCK;
if (!process.env.BSC_RPC_URL || !/^[1-9]\d*$/.test(block ?? '')) {
  console.error('BSC_RPC_URL and a fixed positive FORK_BLOCK are required. Never default to latest.');
  process.exit(1);
}
if (!existsSync(`${root}/contracts/test/fork/ProtocolProbe.t.sol`)) {
  console.error('T0.2 ProtocolProbe.t.sol is not implemented. Fork verification is NOT passed.');
  process.exit(1);
}
console.log(`Fork block: ${block}`);
const result = spawnSync('forge', [
  'test', '--root', 'contracts', '--match-path', 'test/fork/**',
  '--fork-url', 'bsc', '--fork-block-number', block, '-vv',
], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
