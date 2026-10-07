import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, solcInputOutputDecoder, getContractVersion, getStorageLayout, getStorageUpgradeReport } from '@openzeppelin/upgrades-core';
import { validateUpgradeSafety } from '@openzeppelin/upgrades-core/dist/cli/validate/validate-upgrade-safety.js';
import prepareUpgradeBuildInfo from './prepare-upgrade-build-info.mjs';
import auditLinkedLibraries from './audit-linked-libraries.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(process.env.GOVERNANCE24_EVIDENCE_ROOT ?? join(root, 'docs/logs/governance24-contracts-20261007'));
mkdirSync(evidence, { recursive: true });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const directory = prepareUpgradeBuildInfo(root);
const infos = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => ({
  name, info: JSON.parse(readFileSync(join(directory, name), 'utf8')),
}));
const migrations = [
  ['Governance24FreshPoolFactory', 'FreshPoolFactory', 'PoolFactory'],
  ['Governance24BudgetPortfolioFactory', 'BudgetPortfolioFactory', 'BudgetPortfolioFactory'],
  ['Governance24ShareMarket', 'ShareMarket', 'ShareMarket'],
];
const checks = [];

function currentSources(info) {
  return Object.entries(info.input.sources).filter(([name]) => name.startsWith('src/')).every(([name, source]) =>
    source.content === readFileSync(join(root, 'contracts', name), 'utf8'));
}
const full = name => `src/${name}.sol:${name}`;
function selectedInfo(name, reference) {
  const found = infos.find(({ info }) => info.output.contracts?.[`src/${name}.sol`]?.[name]
    && info.output.contracts?.[`src/${reference}.sol`]?.[reference] && currentSources(info));
  assert(found, `Missing current compiler job for ${name} and ${reference}; rebuild before validation.`);
  return found;
}
function layout(info, name) {
  const data = validate(info.output, solcInputOutputDecoder(info.input, info.output), info.solcVersion, info.input);
  return getStorageLayout(data, getContractVersion(data, full(name)));
}
function schemaFields(extracted) {
  const describe = fields => fields.map(field => ({ label: field.label, slot: field.slot, offset: field.offset,
    type: extracted.types[field.type]?.label ?? field.type }));
  return { storage: describe(extracted.storage), namespaces: Object.fromEntries(
    Object.entries(extracted.namespaces ?? {}).map(([namespace, fields]) => [namespace, describe(fields)])),
  };
}

// Original business links and the new read-only governance link are reviewed before permitting linking.
auditLinkedLibraries(root, evidence);
const libraryPath = 'contracts/out/Governance24Validation.sol/Governance24Validation.json';
const library = JSON.parse(readFileSync(join(root, libraryPath), 'utf8'));
const libraryDefinition = library.ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === 'Governance24Validation');
assert(libraryDefinition?.contractKind === 'library');
assert.equal(library.storageLayout.storage.length, 0);
assert(!libraryDefinition.nodes.some(node => node.nodeType === 'VariableDeclaration' && node.stateVariable));
const callable = libraryDefinition.nodes.filter(node => node.nodeType === 'FunctionDefinition' && ['public', 'external'].includes(node.visibility));
assert.deepEqual(callable.map(node => [node.name, node.stateMutability]), [['requireMigration', 'view']]);
function* walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.nodeType) yield value;
  for (const child of Object.values(value)) if (Array.isArray(child)) {
    for (const entry of child) yield* walk(entry);
  } else yield* walk(child);
}
assert(![...walk(libraryDefinition)].some(node => ['Assignment', 'InlineAssembly', 'NewExpression'].includes(node.nodeType)),
  'Governance validation library gained a write, assembly or deployment primitive');
checks.push({ name: 'Governance24Validation', stateless: true, externalEntries: [['requireMigration', 'view']],
  sourceSha256: sha256(readFileSync(join(root, 'contracts/src/libraries/Governance24Validation.sol'))),
});


for (const [name, reference, deliveredName] of migrations) {
  const { name: compilerJob, info } = selectedInfo(name, reference);
  const current = layout(info, name);
  const previous = layout(info, reference);
  const candidateArtifact = JSON.parse(readFileSync(join(root, `contracts/out/${name}.sol/${name}.json`), 'utf8'));
  const baseArtifact = JSON.parse(readFileSync(join(root, `contracts/out/${reference}.sol/${reference}.json`), 'utf8'));
  const linkNames = artifact => Object.entries(artifact.deployedBytecode.linkReferences ?? {}).flatMap(([source, names]) =>
    Object.keys(names).map(link => `${source}:${link}`)).sort();
  const expectedLinks = [...linkNames(baseArtifact), 'src/libraries/Governance24Validation.sol:Governance24Validation'].sort();
  assert.deepEqual(linkNames(candidateArtifact), expectedLinks, `${name} replaced a business library or added an unreviewed dependency`);
  const report = getStorageUpgradeReport(previous, current, {});
  assert(report.ok, report.explain(false));
  assert.deepEqual(schemaFields(current), schemaFields(previous), `${name} introduced or changed a storage field`);
  const targetDirectory = join(root, 'contracts/out/governance24-validation', name);
  mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(join(targetDirectory, compilerJob), JSON.stringify(info));
  const safety = await validateUpgradeSafety(targetDirectory, full(name), full(reference), { requireReference: true, unsafeAllow: ['external-library-linking', 'missing-initializer'] });
  assert(safety.ok && safety.numTotal === 1, safety.explain(false));
  const baselinePath = `docs/storage/Integrated-v2-deployed-${deliveredName}.json`;
  const baselineBytes = readFileSync(join(root, baselinePath));
  const baseline = JSON.parse(baselineBytes);
  const delivered = getStorageUpgradeReport(baseline.layout, current, {});
  assert(delivered.ok, delivered.explain(false));
  checks.push({ name, reference, compilerJob, storageLayoutOk: true, exactBaseFields: true, standaloneSafetyOk: true, retainedBusinessLinks: linkNames(baseArtifact), addedGovernanceViewLink: true,
    deliveredBaseline: baselinePath, deliveredBaselineSha256: sha256(baselineBytes), deliveredStorageOk: true,
    fields: schemaFields(current), allowedMigrationWrites: name.includes('Factory') ? ['existing timelock', 'existing Ownable owner'] : ['existing timelock'],
  });
  console.log(`${name}: exact base linear/ERC-7201 fields, upgrade safety and deployed baseline compatible.`);
}

