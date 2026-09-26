import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { outputPath, verifiedBuildDigest } from '../../deploy/scripts/build-artifacts.mjs';

// Recompile first: a digest read from the same untrusted JSON is not source verification.
const digest = verifiedBuildDigest();
const artifacts = JSON.parse(readFileSync(outputPath, 'utf8')).artifacts;
const document = {
  schemaVersion: 1,
  chainId: '56',
  artifactDigest: digest,
  abis: Object.fromEntries(['PoolFactory', 'PoolLens', 'PoolVault', 'ShareMarket'].map(name => [name, artifacts[name].abi])),
};
const destination = fileURLToPath(new URL('../lib/contracts.generated.json', import.meta.url));
if (process.argv.includes('--check')) {
  assert.deepEqual(JSON.parse(readFileSync(destination, 'utf8')), document, 'Web ABI is stale. Run pnpm contracts:sync.');
  console.log(`Web ABI matches verified contract sources (${digest}).`);
} else {
  writeFileSync(destination, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Generated web ABI from verified sources (${digest}).`);
}
