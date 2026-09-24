import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { keccak256 } = require('ethereum-cryptography/keccak');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const keccak = value => `0x${Buffer.from(keccak256(value)).toString('hex')}`;
const expectedLibraries = ['BurnOperations', 'MiningOperations', 'PoolFunds', 'PurchaseValidation', 'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints'];
const mining = '0x7e2e0dc66a3bd9103e69b766afa62d9f7b697b46';

function readArtifact(root, name) {
  const path = `contracts/out/${name}.sol/${name}.json`;
  const bytes = readFileSync(join(root, path));
  const artifact = JSON.parse(bytes.toString('utf8'));
  const metadata = typeof artifact.metadata === 'string'
    ? JSON.parse(artifact.metadata) : artifact.metadata ?? JSON.parse(artifact.rawMetadata);
  assert(metadata?.sources, `Missing compiler source metadata: ${path}`);
  return { path, artifact, metadata, artifactSha256: sha256(bytes) };
}

function sourceEvidence(root, sourcePath, metadata) {
  const path = `contracts/${sourcePath}`;
  const bytes = readFileSync(join(root, path));
  const expected = metadata.sources[sourcePath]?.keccak256;
  assert(/^0x[0-9a-f]{64}$/i.test(expected ?? ''), `Missing compiler source hash: ${sourcePath}`);
  assert.equal(keccak(bytes), expected.toLowerCase(), `Source differs from its compiled artifact: ${path}`);
  return { path, sourceSha256: sha256(bytes), compilerMetadataKeccak256: expected.toLowerCase() };
}

function templateEvidence(bytecode, label) {
  assert(typeof bytecode?.object === 'string' && bytecode.object.length > 2, `Missing bytecode: ${label}`);
  assert(bytecode.object.startsWith('0x'), `Unexpected bytecode representation: ${label}`);
  return {
    sha256: sha256(bytecode.object),
    hashDefinition: 'SHA-256 of the exact UTF-8 artifact bytecode.object string, including 0x and any placeholders.',
    byteLength: (bytecode.object.length - 2) / 2,
    isDeployedCodeHash: false,
  };
}

function vaultLinks(bytecode, label) {
  const references = bytecode?.linkReferences;
  assert(references && typeof references === 'object', `Missing linkReferences: ${label}`);
  const links = [];
  for (const [source, contracts] of Object.entries(references)) {
    for (const [name, positions] of Object.entries(contracts)) {
      assert(expectedLibraries.includes(name), `Unexpected linked library: ${source}:${name}`);
      assert.equal(source, `src/libraries/${name}.sol`, `Unexpected library source: ${source}`);
      assert(Array.isArray(positions) && positions.length > 0, `Empty link references: ${name}`);
      const expectedPlaceholder = `__$${keccak(Buffer.from(`${source}:${name}`)).slice(2, 36)}$__`;
      for (const position of positions) {
        assert(Number.isSafeInteger(position.start) && position.start >= 0 && position.length === 20,
          `Invalid library address location: ${name}`);
        const placeholder = bytecode.object.slice(2 + position.start * 2, 2 + (position.start + 20) * 2);
        assert.equal(placeholder, expectedPlaceholder, `Missing or incorrectly linked template placeholder: ${name}`);
      }
      links.push({ source, name, positions, placeholder: expectedPlaceholder });
    }
  }
  assert.deepEqual(links.map(link => link.name).sort(), expectedLibraries,
    `${label} must link exactly the reviewed production libraries`);
  return links;
}

function* walkAst(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.nodeType === 'string') yield value;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const entry of child) yield* walkAst(entry);
    } else if (child && typeof child === 'object') yield* walkAst(child);
  }
}

