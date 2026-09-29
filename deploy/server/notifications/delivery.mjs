import { randomUUID } from 'node:crypto';

const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i;
const DAY = 86400_000;
const fail = () => { throw new Error('Notification source is unverified, stale or changed.'); };
const normalize = value => { if (!ADDRESS.test(String(value))) fail(); return value.toLowerCase(); };

export function verifyNotificationSource(feed, { factory, market, now, maxSourceAgeMs = 120_000, checkpoint } = {}) {
  const s = feed?.source;
  if (!s || s.chainId !== 56 || normalize(s.factory) !== normalize(factory) || normalize(s.market) !== normalize(market)
    || s.complete !== true || s.unknownReason || !Number.isSafeInteger(s.confirmations) || s.confirmations < 2
    || !Number.isSafeInteger(s.indexedThrough) || s.indexedThrough !== s.observedSafeHead || !HASH.test(s.indexedBlockHash)
    || !Number.isFinite(Date.parse(s.checkedAt)) || now - Date.parse(s.checkedAt) > maxSourceAgeMs
    || Date.parse(s.checkedAt) > now + 30_000 || !Number.isSafeInteger(s.indexedTimestamp)
    || now - s.indexedTimestamp * 1000 > maxSourceAgeMs || s.indexedTimestamp * 1000 > now + 30_000
    || feed.schemaVersion !== 1 || feed.nextCursor !== null || !Array.isArray(feed.items)
    || feed.items.some(pool => pool.verified !== true)) fail();
  if (checkpoint && (feed.anchorVerified !== true || s.indexedThrough < checkpoint.block
    || s.indexedThrough === checkpoint.block && s.indexedBlockHash !== checkpoint.hash)) fail();
  return s;
}

/** Read the configured local index only; pages and the durable prior checkpoint are hash-pinned. */
export function createNotificationSource({ baseUrl, fetchImpl = fetch, maxPages = 200, timeoutMs = 45_000 } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash) throw new Error('A credential-free loopback chain-index URL is required.');
  return async (checkpoint = null) => {
    const overall = AbortSignal.timeout(timeoutMs);
    let cursor = 0, first = null;
    const items = [], seen = new Set();
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${base.href.replace(/\/$/, '')}/v1/notifications`);
      url.searchParams.set('cursor', String(cursor)); url.searchParams.set('limit', '5');
      if (first) { url.searchParams.set('atBlock', String(first.indexedThrough)); url.searchParams.set('atHash', first.indexedBlockHash); }
      if (checkpoint) { url.searchParams.set('anchorBlock', String(checkpoint.block)); url.searchParams.set('anchorHash', checkpoint.hash); }
      if (overall.aborted) fail();
      const response = await fetchImpl(url, { signal: AbortSignal.any([overall, AbortSignal.timeout(30_000)]), redirect: 'error' });
      if (!response.ok || Number(response.headers?.get?.('content-length') ?? 0) > 4_000_000) fail();
      const raw = await response.text(); if (Buffer.byteLength(raw) > 4_000_000) fail();
      const body = JSON.parse(raw), s = body.source, data = body.data;
      if (!s?.complete || !data || data.schemaVersion !== 1 || !Array.isArray(data.items)
        || data.items.length > 5 || checkpoint && data.anchorVerified !== true) fail();
      if (first && (s.indexedThrough !== first.indexedThrough || s.indexedBlockHash !== first.indexedBlockHash
        || s.factory !== first.factory || s.market !== first.market || s.chainId !== first.chainId)) fail();
      first ??= s;
      for (const pool of data.items) {
        const key = normalize(pool.address); if (seen.has(key)) fail(); seen.add(key); items.push(pool);
      }
      if (data.nextCursor === null) return { source: first, schemaVersion: 1, items, nextCursor: null, anchorVerified: checkpoint ? true : null };
      if (!Number.isSafeInteger(data.nextCursor) || data.nextCursor <= cursor) fail();
      cursor = data.nextCursor;
    }
    throw new Error('Notification source page bound exceeded.');
  };
}

const wei = value => {
  const n = BigInt(value), whole = n / 10n ** 18n, fraction = (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
};
const names = {
  proposal: ['出售投票已开启', 'Miner sale vote opened'],
  reminder_6h: ['出售投票：剩余不足 6 小时', 'Sale vote: less than 6 hours left'],
  reminder_1h: ['出售投票：剩余不足 1 小时', 'Sale vote: less than 1 hour left'],
  vote_closed: ['出售投票已截止', 'Sale voting window closed'],
  listed: ['矿机已挂牌出售', 'Miner listed for sale'],
  completed: ['矿机已成交', 'Miner sale completed'],
};

export function renderNotification(payload, language, publicBaseUrl) {
  const zh = language === 'zh', label = names[payload.kind]?.[zh ? 0 : 1];
  if (!label) throw new Error('Unsupported notification kind.');
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('HTTPS public app URL is required.');
  // Route comes entirely from verified source identifiers, never contact/user supplied text.
  base.searchParams.set('lang', zh ? 'zh' : 'en');
  base.hash = `${payload.projectKind==='portfolio'?'portfolio':'detail'}/${normalize(payload.pool)}`;
  const time = new Date(payload.endsAt * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  const status = payload.kind === 'vote_closed' ? (payload.passed
    ? (zh ? '票数已达门槛，但本轮未执行挂牌；截止后不能执行本轮提案。' : 'Vote thresholds were met, but no listing was executed. This proposal cannot be executed after its deadline.')
    : (zh ? '本提案未达到通过门槛。' : 'This proposal did not meet the approval thresholds.'))
    : payload.kind === 'listed' ? (zh ? '提案已执行挂牌，尚未成交。' : 'The listing was executed. The miner has not been sold yet.')
      : payload.kind === 'completed' ? (zh ? '链上已确认矿机成交。' : 'The completed sale is confirmed on-chain.')
        : (zh ? '请在官网查看方案并通过钱包投票。' : 'Review the proposal and vote with your wallet on the website.');
  const text = zh
    ? `拼矿 BEMine｜${label}\n\n矿机：#${payload.circuitId}\n提案：#${payload.proposalId}\n${payload.kind === 'completed' ? '成交价格' : '拟出售价格'}：${wei(payload.priceWei)} BNB\n你的快照份额：${payload.shares} 份\n投票截止：${time}\n\n${status}\n\n我们不会索取私钥或助记词。`
    : `BEMine | ${label}\n\nMiner: #${payload.circuitId}\nProposal: #${payload.proposalId}\n${payload.kind === 'completed' ? 'Sale price' : 'Proposed price'}: ${wei(payload.priceWei)} BNB\nYour snapshot shares: ${payload.shares}\nVoting deadline: ${time}\n\n${status}\n\nWe never ask for your private key or seed phrase.`;
  return { text, reply_markup: { inline_keyboard: [[{ text: zh ? '查看矿机与投票' : 'View miner & vote', url: base.href }]] } };
}

