import trustedGenesisManifest from '../../web/public/data/frontend-manifest.json';
import { artifactDigest, validateArtifacts, type ArtifactBundle } from './deployment';
import type { IntegratedProposerBootstrapPlan, IntegratedUpgradePlan } from '../shared/integrated-upgrade-plan.mjs';
import type { WalletProvider } from './wallet';

const ORIGIN = 'https://tapeout.cc.cd';
const GENESIS_MANIFEST_SHA256 = '5bf6596502e966de526e899c31d4bc71ef2a9a176e365bf75c0603a12c1b10ae';
// Exact bytes from the separately reviewed /bemine-v2 static export.
const PRODUCT_HOME_SHA256 = 'e152a7eceb5d6e6b1418626f722d2c8a36e17aaa26229b6c96e912040086069b';
const PRODUCT_APP_SHA256 = '6b4f68e294d43409decdeabed27b896643c7855bc5f9a2c799eddb0b62d52a8d';
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
  '正在核验生产部署台、产品页面及当前 BSC 图；升级批次暂不可用。');

async function read(fetcher: typeof fetch, url: string, expectedType: RegExp, maxBytes: number,
  init: RequestInit = {}): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetcher(url, { cache: 'no-store', credentials: 'omit', redirect: 'error',
    signal: AbortSignal.timeout(15_000), ...init });
  insist(response.ok && !response.redirected && (!response.url || response.url === url)
    && expectedType.test(response.headers.get('content-type') || ''),
  `生产发布证据不可用：${new URL(url).pathname}（HTTP ${response.status}）。`);
  const announced = Number(response.headers.get('content-length'));
  insist(!Number.isFinite(announced) || announced <= maxBytes,
    '生产发布证据超过大小限制。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  insist(bytes.byteLength > 0 && bytes.byteLength <= maxBytes, '生产发布证据为空或超过大小限制。');
  return bytes;
}

const decoded = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  insist(!!globalThis.crypto?.subtle, '浏览器无法核验 SHA-256。');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
}

