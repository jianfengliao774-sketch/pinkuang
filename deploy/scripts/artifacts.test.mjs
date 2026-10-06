import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toUtf8Bytes, Interface } from 'ethers';
import {
  assertCurrentArtifactInputs, assertCurrentArtifacts, artifactContentDigest, compileDeploymentArtifacts, libraryNames,
  linkedDeploymentOrder, outputPath, repositoryRoot, requiredContracts, validateArtifacts,
} from './build-artifacts.mjs';

const document = compileDeploymentArtifacts();

test('browser artifacts compile the complete source graph with the reviewed compiler settings', () => {
  assert.equal(document.schemaVersion, 1);
  assert.match(document.compilerVersion, /^0\.8\.24\+commit\.e11b9ed9\./);
  assert.equal(document.settings.evmVersion, 'shanghai');
  assert.deepEqual(document.settings.optimizer, { enabled: true, runs: 1 });
  assert.equal(document.settings.viaIR, false);
  assert.deepEqual(Object.keys(document.artifacts).sort(), [...requiredContracts].sort());
  assert(document.sourceHashes['src/PoolVault.sol']);
  assert(document.sourceHashes['@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol']);
  assert(document.sourceHashes['@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol']);
  assert(Object.values(document.sourceHashes).every(hash => /^[0-9a-f]{64}$/.test(hash)));
});

test('all deployment templates fit chain code limits and every link maps to the correct Solidity placeholder', () => {
  validateArtifacts(document.artifacts);
  for (const artifact of Object.values(document.artifacts)) {
    for (const [template, references] of [[artifact.bytecode, artifact.linkReferences], [artifact.deployedBytecode, artifact.deployedLinkReferences]]) {
      for (const [source, contracts] of Object.entries(references)) {
        for (const [name, slots] of Object.entries(contracts)) {
          const expected = `__$${keccak256(toUtf8Bytes(`${source}:${name}`)).slice(2, 36)}$__`;
          for (const { start, length } of slots) {
            assert.equal(length, 20);
            assert.equal(template.slice(2 + start * 2, 2 + (start + length) * 2), expected);
          }
        }
      }
    }
  }
});

test('nested purchase dependencies and all reviewed libraries precede PoolVault in the compiler link graph', () => {
  const order = linkedDeploymentOrder(document.artifacts);
  for (const name of libraryNames) {
    assert(order.indexOf(name) < order.indexOf('PoolVault'));
    if (!['FlexiblePurchase', 'FirstoSale'].includes(name)) {
      assert.deepEqual(document.artifacts[name].linkReferences, {});
      assert.deepEqual(document.artifacts[name].deployedLinkReferences, {});
    }
  }
  assert(order.indexOf('PurchaseValidation') < order.indexOf('FlexiblePurchase'));
  assert(order.indexOf('PoolFunds') < order.indexOf('FlexiblePurchase'));
  assert(order.indexOf('SaleSettlement') < order.indexOf('FirstoSale'));
  assert.throws(() => linkedDeploymentOrder({ Example: { linkReferences: { 'missing.sol': { Missing: [] } } } }), /Missing artifact/);
  assert.throws(() => linkedDeploymentOrder({ Loop: { linkReferences: { 'loop.sol': { Loop: [] } } } }), /Circular/);
});

test('deployment ABI retains prediction, role validation, binding and post-deployment inspection methods', () => {
  const atomic = new Interface(document.artifacts.AtomicDeployment.abi);
  assert(atomic.getFunction('predictedFactory()'));
  assert(atomic.getFunction('deploy((address,address,address,address,address,address))'));
  assert(atomic.getFunction('deploySingleOwner((address,address,address,address,address,address))'));
  assert(atomic.getFunction('deployIntegratedSingleOwner'));
  assert(atomic.getFunction('predictedPortfolioFactory()'));
  assert(atomic.getFunction('portfolioDeployment()'));
  assert(atomic.getEvent('IntegratedDeploymentCompleted'));
  assert(atomic.getFunction('deployer()'));
  assert(atomic.getFunction('deployment()'));
  assert(atomic.getEvent('DeploymentCompleted'));
  assert(atomic.getEvent('SingleOwnerDeployment'));
  const vault = new Interface(document.artifacts.PoolVault.abi);
  assert.equal(vault.deploy.inputs.length, 1);
  assert.equal(vault.deploy.inputs[0].type, 'address');
  assert(vault.getFunction('OFFICIAL_FACTORY()'));
  assert(vault.getFunction('claim()'));
  assert(vault.getFunction('harvest()'));
  assert(vault.getFunction('completeFirstoSale(uint256,uint256,uint16,uint256)'));
  assert(vault.getFunction('controlledFirstoSaleVersion()'));
  assert.equal(vault.getFunction('claimFor(address)'), null);
  assert(Object.keys(document.artifacts.PoolVault.immutableReferences).length > 0);
  assert(new Interface(document.artifacts.PoolBeacon.abi).getFunction('implementation()'));
  assert(new Interface(document.artifacts.PoolTimelock.abi).getFunction('getMinDelay()'));
  const factory = new Interface(document.artifacts.PoolFactory.abi);
  assert(factory.getFunction('lens()'));
  assert(factory.getFunction('ensureLens()'));
  const checked = factory.getFunction('createFlexiblePoolChecked');
  assert(checked);
  assert.deepEqual(checked.inputs.map(input => input.type), ['tuple', 'tuple', 'uint32', 'uint128']);
  const lens = new Interface(document.artifacts.PoolLens.abi);
  assert.deepEqual(lens.deploy.inputs.map(input => input.type), ['address']);
  assert(lens.getFunction('factory()'));
  assert(Object.keys(document.artifacts.PoolLens.immutableReferences).length > 0);
});

