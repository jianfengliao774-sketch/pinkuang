import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Interface, getAddress } from 'ethers';
import { productGraphConfiguration, verifyProductGraph } from './product-graph.mjs';
import { createJournalService } from './journal-api.mjs';
import { buildDigest } from '../shared/firsto-upgrade-proof.mjs';
import { buildIntegratedUpgradePlan, buildIntegratedProposerBootstrapPlan,
  buildIntegratedRoleMigrationPlan, integratedUpgradeDeploymentOrder } from '../shared/integrated-upgrade-plan.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const genesisRecord = read('../public/upgrade-genesis/genesis-record.json');
const genesisBundle = read('../public/upgrade-genesis/genesis-artifacts.json');
const genesisManifest = read('../../web/public/data/frontend-manifest.json');
const candidateBundle = read('../dist/deployment-artifacts.json');
const addr = number => getAddress(`0x${number.toString(16).padStart(40, '0')}`);
const salt = digit => `0x${digit.repeat(64)}`;
const replacements = Object.fromEntries(integratedUpgradeDeploymentOrder.map((name, index) =>
  [name, addr(10_000 + index)]));

function fixture() {
  const plan = buildIntegratedUpgradePlan({ genesisRecord, genesisBundle,
    trustedGenesisManifest: genesisManifest, upgradeBundle: candidateBundle,
    trustedUpgradeArtifactDigest: buildDigest(candidateBundle), replacements,
    salt: salt('1'), delaySeconds: 172800 });
  const bootstrapPlan = buildIntegratedProposerBootstrapPlan({ genesisRecord, genesisBundle,
    trustedGenesisManifest: genesisManifest, hardwareWallet: addr(20_000),
    salt: salt('2'), delaySeconds: 172800 });
  const evidence = { plan, bootstrapPlan };
  const configuration = () => productGraphConfiguration({ record: genesisRecord, bundle: genesisBundle,
    integratedUpgradeEvidence: evidence, integratedUpgradeArtifact: candidateBundle,
    genesisManifest });
  return { evidence, configuration };
}

test('integrated product graph retains the genesis runtime and pins a separate upgrade build', () => {
  const { evidence, configuration } = fixture();
  const trusted = configuration();
  assert.equal(trusted.record.artifactDigest, genesisRecord.artifactDigest);
  assert.equal(trusted.bundle.artifacts.PoolFactory.bytecode, genesisBundle.artifacts.PoolFactory.bytecode);
  assert.equal(trusted.integratedUpgrade.digest, buildDigest(candidateBundle));
  assert.equal(trusted.integratedUpgrade.plan.operationId, evidence.plan.operationId);
  evidence.plan.salt = salt('3');
  assert.equal(trusted.integratedUpgrade.plan.salt, salt('1'), 'caller cannot mutate the trusted plan');
  assert.throws(configuration, /differs from the reviewed server evidence/);
});

test('integrated product graph rejects a changed genesis, candidate, manifest or hardware bootstrap', () => {
  const { evidence } = fixture();
  const options = { record: genesisRecord, bundle: genesisBundle,
    integratedUpgradeEvidence: evidence, integratedUpgradeArtifact: candidateBundle, genesisManifest };
  const changedRecord = structuredClone(genesisRecord); changedRecord.artifactDigest = salt('4');
  assert.throws(() => productGraphConfiguration({ ...options, record: changedRecord }), /completed, verified/);
  const changedCandidate = structuredClone(candidateBundle); changedCandidate.artifacts.PoolFactory.bytecode += '00';
  assert.throws(() => productGraphConfiguration({ ...options, integratedUpgradeArtifact: changedCandidate }), /digest|reviewed/);
  const changedManifest = structuredClone(genesisManifest); changedManifest.factory = addr(44_000);
  assert.throws(() => productGraphConfiguration({ ...options, genesisManifest: changedManifest }), /Genesis factory/);
  const changedEvidence = structuredClone(evidence); changedEvidence.bootstrapPlan.hardwareWallet = addr(55_000);
  assert.throws(() => productGraphConfiguration({ ...options, integratedUpgradeEvidence: changedEvidence }),
    /bootstrap differs/);
});