function candidates(feed, now, startedAt) {
  const output = new Map();
  for (const pool of feed.items) {
    if (!Array.isArray(pool.proposals)) fail();
    for (const proposal of pool.proposals) {
      const open = proposal.open && proposal.endsAt * 1000 > now && !proposal.roundExecuted && !proposal.executed;
      const stages = [];
      if (open) {
        stages.push({ kind: 'proposal', eventId: proposal.eventId, at: proposal.createdAt * 1000, expiresAt: proposal.endsAt * 1000 });
        const left = proposal.endsAt * 1000 - now;
        if (left <= 3600_000) stages.push({ kind: 'reminder_1h', eventId: proposal.eventId, at: now, expiresAt: proposal.endsAt * 1000 });
        else if (left <= 6 * 3600_000) stages.push({ kind: 'reminder_6h', eventId: proposal.eventId, at: now, expiresAt: (proposal.endsAt - 3600) * 1000 });
      }
      if (!proposal.roundExecuted && !proposal.executed && proposal.endsAt * 1000 <= now) {
        stages.push({ kind: 'vote_closed', eventId: proposal.eventId, at: proposal.endsAt * 1000, expiresAt: proposal.endsAt * 1000 + DAY });
      }
      if (proposal.listing && !proposal.completed && !proposal.expired) {
        stages.push({ kind: 'listed', eventId: proposal.listing.eventId, at: proposal.listing.timestamp * 1000,
          expiresAt: Math.min(proposal.listing.expiresAt * 1000, proposal.listing.timestamp * 1000 + DAY) });
      }
      if (proposal.completed) stages.push({ kind: 'completed', eventId: proposal.completed.eventId,
        at: proposal.completed.timestamp * 1000, expiresAt: proposal.completed.timestamp * 1000 + DAY });
      for (const stage of stages) {
        if (stage.expiresAt <= now || !open && stage.at < startedAt) continue;
        for (const owner of proposal.owners) {
          if (stage.kind.startsWith('reminder') && proposal.votes.some(vote => vote.account === owner.account)) continue;
          const id = `56:${pool.address}:${stage.eventId}:${stage.kind}:${owner.account}`;
          output.set(id, { id, account: owner.account, kind: stage.kind, at: stage.at, expiresAt: stage.expiresAt,
            payload: { kind: stage.kind, pool: pool.address,projectKind:pool.kind==='portfolio'?'portfolio':'pool', circuitId: proposal.circuitId ?? pool.circuitId, proposalId: proposal.proposalId,
              priceWei: proposal.priceWei, shares: owner.shares, endsAt: proposal.endsAt, passed: proposal.passed,
              eventId: stage.eventId, sourceBlock: feed.source.indexedThrough, sourceHash: feed.source.indexedBlockHash } });
        }
      }
    }
  }
  return output;
}

