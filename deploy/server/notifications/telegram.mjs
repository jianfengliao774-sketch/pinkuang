import { setTimeout as delay } from 'node:timers/promises';

export class TelegramDeliveryError extends Error {
  constructor(code, { retryAfterMs = null, blocked = false, retryable = true, rateLimitScope = null } = {}) {
    // Never attach request URLs, API responses or original fetch errors: they may contain the bot token.
    super(`Telegram delivery failed (${code}).`);
    this.name = 'TelegramDeliveryError'; this.code = code;
    this.retryAfterMs = retryAfterMs; this.blocked = blocked; this.retryable = retryable;
    this.rateLimitScope = rateLimitScope;
  }
}

/** One shared instance serializes bot requests. Queue retries belong to the durable worker. */
export class TelegramClient {
  constructor({ token, fetchImpl = globalThis.fetch, now = Date.now, sleep = delay, timeoutMs = 10_000 } = {}) {
    if (typeof token !== 'string' || !/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error('Invalid Telegram bot token configuration.');
    this.token = token; this.fetch = fetchImpl; this.now = now; this.sleep = sleep;
    this.timeoutMs = Math.min(30_000, Math.max(100, timeoutMs)); this.tail = Promise.resolve(); this.nextAt = 0;
    this.chatNextAt = new Map();
  }
  request(method, body) {
    if (!['sendMessage', 'answerCallbackQuery', 'getMe', 'setWebhook', 'getWebhookInfo', 'setMyCommands', 'setMyName', 'setMyDescription', 'setMyShortDescription'].includes(method))
      throw new Error('Unsupported Telegram API operation.');
    const execute = async () => {
      const chat = method === 'sendMessage' ? String(body.chat_id) : null;
      const globalWait = Math.max(0, this.nextAt - this.now());
      const chatWait = chat ? Math.max(0, (this.chatNextAt.get(chat) ?? 0) - this.now()) : 0;
      const wait = Math.max(globalWait, chatWait);
      // Long provider cooldowns belong in the persistent queue, never in a webhook or shutdown wait.
      if (wait > 250) throw new TelegramDeliveryError('rate_limited', {
        retryAfterMs: wait, rateLimitScope: chatWait > globalWait ? 'chat' : 'global',
      });
      if (wait) await this.sleep(wait);
      this.nextAt = this.now() + 50;
      if (chat) {
        this.chatNextAt.delete(chat); this.chatNextAt.set(chat, this.now() + 1000);
        if (this.chatNextAt.size > 10_000) this.chatNextAt.delete(this.chatNextAt.keys().next().value);
      }
      let response, result;
      try {
        response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        });
        result = await response.json();
      } catch { throw new TelegramDeliveryError('network'); }
      if (response.ok && result?.ok === true) return result.result;
      const code = Number(result?.error_code ?? response.status);
      const retryAfter = Number(result?.parameters?.retry_after);
      if (code === 429) {
        const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 86400_000) : 30_000;
        this.nextAt = Math.max(this.nextAt, this.now() + retryAfterMs);
        throw new TelegramDeliveryError('rate_limited', { retryAfterMs, rateLimitScope: 'global' });
      }
      if (code === 403) throw new TelegramDeliveryError('blocked', { blocked: true, retryable: false });
      throw new TelegramDeliveryError(Number.isInteger(code) ? `http_${code}` : 'invalid_response', { retryable: code >= 500 });
    };
    const pending = this.tail.then(execute, execute);
    this.tail = pending.catch(() => {});
    return pending;
  }
  sendMessage(chatId, text, options = {}) {
    if (!/^[1-9]\d{0,18}$/.test(String(chatId)) || typeof text !== 'string' || !text.length || text.length > 4096)
      throw new Error('Invalid Telegram private message.');
    return this.request('sendMessage', { chat_id: String(chatId), text,
      link_preview_options: { is_disabled: true }, ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}) });
  }
  answerCallbackQuery(id) {
    if (typeof id !== 'string' || id.length > 200) return Promise.resolve();
    return this.request('answerCallbackQuery', { callback_query_id: id });
  }
}