// This gate examines compiler AST nodes, not source-text regexes. Its scope is
// deliberately the listed production library source units, not a general security audit.
function reviewLibraryAst(name, artifact) {
  assert.equal(artifact.ast?.absolutePath, `src/libraries/${name}.sol`, `Wrong source AST: ${name}`);
  const definitions = artifact.ast.nodes.filter(node => node.nodeType === 'ContractDefinition' && node.name === name);
  assert.equal(definitions.length, 1, `Missing or duplicate library definition: ${name}`);
  const library = definitions[0];
  assert.equal(library.contractKind, 'library', `${name} is not a Solidity library`);
  assert.deepEqual(library.baseContracts, [], `Library inheritance changed: ${name}`);
  assert(Array.isArray(artifact.storageLayout?.storage), `Missing storage layout: ${name}`);
  assert.equal(artifact.storageLayout.storage.length, 0, `Library has ordinary storage: ${name}`);
  const state = library.nodes.filter(node => node.nodeType === 'VariableDeclaration' && node.stateVariable);
  assert(state.every(node => node.constant === true), `Library has mutable state declarations: ${name}`);
  for (const part of ['bytecode', 'deployedBytecode']) {
    assert.deepEqual(artifact[part]?.linkReferences, {}, `Unexpected nested external library: ${name}`);
  }
  const rawCalls = [];
  for (const node of walkAst(library)) {
    if (node.nodeType === 'Identifier') {
      assert(!['selfdestruct', 'suicide'].includes(node.name), `Destructive builtin in ${name}`);
    }
    // Inspect the access itself, including call-options syntax or a saved function
    // reference; checking only the outer FunctionCall would miss those forms.
    if (node.nodeType === 'MemberAccess') {
      assert(!['delegatecall', 'callcode'].includes(node.memberName), `Explicit delegation in ${name}`);
      if (node.memberName === 'call') {
        const target = node.expression;
        const declaration = state.find(node => node.id === target.referencedDeclaration);
        if (name === 'MiningOperations') {
          assert(target.nodeType === 'Identifier' && target.name === 'MINING'
            && declaration?.constant && declaration.value?.value?.toLowerCase() === mining,
          `Unexpected raw CALL target in ${name}`);
          rawCalls.push({ target: 'MINING', address: mining, sourceLocation: node.src });
        } else {
          assert(name === 'PoolFunds' && target.nodeType === 'MemberAccess' && target.memberName === 'sender'
            && target.expression?.nodeType === 'Identifier' && target.expression.name === 'msg',
          `Unexpected raw CALL target in ${name}`);
          rawCalls.push({ target: 'msg.sender', purpose: 'Original caller pulls its already-cleared BNB credit under Vault nonReentrant.', sourceLocation: node.src });
        }
      }
    }
    if (node.nodeType === 'YulFunctionCall') {
      assert(!['selfdestruct', 'suicide', 'delegatecall', 'callcode', 'call'].includes(node.functionName.name),
        `Unreviewed assembly external call or destructive operation in ${name}`);
    }
  }
  assert.equal(rawCalls.length, ['MiningOperations', 'PoolFunds'].includes(name) ? 1 : 0, `Raw CALL surface changed: ${name}`);
  return { compilerAstChecked: true, inheritance: [], ordinaryStorageFields: 0,
    mutableStateDeclarations: 0, explicitDelegatecallOrCallcode: false, selfdestruct: false, rawCalls,
    scope: 'Own library source AST only; Vault entry-point guards and dependency behavior require separate review/tests.' };
}

/**
 * Record exactly which external libraries a compiled PoolVault requires.
 * This does not assert anything about deployed library addresses or extcodehash.
 */
export default function auditLinkedLibraries(root, logRoot) {
  const projectRoot = resolve(root);
  const evidenceRoot = resolve(logRoot);
  const vault = readArtifact(projectRoot, 'PoolVault');
  const vaultSource = sourceEvidence(projectRoot, 'src/PoolVault.sol', vault.metadata);
  const creationLinks = vaultLinks(vault.artifact.bytecode, 'PoolVault creation bytecode');
  const runtimeLinks = vaultLinks(vault.artifact.deployedBytecode, 'PoolVault runtime bytecode');
  const libraries = expectedLibraries.map(name => {
    const compiled = readArtifact(projectRoot, name);
    const source = sourceEvidence(projectRoot, `src/libraries/${name}.sol`, compiled.metadata);
    // The same source must be the library dependency compiled into Vault's metadata.
    sourceEvidence(projectRoot, `src/libraries/${name}.sol`, vault.metadata);
    return { name, source, artifactPath: compiled.path, artifactSha256: compiled.artifactSha256,
      compilerVersion: compiled.metadata.compiler?.version,
      runtimeBytecodeTemplate: templateEvidence(compiled.artifact.deployedBytecode, name),
      astReview: reviewLibraryAst(name, compiled.artifact) };
  });
  const audit = { schemaVersion: 1, generatedAt: new Date().toISOString(), ok: true,
    vault: { source: vaultSource, artifactPath: vault.path, artifactSha256: vault.artifactSha256,
      runtimeBytecodeTemplate: templateEvidence(vault.artifact.deployedBytecode, 'PoolVault'),
      creationLinks, runtimeLinks }, libraries,
    context: {
      execution: 'Solidity linked-library calls execute by DELEGATECALL in the guarded Vault context.',
      reentrancy: 'Vault owns the nonReentrant entry points. Libraries have no independent reentrancy lock or Vault callback.',
      upgradeValidationException: 'PoolVault permits only external-library-linking; this does not skip storage validation.',
      limitations: 'Compiler templates are not deployed code hashes. Vault link placeholders remain unlinked; a library runtime template also has its own-address deployment fixup. Deployment must separately verify each linked address and runtime code.',
    },
  };
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, 'library-link-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  console.log(`PASS: PoolVault links exactly ${expectedLibraries.length} reviewed libraries; source hashes, unlinked templates and scoped AST gates recorded.`);
  return audit;
}