// Include the selected business implementations, which must retain all delivered pool state.
for (const name of ['PoolVault', 'BudgetPortfolioVault']) {
  const { info } = selectedInfo(name, name);
  const current = layout(info, name);
  const baselinePath = `docs/storage/Integrated-v2-deployed-${name}.json`;
  const baselineBytes = readFileSync(join(root, baselinePath));
  const report = getStorageUpgradeReport(JSON.parse(baselineBytes).layout, current, {});
  assert(report.ok, report.explain(false));
  checks.push({ name, deliveredBaseline: baselinePath, deliveredBaselineSha256: sha256(baselineBytes), deliveredStorageOk: true,
    fields: schemaFields(current), migrationWrites: [],
  });
  console.log(`${name}: delivered business pool storage compatible.`);
}

const artifacts = {};
for (const name of ['PoolTimelock24', 'Governance24Beacon', 'Governance24Dispatcher', ...migrations.map(item => item[0]), 'Governance24Validation']) {
  const artifact = JSON.parse(readFileSync(join(root, `contracts/out/${name}.sol/${name}.json`), 'utf8'));
  const variables = new Map([...walk(artifact.ast)].filter(node => node.nodeType === 'VariableDeclaration').map(node => [String(node.id), node]));
  // Inherited __self declarations live in another source AST; search the matching compiler output too.
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  const requiredSources = Object.keys(metadata.sources).filter(source => source.startsWith('src/'));
  const info = infos.find(({ info }) => {
    const compiled = info.output.contracts?.[artifact.ast.absolutePath]?.[name];
    return compiled && requiredSources.every(source => info.input.sources[source]?.content === readFileSync(join(root, 'contracts', source), 'utf8'))
      && info.output.sources?.[artifact.ast.absolutePath]?.ast?.id === artifact.ast.id
      && `0x${compiled.evm.deployedBytecode.object}` === artifact.deployedBytecode.object
      && JSON.stringify(compiled.evm.deployedBytecode.immutableReferences ?? {}) === JSON.stringify(artifact.deployedBytecode.immutableReferences ?? {});
  })?.info;
  assert(info, `No current compiler job matching exact artifact bytecode, immutable references and AST IDs for ${name}`);
  for (const source of Object.values(info.output.sources)) for (const node of walk(source.ast)) {
    if (node.nodeType === 'VariableDeclaration') variables.set(String(node.id), node);
  }
  const immutableBindings = Object.fromEntries(Object.keys(artifact.deployedBytecode.immutableReferences ?? {}).map(id => {
    const variable = variables.get(id);
    assert(variable?.mutability === 'immutable', `Unknown immutable ${name}:${id}`);
    const self = ['SELF', '__self'].includes(variable.name);
    assert(self || ['OFFICIAL_FACTORY', 'SECONDARY_BEACON', 'INITIAL_PROPOSER'].includes(variable.name), `Unexpected immutable ${name}:${variable.name}`);
    return [id, { name: variable.name, type: variable.typeDescriptions.typeString, binding: self ? 'self' : 'getter', getter: self ? null : `${variable.name}()` }];
  }));
  const bytes = (artifact.deployedBytecode.object.length - 2) / 2;
  assert(bytes < 24576, `${name} exceeds EIP-170`);
  artifacts[name] = { runtimeTemplateBytes: bytes, deployedLinkReferences: artifact.deployedBytecode.linkReferences,
    immutableBindings, runtimeTemplateSha256: sha256(artifact.deployedBytecode.object),
  };
}
writeFileSync(join(evidence, 'governance24-storage-report.json'), JSON.stringify({ schemaVersion: 1,
  generatedAt: new Date().toISOString(), ok: true, checks, artifacts, productionActions: 0,
  note: 'Storage safety and template checks are local evidence; mainnet activation additionally requires pinned live preconditions and exact batch proof.',
}, null, 2) + '\n');
console.log(`Governance24 validation passed: ${checks.length} checks; report ${join(evidence, 'governance24-storage-report.json')}`);
