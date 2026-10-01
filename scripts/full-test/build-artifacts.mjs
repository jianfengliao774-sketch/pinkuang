import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from '../../deploy/node_modules/solc/index.js';
import {
  artifactContentDigest, compilerSettings, libraryNames, repositoryRoot, requiredContracts,
  validateArtifacts, verifyBuildConfiguration,
} from '../../deploy/scripts/build-artifacts.mjs';
import { FULL_TEST_TIMINGS, TIMING_TRANSFORMS, ADMINISTRATOR_TRANSFORMS, sha256, sortedObject, transformFullTestSources } from './profile.mjs';

export const outputDirectory = join(repositoryRoot, 'full-test/public');
export const outputPath = join(outputDirectory, 'deployment-artifacts.json');

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.sol')) yield path;
  }
}

export function originalContractSources(root = repositoryRoot) {
  const contractsRoot = join(root, 'contracts');
  return Object.fromEntries([...sourceFiles(join(contractsRoot, 'src'))].map(path => [
    relative(contractsRoot, path).split(sep).join('/'), { content: readFileSync(path, 'utf8') },
  ]));
}

/** Compile the full graph with in-memory substitutions; formal sources/artifacts are never written. */
export function compileFullTestArtifacts({ root = repositoryRoot } = {}) {
  verifyBuildConfiguration(root);
  const originals = originalContractSources(root);
  const sources = transformFullTestSources(originals);
  const originalSourceHashes = Object.fromEntries(Object.entries(originals).map(([name, source]) => [name, sha256(source.content)]));
  const sourceHashes = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha256(source.content)]));
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: compilerSettings }), {
    import(name) {
      if (!/^@openzeppelin\/(contracts|contracts-upgradeable)\/[A-Za-z0-9_./-]+\.sol$/.test(name)
        || name.split('/').includes('..')) return { error: `Unsupported import: ${name}` };
      try {
        const contents = readFileSync(join(root, 'node_modules', name), 'utf8');
        sourceHashes[name] = originalSourceHashes[name] = sha256(contents);
        return { contents };
      } catch (error) { return { error: `Cannot resolve ${name}: ${error.message}` }; }
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
    assert(contract, `Compiler did not emit ${sourceName}:${contractName}`);
    const { bytecode, deployedBytecode } = contract.evm;
    artifacts[contractName] = { contractName, sourceName, abi: contract.abi,
      bytecode: `0x${bytecode.object}`, deployedBytecode: `0x${deployedBytecode.object}`,
      linkReferences: bytecode.linkReferences ?? {}, deployedLinkReferences: deployedBytecode.linkReferences ?? {},
      immutableReferences: deployedBytecode.immutableReferences ?? {} };
  }
  validateArtifacts(artifacts);
  const formal = JSON.parse(readFileSync(join(root, 'deploy/public/deployment-artifacts.json'), 'utf8'));
  for (const name of requiredContracts) assert.deepEqual(artifacts[name].abi, formal.artifacts[name].abi, `${name} ABI changed.`);
  assert.deepEqual(sortedObject(originalSourceHashes), formal.sourceHashes, 'Formal baseline is stale; review before creating test profile.');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { schemaVersion: 1, compilerVersion: solc.version(), sourceCommit, settings: compilerSettings,
    metadata: { profile: 'full-test', kind: 'bemine-full-mainnet-test', chainId: 56,
      timings: FULL_TEST_TIMINGS, deploymentKind: 'integrated-v2', bootstrapTransactionCount: 16,
      authorityActivationTransactionCount: 7, assets: 'official-protocols',
      formalArtifactDigest: artifactContentDigest(formal),
      timingTransforms: TIMING_TRANSFORMS, administratorMode: 'single', administratorTransforms: ADMINISTRATOR_TRANSFORMS,
      warning: 'Independent test contracts. Mandatory holding/cooldown/upgrade waits are disabled; voting, reviews, authorization and expiry remain unchanged.' },
    originalSourceHashes: sortedObject(originalSourceHashes), sourceHashes: sortedObject(sourceHashes), artifacts: sortedObject(artifacts) };
}

export function writeFullTestArtifacts(document) {
  const digest = artifactContentDigest(document);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  const formalWeb = JSON.parse(readFileSync(join(repositoryRoot, 'web/lib/contracts.generated.json'), 'utf8'));
  const generatedWeb = { ...formalWeb, artifactDigest: digest, metadata: document.metadata,
    abis: Object.fromEntries(Object.keys(formalWeb.abis).map(name => [name, document.artifacts[name]?.abi ?? formalWeb.abis[name]])) };
  writeFileSync(join(outputDirectory, 'contracts.generated.json'), `${JSON.stringify(generatedWeb, null, 2)}\n`);
  return digest;
}

/** Build-time pin: compare compiler output, never trust a downloaded digest document. */
export function verifiedFullTestBuildDigest() {
  const current = compileFullTestArtifacts();
  const saved = JSON.parse(readFileSync(outputPath, 'utf8'));
  const { sourceCommit: _saved, ...savedContent } = saved;
  const { sourceCommit: _current, ...currentContent } = current;
  assert.deepEqual(savedContent, currentContent, 'Full-test artifacts are stale or modified.');
  return artifactContentDigest(current);
}

function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'Usage: node scripts/full-test/build-artifacts.mjs [--check]');
  const document = compileFullTestArtifacts();
  if (args[0] === '--check') {
    const saved = JSON.parse(readFileSync(outputPath, 'utf8'));
    const { sourceCommit: _saved, ...savedContent } = saved;
    const { sourceCommit: _current, ...currentContent } = document;
    assert.deepEqual(savedContent, currentContent, 'Full-test artifacts are stale or modified.');
    console.log(`Full-test artifact inputs/output match ${artifactContentDigest(document)}.`);
  } else {
    const digest = writeFullTestArtifacts(document);
    console.log(`Built ${requiredContracts.length} full-test artifacts (${TIMING_TRANSFORMS.length} exact substitutions), digest ${digest}.`);
    console.log(`Runtime bytes: ${Object.values(document.artifacts).map(a => `${a.contractName} ${(a.deployedBytecode.length - 2) / 2}`).join(', ')}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
