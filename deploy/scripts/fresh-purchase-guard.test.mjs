import test from 'node:test';
import assert from 'node:assert/strict';
import { KEEPER_STATE_ROOT } from './purchase-keeper.mjs';
import { configureFreshPurchase, verifyFreshPurchaseGraph } from './fresh-purchase-guard.mjs';
import { parseSupervisorArguments } from './purchase-supervisor.mjs';
import { parseSupervisorArguments as parseMiningArguments } from './mining-supervisor.mjs';
import { ORIGINAL_GAS_WALLET } from '../shared/original-gas-wallet.mjs';

const factory = '0x1111111111111111111111111111111111111111';
const authority = '0x2222222222222222222222222222222222222222';
const gasWallet = '0x3333333333333333333333333333333333333333';
const journal = '/var/lib/pinkuang-v3/purchase/journal';
const env = {
  FRESH_PURCHASE_ENABLED: '1',
  CREDENTIALS_DIRECTORY: '/run/credentials/pinkuang-purchase-v3.service',
  PINKUANG_KEEPER_STATE_ROOT: KEEPER_STATE_ROOT,
  AUTHORITY_RELAY_JOURNAL: '/var/lib/pinkuang-v3/authority/authority.json',
  BEMINE_DEPLOYMENT_RECORD_PATH: '/var/lib/pinkuang-deploy-v3/record.json',
  BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH: '/srv/pinkuang-deploy-v3/artifacts.json',
  BEMINE_PRODUCT_ACTIVATION_PATH: '/etc/pinkuang-deploy-v3/activation.json',
  BEMINE_EXPECTED_GAS_WALLET: gasWallet,
};
const options = () => parseSupervisorArguments([
  '--factory', factory, '--journal-dir', journal, '--fresh-graph', '--send',
]);
const trusted = {
  record: { addresses: { factory } },
  bundle: { artifacts: { FreshPoolFactory: {} } },
  freshAuthority: { authority: { address: authority, gasWallet } },
};
const dependencies = { readPublicAddress: () => gasWallet, configuration: () => trusted };

test('fresh purchase and mining forward preserved policy and native-sale evidence into the graph guard', () => {
  const paths = {
    salePolicyCatalogPath: '/srv/reviewed/sale-policy-catalog.json',
    salePolicyArtifactPath: '/srv/reviewed/sale-policy-artifacts.json',
    nativeSaleCatalogPath: '/srv/reviewed/native-sale-catalog.json',
    nativeSaleArtifactPath: '/srv/reviewed/native-sale-artifacts.json',
  };
  const configuredEnv = { ...env,
    BEMINE_SALE_POLICY_CATALOG_PATH: paths.salePolicyCatalogPath,
    BEMINE_SALE_POLICY_ARTIFACT_PATH: paths.salePolicyArtifactPath,
    BEMINE_NATIVE_SALE_CATALOG_PATH: paths.nativeSaleCatalogPath,
    BEMINE_NATIVE_SALE_ARTIFACT_PATH: paths.nativeSaleArtifactPath,
  };
  const mining = parseMiningArguments(['--factory', factory, '--authority', authority,
    '--journal-dir', journal, '--fresh-graph', '--send']);
  for (const workerOptions of [options(), mining]) {
    let captured;
    const nativeEvidence = { reviewed: true };
    const guard = configureFreshPurchase(workerOptions, configuredEnv, {
      ...dependencies, configuration(input) {
        captured = input;
        return { ...trusted, freshNativeSale: nativeEvidence };
      },
    });
    assert.deepEqual(Object.fromEntries(Object.keys(paths).map(key => [key, captured[key]])), paths);
    assert.equal(guard.trusted.freshNativeSale, nativeEvidence);
    assert.throws(() => configureFreshPurchase(workerOptions, configuredEnv, {
      ...dependencies, configuration() { throw new Error('Reviewed native-sale configuration rejected.'); },
    }), /Reviewed native-sale configuration rejected/);
  }
});

test('fresh auto purchase is opt-in, credential-bound and uses separate journals', () => {
  assert.equal(configureFreshPurchase(options(), env, dependencies).gasWallet, gasWallet);
  assert.throws(() => configureFreshPurchase(options(), { ...env, FRESH_PURCHASE_ENABLED: '0' }, dependencies), /disabled/);
  assert.throws(() => configureFreshPurchase(options(), { ...env, KEEPER_PRIVATE_KEY: '0x'+'a'.repeat(64) }, dependencies), /systemd/);
  assert.throws(() => configureFreshPurchase(options(), { ...env, PINKUANG_KEEPER_STATE_ROOT: '/tmp/other' }, dependencies), /lock root/);
  assert.throws(() => configureFreshPurchase(options(), { ...env, AUTHORITY_RELAY_JOURNAL: `${journal}/authority.json` }, dependencies), /separate/);
  assert.throws(() => configureFreshPurchase(options(), env, { ...dependencies, readPublicAddress: () => authority }), /Gas credential/);
  assert.throws(() => configureFreshPurchase({ ...options(), factory: authority }, env, dependencies), /Factory or Authority/);
  assert.throws(() => configureFreshPurchase({ ...options(), journalDirExplicitAbsolute: false }, env, dependencies), /separate/);
  const originalEnv={...env,BEMINE_EXPECTED_GAS_WALLET:ORIGINAL_GAS_WALLET};
  const originalDependencies={...dependencies,readPublicAddress:()=>ORIGINAL_GAS_WALLET,
    configuration:()=>({...trusted,freshAuthority:{authority:{...trusted.freshAuthority.authority,
      gasWallet:ORIGINAL_GAS_WALLET}}})};
  assert.throws(()=>configureFreshPurchase(options(),originalEnv,originalDependencies),/drained and disabled v2 sender/);
  assert.equal(configureFreshPurchase(options(),
    {...originalEnv,BEMINE_V2_GAS_SENDER_DRAINED:'1'},originalDependencies).gasWallet,
    ORIGINAL_GAS_WALLET);
});

test('fresh auto purchase requires a current canonical graph before signing', async () => {
  const guard = configureFreshPurchase(options(), env, dependencies);
  const block = { number: 1, timestamp: Math.floor(Date.now() / 1000), hash: '0x'+'f'.repeat(64) };
  const provider = { getNetwork: async () => ({ chainId: 56n }), getBlock: async () => block };
  const graph = { freshFactoryVerified: true, artifactDigest: '0x'+'1'.repeat(64), freshAuthority: { address: authority, gasWallet, codehash:'0x'+'2'.repeat(64) }, addresses: { factory, shareMarket:authority,portfolioFactory:factory,portfolioShareMarket:authority } };
  let checks = 0;
  const proof = await verifyFreshPurchaseGraph(provider, options(), guard, { verifyDrain:async()=>{checks++;}, verifyGraph: async () => { checks++; return graph; } });
  assert.equal(proof.block, block);
  assert.equal(checks, 2);
  await assert.rejects(verifyFreshPurchaseGraph(provider, options(), guard,
    { verifyGraph: async () => ({ ...graph, freshFactoryVerified: false }) }), /graph/);
  await assert.rejects(verifyFreshPurchaseGraph({ ...provider, getNetwork: async () => ({ chainId: 97n }) },
    options(), guard, { verifyGraph: async () => graph }), /mainnet/);
  await assert.rejects(verifyFreshPurchaseGraph({ ...provider, getBlock: async () => ({ ...block, timestamp: block.timestamp - 120 }) },
    options(), guard, { verifyGraph: async () => graph }), /current/);
});