/** Checks live production bytes, server-reviewed plan IDs and a recent finalized chain graph. */
export async function checkUpgradeExecutionRelease(input: UpgradeReleaseInputs): Promise<UpgradeExecutionRelease> {
  try {
    insist((input.origin ?? globalThis.location?.origin) === ORIGIN,
      '只允许在正式 HTTPS 升级入口核验升级发布。');
    insist(HASH.test(input.candidateDigest) && same(artifactDigest(input.candidateBundle), input.candidateDigest)
      && !same(input.candidateDigest, trustedGenesisManifest.artifactDigest),
    '本页候选产物与已发布旧图不匹配。');
    const fetcher = input.fetcher ?? fetch;
    const graphUrl = `${ORIGIN}/pinkuang-deploy-v2/api/journal/product-graph`;
    const runtimeUrl = `${ORIGIN}/pinkuang-deploy-v2/deployment-artifacts.json`;
    const manifestUrl = `${ORIGIN}/bemine-v2/data/frontend-manifest.json`;
    const productUrl = `${ORIGIN}/bemine-v2/`;
    const [graphBytes, runtimeBytes, manifestBytes, htmlBytes] = await Promise.all([
      read(fetcher, graphUrl, /\bapplication\/json\b/i, 1_000_000),
      read(fetcher, runtimeUrl, /\bapplication\/json\b/i, 8_000_000),
      read(fetcher, manifestUrl, /\bapplication\/json\b/i, 20_000),
      read(fetcher, productUrl, /\btext\/html\b/i, 1_000_000),
    ]);
    insist(await sha256(manifestBytes) === GENESIS_MANIFEST_SHA256
      && JSON.stringify(JSON.parse(decoded(manifestBytes))) === JSON.stringify(trustedGenesisManifest),
    '当前产品站的旧图清单与已发布信任锚不符。');
    const servedBundle = JSON.parse(decoded(runtimeBytes)) as ArtifactBundle;
    validateArtifacts(servedBundle);
    insist(same(artifactDigest(servedBundle), input.candidateDigest),
      '当前部署台仍未提供本页候选合约产物。');

    insist(await sha256(htmlBytes) === PRODUCT_HOME_SHA256,
      '当前产品首页不是已审阅的静态发布字节。');
    const html = decoded(htmlBytes);
    const pageScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
      .map(match => new URL(match[1], ORIGIN))
      .filter(url => url.origin === ORIGIN
        && /^\/bemine-v2\/_next\/static\/chunks\/app\/page-[\w-]+\.js$/.test(url.pathname)
        && !url.search && !url.hash);
    insist(pageScripts.length === 1, '当前产品首页没有唯一的正式应用脚本。');
    const productJsBytes = await read(fetcher, pageScripts[0].href,
      /\b(?:application|text)\/javascript\b/i, 2_000_000);
    insist(await sha256(productJsBytes) === PRODUCT_APP_SHA256,
      '当前产品应用脚本不是已审阅的静态发布字节。');
    const productJs = decoded(productJsBytes);
    insist(productJs.includes(input.candidateDigest.toLowerCase()),
      '当前产品应用脚本尚未包含候选产物摘要。');

    const graph = JSON.parse(decoded(graphBytes)) as Record<string, any>;
    const genesis = trustedGenesisManifest;
    insist(graph.status === 'verified' && graph.chainId === 56 && graph.stage === 'genesis'
      && graph.operationId == null,
    '当前产品图并非已核验的 Stage0 旧图。');
    insist(same(graph.artifactDigest, genesis.artifactDigest)
      && same(graph.genesisArtifactDigest, genesis.artifactDigest)
      && same(graph.upgradeArtifactDigest, input.candidateDigest),
    '当前产品图的新旧产物摘要与本页不符。');
    insist(same(graph.reviewedUpgradeOperationId, input.plan.operationId)
      && same(graph.reviewedBootstrapOperationId, input.bootstrapPlan.operationId),
    '生产端已审批次或硬件钱包授权计划与本机计划不同。');
    insist(Number.isSafeInteger(graph.snapshotAgeMs) && graph.snapshotAgeMs >= 0
      && graph.snapshotAgeMs <= 20_000 && Number.isSafeInteger(graph.verifiedBlockNumber)
      && graph.verifiedBlockNumber >= genesis.deployment.blockNumber
      && HASH.test(graph.verifiedBlockHash),
    '当前产品图缺少近期最终确认区块证明。');
    insist(graph.stageActivationBlock === genesis.deployment.blockNumber
      && same(graph.stageActivationHash, genesis.deployment.blockHash)
      && same(graph.factory, genesis.factory)
      && same(graph.portfolioFactory, genesis.portfolioFactory),
    '当前产品图的旧版激活区块或 Factory 已变化。');
    const manifest = graph.manifest;
    insist(manifest && manifest.chainId === 56 && manifest.kind === 'integrated-v2'
      && same(manifest.artifactDigest, genesis.artifactDigest)
      && same(manifest.sourceCommit, genesis.sourceCommit)
      && same(manifest.deployment?.txHash, genesis.deployment.txHash)
      && manifest.deployment?.blockNumber === genesis.deployment.blockNumber
      && same(manifest.deployment?.blockHash, genesis.deployment.blockHash),
    '生产端旧版合约清单与本页信任锚不同。');
    for (const key of ANCHORS) insist(same(manifest[key], genesis[key])
      && same(manifest.codehash?.[key], genesis.codehash[key]),
    `生产端旧版合约 ${key} 地址或代码哈希不同。`);

    // The connected wallet's read-only RPC is independent of the product
    // runtime. It checks both canonical identity and how old its proof is.
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
    '钱包 RPC 的当前规范链与生产图证明不同或已过期。');
    return { ready: true, reason: '生产双图发布和当前链状态已核验。',
      verifiedBlockNumber: graph.verifiedBlockNumber };
  } catch (problem) {
    return blocked(problem instanceof Error ? problem.message : '生产升级发布核验失败。');
  }
}

/** Call again immediately before requesting the wallet signature. */
export async function requireUpgradeExecutionRelease(input: UpgradeReleaseInputs): Promise<void> {
  const result = await checkUpgradeExecutionRelease(input);
  if (!result.ready) throw new Error(result.reason);
}
