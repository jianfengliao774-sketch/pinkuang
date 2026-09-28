import { NotificationConflict, languageOf } from './store.mjs';
import { randomUUID } from 'node:crypto';

const wallet = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const label = telegram => telegram?.username ? `@${telegram.username}` : telegram?.firstName || null;
const bindingId = value => typeof value === 'string' && /^[\da-f-]{36}$/i.test(value);
const words = {
  en: {
    welcome: 'Welcome to BEMine Mining Alerts. Connect your wallet on the official site to receive miner sale proposals, voting reminders and results. We never ask for private keys or seed phrases.',
    paired: 'Telegram account verified. Return to the BEMine page, check the displayed Telegram account and confirm the connection with your authenticated wallet session. No notifications are enabled until you confirm.',
    expired: 'This connection link has expired or has already been used. Open the official BEMine page to create a new link.',
    stopped: 'Telegram notifications are paused for wallets linked to this account. You can still view proposals and vote on the BEMine website. Resume notifications in Notification settings.',
    language: 'Choose your notification language:',
    selected: 'Your notification language is English.',
    settings: 'Manage your wallet connections and notification preferences on the official BEMine website.',
    open: 'Open BEMine', confirm: 'Return to confirm',
  },
  zh: {
    welcome: '欢迎使用拼矿 BEMine 通知助手。请在官网绑定钱包，接收矿机出售提案、投票提醒及结果通知。我们不会索取私钥或助记词。',
    paired: 'Telegram 账号已验证。请返回拼矿网页，核对显示的 Telegram 账号，并在已验证的钱包会话中确认绑定。确认前不会开启通知。',
    expired: '此绑定链接已失效或已被使用。请前往拼矿官网重新生成绑定链接。',
    stopped: '已暂停此 Telegram 账号关联钱包的通知。你仍可在拼矿官网查看提案并投票，之后可在通知设置中恢复提醒。',
    language: '请选择通知语言：', selected: '通知语言已设为中文。',
    settings: '请在拼矿官网管理钱包绑定及通知偏好。', open: '打开拼矿', confirm: '返回确认绑定',
  },
};
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 100) : '';

