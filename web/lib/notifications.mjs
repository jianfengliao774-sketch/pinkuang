import { displayAmount } from './amount-display.mjs';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
export const NOTIFICATION_BOT = 'BEMineNotifyBot';
export const sameNotificationAccount = (a, b) => ADDRESS.test(a ?? '') && ADDRESS.test(b ?? '') && a.toLowerCase() === b.toLowerCase();

/** Use verified current positions, including beneficial shares escrowed in ShareMarket. */
export function ownsPurchasedMiner(rows = []) {
  return rows.some(row => {
    if (!row?.trusted || !['Active', 'Listed'].includes(row.status)) return false;
    try { return BigInt(row.shares ?? 0) > 0n || BigInt(row.lockedShares ?? 0) > 0n; } catch { return false; }
  });
}

export function notificationPromptKind({ eligible, route, connected, history = {}, claim, account }) {
  if (connected) return null;
  if (claim?.status === 'confirmed' && claim.finalized === true && claim.action === 'claim'
    && sameNotificationAccount(claim.account, account) && !history.claimReminderSeen) return 'claim';
  if (eligible && ['overview', 'detail'].includes(route) && !history.purchasePromptSeen) return 'purchase';
  return null;
}

export function notificationHistoryKey(account, factory) {
  if (!ADDRESS.test(account ?? '') || !ADDRESS.test(factory ?? '')) return null;
  return `bemine-notification-prompts:56:${factory.toLowerCase()}:${account.toLowerCase()}`;
}
export function readNotificationHistory(storage, key) {
  try {
    const value = JSON.parse(storage?.getItem(key) || '{}');
    return { purchasePromptSeen: value.purchasePromptSeen === true, claimReminderSeen: value.claimReminderSeen === true };
  } catch { return {}; }
}

export function notificationBase(config = {}) {
  const base = config.journalBase ?? '/api/journal';
  if (typeof base !== 'string' || !/^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(base) || base.includes('..'))
    throw new Error('invalid_notification_origin');
  return `${base.replace(/\/$/, '')}/notifications`;
}
export function telegramBindingUrl(value, bot = NOTIFICATION_BOT) {
  try {
    const url = new URL(value);
    if (bot !== NOTIFICATION_BOT || url.protocol !== 'https:' || url.hostname !== 't.me' || url.port || url.username || url.password
      || url.pathname !== `/${NOTIFICATION_BOT}` || url.hash || [...url.searchParams.keys()].length !== 1
      || !/^[A-Za-z0-9_-]{1,64}$/.test(url.searchParams.get('start') ?? '')) return null;
    return url.href;
  } catch { return null; }
}
export function notificationTarget(item) {
  const pool = item?.payload?.pool ?? item?.pool;
  return ADDRESS.test(pool ?? '') ? `#${item?.payload?.projectKind === 'portfolio' ? 'portfolio' : 'detail'}/${pool}` : '#governance';
}
export function notificationMessage(item, locale = 'en') {
  const zh = locale === 'zh', p = item?.payload ?? {}, kind = item?.kind;
  const titles = {
    proposal: ['你的矿机发起了出售投票', 'A miner sale vote has started'],
    reminder_6h: ['出售投票即将截止', 'Miner sale voting closes soon'],
    reminder_1h: ['出售投票最后提醒', 'Final reminder for the miner sale vote'],
    vote_closed: ['本轮出售投票已结束', 'This miner sale vote has ended'],
    listed: ['矿机已挂牌出售', 'Your miner has been listed for sale'],
    completed: ['矿机已成交', 'Your miner sale is complete'],
  };
  const title = (titles[kind] ?? ['矿机事项更新', 'Miner update'])[zh ? 0 : 1];
  const lines = [];
  if (/^\d{1,78}$/.test(p.circuitId ?? '')) lines.push(`${zh ? '矿机' : 'Miner'} #${p.circuitId}`);
  if (/^\d{1,78}$/.test(p.proposalId ?? '')) lines.push(`${zh ? '提案' : 'Proposal'} #${p.proposalId}`);
  if (['proposal', 'reminder_6h', 'reminder_1h', 'listed'].includes(kind) && /^\d{1,78}$/.test(p.priceWei ?? '')) {
    const price = displayAmount(p.priceWei, 18);
    lines.push(`${zh ? '出售价格' : 'Sale price'}: ${price} BNB`);
  }
  if (['proposal', 'reminder_6h', 'reminder_1h'].includes(kind)) {
    const seconds = Number(p.endsAt), date = new Date(seconds * 1000);
    if (Number.isSafeInteger(seconds) && seconds > 0 && !Number.isNaN(date.getTime()))
      lines.push(`${zh ? '截止' : 'Closes'}: ${date.toLocaleString(zh ? 'zh-CN' : 'en-GB', { timeZoneName: 'short' })}`);
    lines.push(zh ? '请查看当前提案状态，并在官网连接钱包后投票。' : 'Check the current proposal status and connect your wallet on the site to vote.');
  } else if (kind === 'vote_closed') {
    lines.push(p.passed === true
      ? (zh ? '票数达标，但本轮未执行挂牌；截止后不能执行本轮提案。' : 'The vote threshold was reached, but this proposal was not executed before the deadline. It can no longer be executed.')
      : (zh ? '本轮未达到通过门槛，矿机未因此提案挂牌。' : 'The approval threshold was not reached. This proposal did not list the miner.'));
  } else if (kind === 'listed') lines.push(zh ? '挂牌不代表成交，请查看矿机当前出售状态。' : 'A listing is not a completed sale. View the current sale status.');
  else if (kind === 'completed') lines.push(zh ? '请在项目中查看成交结果与款项记录。' : 'View the sale outcome and payment records in the project.');
  return { title, body: lines.join('\n') };
}
export class NotificationApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
export async function notificationRequest({ config, path, account, method = 'GET', body, fetcher = globalThis.fetch, signal }) {
  const allowed = new Set(['capabilities', 'status', 'binding', 'binding/confirm', 'preferences', 'disconnect', 'inbox', 'inbox/read']);
  if (!allowed.has(path) || !['GET', 'POST'].includes(method) || (path !== 'capabilities' && !ADDRESS.test(account ?? '')))
    throw new Error('invalid_notification_request');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetcher(`${notificationBase(config)}/${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { ...(path === 'capabilities' ? {} : { 'X-Pinkuang-Account': account }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new NotificationApiError(response.status, typeof result.error === 'string' ? result.error : 'notification_unavailable');
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
