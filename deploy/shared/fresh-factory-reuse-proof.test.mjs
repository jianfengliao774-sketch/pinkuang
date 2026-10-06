import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress, keccak256 } from 'ethers';
import { buildDigest } from './firsto-upgrade-proof.mjs';
import { FACTORY_IMPLEMENTATION_SLOT, factoryReuseSalt, validateFreshFactoryReuseCatalog,
  freshFactoryReuseOperation, factoryReuseRuntimeMatches, verifyFreshFactoryReuse } from './fresh-factory-reuse-proof.mjs';

const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const block = { number: 100, hash: hash(100) };
const abi = ['function soldMachineReuseVersion() view returns(uint8)', 'function proxiableUUID() view returns(bytes32)',
  'function upgradeToAndCall(address,bytes) payable', 'function owner() view returns(address)',
  'function timelock() view returns(address)', 'function getMinDelay() view returns(uint256)',
  'function PROPOSER_ROLE() view returns(bytes32)', 'function hasRole(bytes32,address) view returns(bool)',
  'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function isOperationDone(bytes32) view returns(bool)'];
const views = new Interface(abi);

function fixture(profile = 'full-test') {
  const a = { factory: addr(1), timelock: addr(2), FreshPoolFactory: addr(3), PoolFactory: addr(3),
    PoolVault: addr(4), shareMarket: addr(5), portfolioFactory: addr(6) };
  const proposer = addr(7), implementation = addr(8);
  const artifact = { contractName: 'FreshPoolFactory', abi, bytecode: '0x6000',
    deployedBytecode: '0x60' + '0'.repeat(64) + '6000' + '0'.repeat(64),
    linkReferences: {}, deployedLinkReferences: {}, immutableReferences: { 17: [{ start: 1, length: 32 }, { start: 35, length: 32 }] } };
  const bundle = { sourceCommit: 'a'.repeat(40), compiler: '0.8.24', sourceHashes: { 'FreshPoolFactory.sol': hash(9) },
    profile, artifacts: { FreshPoolFactory: artifact } };
  const trusted = { record: { addresses: a, artifactDigest: hash(10), input: { ownerMultisig: proposer } },
    bundle: { artifacts: { FreshPoolFactory: {} } }, freshAuthority: { authority: { address: addr(9) } },
    freshSalePolicy: { catalog: { profile, bindings: { proposer } } } };
  const catalog = { schemaVersion: 1, kind: 'fresh-sold-machine-reuse-upgrade-v1', chainId: 56, profile,
    genesisArtifactDigest: hash(10), candidateArtifactDigest: buildDigest(bundle),
    bindings: { factory: a.factory, timelock: a.timelock, proposer },
    expectedImplementations: { FreshPoolFactory: a.FreshPoolFactory }, artifacts: bundle.artifacts,
    minimumDelaySeconds: profile === 'full-test' ? 0 : 172800 };
  catalog.salt = factoryReuseSalt(a.factory, catalog.candidateArtifactDigest);
  trusted.freshFactoryReuse = validateFreshFactoryReuseCatalog(catalog, bundle, trusted);
  let code = artifact.deployedBytecode.slice(2);
  for (const { start, length } of artifact.immutableReferences[17])
    code = code.slice(0, start * 2) + implementation.slice(2).padStart(64, '0') + code.slice((start + length) * 2);
  const operation = freshFactoryReuseOperation(catalog, implementation);
  const state = { baseline: false, done: true, version: 1n, proxyVersion: 1n, delay: BigInt(catalog.minimumDelaySeconds),
    uuid: FACTORY_IMPLEMENTATION_SLOT, owner: a.timelock, timelock: a.timelock, proposer: true,
    operation: operation.operationId, reorg: false, code: '0x' + code, codeReads: 0, calls: [] };
  const provider = { getStorage: async (to, slot, at) => {
    assert.equal(to, a.factory); assert.equal(slot, FACTORY_IMPLEMENTATION_SLOT); assert.equal(at, 100);
    return '0x' + (state.baseline ? a.FreshPoolFactory : implementation).slice(2).padStart(64, '0'); },
    getCode: async (to, at) => { assert.equal(to, implementation); assert.equal(at, 100); state.codeReads++; return state.code; },
    getBlock: async number => ({ number, hash: state.reorg ? hash(101) : hash(number) }),
    send: async (method, [tx, tag]) => {
      assert.equal(method, 'eth_call'); assert.equal(tag, '0x64');
      const parsed = views.parseTransaction(tx); state.calls.push({ to: tx.to, parsed });
      const values = { soldMachineReuseVersion: tx.to === a.factory ? state.proxyVersion : state.version,
        proxiableUUID: state.uuid, owner: state.owner, timelock: state.timelock, getMinDelay: state.delay,
        PROPOSER_ROLE: hash(20), hasRole: state.proposer, hashOperationBatch: state.operation, isOperationDone: state.done };
      if (parsed.name === 'hashOperationBatch') {
        assert.equal(tx.to, a.timelock); assert.equal(parsed.args[0].length, 1); assert.equal(parsed.args[0][0], a.factory);
        assert.equal(parsed.args[1][0], 0n); assert.equal(parsed.args[2][0], operation.payloads[0]);
        assert.equal(parsed.args[3], operation.predecessor); assert.equal(parsed.args[4], catalog.salt);
      }
      if (parsed.name === 'hasRole') assert.equal(parsed.args[1], proposer);
      return views.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    } };
  return { a, proposer, implementation, artifact, bundle, trusted, catalog, operation, state, provider };
}