export function createNotificationService({ store, telegram, botUsername = 'BEMineNotifyBot', publicBaseUrl } = {}) {
  if (!store || !telegram || !/^[A-Za-z\d_]{5,32}[Bb][Oo][Tt]$/.test(botUsername)) throw new Error('Invalid notification service configuration.');
  let base;
  try { base = new URL(publicBaseUrl); } catch { throw new Error('Notification public URL is required.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Notification public URL must be a trusted HTTPS site.');
  const settingsUrl = `${base.href.replace(/\/$/, '')}/#notifications`;
  const status = account => {
    const prefs = store.preferences(account), current = store.getBinding(account), pending = store.pendingBinding(account);
    return { enabled: true, connected: !!current, language: prefs.language, notificationsEnabled: prefs.enabled,
      telegramLabel: label(current?.telegram), blocked: !!current?.blocked,
      binding: pending ? { id: pending.id, status: pending.status, expiresAt: pending.expiresAt, telegramLabel: label(pending.telegram) } : null };
  };
  async function handleWallet({ account, method, path, body = {} }) {
    account = wallet(account);
    if (!account) return { status: 401, body: { error: 'A verified wallet session is required.' } };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { error: 'Invalid notification request.' } };
    try {
      if (method === 'GET' && path === '/status') return { status: 200, body: status(account) };
      if (method === 'POST' && path === '/binding') {
        if (body.language !== undefined && !['en', 'zh'].includes(body.language)) return invalid();
        if (body.language) store.upsertPreferences(account, { language: body.language });
        const pending = store.issueBinding(account);
        return { status: 201, body: { id: pending.id, expiresAt: pending.expiresAt, url: `https://t.me/${botUsername}?start=${pending.token}` } };
      }
      if (method === 'POST' && path === '/binding/confirm') {
        if (!bindingId(body.id) || body.language !== undefined && !['en', 'zh'].includes(body.language)) return invalid();
        store.confirmBinding(account, body.id);
        if (body.language) store.upsertPreferences(account, { language: body.language });
        return { status: 200, body: status(account) };
      }
      if (method === 'POST' && path === '/preferences') {
        if (body.language !== undefined && !['en', 'zh'].includes(body.language) || body.enabled !== undefined && typeof body.enabled !== 'boolean') return invalid();
        store.upsertPreferences(account, { language: body.language, enabled: body.enabled });
        return { status: 200, body: status(account) };
      }
      if (method === 'POST' && path === '/disconnect') {
        store.disconnect(account); return { status: 200, body: status(account) };
      }
      if (method === 'GET' && path === '/inbox') return { status: 200, body: { items: store.inbox(account) } };
      if (method === 'POST' && path === '/inbox/read') {
        if (typeof body.id !== 'string' || !body.id.length || body.id.length > 512) return invalid();
        store.readInbox(account, body.id); return { status: 200, body: { ok: true } };
      }
      return { status: 404, body: { error: 'Notification endpoint not found.' } };
    } catch (error) {
      if (error instanceof NotificationConflict) return { status: 409, body: { error: error.message } };
      return { status: 500, body: { error: 'Notification settings are temporarily unavailable.' } };
    }
  }
  function invalid() { return { status: 400, body: { error: 'Invalid notification request.' } }; }
  const button = (lang, confirm = false) => {
    const url = new URL(settingsUrl); url.searchParams.set('lang', lang);
    return { inline_keyboard: [[{ text: words[lang][confirm ? 'confirm' : 'open'], url: url.href }]] };
  };
  const owner = randomUUID();
  let flushing = false;
  async function flushBotReplies({ limit = 2 } = {}) {
    if (flushing || !store.acquireLease('telegram-bot-replies', owner, 30_000)) return;
    flushing = true;
    try {
      for (const item of store.dueBotReplies(Math.min(2, limit))) {
        if (!store.acquireLease('telegram-bot-replies', owner, 30_000)) break;
        try { await telegram.sendMessage(item.chatId, item.text, { reply_markup: item.reply_markup }); store.finishBotReply(item.id); }
        catch (error) {
          if (error?.blocked || error?.retryable === false || item.attempts >= 5) store.finishBotReply(item.id, { failed: true });
          else store.finishBotReply(item.id, { retryAt: store.now() + Math.max(1000, error?.retryAfterMs ?? Math.min(300_000, 2000 * 2 ** item.attempts)) });
        }
      }
    } finally { store.releaseLease('telegram-bot-replies', owner); flushing = false; }
  }
  async function handleTelegramUpdate(update) {
    const callback = update?.callback_query, message = callback?.message ?? update?.message;
    const from = callback?.from ?? message?.from, chat = message?.chat;
    if (!Number.isSafeInteger(update?.update_id) || chat?.type !== 'private' || from?.is_bot || !Number.isSafeInteger(from?.id)
      || from.id <= 0 || !Number.isSafeInteger(chat.id) || chat.id !== from.id) return { ok: true };
    store.transaction(() => {
      if (!store.claimTelegramUpdate(update.update_id)) return;
      const userId = String(from.id), chatId = String(chat.id), linked = store.bindingsForPeer(userId);
      let lang = store.peerLanguage(userId) ?? linked.find(binding => binding.explicitLanguage)?.language ?? languageOf(from.language_code);
      const reply = (text, reply_markup) => store.enqueueBotReply(update.update_id, { chatId, text, reply_markup });
      if (callback) {
        if (['lang:zh', 'lang:en'].includes(callback.data)) {
          lang = callback.data.slice(5); store.setPeerLanguage(userId, lang);
          for (const binding of linked) store.upsertPreferences(binding.account, { language: lang });
          reply(words[lang].selected, button(lang));
        }
        return;
      }
      const match = /^\/(start|language|settings|stop|help)(?:@([A-Za-z\d_]+))?(?:\s+([^\s]+))?\s*$/i.exec(message.text ?? '');
      if (!match || match[2] && match[2].toLowerCase() !== botUsername.toLowerCase()) {
        reply(words[lang].settings, button(lang)); return;
      }
      const command = match[1].toLowerCase();
      if (command === 'start' && match[3]) {
        const staged = store.stageBinding(match[3], { userId, chatId, username: clean(from.username), firstName: clean(from.first_name) });
        if (staged) {
          const prefs = store.preferences(staged.account);
          if (!prefs.explicitLanguage) store.upsertPreferences(staged.account, { language: lang, explicitLanguage: false });
          lang = store.preferences(staged.account).language;
        }
        reply(words[lang][staged ? 'paired' : 'expired'], button(lang, !!staged));
      } else if (command === 'stop') {
        for (const binding of linked) store.upsertPreferences(binding.account, { enabled: false });
        store.cancelPendingForPeer(userId);
        reply(words[lang].stopped, button(lang));
      } else if (command === 'language') {
        reply(words[lang].language, { inline_keyboard: [[{ text: 'English', callback_data: 'lang:en' }, { text: '中文', callback_data: 'lang:zh' }]] });
      } else reply(words[lang][command === 'start' || command === 'help' ? 'welcome' : 'settings'], button(lang));
    });
    if (callback) {
      try { await telegram.answerCallbackQuery?.(callback.id); } catch { /* An expired callback is not a lost durable reply. */ }
    }
    await flushBotReplies({ limit: 1 });
    return { ok: true };
  }
  return { handleWallet, handleTelegramUpdate, flushBotReplies, status, botUsername, settingsUrl };
}