test('an independently pinned Authority plan requires the approved administrators and exact deployment hash', () => {
  const { evidence } = fixture();
  evidence.rolePlan = buildIntegratedRoleMigrationPlan({ genesisRecord, codePlan: evidence.plan,
    bootstrapPlan: evidence.bootstrapPlan, authorityAddress: addr(30_000),
    hardwareWallet: evidence.bootstrapPlan.hardwareWallet, salt: salt('3'), delaySeconds: 172800 });
  const opts = { record: genesisRecord, bundle: genesisBundle,
    integratedUpgradeEvidence: evidence, integratedUpgradeArtifact: candidateBundle, genesisManifest };
  assert.throws(() => productGraphConfiguration(opts), /Authority requires a reviewed deployment/);
  evidence.authority = { address: addr(30_000), deploymentTxHash: salt('4'),
    administratorOne: '0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',
    administratorTwo: '0xeD2FCBe59EBe1754a3676aeb9CcfBA20f193FcbB', gasWallet: addr(40_000) };
  assert.equal(productGraphConfiguration(opts).integratedUpgrade.rolePlan.authorityAddress, addr(30_000));
  evidence.authority.administratorOne = addr(99_000);
  assert.throws(() => productGraphConfiguration(opts), /administrators differ/);
});

test('unknown Factory implementation fails before any other product read', async () => {
  const trusted = fixture().configuration();
  let reads = 0;
  const provider = { async getStorage() { reads++; return `0x${addr(888_888).slice(2).padStart(64, '0')}`; },
    async send() { throw new Error('unexpected eth_call'); },
    async getCode() { throw new Error('unexpected eth_getCode'); } };
  await assert.rejects(verifyProductGraph(provider, genesisRecord.addresses.factory, trusted,
    { number: 1, hash: salt('5') }), /neither the reviewed genesis nor the reviewed upgrade/);
  assert.equal(reads, 1);
});

