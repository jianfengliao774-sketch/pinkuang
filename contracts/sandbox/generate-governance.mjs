import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const sourcePath = new URL('../src/libraries/SaleGovernance.sol', import.meta.url);
const outputPath = new URL('./SandboxSaleGovernance.sol', import.meta.url);
export function sandboxGovernance(source) {
  const changes = [
    ['"../PoolSaleState.sol"', '"../src/PoolSaleState.sol"'],
    ['library SaleGovernance {', 'library SandboxSaleGovernance {'],
    ['PROPOSE_INTERVAL = 7 days;', 'PROPOSE_INTERVAL = 60 seconds;'],
    ['VOTE_DURATION = 1 days;', 'VOTE_DURATION = 5 minutes;'],
    ['LISTING_DURATION = 7 days;', 'LISTING_DURATION = 15 minutes;'],
  ];
  let generated = source;
  for (const [from, to] of changes) {
    if (generated.split(from).length !== 2) throw new Error(`Expected one production source fragment: ${from}`);
    generated = generated.replace(from, to);
  }
  const split = generated.indexOf('library SandboxSaleGovernance {');
  const body = generated.slice(split);
  let count = 0;
  const internal = body.replace(/(\)\s+)external\b/g, (_match, before) => { count++; return `${before}internal`; });
  if (count !== 6) throw new Error('The six production governance entry points changed; review the sandbox generator.');
  return generated.slice(0, split) + internal;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const generated = sandboxGovernance(await readFile(sourcePath, 'utf8'));
  if (process.argv.includes('--check')) {
    if (await readFile(outputPath, 'utf8') !== generated) throw new Error('Sandbox governance differs from its reviewed source transformation.');
  } else await writeFile(outputPath, generated);
}
