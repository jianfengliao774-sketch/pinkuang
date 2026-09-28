// Sharing opens a user-controlled composer; it never posts or sends a message.
// Official references checked 2026-09-27:
// https://core.telegram.org/widgets/share
// https://docs.x.com/x-for-websites/post-button/overview
import { shareMotto } from './share-copy.mjs';
import { makeArtworkShareUrl } from './share-landing.mjs';
export const DEFAULT_PUBLIC_SHARE_BASE = 'https://tapeout.cc.cd/bemine/';
const PUBLIC_ORIGINS = new Set(['https://tapeout.cc.cd']);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const STATES = new Set(['Funding', 'Funded', 'Active', 'Listed', 'Closed', 'Refunding']);
const COLLECTION_NAMES = new Set(['TapeOut', 'Behemoth']);
export const validShareBasePath = value => typeof value === 'string' && /^\/bemine(?:-[a-z0-9_-]+)?\/?$/.test(value);

function address(value) {
  return typeof value === 'string' && ADDRESS.test(value) && value.toLowerCase() !== ZERO_ADDRESS
    ? value.toLowerCase() : null;
}

/** The caller supplies this from trusted configuration, never window.location or invitation parameters. */
export function validatePublicBaseUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\\\s]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !PUBLIC_ORIGINS.has(url.origin) || url.username || url.password
      || url.search || url.hash || !validShareBasePath(url.pathname)) return null;
    url.pathname = `${url.pathname.replace(/\/$/,'')}/`;
    return url.href;
  } catch { return null; }
}

export function buildProjectShareUrl(publicBaseUrl, poolAddress, source) {
  const base = validatePublicBaseUrl(publicBaseUrl);
  const pool = address(poolAddress);
  if (!base || !pool || (source !== undefined && !['tg', 'x', 'native'].includes(source))) return null;
  const url = new URL(base);
  if (source) url.searchParams.set('source', source);
  url.hash = `detail/${pool}`;
  return url.href;
}

/** Presentation guard, not a receipt verifier. The transaction layer must verify Deposited and finality. */
export function isConfirmedDeposit(confirmation, poolAddress) {
  const pool = address(poolAddress);
  const receipt = confirmation?.receipt;
  const hash = confirmation?.transactionHash;
  return Boolean(pool && confirmation?.action === 'deposit' && confirmation.status === 'confirmed'
    && confirmation.finalized === true && address(confirmation.poolAddress) === pool
    && receipt && [1, 1n, '0x1', 'success'].includes(receipt.status)
    && address(receipt.to) === pool && typeof hash === 'string' && HASH.test(hash)
    && typeof receipt.transactionHash === 'string' && HASH.test(receipt.transactionHash)
    && receipt.transactionHash.toLowerCase() === hash.toLowerCase());
}

function identifier(value) {
  const raw = typeof value === 'bigint' ? value.toString() : value;
  if (typeof raw !== 'string' && !Number.isSafeInteger(raw)) return null;
  const text = String(raw);
  if (!/^\d{1,78}$/.test(text) || BigInt(text) >= 2n ** 256n) return null;
  return BigInt(text).toString();
}

function projectStatus(project, english) {
  const remaining = Number.isInteger(project.remainingShares) && project.remainingShares >= 0
    && project.remainingShares <= 100 ? project.remainingShares : null;
  if (project.state === 'Funding') {
    if (remaining === 0) return english ? 'Fully subscribed. View the latest progress.' : '认购份额已满，查看最新进展。';
    if (remaining !== null) return english ? `Funding · ${remaining} of 100 shares remain. Check availability before joining.`
      : `募集中 · 100 份中剩余 ${remaining} 份，参与前请查看最新进度。`;
    return english ? 'Funding. View current availability.' : '募集中，查看当前可认购份额。';
  }
  const labels = {
    Funded: ['已募满，等待购机。', 'Fully funded. Awaiting miner purchase.'],
    Active: ['项目运行中，查看矿机进展。', 'The project is active. Explore its progress.'],
    Listed: ['整机出售中，查看项目详情。', 'The miner is listed for sale. View project details.'],
    Closed: ['整机已售出，查看项目记录。', 'The miner has been sold. View project records.'],
    Refunding: ['项目退款中，查看退款进展。', 'The project is refunding. View refund progress.'],
  };
  return labels[project.state]?.[english ? 1 : 0] ?? (english ? 'View the latest project status.' : '查看项目最新状态。');
}

export function createProjectShare({ publicBaseUrl, project, confirmation, locale = 'zh', mottoIndex = 0, posterId = 'original' } = {}) {
  if (!project || !COLLECTION_NAMES.has(project.name)) return null;
  const id = identifier(project.circuitId);
  const projectUrl = buildProjectShareUrl(publicBaseUrl, project.poolAddress);
  const url = makeArtworkShareUrl(projectUrl, posterId);
  if (id === null || !url) return null;
  const english = locale === 'en';
  const confirmed = isConfirmedDeposit(confirmation, project.poolAddress);
  const title = `${project.name} #${id}`;
  const status = projectStatus(project, english);
  const opening = confirmed
    ? (english ? `I've joined ${title} on BEMine.` : `我已参与拼矿 BEMine 的 ${title}。`)
    : (english ? `Explore ${title} on BEMine.` : `一起了解拼矿 BEMine 的 ${title}。`);
  const canSubscribe = project.state === 'Funding' && Number.isInteger(project.remainingShares)
    && project.remainingShares > 0 && project.remainingShares <= 100;
  const motto = shareMotto(locale, mottoIndex, canSubscribe);
  const text = `${opening}\n${motto}\n${status}`;
  // X counts CJK characters more heavily. Keep its composer concise, even for a uint256 circuit ID.
  const xStatus = canSubscribe
    ? (english ? `${project.remainingShares}/100 shares available. Check the latest status.` : `剩余 ${project.remainingShares}/100 份，以最新进度为准。`)
    : (english ? 'View the latest project status.' : '查看项目最新进展。');
  const xText = `BEMine · ${title}\n${motto}\n${xStatus}`;
  const intent = (endpoint, source, intentText = text) => {
    const target = new URL(endpoint);
    target.searchParams.set('url', makeArtworkShareUrl(buildProjectShareUrl(publicBaseUrl, project.poolAddress, source), posterId));
    target.searchParams.set('text', intentText);
    return target.href;
  };
  return {
    title, text, xText, motto, url, projectUrl, copyText: `${text}\n${url}`, confirmed, status, canSubscribe,
    stateKnown: STATES.has(project.state),
    telegramUrl: intent('https://t.me/share/url', 'tg'),
    xUrl: intent('https://x.com/intent/tweet', 'x', xText),
  };
}
