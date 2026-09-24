import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = readdirSync(`${root}/contracts/src`, { recursive: true });
if (!sources.some(path => path.endsWith('.sol'))) {
  console.log('NOT APPLICABLE (T0.1): no business implementations or prior storage layout exist.');
  process.exit(0);
}
// This CLI is the validation engine used by openzeppelin-foundry-upgrades.
// Later upgrades MUST supply @custom:oz-upgrades-from/referenceContract baselines.
const result = spawnSync(process.execPath, [
  `${root}/node_modules/@openzeppelin/upgrades-core/dist/cli/cli.js`,
  'validate', 'contracts/out/build-info',
], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