/** Single-worker queue. Contact is resolved again just before send, never persisted in jobs. */
export function createNotificationWorker({ store, source, sender, factory, market, publicBaseUrl,
  now = Date.now, maxSourceAgeMs = 120_000, batchSize = 50 } = {}) {
  factory = normalize(factory); market = normalize(market);
  if (!store || typeof source !== 'function' || typeof sender?.sendMessage !== 'function') throw new Error('Notification worker dependencies are required.');
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('HTTPS public app URL is required.');
  let running = false;
  const owner = randomUUID(), lease = 'notification-delivery', ttlMs = 120_000;
  return {
    async tick() {
      if (running) return { status: 'busy', sent: 0 };
      if (!store.acquireLease(lease, owner, ttlMs, now())) return { status: 'busy', sent: 0 };
      running = true;
      try {
        const at = now(), checkpoint = store.getMeta('delivery_checkpoint');
        const feed = await source(checkpoint);
        const verified = verifyNotificationSource(feed, { factory, market, now: now(), maxSourceAgeMs, checkpoint });
        if (!store.acquireLease(lease, owner, ttlMs, now())) throw new Error('Notification worker lease was lost.');
        const startedAt = store.getMeta('delivery_started_at') ?? at;
        store.setMeta('delivery_started_at', startedAt);
        const available = candidates(feed, at, startedAt), justOpened = new Set();
        for (const item of available.values()) {
          store.addInbox({ ...item, createdAt: item.at });
          const binding = store.getBinding(item.account);
          if (!binding || !binding.enabled || binding.blocked) continue;
          // New bindings receive active proposals, never a replay of historical results.
          if (!['proposal', 'reminder_6h', 'reminder_1h'].includes(item.kind) && binding.createdAt > item.at) continue;
          const pair = `${item.account}:${item.payload.pool}:${item.payload.proposalId}`;
          if (item.kind.startsWith('reminder') && (justOpened.has(pair) || binding.createdAt > item.payload.endsAt * 1000
            - (item.kind === 'reminder_1h' ? 3600_000 : 6 * 3600_000)
            || at - (store.getMeta(`delivery_last_proposal:${pair}`) ?? 0) < 10 * 60_000)) continue;
          if (store.enqueue({ ...item, dueAt: at }) && item.kind === 'proposal') justOpened.add(pair);
        }
        let sent = 0, cancelled = 0, retried = 0, outcomeUnknown = 0;
        const pausedUntil = store.getMeta('delivery_not_before') ?? 0;
        for (const job of now() < pausedUntil ? [] : store.due(now(), batchSize)) {
          verifyNotificationSource(feed, { factory, market, now: now(), maxSourceAgeMs, checkpoint });
          if (!store.acquireLease(lease, owner, ttlMs, now())) throw new Error('Notification worker lease was lost.');
          const item = available.get(job.id), binding = store.getBinding(job.account);
          if (!item || item.expiresAt <= now() || !binding || !binding.enabled || binding.blocked
            || !['proposal', 'reminder_6h', 'reminder_1h'].includes(item.kind) && binding.createdAt > item.at) {
            store.ack(job.id, now(), 'cancelled'); cancelled++; continue;
          }
          try {
            const message = renderNotification(item.payload, binding.language, publicBaseUrl);
            await sender.sendMessage(binding.telegram.chatId, message.text, { reply_markup: message.reply_markup });
            store.ack(job.id, now()); sent++;
            if (item.kind === 'proposal') store.setMeta(`delivery_last_proposal:${job.account}:${item.payload.pool}:${item.payload.proposalId}`, now());
          } catch (error) {
            if (error?.uncertain) { store.block(job.id, 'telegram_outcome_unknown'); outcomeUnknown++; }
            else if (error?.blocked) { store.markBlocked?.(job.account); store.block(job.id, 'telegram_blocked'); }
            else if ((error?.code === 429 || error?.code === 'rate_limited') || error?.retryable !== false && job.attempts < 8) {
              const rateLimited = error?.code === 429 || error?.code === 'rate_limited';
              const chatLimited = rateLimited && error?.rateLimitScope === 'chat';
              const wait = rateLimited ? Math.max(1000, Number(error?.retryAfterMs) || 30_000)
                : Math.max(Number(error?.retryAfterMs) || 0, Math.min(3600_000, 30_000 * 2 ** job.attempts));
              store.retry(job.id, { dueAt: now() + wait, countAttempt: !rateLimited,
                errorCode: chatLimited ? 'telegram_chat_cooldown' : rateLimited ? 'telegram_rate_limit' : 'telegram_temporary_failure' });
              retried++;
              if (rateLimited && !chatLimited) { store.setMeta('delivery_not_before', now() + wait); break; }
            } else store.block(job.id, 'telegram_delivery_failed');
          }
        }
        store.setMeta('delivery_checkpoint', { block: verified.indexedThrough, hash: verified.indexedBlockHash });
        return { status: outcomeUnknown ? 'outcome_unknown' : 'ok', sent, cancelled, retried,
          outcomeUnknown, sourceBlock: verified.indexedThrough };
      } finally { running = false; store.releaseLease(lease, owner); }
    },
  };
}