test('--check rejects source or artifact drift while permitting a later Git commit with identical source bytes', () => {
  const saved = structuredClone(document);
  saved.sourceCommit = 'a'.repeat(40);
  assert.doesNotThrow(() => assertCurrentArtifacts(saved, document));
  saved.sourceHashes['src/PoolVault.sol'] = 'f'.repeat(64);
  assert.throws(() => assertCurrentArtifacts(saved, document), /stale or modified/);
  const corrupt = structuredClone(document);
  corrupt.artifacts.PoolFactory.bytecode = `0x00${corrupt.artifacts.PoolFactory.bytecode.slice(4)}`;
  assert.throws(() => assertCurrentArtifacts(corrupt, document), /stale or modified/);
});

test('malformed link locations and oversized runtime code cannot enter a deployment bundle', () => {
  const malformed = structuredClone(document.artifacts);
  const reference = Object.values(Object.values(malformed.PoolVault.linkReferences)[0])[0][0];
  reference.start = 0;
  assert.throws(() => validateArtifacts(malformed), /Missing link placeholder/);
  const oversized = structuredClone(document.artifacts);
  oversized.PoolFactory.deployedBytecode = oversized.PoolFactory.deployedBytecode.padEnd(2 + 24_577 * 2, '0');
  assert.throws(() => validateArtifacts(oversized), /EIP-170/);
});


test('source-pinned digest binds ABI, creation/runtime code and compiler sources, excluding only commit provenance', () => {
  const digest = artifactContentDigest(document), laterCommit = structuredClone(document);
  laterCommit.sourceCommit = 'b'.repeat(40);
  assert.equal(artifactContentDigest(laterCommit), digest);
  for (const mutate of [
    item => { item.artifacts.PoolFactory.bytecode += '00'; },
    item => { item.artifacts.PoolVault.abi.push({ type: 'function', name: 'unreviewed', inputs: [], outputs: [], stateMutability: 'view' }); },
    item => { item.sourceHashes['src/PoolVault.sol'] = 'a'.repeat(64); },
  ]) {
    const tampered = structuredClone(document); mutate(tampered);
    assert.notEqual(artifactContentDigest(tampered), digest);
    tampered.claimedDigest = artifactContentDigest(tampered);
    assert.throws(() => assertCurrentArtifacts(tampered, document), /stale or modified/);
  }
});

test('long-running dev journal guard rejects changed Solidity files and stale artifact bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinkuang-artifact-inputs-'));
  const artifactPath = join(root, 'deployment-artifacts.json');
  const options = { root, artifactPath };
  const digest = artifactContentDigest(document);
  try {
    await mkdir(join(root, 'contracts'), { recursive: true });
    await cp(join(repositoryRoot, 'contracts/src'), join(root, 'contracts/src'), { recursive: true });
    await copyFile(join(repositoryRoot, 'contracts/foundry.toml'), join(root, 'contracts/foundry.toml'));
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'));
    await copyFile(outputPath, artifactPath);
    assert.doesNotThrow(() => assertCurrentArtifactInputs(digest, options));
    const changed = JSON.parse(await readFile(artifactPath, 'utf8'));
    changed.artifacts.PoolFactory.bytecode += '00';
    await writeFile(artifactPath, JSON.stringify(changed));
    assert.throws(() => assertCurrentArtifactInputs(digest, options), /Deployment artifacts changed/);
    await copyFile(outputPath, artifactPath);
    await appendFile(join(root, 'contracts/src/PoolVault.sol'), '\n');
    assert.throws(() => assertCurrentArtifactInputs(digest, options), /Solidity sources changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
