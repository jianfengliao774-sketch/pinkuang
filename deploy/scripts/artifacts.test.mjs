import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toUtf8Bytes, Interface } from 'ethers';
import {
  assertCurrentArtifacts, artifactContentDigest, compileDeploymentArtifacts, libraryNames,
  linkedDeploymentOrder, requiredContracts, validateArtifacts,
} from './build-artifacts.mjs';

const document = compileDeploymentArtifacts();

test('browser artifacts compile the complete source graph with the reviewed compiler settings', () => {
  assert.equal(document.schemaVersion, 1);
  assert.match(document.compilerVersion, /^0\.8\.24\+commit\.e11b9ed9\./);
  assert.equal(document.settings.evmVersion, 'shanghai');
  assert.deepEqual(document.settings.optimizer, { enabled: true, runs: 200 });
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
    if (name !== 'FlexiblePurchase') {
      assert.deepEqual(document.artifacts[name].linkReferences, {});
      assert.deepEqual(document.artifacts[name].deployedLinkReferences, {});
    }
  }
  assert(order.indexOf('PurchaseValidation') < order.indexOf('FlexiblePurchase'));
  assert(order.indexOf('PoolFunds') < order.indexOf('FlexiblePurchase'));
  assert.throws(() => linkedDeploymentOrder({ Example: { linkReferences: { 'missing.sol': { Missing: [] } } } }), /Missing artifact/);
  assert.throws(() => linkedDeploymentOrder({ Loop: { linkReferences: { 'loop.sol': { Loop: [] } } } }), /Circular/);
});

test('deployment ABI retains prediction, role validation, binding and post-deployment inspection methods', () => {
  const atomic = new Interface(document.artifacts.AtomicDeployment.abi);
  assert(atomic.getFunction('predictedFactory()'));
  assert(atomic.getFunction('deploy((address,address,address,address,address,address))'));
  assert(atomic.getFunction('deploySingleOwner((address,address,address,address,address,address))'));
  assert(atomic.getFunction('deployer()'));
  assert(atomic.getFunction('deployment()'));
  assert(atomic.getEvent('DeploymentCompleted'));
  assert(atomic.getEvent('SingleOwnerDeployment'));
  const vault = new Interface(document.artifacts.PoolVault.abi);
  assert.equal(vault.deploy.inputs.length, 1);
  assert.equal(vault.deploy.inputs[0].type, 'address');
  assert(vault.getFunction('OFFICIAL_FACTORY()'));
  const claimFor = vault.getFunction('claimFor(address)');
  assert(claimFor);
  assert.deepEqual(claimFor.inputs.map(input => input.type), ['address']);
  assert.deepEqual(claimFor.outputs.map(output => output.type), ['uint256']);
  assert.equal(claimFor.stateMutability, 'nonpayable');
  assert(Object.keys(document.artifacts.PoolVault.immutableReferences).length > 0);
  assert(new Interface(document.artifacts.PoolBeacon.abi).getFunction('implementation()'));
  assert(new Interface(document.artifacts.PoolTimelock.abi).getFunction('getMinDelay()'));
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
  oversized.PoolFactory.deployedBytecode = `0x${'00'.repeat(24_577)}`;
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
