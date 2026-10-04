import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatV2GenesisGraph, createV2GenesisGraphReader } from './v2-genesis-public-graph.mjs';
import { patchD09Journal } from './stage-d09.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
// This tests the original d09 runtime. Later releases replaced the mutable
// upgrade-genesis files with a FreshPoolFactory graph that d09 cannot verify.
const evidenceSource = '8958edd1cf5fbf0402a4ae448782dd04f6e00e1e';
const artifactDigest = '0x7617c81d718e2127be6b1878abad81d7a3c8bf9c4f8cb35bf85755e42df049d7';
const artifactSource = '8c5598cf44fe8fb6174969eba12b3baa13f7942b';
const historical = path => execFileSync('git', ['show', `${evidenceSource}:${path}`],
  { cwd: root, maxBuffer: 12_000_000 });
const record = JSON.parse(historical('deploy/public/upgrade-genesis/genesis-record.json'));
const bundle = JSON.parse(historical('deploy/public/upgrade-genesis/genesis-artifacts.json'));
const manifestBytes = historical('web/public/data/frontend-manifest.json');
const manifest = JSON.parse(manifestBytes);
assert.equal(record.artifactDigest, artifactDigest);
assert.equal(manifest.artifactDigest, artifactDigest);
for (const evidence of [record, bundle, manifest]) assert.equal(evidence.sourceCommit, artifactSource);
assert.equal(record.addresses.factory, manifest.factory);
assert.ok(record.addresses.PoolFactory);
assert.equal(record.addresses.FreshPoolFactory, undefined);

// Exercise the exact current validator source with this page's preserved v2
// build pin, in a disposable tree. No checked-in UI or manifest is changed.
const pageFixture = await mkdtemp(join(tmpdir(), 'v2-genesis-page-'));
after(() => rm(pageFixture, { recursive: true, force: true }));
mkdirSync(join(pageFixture, 'lib'), { recursive: true });
mkdirSync(join(pageFixture, 'public/data'), { recursive: true });
for (const name of ['live-config.mjs', 'chain-client.mjs', 'contracts.generated.json', 'read-retry.mjs']) {
  const original = join(root, 'web/lib', name), copy = join(pageFixture, 'lib', name);
  copyFileSync(original, copy);
  assert.ok(readFileSync(copy).equals(readFileSync(original)), `Validator source differs: ${name}`);
}
writeFileSync(join(pageFixture, 'public/data/frontend-manifest.json'), manifestBytes);
symlinkSync(join(root, 'deploy/node_modules'), join(pageFixture, 'node_modules'));
const { loadLiveConfig, validateProductGraph, GENESIS_ARTIFACT_DIGEST } =
  await import(pathToFileURL(join(pageFixture, 'lib/live-config.mjs')));
assert.equal(GENESIS_ARTIFACT_DIGEST, artifactDigest);
const initial = record.steps.find(step => step.id === 'initialize');
const activation = { number: initial.receipt.blockNumber, hash: initial.receipt.blockHash,
  timestamp: Math.floor(Date.parse(manifest.verifiedAt) / 1000) };
const finalized = { number: record.verification.blockNumber + 100, hash: `0x${'ab'.repeat(32)}` };
const graph = { factory: record.addresses.factory, legacyFactory: record.addresses.factory,
  productKind: 'pool', artifactDigest: record.artifactDigest, blockNumber: finalized.number };

test('v2-only public graph is accepted by current page sources with the preserved v2 build pin', () => {
  const response = formatV2GenesisGraph(record, graph, finalized, activation);
  const page = validateProductGraph(response, manifest);
  assert.equal(page.stage, 'genesis');
  assert.equal(page.manifest.factory, manifest.factory);
  assert.equal(page.manifest.portfolioFactory, manifest.portfolioFactory);
  assert.equal(page.artifactDigest, manifest.artifactDigest);
  assert.equal(page.operationalReady, false);
  assert.equal(response.upgradeArtifactDigest, null);
});

test('v2 graph rejects any upgrade proof or wrong historical code evidence', () => {
  assert.throws(() => formatV2GenesisGraph(record, { ...graph, upgrade: {} }, finalized, activation), /original deployment/);
  const changed = structuredClone(record);
  changed.verification.code.factory.codehash = 'invalid';
  assert.throws(() => formatV2GenesisGraph(changed, graph, finalized, activation), /code evidence/);
});

test('single-flight finalized reads are cached and failures are briefly cooled down', async () => {
  let now = 1000, graphCalls = 0, fail = false;
  const provider = { async send() { return '0x38'; }, async getBlock(number) {
    if (fail) throw new Error('RPC unavailable');
    if (number === 'finalized' || number === finalized.number) return finalized;
    if (number === activation.number) return activation;
    throw new Error('Unexpected block');
  } };
  const reader = createV2GenesisGraphReader({ provider, trustedProduct: { record },
    graphVerifier: async () => { graphCalls++; return graph; }, now: () => now,
    ttlMs: 20, retryMs: 3 });
  const first = await Promise.all([reader(), reader(), reader()]);
  assert.equal(graphCalls, 1);
  assert.ok(first.every(item => item.artifactDigest === record.artifactDigest));
  now += 10;
  assert.equal((await reader()).snapshotAgeMs, 10);
  assert.equal(graphCalls, 1);
  now += 11; fail = true;
  await assert.rejects(reader(), /RPC unavailable/);
  await assert.rejects(reader(), /cooling down/);
  now += 3; fail = false;
  await reader();
  assert.equal(graphCalls, 2);
});