test('public product-graph response is pinned to a verified block and never falls back to an unreviewed digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'product-graph-api-'));
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const block = { number: initial.receipt.blockNumber+100, hash: salt('6'), timestamp: 1_700_000_100 };
  let clock=1_000_000;
  const provider = { async send(method) { assert.equal(method, 'eth_chainId'); return '0x38'; },
    async getBlock(tag) {
      if (tag === 'finalized' || tag === block.number) return block;
      if (tag === initial.receipt.blockNumber) return {
        number:tag,hash:initial.receipt.blockHash,timestamp:1_700_000_000};
      throw new Error(`Unexpected block ${tag}`);
    } };
  const addresses = genesisRecord.addresses;
  let verifiedDigest = genesisRecord.artifactDigest;
  const service = createJournalService({ dbPath: join(directory, 'private', 'journal.sqlite'),
    origin: 'http://127.0.0.1:4173', provider, now:()=>clock,
    currentArtifactDigest: () => genesisRecord.artifactDigest,
    productDeploymentRecord: genesisRecord, productArtifactBundle: genesisBundle,
    allowedProductFactories: [addresses.factory, addresses.portfolioFactory],
    productGraphVerifier: async (_provider, factory, confirmedBlock) => {
      assert.equal(factory, addresses.factory);
      assert.deepEqual(confirmedBlock, block);
      return { factory, blockNumber: block.number, artifactDigest: verifiedDigest,
        addresses, codehash: Object.fromEntries(Object.entries(genesisRecord.verification.code)
          .map(([name, value]) => [name, value.codehash])) };
    } });
  const server = createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    const valid = await fetch(base);
    assert.equal(valid.status, 200);
    const payload = await valid.json();
    assert.equal(payload.stage, 'genesis');
    assert.equal(payload.manifest.artifactDigest, genesisRecord.artifactDigest);
    assert.equal(payload.manifest.deployment.txHash,
      genesisRecord.steps.find(step => step.id === 'initialize').txHash);
    assert.equal(payload.manifest.codehash.factory,
      genesisRecord.verification.code.factory.codehash);
    assert.equal(payload.stageActivationBlock,initial.receipt.blockNumber);
    assert.equal(payload.stageActivationHash,initial.receipt.blockHash);
    clock+=100;
    assert.equal((await (await fetch(base)).json()).snapshotAgeMs,100,
      'read-only bootstrap may reuse a bounded verified snapshot');
    assert.equal((await fetch(`${base}?pool=${addresses.factory}`)).status, 400);
    verifiedDigest = salt('7');
    clock+=20_000;block.number++;block.hash = salt('8');
    assert.equal((await fetch(base)).status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('public product-graph response exposes the reviewed candidate manifest only after its verifier passes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'product-graph-candidate-api-'));
  const { evidence } = fixture();
  const deploymentBlock=genesisRecord.steps.find(step=>step.id==='initialize').receipt.blockNumber;
  const activationBlock=deploymentBlock+10;
  const activationHash=salt('d');
  evidence.codeExecuteTxHash=salt('e');
  const block = { number: deploymentBlock+100, hash: salt('9'), timestamp: 1_700_000_100 };
  let clock=2_000_000;
  const executionAbi=new Interface([
    'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  ]);
  const logs=evidence.plan.targets.map((target,index)=>({
    address:genesisRecord.addresses.timelock,transactionHash:evidence.codeExecuteTxHash,
    blockHash:activationHash,removed:false,
    ...executionAbi.encodeEventLog('CallExecuted',[
      evidence.plan.operationId,BigInt(index),target,0n,evidence.plan.payloads[index],
    ]),
  }));
  const tx={hash:evidence.codeExecuteTxHash,chainId:56n,blockNumber:activationBlock,
    blockHash:activationHash,index:0};
  const receipt={hash:evidence.codeExecuteTxHash,status:1,blockNumber:activationBlock,
    blockHash:activationHash,index:0,logs};
  const provider = {
    async send(method) { assert.equal(method,'eth_chainId');return '0x38'; },
    async getTransaction(hash) { assert.equal(hash,evidence.codeExecuteTxHash);return tx; },
    async getTransactionReceipt(hash) { assert.equal(hash,evidence.codeExecuteTxHash);return receipt; },
    async getBlock(tag) {
      if (tag==='finalized' || tag===block.number) return block;
      if (tag===activationBlock) return {number:tag,hash:activationHash,
        timestamp:block.timestamp-1,transactions:[evidence.codeExecuteTxHash]};
      throw new Error(`Unexpected block ${tag}`);
    },
  };
  const candidateAddresses = { ...genesisRecord.addresses, ...replacements };
  const codehash = Object.fromEntries(Object.entries(genesisRecord.verification.code)
    .map(([name, value]) => [name, value.codehash]));
  codehash.BudgetPortfolioVault = salt('a');
  codehash.BudgetPortfolioFactory = salt('b');
  let verified = true;
  const service = createJournalService({ dbPath: join(directory, 'private', 'journal.sqlite'),
    origin: 'http://127.0.0.1:4173', provider, now:()=>clock,
    currentArtifactDigest: () => genesisRecord.artifactDigest,
    productDeploymentRecord: genesisRecord, productArtifactBundle: genesisBundle,
    integratedUpgradeEvidence: evidence, integratedUpgradeArtifact: candidateBundle, genesisManifest,
    allowedProductFactories: [genesisRecord.addresses.factory, genesisRecord.addresses.portfolioFactory],
    productGraphVerifier: async () => {
      if (!verified) throw new Error('candidate no longer verified');
      return { factory: genesisRecord.addresses.factory, blockNumber: block.number,
        artifactDigest: buildDigest(candidateBundle), addresses: candidateAddresses, codehash,
        securityUpgrade: { operationId: evidence.plan.operationId, roleWiringComplete: false } };
    } });
  const server = createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    receipt.logs=[];
    assert.equal((await fetch(url)).status,503,'a claimed execute hash without exact Timelock events is not an activation');
    receipt.logs=logs;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.stage, 'code-upgraded');
    assert.equal(payload.artifactDigest, buildDigest(candidateBundle));
    assert.equal(payload.manifest.portfolioImplementation, replacements.BudgetPortfolioVault);
    assert.equal(payload.manifest.codehash.portfolioFactoryImplementation, salt('b'));
    assert.equal(payload.stageActivationBlock,activationBlock);
    assert.equal(payload.stageActivationHash,activationHash);
    assert.equal(payload.manifest.verifiedBlockNumber,activationBlock);
    assert.equal(payload.verifiedBlockNumber,block.number);
    assert.equal(payload.operationalReady, false);
    verified = false;clock+=20_000;block.number++;block.hash = salt('c');
    assert.equal((await fetch(url)).status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
