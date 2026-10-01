import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { keccak256 } from '../deploy/node_modules/ethers/lib.esm/index.js';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..');
const hash = body => createHash('sha256').update(body).digest('hex');
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.match(sourceHead, /^[a-f0-9]{40}$/);
const deployOrder = ['ShareCheckpoints', 'SaleSettlement', 'SandboxSalePool'];
const contracts = {};
const auxiliaryContracts = {};
const preview = process.argv.includes('--preview');
for (const name of [...deployOrder, 'SandboxMockMiner']) {
  const path = resolve(root, 'contracts/out', name + '.sol', name + '.json');
  const artifact = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(artifact.metadata.compiler.version.split('+')[0], '0.8.24');
  for (const [sourcePath, metadata] of Object.entries(artifact.metadata.sources)) {
    const absolute = resolve(root, 'contracts', sourcePath);
    const source = await readFile(absolute);
    assert.equal(keccak256(source), metadata.keccak256, `${name}: stale compiler output for ${sourcePath}; rebuild contracts`);
    const repositoryPath = relative(root, absolute).split(sep).join('/');
    if (!preview && /^contracts\/(?:src|sandbox)\//.test(repositoryPath)) {
      assert(source.equals(execFileSync('git', ['show', `${sourceHead}:${repositoryPath}`], { cwd: root })), `${name}: compile input differs from HEAD: ${repositoryPath}`);
    }
  }
  assert(artifact.bytecode.object.startsWith('0x') && artifact.deployedBytecode.object.startsWith('0x'));
  const runtimeBytes = (artifact.deployedBytecode.object.length - 2) / 2;
  assert(runtimeBytes > 0 && runtimeBytes <= 24576, name + ' runtime exceeds EIP-170');
  assert((artifact.bytecode.object.length - 2) / 2 <= 49152, name + ' initcode exceeds EIP-3860');
  const destination = deployOrder.includes(name) ? contracts : auxiliaryContracts;
  destination[name] = {
    abi: artifact.abi, bytecode: artifact.bytecode.object,
    linkReferences: artifact.bytecode.linkReferences ?? {},
    deployedBytecode: artifact.deployedBytecode.object,
    deployedLinkReferences: artifact.deployedBytecode.linkReferences ?? {},
    immutableReferences: artifact.deployedBytecode.immutableReferences ?? {},
    runtimeBytes, artifactSha256: hash(await readFile(path)), compiler: artifact.metadata.compiler,
    compilerSettings: artifact.metadata.settings,
  };
}
const dependencies = new Set(Object.values(contracts).flatMap(contract =>
  Object.values(contract.linkReferences).flatMap(source => Object.keys(source))));
assert.deepEqual([...dependencies].sort(), ['SaleSettlement', 'ShareCheckpoints']);
const sources = [
  'contracts/sandbox/SandboxSalePool.sol', 'contracts/sandbox/SandboxMockMiner.sol',
  'contracts/sandbox/SandboxSaleGovernance.sol', 'contracts/sandbox/generate-governance.mjs',
  'contracts/src/libraries/SaleGovernance.sol', 'contracts/src/libraries/ShareCheckpoints.sol',
  'contracts/src/libraries/SaleSettlement.sol', 'contracts/src/PoolSaleState.sol',
  'contracts/src/PoolVaultState.sol',
  'contracts/foundry.toml', 'contracts/remappings.txt', 'package.json', 'package-lock.json',
];
const sourceSha256 = {};
for (const path of sources) {
  const current = await readFile(resolve(root, path));
  if (!preview) assert(current.equals(execFileSync('git', ['show', `${sourceHead}:${path}`], { cwd: root })), `${path} differs from source HEAD`);
  sourceSha256[path] = hash(current);
}
const body = {
  schemaVersion: 1, kind: 'bemine-mainnet-sale-sandbox', chainId: 56, sourceHead,
  sourceRepository: 'https://github.com/jianfengliao774-sketch/pinkuang',
  simulationOnly: true, sourceBound: !preview, buildMode: preview ? 'preview' : 'source-bound',
  timings: { proposeWaitSeconds: 60, voteSeconds: 300, listingSeconds: 900 },
  maxSimulatedSaleWei: '1000000000000000',
  deployOrder, contracts, auxiliaryContracts, sourceSha256,
  productionExcludedAddresses: [
    '0xd81dBD0E622447D26405B3576F0C3Fd698AF01B8',
    '0xc72016011AA2E16Ff48f864f35BAd34CB0Bb21Dc',
    '0xE145e352889Fa14BF59205843044B0744F123f39',
    '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',
    '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
    '0x33423244F9a5bF81b12B1a018aF6F4e079B97f29',
  ],
  coverage: 'Production governance and sale settlement cores with short timing, simulated ERC721 and native BNB; excludes production Authority relay, Firsto exchange and mining rewards.',
};
await mkdir(resolve(here, 'public'), { recursive: true });
const out = resolve(here, 'public/sale-sandbox-artifacts.json');
await writeFile(out, JSON.stringify(body, null, 2) + '\n');
console.log(JSON.stringify({ sourceHead, output: out, contracts: Object.fromEntries(Object.entries(contracts).map(([name, contract]) => [name, { runtimeBytes: contract.runtimeBytes, links: contract.linkReferences }])) }));
