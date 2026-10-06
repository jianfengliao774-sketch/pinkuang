import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createJournalService } from './journal-api.mjs';

const load = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const record = load('../public/upgrade-genesis/genesis-record.json');
const bundle = load('../public/upgrade-genesis/genesis-artifacts.json');
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const names = ['PoolFunds', 'FlexiblePurchase', 'PoolVault'];
const publicCapability = {
  version: 1, candidateArtifactDigest: hash(101), catalogDigest: hash(102), operationId: hash(103),
  replacements: Object.fromEntries(names.map((name, i) => [name, address(200 + i)])),
  codehash: Object.fromEntries(names.map((name, i) => [name, hash(300 + i)])),
  verifiedBlockNumber: record.steps.find(step => step.id === 'initialize').receipt.blockNumber + 10,
  verifiedBlockHash: hash(104),
};

async function fixture({ capability = true, rejected = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'journal-target-owner-capability-'));
  const initial = record.steps.find(step => step.id === 'initialize');
  const block = { number: initial.receipt.blockNumber + 100, hash: hash(901), timestamp: 1_700_000_100 };
  const activationBlock = initial.receipt.blockNumber + 10, activationHash = hash(902);
  let clock = 1_000_000, offline = false, failedRead, verifications = 0;
  const failureReached = new Promise(resolve => { failedRead = resolve; });
  const authority = { address: address(800), gasWallet: address(801), administratorOne: address(802),
    administratorTwo: address(803), codehash: hash(804), deploymentTxHash: hash(805),
    activationBlock, activationHash };
  const provider = {
    async send(method) { assert.equal(method, 'eth_chainId'); return '0x38'; },
    async getBlock(tag) {
      if (tag === 'finalized' && offline) {
        failedRead();
        throw Object.assign(new Error('temporary read transport failure'), { code: 'NETWORK_ERROR' });
      }
      if (tag === 'finalized' || tag === block.number) return block;
      if (tag === activationBlock) return { number: tag, hash: activationHash, timestamp: block.timestamp - 1 };
      throw new Error(`Unexpected block ${tag}`);
    },
  };
  const service = createJournalService({ dbPath: join(directory, 'private', 'journal.sqlite'),
    origin: 'http://127.0.0.1:4173', provider, now: () => clock,
    currentArtifactDigest: () => record.artifactDigest,
    productDeploymentRecord: record, productArtifactBundle: bundle,
    allowedProductFactories: [record.addresses.factory, record.addresses.portfolioFactory],
    productGraphVerifier: async () => {
      verifications++;
      if (rejected) throw new Error('Reviewed target-owner upgrade did not verify.');
      return { factory: record.addresses.factory, blockNumber: block.number,
        artifactDigest: record.artifactDigest, addresses: record.addresses,
        codehash: Object.fromEntries(Object.entries(record.verification.code).map(([name, row]) => [name, row.codehash])),
        freshFactoryVerified: true, freshAuthority: authority,
        ...(capability ? { targetOwnerUpgrade: { ...publicCapability,
          // Deliberately attach private fields to guard the API serialization boundary.
          salt: 'private-governance-salt', catalog: { secret: 'private-review-record' },
          replacements: { ...publicCapability.replacements, extra: 'private-extra-replacement' },
          codehash: { ...publicCapability.codehash, extra: 'private-extra-codehash' } } } : {}) };
    } });
  const server = createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
  return { service, url, failureReached, verifications: () => verifications,
    makeOffline() { clock += 45_000; offline = true; },
    async close() { await new Promise(resolve => server.close(resolve)); await service.close();
      await rm(directory, { recursive: true, force: true }); } };
}

test('completed target-owner capability publishes verified public proof without private catalog fields', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.url); assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.targetOwnerUpgrade, publicCapability);
    assert.deepEqual(f.service.currentProductGraphSnapshot().targetOwnerUpgrade, publicCapability);
    assert.equal(payload.manifest.artifactDigest, record.artifactDigest);
    assert.equal(payload.factory, record.addresses.factory);
    assert.equal(payload.stage, 'fresh-active');
    assert.equal(payload.operationalReady, false, 'capability does not manufacture sender readiness');
    assert.equal(JSON.stringify(payload).includes('private-'), false);
    assert.equal(f.verifications(), 1);
    const selected = await fetch(`${f.url}?targetOwnerUpgrade=1`);
    assert.equal(selected.status, 400, 'callers cannot choose or manufacture capability');
    assert.equal(f.verifications(), 1);
  } finally { await f.close(); }
});

test('an absent or failed upgraded graph cannot advertise target-owner capability', async () => {
  for (const options of [{ capability: false }, { rejected: true }]) {
    const f = await fixture(options);
    try {
      const response = await fetch(f.url);
      assert.equal(response.status, options.rejected ? 503 : 200);
      const payload = await response.json(); assert.equal(payload.targetOwnerUpgrade, undefined);
      if (options.rejected) assert.equal(f.service.currentProductGraphSnapshot(), null);
    } finally { await f.close(); }
  }
});

test('retained target-owner capability is display-only after current proof transport fails', async () => {
  const f = await fixture();
  try {
    assert.equal((await (await fetch(f.url)).json()).readMode, 'current');
    f.makeOffline();
    assert.equal((await (await fetch(f.url)).json()).readMode, 'verified_snapshot');
    await f.failureReached; await new Promise(resolve => setImmediate(resolve));
    const stale = await (await fetch(f.url)).json();
    assert.deepEqual(stale.targetOwnerUpgrade, publicCapability);
    assert.equal(stale.stale, true); assert.equal(stale.transactionReady, false);
    assert.equal(stale.operationalReady, false); assert.equal(stale.userExitReady, false);
    assert.equal(stale.snapshotAgeMs, 45_000, 'failed proof cannot extend the capability snapshot age');
    assert.equal(f.verifications(), 1, 'historical capability cannot stand in for a new proof');
  } finally { await f.close(); }
});
