import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { keccak256, toUtf8Bytes } from 'ethers';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const outputPath = join(repositoryRoot, 'deploy/public/deployment-artifacts.json');
export const libraryNames = Object.freeze([
  'FlexiblePurchase', 'MiningOperations', 'PoolFunds', 'PurchaseValidation',
  'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints',
]);
export const requiredContracts = Object.freeze([
  ...libraryNames, 'AtomicDeployment', 'PoolVault', 'PoolFactory', 'ShareMarket',
  'PoolBeacon', 'PoolTimelock', 'ERC1967Proxy',
]);
export const compilerSettings = Object.freeze({
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'shanghai',
  viaIR: false,
  outputSelection: {
    '*': {
      '*': [
        'abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences',
        'evm.deployedBytecode.object', 'evm.deployedBytecode.linkReferences',
        'evm.deployedBytecode.immutableReferences',
      ],
    },
  },
});

const sha256 = content => createHash('sha256').update(content).digest('hex');
const sortedObject = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')));

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.sol')) yield path;
  }
}

/** Reject silent drift from the reviewed Foundry compiler and dependency versions. */
export function verifyBuildConfiguration(root = repositoryRoot) {
  assert.match(solc.version(), /^0\.8\.24\+commit\.e11b9ed9\./, 'Install the pinned solc 0.8.24 compiler.');
  const config = readFileSync(join(root, 'contracts/foundry.toml'), 'utf8');
  const defaultProfile = config.match(/^\[profile\.default\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  assert(defaultProfile, 'Missing [profile.default] in contracts/foundry.toml.');
  const expected = {
    solc_version: '"0.8.24"', evm_version: '"shanghai"', optimizer: 'true',
    optimizer_runs: '200', via_ir: 'false',
  };
  for (const [key, value] of Object.entries(expected)) {
    const matches = [...defaultProfile.matchAll(new RegExp(`^${key}\\s*=\\s*([^#\\r\\n]+)`, 'gm'))];
    assert.equal(matches.length, 1, `Expected one ${key} setting in contracts/foundry.toml.`);
    assert.equal(matches[0][1].trim(), value, `Foundry ${key} changed; review browser artifacts before building.`);
  }
  for (const name of ['contracts', 'contracts-upgradeable']) {
    const dependency = JSON.parse(readFileSync(join(root, 'node_modules/@openzeppelin', name, 'package.json'), 'utf8'));
    assert.equal(dependency.version, '5.0.2', `@openzeppelin/${name} must be 5.0.2.`);
  }
}

function dependencies(artifact) {
  const names = new Set();
  for (const references of [artifact.linkReferences, artifact.deployedLinkReferences]) {
    for (const contracts of Object.values(references ?? {})) {
      for (const name of Object.keys(contracts)) names.add(name);
    }
  }
  return [...names].sort();
}

/** Topological order only describes compiler links; AtomicDeployment has runtime binding requirements too. */
export function linkedDeploymentOrder(artifacts) {
  const visited = new Set();
  const visiting = new Set();
  const order = [];
  function visit(name) {
    assert(artifacts[name], `Missing artifact for linked dependency ${name}.`);
    assert(!visiting.has(name), `Circular library link dependency: ${name}.`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of dependencies(artifacts[name])) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  }
  for (const name of Object.keys(artifacts).sort()) visit(name);
  return order;
}

function verifyBytecode(template, references, label) {
  assert.match(template, /^0x(?:[0-9a-f]{2}|__\$[0-9a-f]{34}\$__)+$/i, `Invalid bytecode template: ${label}.`);
  assert(template.length > 2 && template.length % 2 === 0, `Empty or malformed bytecode: ${label}.`);
  let linked = template;
  const occupied = new Set();
  for (const [source, contracts] of Object.entries(references)) {
    for (const [name, positions] of Object.entries(contracts)) {
      assert.equal(source, `src/libraries/${name}.sol`, `Unexpected linked source ${source}.`);
      assert(libraryNames.includes(name), `Unreviewed linked library ${name}.`);
      assert(positions.length > 0, `Empty link references for ${name}.`);
      for (const { start, length } of positions) {
        assert(Number.isSafeInteger(start) && start >= 0 && length === 20, `Invalid link offset: ${label}/${name}.`);
        assert(2 + (start + length) * 2 <= template.length, `Link beyond bytecode: ${label}/${name}.`);
        assert.match(template.slice(2 + start * 2, 2 + (start + length) * 2), /^__\$[0-9a-f]{34}\$__$/, `Missing link placeholder: ${label}/${name}.`);
        for (let offset = start; offset < start + length; offset += 1) {
          assert(!occupied.has(offset), `Overlapping link references: ${label}/${name}.`);
          occupied.add(offset);
        }
        linked = `${linked.slice(0, 2 + start * 2)}${'11'.repeat(length)}${linked.slice(2 + (start + length) * 2)}`;
      }
    }
  }
  assert.match(linked, /^0x[0-9a-f]+$/i, `Unaccounted placeholder in ${label}.`);
}

export function validateArtifacts(artifacts) {
  assert.deepEqual(Object.keys(artifacts).sort(), [...requiredContracts].sort(), 'Deployment artifact inventory changed.');
  for (const [name, artifact] of Object.entries(artifacts)) {
    assert.equal(artifact.contractName, name);
    assert(Array.isArray(artifact.abi) && artifact.abi.length > 0, `Missing ABI: ${name}.`);
    verifyBytecode(artifact.bytecode, artifact.linkReferences, `${name} initcode`);
    verifyBytecode(artifact.deployedBytecode, artifact.deployedLinkReferences, `${name} runtime`);
    const initcodeBytes = (artifact.bytecode.length - 2) / 2;
    const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
    assert(initcodeBytes <= 49_152, `${name} exceeds the EIP-3860 initcode limit.`);
    assert(runtimeBytes <= 24_576, `${name} exceeds the EIP-170 runtime limit.`);
    for (const slots of Object.values(artifact.immutableReferences)) {
      for (const { start, length } of slots) {
        assert(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(length) && length > 0
          && start + length <= runtimeBytes, `Invalid immutable location: ${name}.`);
      }
    }
  }
  for (const name of libraryNames) assert.deepEqual(dependencies(artifacts[name]), name === 'FlexiblePurchase' ? ['PoolFunds', 'PurchaseValidation'] : [], `${name} has an unexpected external-library dependency.`);
  assert.deepEqual(dependencies(artifacts.PoolVault), libraryNames.filter(name => name !== 'PurchaseValidation'), 'PoolVault direct links differ from the reviewed dependency graph.');
  linkedDeploymentOrder(artifacts);
}

export function compileDeploymentArtifacts({ root = repositoryRoot } = {}) {
  verifyBuildConfiguration(root);
  const contractsRoot = join(root, 'contracts');
  const sources = {};
  const sourceHashes = {};
  for (const path of sourceFiles(join(contractsRoot, 'src'))) {
    const name = relative(contractsRoot, path).split(sep).join('/');
    const content = readFileSync(path, 'utf8');
    sources[name] = { content };
    sourceHashes[name] = sha256(content);
  }
  const input = { language: 'Solidity', sources, settings: compilerSettings };
  const compiled = JSON.parse(solc.compile(JSON.stringify(input), {
    import(name) {
      // Resolve only the pinned OpenZeppelin packages; never fetch imports from the network.
      if (!/^@openzeppelin\/(contracts|contracts-upgradeable)\/[A-Za-z0-9_./-]+\.sol$/.test(name)
        || name.split('/').includes('..')) return { error: `Unsupported import: ${name}` };
      try {
        const contents = readFileSync(join(root, 'node_modules', name), 'utf8');
        sourceHashes[name] = sha256(contents);
        return { contents };
      } catch (error) {
        return { error: `Cannot resolve ${name}: ${error.message}` };
      }
    },
  }));
  const errors = (compiled.errors ?? []).filter(error => error.severity === 'error');
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  const artifacts = {};
  for (const contractName of requiredContracts) {
    const sourceName = contractName === 'ERC1967Proxy'
      ? '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol'
      : `src/${libraryNames.includes(contractName) ? 'libraries/' : ''}${contractName}.sol`;
    const contract = compiled.contracts?.[sourceName]?.[contractName];
    assert(contract, `Compiler did not emit ${sourceName}:${contractName}.`);
    const { bytecode, deployedBytecode } = contract.evm;
    artifacts[contractName] = {
      contractName, sourceName, abi: contract.abi,
      bytecode: `0x${bytecode.object}`, deployedBytecode: `0x${deployedBytecode.object}`,
      linkReferences: bytecode.linkReferences ?? {},
      deployedLinkReferences: deployedBytecode.linkReferences ?? {},
      immutableReferences: deployedBytecode.immutableReferences ?? {},
    };
  }
  validateArtifacts(artifacts);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.match(sourceCommit, /^[0-9a-f]{40,64}$/, 'Missing source repository commit.');
  return {
    schemaVersion: 1, compilerVersion: solc.version(), sourceCommit,
    settings: compilerSettings, sourceHashes: sortedObject(sourceHashes),
    artifacts: sortedObject(artifacts),
  };
}

export function assertCurrentArtifacts(saved, current) {
  assert.match(saved.sourceCommit ?? '', /^[0-9a-f]{40,64}$/, 'Saved artifact has no source commit.');
  // Committing the generated file advances HEAD. Source hashes and compiler output, not
  // the surrounding Git commit, determine whether the generated bytes are still current.
  const { sourceCommit: savedCommit, ...savedContent } = saved;
  const { sourceCommit: currentCommit, ...currentContent } = current;
  assert.deepEqual(savedContent, currentContent, 'Deployment artifacts are stale or modified. Run npm run artifacts in deploy/.');
}

function canonicalContent(value) {
  if (Array.isArray(value)) return value.map(canonicalContent);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalContent(value[key])]));
  return value;
}

/** Git provenance is informational; all compiler inputs and ABI/code bytes are bound. */
export function artifactContentDigest(document) {
  const { sourceCommit: _commit, ...content } = document;
  return keccak256(toUtf8Bytes(JSON.stringify(canonicalContent(content))));
}

/** Called by Vite in Node, never by a browser or from a downloaded hash document. */
export function verifiedBuildDigest() {
  const compiled = compileDeploymentArtifacts();
  const saved = JSON.parse(readFileSync(outputPath, 'utf8'));
  assertCurrentArtifacts(saved, compiled);
  return artifactContentDigest(compiled);
}

function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'Usage: node scripts/build-artifacts.mjs [--check]');
  const document = compileDeploymentArtifacts();
  if (args[0] === '--check') {
    assertCurrentArtifacts(JSON.parse(readFileSync(outputPath, 'utf8')), document);
    console.log('Deployment artifacts match all local sources, dependencies and compiler settings.');
    return;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Built ${requiredContracts.length} deployment artifacts from ${Object.keys(document.sourceHashes).length} sources (${document.compilerVersion}).`);
  console.log(`Runtime bytes: ${Object.values(document.artifacts).map(artifact => `${artifact.contractName} ${(artifact.deployedBytecode.length - 2) / 2}`).join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