test('Factory reuse catalog binds the one artifact, previous implementation and exact existing profile', () => {
  const f = fixture();
  for (const mutate of [c => c.bindings.factory = addr(30), c => c.bindings.timelock = addr(30),
    c => c.bindings.proposer = addr(30), c => c.expectedImplementations.FreshPoolFactory = addr(30),
    c => c.profile = 'formal', c => c.genesisArtifactDigest = hash(30), c => c.salt = hash(30),
    c => c.minimumDelaySeconds = 172800, c => c.artifacts.PoolVault = c.artifacts.FreshPoolFactory]) {
    const catalog = structuredClone(f.catalog); mutate(catalog);
    assert.throws(() => validateFreshFactoryReuseCatalog(catalog, f.bundle, f.trusted));
  }
  const bundle = structuredClone(f.bundle); bundle.artifacts.FreshPoolFactory.bytecode += '00';
  assert.throws(() => validateFreshFactoryReuseCatalog(f.catalog, bundle, f.trusted), /identity/);
  const formal = fixture('formal'); assert.equal(formal.catalog.minimumDelaySeconds, 172800);
  assert.equal(validateFreshFactoryReuseCatalog({ ...formal.catalog, minimumDelaySeconds: '172800' }, formal.bundle,
    formal.trusted).catalog.minimumDelaySeconds, '172800');
  assert.equal(validateFreshFactoryReuseCatalog({ ...f.catalog, minimumDelaySeconds: '0' }, f.bundle,
    f.trusted).catalog.minimumDelaySeconds, '0');
  const weak = { ...formal.catalog, minimumDelaySeconds: 0 };
  assert.throws(() => validateFreshFactoryReuseCatalog(weak, formal.bundle, formal.trusted), /delay/);
});

test('UUPS self bytes must equal the deployed address; no mask, extra immutable or library is accepted', () => {
  const f = fixture(); assert(factoryReuseRuntimeMatches(f.artifact, f.state.code, f.implementation));
  assert.equal(factoryReuseRuntimeMatches(f.artifact, f.state.code, addr(31)), false);
  assert.equal(factoryReuseRuntimeMatches(f.artifact, f.state.code + '00', f.implementation), false);
  for (const mutate of [a => a.immutableReferences[18] = [{ start: 0, length: 1 }],
    a => a.immutableReferences[17][0].length = 20,
    a => a.deployedLinkReferences = { 'arbitrary.sol': { NewLibrary: [{ start: 0, length: 20 }] } },
    a => a.abi.push({ type: 'constructor', inputs: [{ name: 'unreviewed', type: 'address' }] })]) {
    const bundle = structuredClone(f.bundle); mutate(bundle.artifacts.FreshPoolFactory);
    const catalog = { ...f.catalog, artifacts: bundle.artifacts, candidateArtifactDigest: buildDigest(bundle) };
    catalog.salt = factoryReuseSalt(f.a.factory, catalog.candidateArtifactDigest);
    assert.throws(() => validateFreshFactoryReuseCatalog(catalog, bundle, f.trusted));
  }
});

test('a baseline stays unchanged; fixed UUPS execution proves only the new Factory and its two aliases', async () => {
  const f = fixture(); f.state.baseline = true;
  assert.equal(await verifyFreshFactoryReuse(f.provider, f.trusted, block), null); assert.equal(f.state.codeReads, 0);
  f.state.baseline = false;
  const proof = await verifyFreshFactoryReuse(f.provider, f.trusted, block);
  assert.deepEqual(proof.replacements, { PoolFactory: f.implementation, FreshPoolFactory: f.implementation });
  assert.equal(proof.codehash.PoolFactory, keccak256(f.state.code)); assert.equal(proof.operationId, f.operation.operationId);
  const calls = f.state.calls.length;
  assert.equal(await verifyFreshFactoryReuse(f.provider, f.trusted, block), proof);
  assert.equal(f.state.codeReads, 1); assert.equal(f.state.calls.length, calls);
  f.state.reorg = true;
  await assert.rejects(verifyFreshFactoryReuse(f.provider, f.trusted, block), /anchor/);
});

test('incomplete, wrong-chain graph bindings or changed immutable runtime never activate reuse', async () => {
  for (const mutation of [s => s.done = false, s => s.version = 0n, s => s.proxyVersion = 0n,
    s => s.uuid = hash(31), s => s.owner = addr(31), s => s.timelock = addr(31),
    s => s.delay = 1n, s => s.operation = hash(31), s => s.proposer = false,
    s => s.code = s.code.slice(0, -2) + 'ff', s => s.reorg = true]) {
    const f = fixture(); mutation(f.state);
    await assert.rejects(verifyFreshFactoryReuse(f.provider, f.trusted, block));
  }
  const f = fixture(); f.provider.getStorage = async () => '0x' + 'ff'.repeat(32);
  await assert.rejects(verifyFreshFactoryReuse(f.provider, f.trusted, block), /slot/);
});
