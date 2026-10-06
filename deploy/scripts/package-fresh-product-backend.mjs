import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packageFreshProductBackend } from './package-fresh-console.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    assert(process.argv.length === 6 && process.argv[2] === '--input' && process.argv[4] === '--out',
      'Usage: node scripts/package-fresh-product-backend.mjs --input reviewed-cutover-input.json --out <absolute-new-directory>');
    const input = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    for (const key of ['record', 'bundle', 'activation', 'manifest']) {
      assert(typeof input[`${key}Path`] === 'string', `Missing ${key}Path.`);
      input[key] = JSON.parse(readFileSync(input[`${key}Path`], 'utf8'));
    }
    const deployDir = fileURLToPath(new URL('../', import.meta.url));
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: deployDir, encoding: 'utf8' }).trim();
    console.log(JSON.stringify(await packageFreshProductBackend({
      deployDir, outDir: process.argv[5], sourceHead, cutoverInput: input,
    }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
