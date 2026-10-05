import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { evidenceDigest } from './firsto-upgrade-proof.mjs';
import { preparePortfolioDustDeployment, buildPortfolioDustPlan, validatePortfolioDustChain } from './portfolio-dust-plan.mjs';

const address = number => getAddress(`0x${number.toString(16).padStart(40, '0')}`);
const salt = keccak256(toUtf8Bytes('independent portfolio remainder upgrade'));
const replacement = address(900);
const placeholder = `__$${'1'.repeat(34)}$__`;
const iface = new Interface([
  'function owner() view returns(address)', 'function timelock() view returns(address)',
  'function operator() view returns(address)', 'function treasury() view returns(address)',
  'function beacon() view returns(address)', 'function implementation() view returns(address)',
  'function OFFICIAL_FACTORY() view returns(address)', 'function coreFactory() view returns(address)',
  'function budgetFactory() view returns(address)', 'function administratorOne() view returns(address)',
  'function administratorTwo() view returns(address)', 'function gasWallet() view returns(address)',
  'function getMinDelay() view returns(uint256)', 'function hasRole(bytes32,address) view returns(bool)',
  'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns(bytes32)',
  'function getTimestamp(bytes32) view returns(uint256)', 'function isOperation(bytes32) view returns(bool)',
  'function isOperationReady(bytes32) view returns(bool)', 'function isOperationDone(bytes32) view returns(bool)',
  'function upgradeTo(address)', 'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function execute(address,uint256,bytes,bytes32,bytes32) payable',
]);
function fixture({ phase = 'unscheduled', newImplementation = false, mutate = () => {}, reorg = false } = {}) {
  const artifact = { contractName: 'BudgetPortfolioVault', abi: [{ type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'factory_', type: 'address' }] }],
    bytecode: `0x60${placeholder}6001`, deployedBytecode: `0x60${placeholder}${'0'.repeat(64)}6002`,
    linkReferences: { 'src/libraries/SaleGovernance.sol': { SaleGovernance: [{ start: 1, length: 20 }] } },
    deployedLinkReferences: { 'src/libraries/SaleGovernance.sol': { SaleGovernance: [{ start: 1, length: 20 }] } },
    immutableReferences: { factory: [{ start: 21, length: 32 }] } };
  const manifest = { kind: 'integrated-v2', chainId: 56, artifactDigest: keccak256(toUtf8Bytes('formal genesis')),
    factory: address(1), portfolioFactory: address(2), portfolioBeacon: address(3), timelock: address(4),
    portfolioImplementation: address(5), portfolioFactoryImplementation: address(6),
    authority: address(7), gasWallet: address(10), verifiedBlockNumber: 100,
    verifiedBlockHash: keccak256(toUtf8Bytes('activation')), codehash: {},
    freshAuthority: { address: address(7), administratorOne: address(8), administratorTwo: address(9), gasWallet: address(10) } };
  const code = new Map();
  for (const [index, key] of ['portfolioFactory', 'portfolioBeacon', 'timelock', 'portfolioImplementation', 'portfolioFactoryImplementation'].entries()) {
    const runtime = `0x60${(index + 10).toString(16).padStart(2, '0')}6001`; code.set(manifest[key].toLowerCase(), runtime); manifest.codehash[key] = keccak256(runtime);
  }
  code.set(manifest.authority.toLowerCase(), '0x60016002'); manifest.freshAuthority.codehash = keccak256('0x60016002');
  code.set(address(11).toLowerCase(), '0x60016003');
  const config = { schemaVersion: 1, kind: 'portfolio-dust-release-v1', chainId: 56, manifest,
    genesisRecord: { kind: 'integrated-v2', chainId: 56, status: 'complete', artifactDigest: manifest.artifactDigest,
      addresses: { factory: manifest.factory, portfolioFactory: manifest.portfolioFactory, portfolioBeacon: manifest.portfolioBeacon, timelock: manifest.timelock },
      input: { ownerMultisig: address(12) } },
    candidateArtifact: artifact, candidateArtifactHash: evidenceDigest(artifact), candidateArtifactDigest: keccak256(toUtf8Bytes('new candidate bundle')),
    saleGovernance: { address: address(11), codehash: keccak256('0x60016003') }, deployer: address(12), proposer: address(12) };
  const prepared = preparePortfolioDustDeployment(config), plan = buildPortfolioDustPlan(config, replacement, salt);
  code.set(replacement.toLowerCase(), prepared.expectedRuntime);
  const block = { number: 200, hash: keccak256(toUtf8Bytes('finalized snapshot')), timestamp: 2000000 };
  const calls = [], overrides = {}, slots = new Map([[manifest.portfolioFactory.toLowerCase(), `0x${manifest.portfolioFactoryImplementation.slice(2).toLowerCase().padStart(64, '0')}`]]);
  let snapshotReads = 0;
  const provider = {
    async getBlock(tag) {
      if (tag === 'finalized') return { ...block };
      if (tag === block.number) { snapshotReads++; return { ...block, hash: reorg && snapshotReads === 1 ? ZeroHash : block.hash }; }
      if (tag === manifest.verifiedBlockNumber) return { number: tag, hash: manifest.verifiedBlockHash };
      throw new Error(`Unexpected block ${tag}`);
    },
    async getCode(to, tag) { assert.equal(tag, block.number); calls.push(['getCode', to]); return code.get(to.toLowerCase()) ?? '0x'; },
    async getStorage(to, slot, tag) { assert.equal(tag, block.number); assert.equal(slot, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'); return slots.get(to.toLowerCase()); },
    async send(method, params) {
      calls.push([method, params]);
      if (method === 'eth_chainId') return overrides.chain ?? '0x38';
      assert.equal(method, 'eth_call', 'No wallet or write RPC belongs in this validator');
      assert.equal(params[1], `0x${block.number.toString(16)}`);
      const tx = iface.parseTransaction({ data: params[0].data }), to = params[0].to.toLowerCase();
      const key = `${to}:${tx.name}`; let value;
      if (Object.hasOwn(overrides, key)) value = overrides[key];
      else if (tx.name === 'owner' || tx.name === 'timelock') value = manifest.timelock;
      else if (tx.name === 'operator' || tx.name === 'treasury') value = manifest.authority;
      else if (tx.name === 'beacon') value = manifest.portfolioBeacon;
      else if (tx.name === 'implementation') value = newImplementation ? replacement : manifest.portfolioImplementation;
      else if (tx.name === 'OFFICIAL_FACTORY' || tx.name === 'budgetFactory') value = manifest.portfolioFactory;
      else if (tx.name === 'coreFactory') value = manifest.factory;
      else if (['administratorOne', 'administratorTwo', 'gasWallet'].includes(tx.name)) value = manifest.freshAuthority[tx.name];
      else if (tx.name === 'getMinDelay') value = 172800n;
      else if (tx.name === 'hasRole') value = true;
      else if (tx.name === 'hashOperation') value = plan.operationId;
      else if (tx.name === 'getTimestamp') value = phase === 'unscheduled' ? 0n : phase === 'done' ? 1n : phase === 'ready' ? 1900000n : 2100000n;
      else if (tx.name === 'isOperation') value = phase !== 'unscheduled';
      else if (tx.name === 'isOperationReady') value = phase === 'ready';
      else if (tx.name === 'isOperationDone') value = phase === 'done';
      else throw new Error(`Unexpected getter ${tx.name}`);
      return iface.encodeFunctionResult(tx.name, [value]);
    },
  };
  mutate({ config, code, overrides, slots, manifest, provider });
  return { config, prepared, plan, provider, block, calls, code, overrides, manifest };
}
test('CREATE preserves the portfolio Factory constructor and only the reviewed library link', () => {
  const f = fixture(), expectedFactory = f.manifest.portfolioFactory.slice(2).toLowerCase().padStart(64, '0');
  assert(f.prepared.data.endsWith(expectedFactory));
  assert.equal(f.prepared.dataHash, keccak256(f.prepared.data));
  assert(f.prepared.expectedRuntime.includes(address(11).slice(2).toLowerCase()));
  assert(f.prepared.expectedRuntime.includes(expectedFactory));
  assert(!f.prepared.expectedRuntime.includes(placeholder));
});
test('governance is one upgradeTo on the existing portfolio Beacon, with value zero and full delay', () => {
  const { config, plan } = fixture(), schedule = iface.parseTransaction({ data: plan.scheduleData }), execute = iface.parseTransaction({ data: plan.executeData });
  assert.equal(schedule.name, 'schedule'); assert.equal(execute.name, 'execute');
  assert.equal(schedule.args[0], config.manifest.portfolioBeacon); assert.equal(schedule.args[1], 0n);
  assert.equal(schedule.args[5], 172800n); assert.equal(schedule.args[3], ZeroHash);
  assert.equal(iface.parseTransaction({ data: schedule.args[2] }).name, 'upgradeTo');
  assert.equal(iface.parseTransaction({ data: schedule.args[2] }).args[0], replacement);
  const independentId = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'bytes', 'bytes32', 'bytes32'], [plan.target, 0n, plan.payload, ZeroHash, salt]));
  assert.equal(plan.operationId, independentId);
  assert.notEqual(plan.target, config.manifest.factory); assert.notEqual(plan.target, config.manifest.portfolioFactory);
  assert.throws(() => buildPortfolioDustPlan(config, replacement, salt, 172799), /48 hours/);
  assert.throws(() => buildPortfolioDustPlan(config, replacement, ZeroHash), /nonzero/);
  assert.throws(() => buildPortfolioDustPlan(config, config.manifest.portfolioImplementation, salt), /new implementation/);
});
test('changed candidate bytes, unknown library and second immutable group cannot become signing data', () => {
  const f = fixture(), changed = structuredClone(f.config); changed.candidateArtifact.bytecode += '00';
  assert.throws(() => preparePortfolioDustDeployment(changed), /fixed artifact pin/);
  const unknown = structuredClone(f.config); unknown.candidateArtifact.linkReferences['src/libraries/Other.sol'] = { Other: [{ start: 1, length: 20 }] };
  unknown.candidateArtifactHash = evidenceDigest(unknown.candidateArtifact);
  assert.throws(() => preparePortfolioDustDeployment(unknown), /Only the preserved SaleGovernance/);
  const immutable = structuredClone(f.config); immutable.candidateArtifact.immutableReferences.other = [{ start: 21, length: 32 }];
  immutable.candidateArtifactHash = evidenceDigest(immutable.candidateArtifact);
  assert.throws(() => preparePortfolioDustDeployment(immutable), /Exactly one factory immutable/);
});
test('runtime size, constructor shape and overlapping immutable locations remain release constraints', () => {
  const f = fixture();
  const oversized = structuredClone(f.config);
  oversized.candidateArtifact.deployedBytecode += '00'.repeat(24577);
  oversized.candidateArtifactHash = evidenceDigest(oversized.candidateArtifact);
  assert.throws(() => preparePortfolioDustDeployment(oversized), /EIP-170/);
  const constructor = structuredClone(f.config);
  constructor.candidateArtifact.abi[0].inputs.push({ name: 'other', type: 'address' });
  constructor.candidateArtifactHash = evidenceDigest(constructor.candidateArtifact);
  assert.throws(() => preparePortfolioDustDeployment(constructor), /single factory constructor/);
  const overlap = structuredClone(f.config);
  overlap.candidateArtifact.immutableReferences.factory.push({ start: 21, length: 32 });
  overlap.candidateArtifactHash = evidenceDigest(overlap.candidateArtifact);
  assert.throws(() => preparePortfolioDustDeployment(overlap), /Overlapping factory immutable/);
});
test('initial chain proof is finalized, immutable and never reads core implementation pointers', async () => {
  const f = fixture(), proof = await validatePortfolioDustChain(f.provider, f.config);
  assert.equal(proof.implState, 'old'); assert.equal(proof.operation, null); assert.equal(proof.blockHash, f.block.hash);
  assert.equal(proof.minDelay, '172800'); assert.equal(proof.chainActionsPerformed, false); assert(Object.isFrozen(proof));
  assert(!f.calls.some(([method, params]) => method === 'getCode' && params.toLowerCase() === f.manifest.factory.toLowerCase()));
  assert(f.calls.every(([method]) => ['getCode', 'eth_call', 'eth_chainId'].includes(method)));
});
test('replacement byte mismatch including wrong Factory immutable or library link fails exact runtime proof', async () => {
  for (const change of [runtime => runtime.replace(address(11).slice(2).toLowerCase(), address(99).slice(2).toLowerCase()),
    runtime => runtime.replace(address(2).slice(2).toLowerCase().padStart(64, '0'), address(99).slice(2).toLowerCase().padStart(64, '0'))]) {
    const f = fixture(); f.code.set(replacement.toLowerCase(), change(f.prepared.expectedRuntime));
    await assert.rejects(validatePortfolioDustChain(f.provider, f.config, { replacement }), /Replacement runtime/);
  }
});
test('preserved library, Authority, portfolio proxy and Beacon authority changes block continuation', async () => {
  const mutations = [
    ({ code }) => code.set(address(11).toLowerCase(), '0x6004'),
    ({ code, manifest }) => code.set(manifest.authority.toLowerCase(), '0x6004'),
    ({ overrides, manifest }) => { overrides[`${manifest.portfolioBeacon.toLowerCase()}:owner`] = address(88); },
    ({ overrides, manifest }) => { overrides[`${manifest.authority.toLowerCase()}:gasWallet`] = address(88); },
    ({ slots, manifest }) => slots.set(manifest.portfolioFactory.toLowerCase(), `0x${address(88).slice(2).padStart(64, '0')}`),
    ({ overrides, manifest }) => { overrides[`${manifest.timelock.toLowerCase()}:hasRole`] = false; },
    ({ overrides, manifest }) => { overrides[`${manifest.timelock.toLowerCase()}:getMinDelay`] = 172799n; },
  ];
  for (const mutate of mutations) {
    const f = fixture({ mutate }); await assert.rejects(validatePortfolioDustChain(f.provider, f.config), /differ/);
  }
});
test('operation readiness uses finalized chain time and only accepts the matching portfolio implementation phase', async () => {
  for (const phase of ['unscheduled', 'waiting', 'ready']) {
    const f = fixture({ phase }), proof = await validatePortfolioDustChain(f.provider, f.config, { replacement, salt });
    assert.equal(proof.operation, phase); assert.equal(proof.implState, 'old'); assert.equal(proof.operationReceiptVerified, false);
  }
  const done = fixture({ phase: 'done', newImplementation: true });
  assert.equal((await validatePortfolioDustChain(done.provider, done.config, { replacement, salt })).operation, 'done');
  const wrongDone = fixture({ phase: 'done' });
  await assert.rejects(validatePortfolioDustChain(wrongDone.provider, wrongDone.config, { replacement, salt }), /operation phase/);
  const premature = fixture({ phase: 'waiting', newImplementation: true });
  await assert.rejects(validatePortfolioDustChain(premature.provider, premature.config, { replacement, salt }), /operation phase/);
});
test('chain mismatch, unreviewed implementation and canonical reorg are rejected', async () => {
  const wrongChain = fixture({ mutate: ({ overrides }) => { overrides.chain = '0x1'; } });
  await assert.rejects(validatePortfolioDustChain(wrongChain.provider, wrongChain.config), /finalized BSC/);
  const unknown = fixture({ mutate: ({ overrides, manifest }) => { overrides[`${manifest.portfolioBeacon.toLowerCase()}:implementation`] = address(88); } });
  await assert.rejects(validatePortfolioDustChain(unknown.provider, unknown.config), /unreviewed implementation/);
  const reorg = fixture({ reorg: true }); await assert.rejects(validatePortfolioDustChain(reorg.provider, reorg.config), /Canonical BSC block changed/);
});
test('Timelock state and operation hash must agree, and raised minDelay must be respected', async () => {
  for (const mutate of [
    ({ overrides, manifest }) => { overrides[`${manifest.timelock.toLowerCase()}:hashOperation`] = ZeroHash; },
    ({ overrides, manifest }) => { overrides[`${manifest.timelock.toLowerCase()}:isOperationReady`] = false; },
    ({ overrides, manifest }) => { overrides[`${manifest.timelock.toLowerCase()}:getMinDelay`] = 200000n; },
  ]) {
    const f = fixture({ phase: 'ready', mutate });
    await assert.rejects(validatePortfolioDustChain(f.provider, f.config, { replacement, salt }), /differs|Inconsistent|current Timelock minimum/);
  }
});
