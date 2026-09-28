import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forgeToolchain } from './foundry.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { executable, env } = forgeToolchain(root);
const result = spawnSync(executable, process.argv.slice(2), { env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
if (result.signal) console.error(`Forge terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
