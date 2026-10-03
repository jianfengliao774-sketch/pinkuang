import trustedGenesisManifest from '../../web/public/data/frontend-manifest.json';
import { artifactDigest, validateArtifacts, type ArtifactBundle } from './deployment';
import type { IntegratedProposerBootstrapPlan, IntegratedUpgradePlan } from '../shared/integrated-upgrade-plan.mjs';
import type { WalletProvider } from './wallet';

const UPGRADE_ORIGIN = 'https://bemine.cc.cd';
const PRODUCT_ORIGIN = 'https://bemine.cc.cd';
const PRODUCT_BASE = '/bemine-v5';
const PRODUCT_MANIFEST_SHA256 = '0697a2d36e1056192c357c4cc82dc3e68f4993e79776ebe9257f59772dd950df';
const PRODUCT_HOME_SHA256 = '7ac16fe9100938cbf7711722bf21dbbb0e51c2e3b2bb00201ae66cd2f6ddcd4b';
const PRODUCT_APP_SHA256 = '0a59a3aa45bbcbaa87e4245a7566b31b84289146ad9b457472a16e07cd87dc70';
const PRODUCT_RELEASE_SHA256 = '0be7a34dbf9c7d52a4bb172b582523ae29cbf191d04eacd48f22634e4e5923d2';
const HASH = /^0x[0-9a-f]{64}$/i;
const ANCHORS = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock', 'portfolioFactory',
  'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation', 'portfolioFactoryImplementation'] as const;
const blocked = (reason: string): UpgradeExecutionRelease => ({ ready: false, reason });
const same = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
function insist(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export type UpgradeExecutionRelease = { ready: boolean; reason: string; verifiedBlockNumber?: number };
export type UpgradeReleaseInputs = {
  candidateBundle: ArtifactBundle;
  candidateDigest: string;
  plan: IntegratedUpgradePlan;
  bootstrapPlan: IntegratedProposerBootstrapPlan;
  wallet: WalletProvider;
  origin?: string;
  fetcher?: typeof fetch;
};

/** An unverified release is never enough to authorize a Timelock signature. */
export const initialUpgradeExecutionRelease: UpgradeExecutionRelease = blocked(
  '正在核验正式 v5 网站、独立升级包及 BSC 当前链图；暂不可签署升级批次。');

async function read(fetcher: typeof fetch, url: string, expectedType: RegExp, maxBytes: number,
  init: RequestInit = {}): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetcher(url, { cache: 'no-store', credentials: 'omit', redirect: 'error',
    signal: AbortSignal.timeout(15_000), ...init });
  insist(response.ok && !response.redirected && (!response.url || response.url === url)
    && expectedType.test(response.headers.get('content-type') || ''),
  `正式发布证据不可用：${new URL(url).pathname}（HTTP ${response.status}）。`);
  const announced = Number(response.headers.get('content-length'));
  insist(!Number.isFinite(announced) || announced <= maxBytes, '正式发布证据超过大小限制。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  insist(bytes.byteLength > 0 && bytes.byteLength <= maxBytes, '正式发布证据为空或超过大小限制。');
  return bytes;
}

const decoded = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  insist(!!globalThis.crypto?.subtle, '浏览器无法核验 SHA-256。');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
}

