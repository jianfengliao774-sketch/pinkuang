import { ARTIFACT_DIGEST } from './chain-client.mjs';
import { fetchLiveJson, insist, liveAddress, validateManifest } from './live-config.mjs';
import { readTestDisplay, TEST_DISPLAY_TIMEOUT_MS } from './test-display-transport.mjs';

export const FULL_TEST_BASE = '/bemine-full-test';
export const FULL_TEST_TIMINGS = Object.freeze({ holdSeconds: 0, proposalCooldownSeconds: 0,
  nextRoundSeconds: 0, voteSeconds: 86400, listingSeconds: 604800, upgradeDelaySeconds: 0 });

const CONFIG_CACHE_AGE_MS = 30 * 60_000;
const cacheKey = origin => `bemine:full-test-display-config:${origin}:${ARTIFACT_DIGEST}`;
const browserStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

/** This cache only paints public data; it never enables transactions or automation. */
export function readCachedFullTestProductConfig({origin = globalThis.location?.origin,
  storage = browserStorage(), now = Date.now()} = {}) {
  try {
    const saved = JSON.parse(storage?.getItem(cacheKey(origin)) ?? 'null');
    if (!saved || saved.origin !== origin || !Number.isSafeInteger(saved.savedAt)
      || now < saved.savedAt || now - saved.savedAt > CONFIG_CACHE_AGE_MS) return null;
    const config = normalizeFullTestProductConfig(saved.input, origin);
    if (config.status !== 'ready') return null;
    return Object.freeze({...config, transactionReady:false, operationalReady:false, configurationCached:true});
  } catch { return null; }
}

/** A separate, same-origin test deployment; never falls back to the formal manifest. */
export async function loadFullTestProductConfig({ basePath = FULL_TEST_BASE,
  origin = globalThis.location?.origin, fetcher = globalThis.fetch,
  storage = browserStorage(), now = Date.now() } = {}) {
  insist(basePath === FULL_TEST_BASE || basePath === `${FULL_TEST_BASE}/`, 'invalid_config', '完整测试站路径无效。');
  insist(typeof origin === 'string' && /^https?:\/\//.test(origin) && new URL(origin).origin === origin,
    'invalid_config', '完整测试站来源无效。');
  const input = await readTestDisplay(() => fetchLiveJson(`${origin}${FULL_TEST_BASE}/api/full-test/config`,
    {fetcher, maxBytes:131072, timeoutMs:TEST_DISPLAY_TIMEOUT_MS}));
  const config = normalizeFullTestProductConfig(input, origin);
  try {
    if (config.status === 'ready') storage?.setItem(cacheKey(origin), JSON.stringify({origin, savedAt:now, input}));
    else storage?.removeItem(cacheKey(origin));
  } catch { /* Storage availability cannot block a live config. */ }
  return config;
}

function normalizeFullTestProductConfig(input, origin) {
  const configUrl = `${origin}${FULL_TEST_BASE}/api/full-test/config`;
  insist(input?.schemaVersion === 1 && input.profile === 'full-test' && input.chainId === 56
    && input.artifactDigest?.toLowerCase() === ARTIFACT_DIGEST.toLowerCase(),
  'full_test_config', '测试站配置与本次测试合约构建不一致。');
  insist(input.timings?.holdSeconds === 0 && input.timings?.proposalCooldownSeconds === 0
    && input.timings?.voteSeconds === 86400 && input.timings?.listingSeconds === 604800
    && (input.timings.upgradeDelaySeconds === undefined || input.timings.upgradeDelaySeconds === 0),
  'full_test_config', '测试站等待时间配置无效。');
  const roles = Object.freeze(Object.fromEntries(['deployer', 'administratorOne', 'administratorTwo', 'gasWallet']
    .map(name => [name, liveAddress(input.roles?.[name])])));
  insist(roles.administratorOne.toLowerCase() === roles.administratorTwo.toLowerCase()
    && roles.deployer.toLowerCase() === roles.administratorOne.toLowerCase()
    && roles.administratorOne.toLowerCase() !== roles.gasWallet.toLowerCase(),
    'full_test_config', '测试站使用部署钱包作为唯一管理员；Gas 钱包须独立。');
  const common = { testProfile: true, productFamily: 'fresh-v4', displayOnly: true,
    readMode: 'display', origin, basePath: FULL_TEST_BASE, roles, timings: FULL_TEST_TIMINGS,
    deployer: roles.deployer, deployConsoleUrl: `${origin}${FULL_TEST_BASE}/deploy/`,
    configUrl, manifestUrl: configUrl, artifactDigest: ARTIFACT_DIGEST,
    productGraphUrl: `${origin}${FULL_TEST_BASE}/api/journal/product-graph`,
    indexBaseUrl: `${origin}${FULL_TEST_BASE}/api/chain-index`,
    journalBase: `${FULL_TEST_BASE}/api/journal`, rpcUrl: `${origin}${FULL_TEST_BASE}/api/rpc` };
  if (input.status === 'unconfigured') return Object.freeze({ ...common, status: 'unconfigured',
    phase: input.phase, reason: '测试合约尚未完成部署及权限激活。页面已可浏览，部署完成后显示测试项目。',
    transactionReady: false, operationalReady: false, userExitReady: false });
  insist(input.status === 'ready', 'full_test_config', '完整测试站尚未就绪。');
  const manifest = validateManifest(input.manifest, ARTIFACT_DIGEST, {singleAdministrator:true});
  insist(manifest.kind === 'integrated-v2' && manifest.freshAuthority
    && manifest.freshAuthority.administratorOne.toLowerCase() === roles.administratorOne.toLowerCase()
    && manifest.freshAuthority.administratorTwo.toLowerCase() === roles.administratorTwo.toLowerCase()
    && manifest.freshAuthority.gasWallet.toLowerCase() === roles.gasWallet.toLowerCase(),
  'full_test_config', '完整测试合约权限尚未绑定本次测试角色。');
  return Object.freeze({ ...common, status: 'ready', stage: 'fresh-active',
    manifest, pinnedManifest: manifest, freshAuthority: manifest.freshAuthority,
    freshFactoryVerified: true, transactionReady: input.transactionReady === true,
    operationalReady: input.operationalReady === true, userExitReady: true });
}