test('exact d09b25c patch inserts public route before login and rejects a zero-priced share listing', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const original = execFileSync('git', ['show', 'd09b25c:deploy/server/journal-api.mjs'], { cwd: root });
  const patched = patchD09Journal(original).toString('utf8');
  assert.ok(patched.indexOf("path === '/api/journal/product-graph'")
    < patched.indexOf("if (!account) fail(401, 'Wallet session is required.')"));
  assert.match(patched, /decoded\.name === 'list' && decoded\.args\[2\] === 0n/);
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patched, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.throws(() => patchD09Journal(Buffer.from(patched)), /Not the reviewed/);
});

test('patched d09b25c runtime serves only its verified genesis graph without a wallet session', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'v2-genesis-graph-compat-'));
  let server, service, graphFailure = false, corruptGraph = false;
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', 'd09b25c', 'deploy'],
      { cwd: root, maxBuffer: 30_000_000 });
    const unpack = spawnSync('tar', ['-xf', '-', '-C', directory], { input: archive });
    assert.equal(unpack.status, 0, unpack.stderr?.toString());
    const oldJournal = join(directory, 'deploy/server/journal-api.mjs');
    writeFileSync(oldJournal, patchD09Journal(readFileSync(oldJournal)));
    copyFileSync(new URL('./v2-genesis-public-graph.mjs', import.meta.url),
      join(directory, 'deploy/server/v2-genesis-public-graph.mjs'));
    symlinkSync(join(root, 'deploy/node_modules'), join(directory, 'deploy/node_modules'));
    const module = await import(pathToFileURL(oldJournal));
    const oldGraph = await import(pathToFileURL(join(directory, 'deploy/server/product-graph.mjs')));
    const freshRecord = JSON.parse(readFileSync(new URL('../../../public/upgrade-genesis/genesis-record.json', import.meta.url)));
    const freshBundle = JSON.parse(readFileSync(new URL('../../../public/upgrade-genesis/genesis-artifacts.json', import.meta.url)));
    assert.ok(freshRecord.addresses.FreshPoolFactory, 'negative fixture must be the actual later Fresh graph');
    assert.equal(freshRecord.addresses.PoolFactory, undefined, 'do not fabricate a legacy implementation alias');
    assert.throws(() => oldGraph.productGraphConfiguration({ record: freshRecord, bundle: freshBundle }),
      /invalid address/, 'the old runtime must reject the later Fresh graph');
    const provider = { async send() { return '0x38'; }, async getBlock(number) {
      if (number === 'finalized' || number === finalized.number) return finalized;
      if (number === activation.number) return activation;
      throw new Error('Unexpected block');
    } };
    service = module.createJournalService({ dbPath: join(directory, 'journal.sqlite'),
      origin: 'http://127.0.0.1:4173', provider,
      currentArtifactDigest: () => record.artifactDigest,
      allowedProductFactories: [record.addresses.factory, record.addresses.portfolioFactory],
      productDeploymentRecord: record, productArtifactBundle: bundle,
      productGraphVerifier: async () => graph });
    server = createServer((request, response) => {
      if (request.url === '/bemine-v2/data/frontend-manifest.json') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(manifest));
        return;
      }
      if (request.url.startsWith('/bemine-v2/api/')) {
        request.url = request.url.replace('/bemine-v2/api/', '/api/');
      }
      if (request.url === '/api/journal/product-graph' && graphFailure) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Verification unavailable' }));
        return;
      }
      if (request.url === '/api/journal/product-graph' && corruptGraph) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'verified', chainId: 56, stage: 'genesis' }));
        return;
      }
      service.handle(request, response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/journal/product-graph`);
    assert.equal(response.status, 200);
    assert.equal(validateProductGraph(await response.json(), manifest).stage, 'genesis');
    const liveConfig = await loadLiveConfig({ origin: base, basePath: '/bemine-v2' });
    assert.equal(liveConfig.status, 'ready');
    assert.equal(liveConfig.stage, 'genesis');
    assert.equal(liveConfig.manifest.factory, manifest.factory);
    assert.equal(liveConfig.operationalReady, false);
    graphFailure = true;
    await assert.rejects(loadLiveConfig({ origin: base, basePath: '/bemine-v2' }), /HTTP 503/);
    graphFailure = false;
    corruptGraph = true;
    await assert.rejects(loadLiveConfig({ origin: base, basePath: '/bemine-v2' }),
      error => error.code === 'product_graph');
    corruptGraph = false;
    assert.equal((await fetch(`${base}/api/journal/product-graph?factory=other`)).status, 400);
    assert.equal((await fetch(`${base}/api/journal/session`)).status, 401);

    const zeroPrice = { factory: record.addresses.factory, targetType: 'market',
      action: { kind: 'list' }, value: '0',
      data: module.PRODUCT_MARKET_ABI.encodeFunctionData('list', [record.addresses.factory, 1n, 0n]) };
    await assert.rejects(module.verifyProductIntent(provider, zeroPrice,
      new Set([record.addresses.factory.toLowerCase()])), /Share listing price must be positive/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (service) await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