/** Checks the separately hosted signing package against the currently active v5 genesis. */
export async function checkUpgradeExecutionRelease(input: UpgradeReleaseInputs): Promise<UpgradeExecutionRelease> {
  try {
    insist((input.origin ?? globalThis.location?.origin) === UPGRADE_ORIGIN,
      '只允许从 bemine.cc.cd 的正式升级入口发起签名。');
    insist(HASH.test(input.candidateDigest) && same(artifactDigest(input.candidateBundle), input.candidateDigest)
      && !same(input.candidateDigest, trustedGenesisManifest.artifactDigest),
    '升级页候选产物与已部署的 v5 旧图不匹配。');
    const fetcher = input.fetcher ?? fetch;
    const graphUrl = `${PRODUCT_ORIGIN}${PRODUCT_BASE}/api/journal/product-graph`;
    const manifestUrl = `${PRODUCT_ORIGIN}${PRODUCT_BASE}/data/frontend-manifest.v5.json`;
    const productUrl = `${PRODUCT_ORIGIN}${PRODUCT_BASE}/`;
    const releaseUrl = `${PRODUCT_ORIGIN}${PRODUCT_BASE}/fresh-product-release.json`;
    const runtimeUrl = `${UPGRADE_ORIGIN}/pinkuang-upgrade-v5/deployment-artifacts.json`;
    const [graphBytes, runtimeBytes, manifestBytes, htmlBytes, releaseBytes] = await Promise.all([
      read(fetcher, graphUrl, /\bapplication\/json\b/i, 1_000_000),
      read(fetcher, runtimeUrl, /\bapplication\/json\b/i, 8_000_000),
      read(fetcher, manifestUrl, /\bapplication\/json\b/i, 20_000),
      read(fetcher, productUrl, /\btext\/html\b/i, 1_000_000),
      read(fetcher, releaseUrl, /\bapplication\/json\b/i, 20_000),
    ]);
    insist(await sha256(manifestBytes) === PRODUCT_MANIFEST_SHA256
      && JSON.stringify(JSON.parse(decoded(manifestBytes))) === JSON.stringify(trustedGenesisManifest),
    '正式 v5 合约清单与本页固定的主网旧图不符。');
    const release = JSON.parse(decoded(releaseBytes)) as Record<string, any>;
    insist(await sha256(releaseBytes) === PRODUCT_RELEASE_SHA256
      && release.kind === 'fresh-v5-product-static-candidate' && release.chainId === 56
      && release.basePath === PRODUCT_BASE && release.publicOrigin === PRODUCT_ORIGIN
      && release.publicUrl === `${PRODUCT_ORIGIN}${PRODUCT_BASE}/`
      && same(release.artifactDigest, trustedGenesisManifest.artifactDigest),
    '正式 v5 网站发布记录与固定的生产版本不符。');

    const servedBundle = JSON.parse(decoded(runtimeBytes)) as ArtifactBundle;
    validateArtifacts(servedBundle);
    insist(same(artifactDigest(servedBundle), input.candidateDigest),
      '独立升级入口提供的字节码与本机已核验的候选产物不同。');
    insist(await sha256(htmlBytes) === PRODUCT_HOME_SHA256,
      'bemine.cc.cd 当前首页不是已核验的 v5 正式页面。');
    const html = decoded(htmlBytes);
    const pageScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
      .map(match => new URL(match[1], PRODUCT_ORIGIN))
      .filter(url => url.origin === PRODUCT_ORIGIN
        && /^\/bemine-v5\/_next\/static\/chunks\/app\/page-[\w-]+\.js$/.test(url.pathname)
        && !url.search && !url.hash);
    insist(pageScripts.length === 1, '正式 v5 首页没有唯一的主应用脚本。');
    const productJsBytes = await read(fetcher, pageScripts[0].href,
      /\b(?:application|text)\/javascript\b/i, 2_000_000);
    insist(await sha256(productJsBytes) === PRODUCT_APP_SHA256,
      '正式 v5 应用脚本与已审阅的网站发布字节不符。');

    const graph = JSON.parse(decoded(graphBytes)) as Record<string, any>;
    const genesis = trustedGenesisManifest as Record<string, any>;
    insist(graph.status === 'verified' && graph.chainId === 56 && graph.stage === 'fresh-active'
      && graph.operationId == null,
    '当前 BSC 产品图不处于已核验且未更改的 v5 激活状态。');
    insist(same(graph.artifactDigest, genesis.artifactDigest)
      && same(graph.genesisArtifactDigest, genesis.artifactDigest)
      && (graph.upgradeArtifactDigest == null || same(graph.upgradeArtifactDigest, input.candidateDigest)),
    '当前产品图的新旧合约摘要与本页计划不符。');
    insist(graph.reviewedUpgradeOperationId == null
      || same(graph.reviewedUpgradeOperationId, input.plan.operationId),
    '生产端登记的代码升级批次与本页计划不同。');
    insist(graph.reviewedBootstrapOperationId == null
      || same(graph.reviewedBootstrapOperationId, input.bootstrapPlan.operationId),
    '生产端登记的硬件钱包授权计划与本页计划不同。');
    insist(Number.isSafeInteger(graph.snapshotAgeMs) && graph.snapshotAgeMs >= 0
      && graph.snapshotAgeMs <= 20_000 && Number.isSafeInteger(graph.verifiedBlockNumber)
      && graph.verifiedBlockNumber >= genesis.deployment.blockNumber
      && HASH.test(graph.verifiedBlockHash),
    '当前产品图缺少近期最终确认区块证明。');
    insist(graph.stageActivationBlock === genesis.verifiedBlockNumber
      && same(graph.stageActivationHash, genesis.verifiedBlockHash)
      && same(graph.factory, genesis.factory) && same(graph.portfolioFactory, genesis.portfolioFactory),
    '当前产品图的激活区块或 Factory 与已发布 v5 旧图不同。');
    const manifest = graph.manifest;
    insist(manifest && manifest.chainId === 56 && manifest.kind === 'integrated-v2'
      && same(manifest.artifactDigest, genesis.artifactDigest)
      && same(manifest.sourceCommit, genesis.sourceCommit)
      && same(manifest.deployment?.txHash, genesis.deployment.txHash)
      && manifest.deployment?.blockNumber === genesis.deployment.blockNumber
      && same(manifest.deployment?.blockHash, genesis.deployment.blockHash),
    '生产端 v5 合约图与本页固定的部署记录不符。');
    for (const key of ANCHORS) insist(same(manifest[key], genesis[key])
      && same(manifest.codehash?.[key], genesis.codehash[key]),
    `生产端旧合约 ${key} 地址或代码哈希不同。`);

    // A separate wallet RPC confirms the live canonical block before a signature.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const walletReads = Promise.all([
      input.wallet.request({ method: 'eth_chainId' }),
      input.wallet.request({ method: 'eth_blockNumber' }),
      input.wallet.request({ method: 'eth_getBlockByNumber',
        params: [`0x${graph.verifiedBlockNumber.toString(16)}`, false] }),
    ]);
    const [walletChain, latestHex, canonical] = await Promise.race([walletReads,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('钱包只读链查询超时。')), 15_000); }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); });
    insist(walletChain === '0x38' && typeof latestHex === 'string' && /^0x[0-9a-f]+$/i.test(latestHex),
      '钱包 RPC 未返回当前 BSC 主网区块。');
    const latest = Number(BigInt(latestHex));
    const block = canonical as { number?: unknown; hash?: unknown } | null;
    insist(Number.isSafeInteger(latest) && latest >= graph.verifiedBlockNumber
      && latest - graph.verifiedBlockNumber <= 132
      && typeof block?.number === 'string' && Number.parseInt(block.number, 16) === graph.verifiedBlockNumber
      && same(block.hash, graph.verifiedBlockHash),
    '钱包 RPC 的当前规范链与正式产品图证明不同或已过期。');
    return { ready: true, reason: '正式 v5 网站、主网旧图与独立升级产物已核验。',
      verifiedBlockNumber: graph.verifiedBlockNumber };
  } catch (problem) {
    return blocked(problem instanceof Error ? problem.message : '正式升级发布核验失败。');
  }
}

/** Call again immediately before requesting the wallet signature. */
export async function requireUpgradeExecutionRelease(input: UpgradeReleaseInputs): Promise<void> {
  const result = await checkUpgradeExecutionRelease(input);
  if (!result.ready) throw new Error(result.reason);
}
