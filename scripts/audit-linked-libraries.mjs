import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { keccak256 } = require('ethereum-cryptography/keccak');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const keccak = value => `0x${Buffer.from(keccak256(value)).toString('hex')}`;
const expectedLibraries = ['FirstoSale', 'FlexiblePurchase', 'MiningOperations', 'PoolFunds', 'PurchaseValidation', 'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints'];
const directVaultLibraries = expectedLibraries.filter(name => name !== 'PurchaseValidation');
const nestedLibraries = {
  FlexiblePurchase: ['PoolFunds', 'PurchaseValidation'],
  FirstoSale: ['MiningOperations', 'PoolFunds', 'RewardAccounting', 'SaleGovernance', 'SaleSettlement'],
};
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

function vaultLinks(bytecode, label, expected = directVaultLibraries) {
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
  assert.deepEqual(links.map(link => link.name).sort(), expected,
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

function expressionShape(node) {
  if (node?.nodeType === 'Identifier') return node.name;
  if (node?.nodeType === 'Literal') return node.value;
  if (node?.nodeType === 'MemberAccess') return `${expressionShape(node.expression)}.${node.memberName}`;
  if (node?.nodeType === 'UnaryOperation') return [node.operator, expressionShape(node.subExpression)];
  if (node?.nodeType === 'BinaryOperation') return [node.operator, expressionShape(node.leftExpression), expressionShape(node.rightExpression)];
  throw new Error(`Unreviewed reference expression: ${node?.nodeType}`);
}

function reviewedVaultCalls(helper, expected) {
  const allCalls = [...walkAst(helper.body)].filter(node => node.nodeType === 'FunctionCall');
  const calls = allCalls.filter(node => node.expression?.nodeType === 'MemberAccess'
    && node.expression.typeDescriptions?.typeIdentifier?.startsWith('t_function_external'));
  assert.deepEqual(calls.map(node => node.expression.memberName).sort(), [...expected].sort(),
    `${helper.name} external call surface changed.`);
  for (const call of calls) {
    const converted = call.expression.expression;
    assert(converted.nodeType === 'FunctionCall' && converted.kind === 'typeConversion'
      && converted.expression?.name === 'IPoolVault' && converted.arguments?.[0]?.name === 'pool',
    `${helper.name} external call must target only IPoolVault(pool).`);
  }
  for (const call of allCalls) {
    if (calls.includes(call)) continue;
    if (call.kind === 'typeConversion' && call.expression?.name === 'IPoolVault'
      && call.arguments?.length === 1 && call.arguments[0]?.name === 'pool') continue;
    assert(call.expression?.name === 'ReferenceMinerChanged' && call.arguments?.length === 0,
      `${helper.name} gained an unreviewed function call.`);
  }
  for (const node of walkAst(helper.body)) {
    if (node.nodeType === 'MemberAccess') assert(!['call', 'delegatecall', 'callcode', 'send', 'transfer'].includes(node.memberName),
      `${helper.name} has an unreviewed raw call.`);
    if (node.nodeType === 'YulFunctionCall') assert(!['call', 'delegatecall', 'callcode'].includes(node.functionName.name),
      `${helper.name} has an unreviewed assembly call.`);
  }
  return calls;
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
  let additionalNamespace;
  if (name === 'FlexiblePurchase') {
    const namespace = 'tapeout.storage.FlexiblePurchase';
    const namespaceSeed = (BigInt(keccak(Buffer.from(namespace))) - 1n).toString(16).padStart(64, '0');
    const slot = `0x${(BigInt(keccak(Buffer.from(namespaceSeed, 'hex'))) & ~255n).toString(16).padStart(64, '0')}`;
    assert.equal(state.find(node => node.name === 'SELECTION_STORAGE')?.value?.value?.toLowerCase(), slot,
      'FlexiblePurchase namespace does not match ERC-7201 derivation.');
    additionalNamespace = { namespace: `erc7201:${namespace}`, slot, definition: 'src/PurchaseSelectionState.sol:PurchaseSelectionState.SelectionStorage',
      note: 'Inherited by PoolVault; fields and nested config are extracted by OpenZeppelin storage validation, not inferred from library AST.' };
  }
  for (const part of ['bytecode', 'deployedBytecode']) {
    vaultLinks(artifact[part], `${name} ${part}`, nestedLibraries[name] ?? []);
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
    mutableStateDeclarations: 0, explicitDelegatecallOrCallcode: false, selfdestruct: false, rawCalls, additionalNamespace,
    scope: 'Own library source AST only; Vault/Factory entry-point guards and dependency behavior require separate review/tests.' };
}

/**
 * Record exactly which external libraries a compiled PoolVault requires.
 * This does not assert anything about deployed library addresses or extcodehash.
 */
export default function auditLinkedLibraries(root, logRoot) {
  const projectRoot = resolve(root);
  const evidenceRoot = resolve(logRoot);
  const vault = readArtifact(projectRoot, 'PoolVault');
  const factory = readArtifact(projectRoot, 'PoolFactory');
  const freshFactory = readArtifact(projectRoot, 'FreshPoolFactory');
  const budgetVault = readArtifact(projectRoot, 'BudgetPortfolioVault');
  const factorySource = sourceEvidence(projectRoot, 'src/PoolFactory.sol', factory.metadata);
  const freshFactorySource = sourceEvidence(projectRoot, 'src/FreshPoolFactory.sol', freshFactory.metadata);
  const budgetVaultSource = sourceEvidence(projectRoot, 'src/BudgetPortfolioVault.sol', budgetVault.metadata);
  sourceEvidence(projectRoot, 'src/PoolFactory.sol', freshFactory.metadata);
  const vaultSource = sourceEvidence(projectRoot, 'src/PoolVault.sol', vault.metadata);
  const selectionSource = sourceEvidence(projectRoot, 'src/PurchaseSelectionState.sol', vault.metadata);
  const designatedStateSource = sourceEvidence(projectRoot, 'src/DesignatedPurchaseState.sol', vault.metadata);
  const designatedPolicySource = sourceEvidence(projectRoot, 'src/libraries/DesignatedPurchase.sol', vault.metadata);
  const designatedPolicy = readArtifact(projectRoot, 'DesignatedPurchase');
  sourceEvidence(projectRoot, 'src/libraries/DesignatedPurchase.sol', designatedPolicy.metadata);
  assert.equal(designatedPolicy.artifact.storageLayout?.storage?.length, 0,
    'Internal DesignatedPurchase library must have no ordinary storage.');
  vaultLinks(designatedPolicy.artifact.bytecode, 'DesignatedPurchase creation bytecode', []);
  vaultLinks(designatedPolicy.artifact.deployedBytecode, 'DesignatedPurchase runtime bytecode', []);
  const designatedDefinition = designatedPolicy.artifact.ast.nodes
    .find(node => node.nodeType === 'ContractDefinition' && node.name === 'DesignatedPurchase');
  assert(designatedDefinition?.contractKind === 'library', 'Missing internal DesignatedPurchase library.');
  assert(designatedDefinition.nodes.filter(node => node.nodeType === 'FunctionDefinition')
    .every(node => node.visibility === 'internal' || node.visibility === 'private'),
  'DesignatedPurchase must remain internal-only; adding an external link needs separate review.');
  const designatedSlot = `0x${(BigInt(keccak(Buffer.from((BigInt(keccak(Buffer.from('tapeout.storage.DesignatedPurchase'))) - 1n)
    .toString(16).padStart(64, '0'), 'hex'))) & ~255n).toString(16).padStart(64, '0')}`;
  const slotDeclaration = designatedDefinition.nodes.find(node => node.nodeType === 'VariableDeclaration'
    && node.name === 'STORAGE_SLOT');
  assert.equal(slotDeclaration?.value?.value?.toLowerCase(), designatedSlot,
    'DesignatedPurchase namespace slot differs from ERC-7201 derivation.');
  const executor = readArtifact(projectRoot, 'FirstoSaleExecutor');
  const executorSource = sourceEvidence(projectRoot, 'src/FirstoSaleExecutor.sol', vault.metadata);
  const executorDefinition = executor.artifact.ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === 'FirstoSaleExecutor');
  assert(executorDefinition && executorDefinition.baseContracts.length === 0, 'Unexpected Firsto executor inheritance.');
  assert(executorDefinition.nodes.filter(node => node.nodeType === 'FunctionDefinition').every(node => node.kind === 'constructor'),
    'Firsto executor must have no callable runtime entry points.');
  assert.equal(executor.artifact.storageLayout.storage.length, 0, 'Firsto executor must not retain storage.');
  assert(executor.artifact.abi.every(item => ['constructor', 'error'].includes(item.type)), 'Unexpected Firsto executor ABI.');
  const exchangeCalls = [];
  for (const node of walkAst(executorDefinition)) {
    if (node.nodeType === 'MemberAccess') {
      assert(!['call', 'delegatecall', 'callcode', 'send', 'transfer'].includes(node.memberName), 'Unexpected executor raw payment/call.');
      if (node.memberName === 'fillSignedAsk') exchangeCalls.push(node);
    }
    if (node.nodeType === 'Identifier') assert(!['selfdestruct', 'suicide'].includes(node.name), 'Destructive executor operation.');
    if (node.nodeType === 'YulFunctionCall') assert(!['call', 'delegatecall', 'callcode', 'selfdestruct'].includes(node.functionName.name), 'Unexpected executor assembly call.');
  }
  assert.equal(exchangeCalls.length, 1, 'Executor must make exactly one reviewed Firsto fill call.');
  assert.equal(exchangeCalls[0].expression.arguments?.[0]?.value?.toLowerCase(),
    '0x33423244f9a5bf81b12b1a018af6f4e079b97f29', 'Executor Firsto target must be fixed.');
  const creationLinks = vaultLinks(vault.artifact.bytecode, 'PoolVault creation bytecode');
  const runtimeLinks = vaultLinks(vault.artifact.deployedBytecode, 'PoolVault runtime bytecode');
  const poolFactoryCreationLinks = vaultLinks(factory.artifact.bytecode, 'PoolFactory creation bytecode', ['PurchaseValidation']);
  const poolFactoryRuntimeLinks = vaultLinks(factory.artifact.deployedBytecode, 'PoolFactory runtime bytecode', ['PurchaseValidation']);
  const freshFactoryCreationLinks = vaultLinks(freshFactory.artifact.bytecode, 'FreshPoolFactory creation bytecode', ['PurchaseValidation']);
  const freshFactoryRuntimeLinks = vaultLinks(freshFactory.artifact.deployedBytecode, 'FreshPoolFactory runtime bytecode', ['PurchaseValidation']);
  const budgetVaultCreationLinks = vaultLinks(budgetVault.artifact.bytecode,
    'BudgetPortfolioVault creation bytecode', ['SaleGovernance']);
  const budgetVaultRuntimeLinks = vaultLinks(budgetVault.artifact.deployedBytecode,
    'BudgetPortfolioVault runtime bytecode', ['SaleGovernance']);
  const validationLibrary = readArtifact(projectRoot, 'PurchaseValidation');
  const libraryDefinition = validationLibrary.artifact.ast.nodes
    .find(node => node.nodeType === 'ContractDefinition' && node.name === 'PurchaseValidation');
  assert(libraryDefinition, 'Missing PurchaseValidation library AST.');
  const helperByName = new Map(libraryDefinition.nodes
    .filter(node => node.nodeType === 'FunctionDefinition').map(node => [node.name, node]));
  const factoryDefinition = factory.artifact.ast.nodes
    .find(node => node.nodeType === 'ContractDefinition' && node.name === 'PoolFactory');
  assert(factoryDefinition, 'Missing PoolFactory AST.');
  const libraryCalls = [...walkAst(factoryDefinition)].filter(node => node.nodeType === 'MemberAccess'
    && node.expression?.nodeType === 'Identifier' && node.expression.name === 'PurchaseValidation');
  assert.deepEqual(libraryCalls.map(node => node.memberName).sort(),
    ['configureDesignatedPoolChecked', 'liveMachineReservation', 'requireFlexibleReferenceMatches', 'validatePoolParams'],
    'PoolFactory library call surface changed.');
  const factoryCallSites = libraryCalls.map(node => {
    const helper = helperByName.get(node.memberName);
    const expectedMutability = node.memberName === 'configureDesignatedPoolChecked' ? 'nonpayable' : 'view';
    assert(helper && helper.stateMutability === expectedMutability
      && helper.visibility === 'external', `PoolFactory linked helper mutability changed: ${node.memberName}`);
    return { name: node.memberName, stateMutability: helper.stateMutability, library: 'PurchaseValidation' };
  });
  const checkedCreate = factoryDefinition.nodes.find(node => node.nodeType === 'FunctionDefinition'
    && node.name === 'createDesignatedPoolChecked');
  assert(checkedCreate?.modifiers?.some(node => node.modifierName?.name === 'nonReentrant'),
    'Designated pool creation must remain nonReentrant.');
  const [createStatement, configureStatement] = checkedCreate.body?.statements ?? [];
  assert.equal(checkedCreate.body.statements.length, 2, 'Designated creation sequence changed.');
  const createAssignment = createStatement?.expression;
  const createCall = createAssignment?.rightHandSide;
  assert(createAssignment?.nodeType === 'Assignment' && createAssignment.leftHandSide?.name === 'pool'
    && createCall?.expression?.name === '_createPool'
    && createCall.arguments?.[0]?.name === 'params' && createCall.arguments?.[1]?.value === 'true',
  'Designated creation must first use the guarded _createPool(params, true).');
  const configureCall = configureStatement?.expression;
  assert(configureCall?.expression?.expression?.name === 'PurchaseValidation'
    && configureCall.expression.memberName === 'configureDesignatedPoolChecked',
  'Designated creation must then call the reviewed linked helper.');
  assert.deepEqual(configureCall.arguments.map(expressionShape),
    ['pool', 'params.circuitId', 'config', 'expectedTaskId', 'expectedReferenceWeight'],
  'Designated reference check must bind the created pool and exact target.');
  const designatedHelper = helperByName.get('configureDesignatedPoolChecked');
  const helperCalls = reviewedVaultCalls(designatedHelper, ['configureDesignatedPurchase', 'designatedPurchase']);
  assert(helperCalls[0].expression.memberName === 'configureDesignatedPurchase'
    && helperCalls[0].arguments?.[0]?.name === 'config'
    && helperCalls[1].expression.memberName === 'designatedPurchase',
  'Designated helper must configure the provided terms before reading them back.');
  assert.deepEqual(expressionShape(designatedHelper.body.statements[2]?.condition),
    ['||', ['||', ['||', ['||', ['!', 'enabled'], ['!=', 'referenceId', 'expectedCircuitId']],
      ['!=', 'taskId', 'expectedTaskId']], ['==', 'expectedReferenceWeight', '0']],
    ['!=', 'weight', 'expectedReferenceWeight']],
  'Designated helper reference identity, task, or weight check changed.');
  reviewedVaultCalls(helperByName.get('requireFlexibleReferenceMatches'),
    ['purchaseModel', 'purchaseReferenceWeight']);
  const freshFactoryDefinition = freshFactory.artifact.ast.nodes
    .find(node => node.nodeType === 'ContractDefinition' && node.name === 'FreshPoolFactory');
  assert(freshFactoryDefinition && freshFactoryDefinition.baseContracts.length === 1
    && freshFactoryDefinition.baseContracts[0].baseName.name === 'PoolFactory',
  'FreshPoolFactory must inherit the reviewed PoolFactory implementation.');
  const saleGovernance = readArtifact(projectRoot, 'SaleGovernance');
  const saleGovernanceDefinition = saleGovernance.artifact.ast.nodes
    .find(node => node.nodeType === 'ContractDefinition' && node.name === 'SaleGovernance');
  assert(saleGovernanceDefinition, 'Missing SaleGovernance library AST.');
  const saleFunctions = new Map(saleGovernanceDefinition.nodes
    .filter(node => node.nodeType === 'FunctionDefinition').map(node => [node.name, node]));
  const budgetVaultDefinition = budgetVault.artifact.ast.nodes
    .find(node => node.nodeType === 'ContractDefinition' && node.name === 'BudgetPortfolioVault');
  assert(budgetVaultDefinition, 'Missing BudgetPortfolioVault AST.');
  const budgetLibraryCalls = [...walkAst(budgetVaultDefinition)].filter(node => node.nodeType === 'MemberAccess'
    && node.expression?.nodeType === 'Identifier' && node.expression.name === 'SaleGovernance');
  assert.deepEqual(budgetLibraryCalls.map(node => node.memberName).sort(),
    ['budgetReviewPolicy', 'executeBudgetChildSale', 'requirePortfolioReviewable', 'requirePortfolioSaleApproved'],
  'BudgetPortfolioVault SaleGovernance call surface changed.');
  const budgetCallSites = budgetLibraryCalls.map(node => {
    const helper = saleFunctions.get(node.memberName);
    assert(helper && helper.visibility === 'external',
      `BudgetPortfolioVault linked helper is not an external SaleGovernance function: ${node.memberName}`);
    return { name: node.memberName, stateMutability: helper.stateMutability, library: 'SaleGovernance' };
  });
  const executeChildSale = budgetVaultDefinition.nodes
    .find(node => node.nodeType === 'FunctionDefinition' && node.name === 'executeChildSale');
  assert(executeChildSale?.modifiers?.some(node => node.modifierName?.name === 'nonReentrant'),
    'BudgetPortfolioVault linked child-sale execution must remain nonReentrant.');
  const libraries = expectedLibraries.map(name => {
    const compiled = readArtifact(projectRoot, name);
    const source = sourceEvidence(projectRoot, `src/libraries/${name}.sol`, compiled.metadata);
    // The same source must be the library dependency compiled into Vault's metadata.
    sourceEvidence(projectRoot, `src/libraries/${name}.sol`, vault.metadata);
    return { name, source, artifactPath: compiled.path, artifactSha256: compiled.artifactSha256,
      compilerVersion: compiled.metadata.compiler?.version,
      runtimeBytecodeTemplate: templateEvidence(compiled.artifact.deployedBytecode, name),
      creationLinks: vaultLinks(compiled.artifact.bytecode, `${name} creation bytecode`, nestedLibraries[name] ?? []),
      runtimeLinks: vaultLinks(compiled.artifact.deployedBytecode, `${name} runtime bytecode`, nestedLibraries[name] ?? []),
      astReview: reviewLibraryAst(name, compiled.artifact) };
  });
  const firstoSale = readArtifact(projectRoot, 'FirstoSale');
  const firstoSaleDefinition = firstoSale.artifact.ast.nodes
    .find(node => node.nodeType === 'ContractDefinition' && node.name === 'FirstoSale');
  assert(firstoSaleDefinition, 'Missing FirstoSale library AST.');
  const expectedFirstoCalls = {
    MiningOperations: ['claimReward'],
    PoolFunds: ['materializePurchase'],
    RewardAccounting: ['account', 'settle'],
    SaleGovernance: ['tradingFrozen'],
    SaleSettlement: ['completeNative', 'prepareFirsto'],
  };
  const firstoCallSites = Object.fromEntries(Object.keys(expectedFirstoCalls).map(name => [name, []]));
  for (const node of walkAst(firstoSaleDefinition)) {
    if (node.nodeType !== 'MemberAccess' || node.expression?.nodeType !== 'Identifier'
      || !Object.hasOwn(expectedFirstoCalls, node.expression.name)) continue;
    firstoCallSites[node.expression.name].push(node.memberName);
  }
  for (const [libraryName, names] of Object.entries(expectedFirstoCalls)) {
    assert.deepEqual([...new Set(firstoCallSites[libraryName])].sort(), names,
      `FirstoSale linked ${libraryName} call surface changed.`);
    const library = readArtifact(projectRoot, libraryName);
    const definition = library.artifact.ast.nodes
      .find(node => node.nodeType === 'ContractDefinition' && node.name === libraryName);
    const externalFunctions = new Map(definition.nodes.filter(node => node.nodeType === 'FunctionDefinition')
      .map(node => [node.name, node]));
    for (const name of names) {
      assert.equal(externalFunctions.get(name)?.visibility, 'external',
        `FirstoSale linked ${libraryName}.${name} must stay externally linked.`);
    }
  }
  const audit = { schemaVersion: 1, generatedAt: new Date().toISOString(), ok: true,
    vault: { source: vaultSource, selectionSource, designatedStateSource, designatedPolicySource,
      designatedNamespace: { name: 'erc7201:tapeout.storage.DesignatedPurchase', slot: designatedSlot,
        internalOnly: true }, artifactPath: vault.path, artifactSha256: vault.artifactSha256,
      runtimeBytecodeTemplate: templateEvidence(vault.artifact.deployedBytecode, 'PoolVault'),
      creationLinks, runtimeLinks }, libraries,
    firstoExecutor: { source: executorSource, artifactPath: executor.path, constructorOnly: true, fixedExchange: true },
    firstoSaleLinking: { source: sourceEvidence(projectRoot, 'src/libraries/FirstoSale.sol', firstoSale.metadata),
      artifactPath: firstoSale.path, callSites: Object.fromEntries(Object.entries(firstoCallSites)
        .map(([name, calls]) => [name, [...new Set(calls)].sort()])),
      note: 'Only the pinned external library functions are reachable from FirstoSale; exact linked template addresses are verified by deployment evidence.' },
    context: {
      factoryLinking: {
        PoolFactory: { source: factorySource, creationLinks: poolFactoryCreationLinks,
          runtimeLinks: poolFactoryRuntimeLinks, callSites: factoryCallSites,
          note: 'Exactly four reviewed PurchaseValidation calls are present; the designated nonpayable helper configures the newly created Vault and checks its identity, task and weight in the same nonReentrant transaction.' },
        FreshPoolFactory: { source: freshFactorySource, creationLinks: freshFactoryCreationLinks,
          runtimeLinks: freshFactoryRuntimeLinks, base: 'PoolFactory',
          note: 'FreshPoolFactory inherits the exact reviewed PoolFactory call surface.' },
        BudgetPortfolioVault: { source: budgetVaultSource, creationLinks: budgetVaultCreationLinks,
          runtimeLinks: budgetVaultRuntimeLinks, callSites: budgetCallSites, childSaleNonReentrant: true,
          note: 'SaleGovernance is storage-free; child sale writes are called only under BudgetPortfolioVault.nonReentrant.' },
      },
      execution: 'Solidity linked-library calls execute by DELEGATECALL in the calling Vault or Factory context.',
      reentrancy: 'Vault owns the nonReentrant purchase/payment entry points; Factory owns nonReentrant pool creation. FlexiblePurchase uses bounded static balanceOf callbacks to Vault when recording purchase-time refund credits; no arbitrary call target or calldata is accepted.',
      upgradeValidationException: 'PoolVault and BudgetPortfolioVault narrowly annotate their constructors/immutable fields and linked-library use. PoolFactory external-library-linking covers the four pinned PurchaseValidation call sites above, including atomic designated configuration. BudgetPortfolioVault SaleGovernance call sites and nonReentrant child sale path are pinned above. Storage validation is not skipped; immutable factory values are verified separately.',
      limitations: 'Compiler templates are not deployed code hashes. Vault link placeholders and constructor immutable references require deployment fixups; a library runtime template also has its own-address fixup. Deployment and Beacon upgrade checks must verify the official factory binding, each linked address and runtime code.',
    },
  };
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, 'library-link-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  console.log(`PASS: PoolFactory and FreshPoolFactory link only the four audited PurchaseValidation helpers; PoolVault links ${directVaultLibraries.length} direct and ${expectedLibraries.length} total reviewed libraries; source hashes, templates and scoped AST gates recorded.`);
  return audit;
}
