import { verifyFreshLegacyDrain } from '../server/fresh-machine-readiness.mjs';
import { freshGraphIdentity } from '../shared/fresh-runtime-identity.mjs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Contract, getAddress } from 'ethers';
import { productGraphConfiguration, verifyProductGraph } from '../server/product-graph.mjs';
import { KEEPER_STATE_ROOT } from './purchase-keeper.mjs';
import { readKeeperPublicAddress } from './keeper-credential.mjs';
import { requireOriginalSenderDrained } from '../shared/original-gas-wallet.mjs';

const same = (a, b) => getAddress(a) === getAddress(b);
const within = (child, parent) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
};

/** A separate, opt-in gate for the fresh Factory. The v2 supervisor never enters it. */
export function configureFreshPurchase(options, env = process.env, dependencies = {}) {
  if (!options.freshGraph) return null;
  if (options.send && env.FRESH_PURCHASE_ENABLED !== '1')
    throw new Error('Fresh automatic purchase is disabled until explicitly activated.');
  if (!env.CREDENTIALS_DIRECTORY || env.KEEPER_PRIVATE_KEY || env.KEEPER_PRIVATE_KEY_FILE)
    throw new Error('Fresh purchase requires only a systemd Gas-wallet credential.');
  if (!env.PINKUANG_KEEPER_STATE_ROOT || !isAbsolute(env.PINKUANG_KEEPER_STATE_ROOT)
    || env.PINKUANG_KEEPER_STATE_ROOT !== KEEPER_STATE_ROOT)
    throw new Error('Fresh purchase must share the explicit Gas-wallet lock root with relay and mining.');
  if (!options.journalDirExplicitAbsolute || !isAbsolute(options.journalDir)
    || !env.AUTHORITY_RELAY_JOURNAL || !isAbsolute(env.AUTHORITY_RELAY_JOURNAL)
    || within(env.AUTHORITY_RELAY_JOURNAL, options.journalDir)
    || within(options.journalDir, dirname(env.AUTHORITY_RELAY_JOURNAL)))
    throw new Error('Fresh purchase requires a separate absolute journal directory.');
  for (const key of ['BEMINE_DEPLOYMENT_RECORD_PATH', 'BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH',
    'BEMINE_PRODUCT_ACTIVATION_PATH']) {
    if (!env[key] || !isAbsolute(env[key])) throw new Error(`Fresh purchase requires ${key}.`);
  }
  const gasWallet = getAddress(env.BEMINE_EXPECTED_GAS_WALLET);
  if (options.send) requireOriginalSenderDrained(gasWallet, env);
  const credentialAddress = (dependencies.readPublicAddress ?? readKeeperPublicAddress)(env);
  if (!same(credentialAddress, gasWallet))
    throw new Error('Gas credential public address differs from the reviewed wallet.');
  const trusted = (dependencies.configuration ?? productGraphConfiguration)({
    recordPath: env.BEMINE_DEPLOYMENT_RECORD_PATH,
    bundlePath: env.BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH,
    productActivationPath: env.BEMINE_PRODUCT_ACTIVATION_PATH,
    expectedGasWallet: gasWallet,
    salePolicyCatalogPath: env.BEMINE_SALE_POLICY_CATALOG_PATH,
    salePolicyArtifactPath: env.BEMINE_SALE_POLICY_ARTIFACT_PATH,
    nativeSaleCatalogPath: env.BEMINE_NATIVE_SALE_CATALOG_PATH,
    nativeSaleArtifactPath: env.BEMINE_NATIVE_SALE_ARTIFACT_PATH,
  });
  if (!trusted?.bundle?.artifacts?.FreshPoolFactory || !trusted?.freshAuthority
    || !same(options.factory, trusted.record.addresses.factory)
    || !same(trusted.freshAuthority.authority.gasWallet, gasWallet))
    throw new Error('Fresh Factory or Authority differs from the reviewed deployment.');
  return { trusted, gasWallet };
}

export async function verifyFreshPurchaseGraph(provider, options, guard, dependencies = {}) {
  if ((await provider.getNetwork()).chainId !== 56n)
    throw new Error('Fresh purchase requires BSC mainnet.');
  const block = await provider.getBlock('latest');
  if (!block || !Number.isSafeInteger(block.number) || !Number.isSafeInteger(block.timestamp)
    || Math.abs(Math.floor(Date.now() / 1000) - block.timestamp) > 90)
    throw new Error('Fresh purchase cannot verify a current BSC block.');
  const graph = await (dependencies.verifyGraph ?? verifyProductGraph)(provider, options.factory, guard.trusted, block);
  if (!graph.freshFactoryVerified || !graph.freshAuthority
    || !same(graph.addresses.factory, options.factory)
    || !same(graph.freshAuthority.address, guard.trusted.freshAuthority.authority.address)
    || !same(graph.freshAuthority.gasWallet, guard.gasWallet))
    throw new Error('Fresh purchase graph or Gas-wallet binding changed.');
  if (options.send) await (dependencies.verifyDrain ?? verifyFreshLegacyDrain)(provider, freshGraphIdentity(graph), {allowCurrentPending:options.reconcileExisting === true});
  return { block, graph };
}

export async function verifyFreshPurchasePool(provider, options, guard, pool, dependencies = {}) {
  const { block } = await verifyFreshPurchaseGraph(provider, options, guard, dependencies);
  const factory = new Contract(options.factory,
    ['function isPool(address) view returns(bool)'], provider);
  const vault = new Contract(pool,
    ['function factory() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)'], provider);
  const tag = { blockTag: block.number };
  const [registered, boundFactory, officialFactory] = await Promise.all([
    factory.isPool(pool, tag), vault.factory(tag), vault.OFFICIAL_FACTORY(tag),
  ]);
  if (!registered || !same(boundFactory, options.factory) || !same(officialFactory, options.factory))
    throw new Error('Fresh purchase pool is not registered in the reviewed Factory.');
}
