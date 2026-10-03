import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'ethers';
import { ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { freshManifestDigest, loadFreshDisplayConfig } from '../lib/fresh-product-config.mjs';
import { loadProductConfig, loadProductDisplayConfig } from '../lib/product-config.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const keys = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock', 'portfolioFactory',
  'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation', 'portfolioFactoryImplementation'];
const authority = { address: address(30), administratorOne: address(31),
  administratorTwo: address(32), gasWallet: address(33), codehash: hash(99), deploymentTxHash: hash(98) };
const manifest = { schemaVersion: 1, kind: 'integrated-v2', chainId: 56,
  ...Object.fromEntries(keys.map((key, index) => [key, address(index + 10)])),
  codehash: Object.fromEntries(keys.map(key => [key, hash(50)])),
  authority: authority.address, gasWallet: authority.gasWallet, freshAuthority: authority,
  deployment: { txHash: hash(40), blockNumber: 90, blockHash: hash(41) },
  artifactDigest: ARTIFACT_DIGEST, sourceCommit: 'a'.repeat(40),
  verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBlockNumber: 100 };
const origin = 'https://example.test';
const options = { productFamily: 'fresh-v4', origin, basePath: '/bemine-v4',
  manifestSha256: freshManifestDigest(manifest) };
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  redirected: false, headers: { get: name => name === 'content-type' ? 'application/json' : null },
  text: async () => JSON.stringify(value) });
const noNetwork = async () => { assert.fail('Build-pinned browsing must not fetch anything.'); };

test('build-pinned display boot performs zero network calls and grants no current permissions', async () => {
  const config = await loadProductDisplayConfig({ ...options, pinnedManifest: manifest, fetcher: noNetwork });
  assert.equal(config.status, 'ready');
  assert.equal(config.stage, 'fresh-active');
  assert.equal(config.productFamily, 'fresh-v4');
  assert.equal(config.displayOnly, true);
  assert.equal(config.readMode, 'display');
  assert.equal(config.manifestSource, 'build');
  for (const key of ['transactionReady', 'operationalReady', 'userExitReady', 'freshFactoryVerified'])
    assert.equal(config[key], false, key);
  for (const key of ['verifiedBlockHash', 'stageActivationBlock', 'stageActivationHash', 'operationId'])
    assert.equal(Object.hasOwn(config, key), false, key);
  assert.equal(config.manifest, config.pinnedManifest);
  assert.equal(config.manifest.factory, manifest.factory);
  assert.equal(config.manifest.verifiedBlockNumber, 100); // Historical build data is not renewed.
  assert.equal(config.manifest.verifiedAt, manifest.verifiedAt);
  assert.equal(config.freshAuthority.administratorOne, authority.administratorOne);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.manifest), true);
  assert.equal(config.indexBaseUrl, `${origin}/bemine-v4/api/chain-index`);
  assert.equal(config.journalBase, '/bemine-v4/api/journal');
  assert.equal(config.rpcUrl, `${origin}/bemine-v4/api/rpc`);
});

test('development display fallback reads only the same-origin static manifest, never a graph or RPC', async () => {
  const calls = [];
  const config = await loadFreshDisplayConfig({ ...options, basePath: '/bemine-v4/', fetcher: async (url, init) => {
    calls.push({ url, method: init.method });
    assert.equal(url, `${origin}/bemine-v4/data/frontend-manifest.v4.json`);
    return response(manifest);
  } });
  assert.deepEqual(calls, [{ url: `${origin}/bemine-v4/data/frontend-manifest.v4.json`, method: 'GET' }]);
  assert.equal(config.manifestSource, 'same-origin');
  assert.equal(config.transactionReady, false);
});

test('display boot rejects substituted static roots and explicitly supplied invalid build roots', async () => {
  await assert.rejects(loadFreshDisplayConfig({ ...options, fetcher: async () =>
    response({ ...manifest, factory: address(200) }) }), { code: 'fresh_manifest_mismatch' });
  await assert.rejects(loadFreshDisplayConfig({ ...options,
    pinnedManifest: { ...manifest, factory: address(200) }, fetcher: noNetwork }),
  { code: 'fresh_manifest_mismatch' });
  const altered = { ...manifest, freshAuthority: undefined };
  await assert.rejects(loadFreshDisplayConfig({ ...options, pinnedManifest: altered,
    manifestSha256: freshManifestDigest(altered), fetcher: noNetwork }), { code: 'manifest_schema' });
});

test('display boot validates origin, independent v4 path and fixed digest before any requests', async () => {
  for (const changed of [{ origin: 'https://example.test/path' }, { origin: 'file:///tmp' },
    { basePath: '/bemine-v2' }, { basePath: '' }, { manifestSha256: undefined }])
    await assert.rejects(loadFreshDisplayConfig({ ...options, ...changed, pinnedManifest: manifest,
      fetcher: noNetwork }));
  assert.throws(() => loadProductDisplayConfig({ ...options, productFamily: 'other' }), /Unknown/);
});

test('missing static deployment stays unconfigured without fabricating action readiness', async () => {
  let requests = 0;
  const config = await loadFreshDisplayConfig({ ...options, fetcher: async url => {
    requests++;
    assert.equal(url, `${origin}/bemine-v4/data/frontend-manifest.v4.json`);
    return response(null, 404);
  } });
  assert.equal(requests, 1);
  assert.equal(config.status, 'unconfigured');
  assert.equal(config.displayOnly, true);
  assert.equal(config.transactionReady, false);
  assert.equal(config.operationalReady, false);
  assert.equal(config.userExitReady, false);
});

test('display read endpoints retain the existing trusted-origin restrictions', async () => {
  for (const rpcUrl of ['https://unapproved.test/rpc', 'https://user:pass@example.test/rpc',
    'http://other.test/rpc', `${origin}/rpc#fragment`])
    await assert.rejects(loadFreshDisplayConfig({ ...options, rpcUrl, pinnedManifest: manifest,
      fetcher: noNetwork }));
  const config = await loadFreshDisplayConfig({ ...options, rpcUrl: 'https://allowed.test/rpc',
    allowedRpcOrigins: ['https://allowed.test'], pinnedManifest: manifest, fetcher: noNetwork });
  assert.equal(config.rpcUrl, 'https://allowed.test/rpc');
  assert.equal(config.transactionReady, false);
});

test('action config keeps the real product-graph path; display config is not promoted by loading', async () => {
  const calls = [];
  await assert.rejects(loadProductConfig({ ...options, fetcher: async url => {
    calls.push(url);
    return response(url.endsWith('.v4.json') ? manifest : { status: 'unverified' });
  } }), { code: 'fresh_product_graph' });
  assert.deepEqual(calls, [`${origin}/bemine-v4/data/frontend-manifest.v4.json`,
    `${origin}/bemine-v4/api/journal/product-graph`]);
  const display = await loadProductDisplayConfig({ ...options, pinnedManifest: manifest, fetcher: noNetwork });
  assert.equal(display.transactionReady, false);
});
