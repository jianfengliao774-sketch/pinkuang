import { randomUUID } from 'node:crypto';
import { verifyNotificationSource } from './delivery.mjs';
import { assertCommunityDestination } from './community-config.mjs';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const UINT = /^(0|[1-9]\d{0,77})$/;
const STATES = new Set(['Funding', 'Funded', 'Active', 'Listed', 'Closed', 'Refunding']);
const fail = () => { throw new Error('Community source is unverified, stale or changed.'); };
const address = value => { if (typeof value !== 'string' || !ADDRESS.test(value)) fail(); return value.toLowerCase(); };
const uint = value => { const text = String(value); if (!UINT.test(text) || BigInt(text) >= 2n ** 256n) fail(); return text; };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const wei = value => {
  const n = BigInt(uint(value));
  const fraction = (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${n / 10n ** 18n}${fraction ? `.${fraction}` : ''}`;
};

function validatePool(pool, block = Number.MAX_SAFE_INTEGER) {
  address(pool.address); address(pool.collection);
  uint(pool.circuitId); if (pool.actualCircuitId != null) uint(pool.actualCircuitId);
  uint(pool.targetRaiseWei); uint(pool.unitPriceWei);
  if (pool.verified !== true || !integer(pool.createdBlock) || pool.createdBlock > block || !integer(pool.createdAt)
    || !/^0x[0-9a-f]{64}:\d+$/i.test(pool.eventId) || !STATES.has(pool.state)
    || !integer(pool.totalShares) || pool.totalShares !== 100 || !integer(pool.subscribedShares)
    || pool.subscribedShares > pool.totalShares || !integer(pool.fundingDeadline)
    || pool.fundingDeadline > 8_640_000_000_000 || typeof pool.depositPaused !== 'boolean' || BigInt(pool.unitPriceWei) === 0n
    || BigInt(pool.targetRaiseWei) === 0n) fail();
  return pool;
}

/** All pages use one canonical snapshot; only the local configured index can supply projects. */
export function createCommunitySource({ baseUrl, fetchImpl = fetch, maxPages = 200, timeoutMs = 45_000 } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash) throw new Error('A credential-free loopback chain-index URL is required.');
  if (!integer(maxPages) || maxPages < 1 || maxPages > 200 || !integer(timeoutMs) || timeoutMs < 1 || timeoutMs > 45_000)
    throw new Error('Community source read bounds are invalid.');
  return async (checkpoint = null) => {
    const overall = AbortSignal.timeout(timeoutMs), items = [], invalidPools = [], seen = new Set();
    let cursor = 0, first = null;
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${base.href.replace(/\/$/, '')}/v1/community`);
      url.searchParams.set('cursor', String(cursor)); url.searchParams.set('limit', '5');
      if (first) { url.searchParams.set('atBlock', String(first.indexedThrough)); url.searchParams.set('atHash', first.indexedBlockHash); }
      if (checkpoint) { url.searchParams.set('anchorBlock', String(checkpoint.block)); url.searchParams.set('anchorHash', checkpoint.hash); }
      if (overall.aborted) fail();
      const response = await fetchImpl(url, { signal: AbortSignal.any([overall, AbortSignal.timeout(30_000)]), redirect: 'error' });
      if (!response.ok || Number(response.headers?.get?.('content-length') ?? 0) > 4_000_000) fail();
      const raw = await response.text(); if (Buffer.byteLength(raw) > 4_000_000) fail();
      const { source: s, data } = JSON.parse(raw);
      const rejected = data?.invalidPools ?? [];
      if (!s?.complete || s.unknownReason || !HASH.test(s.indexedBlockHash) || !data || data.schemaVersion !== 1
        || !Array.isArray(data.items) || data.items.length > 5 || !Array.isArray(rejected)
        || rejected.length > 5 || data.items.length + rejected.length > 5
        || checkpoint && data.anchorVerified !== true) fail();
      if (first && (s.indexedThrough !== first.indexedThrough || s.indexedBlockHash !== first.indexedBlockHash
        || s.factory !== first.factory || s.market !== first.market || s.chainId !== first.chainId
        || s.indexedTimestamp !== first.indexedTimestamp || s.observedSafeHead !== first.observedSafeHead)) fail();
      first ??= s;
      for (const rawAddress of rejected) {
        const key = address(rawAddress); if (seen.has(key)) fail(); seen.add(key); invalidPools.push(key);
      }
      for (const pool of data.items) {
        const key = address(pool?.address); if (seen.has(key)) fail(); seen.add(key); items.push(pool);
      }
      if (data.nextCursor === null) return { source: first, schemaVersion: 1, items, invalidPools,
        nextCursor: null, anchorVerified: checkpoint ? true : null };
      if (!integer(data.nextCursor) || data.nextCursor <= cursor) fail();
      cursor = data.nextCursor;
    }
    throw new Error('Community source page bound exceeded.');
  };
}

const slogans = [
  ['一人一份，一起开矿。', 'One share each. Mine together.'],
  ['矿机有点大？我们一起拿下。', 'Big miner? Let’s team up.'],
  ['把热爱拼在一起。', 'Bring your enthusiasm. Join the pool.'],
];
const labels = {
  Funding: ['开放认购', 'Open for subscription'], Funded: ['募集完成，等待购机', 'Funded · awaiting purchase'],
  Active: ['购机成功，挖矿中', 'Purchased · mining'], Listed: ['矿机挂牌出售中', 'Miner listed for sale'],
  Closed: ['项目已关闭', 'Pool closed'], Refunding: ['募集已结束', 'Funding ended'], Expired: ['认购已截止', 'Subscription closed'],
  Paused: ['认购暂时暂停', 'Subscription paused'],
};
const stateOf = (pool, now) => pool.state === 'Funding' ? pool.fundingDeadline * 1000 <= now ? 'Expired'
  : pool.depositPaused ? 'Paused' : pool.state : pool.state;
const open = (pool, now) => stateOf(pool, now) === 'Funding' && pool.subscribedShares < pool.totalShares;

export function renderCommunityAnnouncement(pool, { publicBaseUrl, now = Date.now() } = {}) {
  validatePool(pool);
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('HTTPS public app URL is required.');
  const poolAddress = address(pool.address), state = stateOf(pool, now), label = labels[state];
  const slogan = slogans[parseInt(poolAddress.slice(-4), 16) % slogans.length];
  const deadline = new Date(pool.fundingDeadline * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const miner = pool.actualCircuitId != null && ['Active', 'Listed', 'Closed'].includes(pool.state)
    ? `矿机 / Miner #${pool.actualCircuitId}` : `参考矿机 / Reference miner #${pool.circuitId}`;
  const caption = `拼矿 BEMine｜${label[0]}\n${label[1]}\n\n${slogan[0]}\n${slogan[1]}\n\n${miner}\n每份认购（含预留）/ Per share (incl. reserve): ${wei(pool.unitPriceWei)} BNB\n募集目标 / Target: ${wei(pool.targetRaiseWei)} BNB\n发布时进度 / Snapshot: ${pool.subscribedShares}/${pool.totalShares} 份 / shares\n认购截止 / Deadline: ${deadline}\n\n最新状态与参与规则请查看项目。\nOpen the project for current status and participation rules.`;
  if (caption.length > 1024) throw new Error('Community caption exceeds Telegram photo limit.');
  const link = lang => { const url = new URL(base); url.searchParams.set('lang', lang); url.hash = `detail/${poolAddress}`; return url.href; };
  return { caption, reply_markup: { inline_keyboard: [[{ text: '查看项目', url: link('zh') }, { text: 'View pool', url: link('en') }]] } };
}

/** Public announcements have separate durable state and never enter the personal notification queue. */
export function createCommunityWorker({ store, source, sender, factory, market, publicBaseUrl, community,
  now = Date.now, maxSourceAgeMs = 120_000 } = {}) {
  factory = address(factory); market = address(market);
  if (!store?.db || typeof source !== 'function' || typeof sender?.sendTopicPhoto !== 'function'
    || typeof sender?.editTopicCaption !== 'function') throw new Error('Community worker dependencies are required.');
  assertCommunityDestination(community);
  const destination = Object.freeze({ ...community, chatId: String(community.chatId) });
  const base = new URL(publicBaseUrl), photo = new URL(destination.photoUrl);
  if (base.protocol !== 'https:' || base.username || base.password || photo.protocol !== 'https:' || photo.username || photo.password
    || photo.origin !== base.origin) throw new Error('Same-origin HTTPS community image and public app URL are required.');
  const scope = `community:56:${factory}:${market}:${destination.chatId}:${destination.threadId}`;
  const checkpointKey = `${scope}:checkpoint`, baselineKey = `${scope}:baseline`, cooldownKey = `${scope}:not_before`;
  const owner = randomUUID(), ttlMs = 120_000;
  let running = false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS community_announcements (
    scope TEXT NOT NULL, pool TEXT NOT NULL, event_id TEXT NOT NULL, message_id INTEGER,
    last_state TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL, error_code TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(scope,pool));
    CREATE INDEX IF NOT EXISTS community_announcements_due ON community_announcements(scope,status,due_at);`);
  return {
    async tick() {
      if (running || !store.acquireLease(scope, owner, ttlMs, now())) return { status: 'busy', sent: 0, edited: 0 };
      running = true;
      try {
        const checkpoint = store.getMeta(checkpointKey), feed = await source(checkpoint);
        const verifiedItems = feed?.items?.filter(pool => pool?.verified === true);
        const verifiedFeed = { ...feed, items: verifiedItems };
        const verified = verifyNotificationSource(verifiedFeed, { factory, market, now: now(), checkpoint, maxSourceAgeMs });
        const pools = new Map();
        let invalid = feed.invalidPools?.length ?? 0;
        for (const pool of feed.items) {
          const key = address(pool?.address);
          if (pools.has(key) || feed.invalidPools?.includes(key)) fail();
          try { validatePool(pool, verified.indexedThrough); pools.set(key, pool); }
          catch { invalid++; }
        }
        if (!store.acquireLease(scope, owner, ttlMs, now())) throw new Error('Community worker lease was lost.');
        const baseline = store.getMeta(baselineKey), nextCheckpoint = { block: verified.indexedThrough, hash: verified.indexedBlockHash };
        if (baseline === null) {
          store.transaction(() => { store.setMeta(baselineKey, nextCheckpoint); store.setMeta(checkpointKey, nextCheckpoint); });
          return { status: 'baselined', sent: 0, edited: 0, sourceBlock: verified.indexedThrough };
        }
        store.transaction(() => {
          for (const [key, pool] of pools) {
            if (pool.createdBlock > baseline.block && open(pool, now())) {
              store.db.prepare('INSERT OR IGNORE INTO community_announcements(scope,pool,event_id,due_at,updated_at) VALUES(?,?,?,?,?)')
                .run(scope, key, pool.eventId, now(), now());
            }
            const row = store.db.prepare('SELECT * FROM community_announcements WHERE scope=? AND pool=?').get(scope, key);
            if (!row) continue;
            if (row.event_id !== pool.eventId) {
              // Never edit a message whose creation event changed, but keep
              // unrelated projects moving while the operator investigates.
              pools.delete(key); invalid++; continue;
            }
            if ((!row.message_id && row.status === 'cancelled' && open(pool, now()))
              || row.message_id && row.status === 'idle' && row.last_state !== stateOf(pool, now())) {
              store.db.prepare("UPDATE community_announcements SET status='pending',attempts=0,due_at=?,updated_at=?,error_code=NULL WHERE scope=? AND pool=?")
                .run(now(), now(), scope, key);
            } else if (!row.message_id && row.status === 'pending' && !open(pool, now())) {
              store.db.prepare("UPDATE community_announcements SET status='cancelled',updated_at=? WHERE scope=? AND pool=?").run(now(), scope, key);
            }
          }
        });
        let sent = 0, edited = 0, retried = 0, blocked = 0, outcomeUnknown = 0;
        const keys = [...pools.keys()];
        const job = !keys.length || now() < (store.getMeta(cooldownKey) ?? 0) ? null
          : store.db.prepare(`SELECT * FROM community_announcements WHERE scope=? AND status='pending' AND due_at<=?
              AND pool IN (${keys.map(() => '?').join(',')}) ORDER BY due_at,pool LIMIT 1`).get(scope, now(), ...keys);
        if (job) {
          const pool = pools.get(job.pool); if (!pool) fail();
          verifyNotificationSource(verifiedFeed, { factory, market, now: now(), checkpoint, maxSourceAgeMs });
          if (!store.acquireLease(scope, owner, ttlMs, now())) throw new Error('Community worker lease was lost.');
          let accepted = false;
          try {
            const renderedAt = now(), renderedState = stateOf(pool, renderedAt);
            const message = renderCommunityAnnouncement(pool, { publicBaseUrl, now: renderedAt });
            // A crash after Telegram accepts a request can lose its receipt. Persist
            // the in-flight state before calling Telegram so restart never resends it.
            const reserved = store.db.prepare("UPDATE community_announcements SET status='sending',updated_at=? WHERE scope=? AND pool=? AND status='pending'")
              .run(now(), scope, job.pool);
            if (reserved.changes !== 1) throw new Error('Community announcement reservation failed.');
            const result = job.message_id ? await sender.editTopicCaption(destination, job.message_id, message)
              : await sender.sendTopicPhoto(destination, message);
            accepted = true;
            const messageId = job.message_id ?? result?.message_id;
            if (!Number.isSafeInteger(messageId) || messageId <= 0)
              throw Object.assign(new Error('Missing Telegram message id.'), { uncertain: true });
            store.db.prepare("UPDATE community_announcements SET status='idle',message_id=?,last_state=?,attempts=0,error_code=NULL,updated_at=? WHERE scope=? AND pool=?")
              .run(messageId, renderedState, now(), scope, job.pool);
            if (job.message_id) edited++; else sent++;
          } catch (error) {
            const rateLimited = error?.code === 429 || error?.code === 'rate_limited';
            if (accepted || error?.uncertain) {
              // Telegram may already have published or edited this message.
              // Never auto-send again without checking the exact group topic.
              store.db.prepare("UPDATE community_announcements SET status='blocked',attempts=attempts+1,error_code='telegram_outcome_unknown',updated_at=? WHERE scope=? AND pool=?")
                .run(now(), scope, job.pool);
              blocked++; outcomeUnknown++;
            } else if (!error?.blocked && (rateLimited || error?.retryable !== false && job.attempts + 1 < 8)) {
              const supplied = Number(error?.retryAfterMs), retryAfterMs = Number.isFinite(supplied) && supplied > 0 ? supplied : 0;
              const delay = rateLimited ? Math.max(1000, retryAfterMs || 30_000) : Math.max(retryAfterMs, Math.min(3600_000, 30_000 * 2 ** job.attempts));
              store.db.prepare("UPDATE community_announcements SET status='pending',attempts=attempts+?,due_at=?,error_code=?,updated_at=? WHERE scope=? AND pool=?")
                .run(rateLimited ? 0 : 1, now() + delay, rateLimited ? 'telegram_rate_limit' : 'telegram_temporary_failure', now(), scope, job.pool);
              if (rateLimited) store.setMeta(cooldownKey, now() + delay);
              retried++;
            } else {
              store.db.prepare("UPDATE community_announcements SET status='blocked',attempts=attempts+1,error_code='telegram_delivery_failed',updated_at=? WHERE scope=? AND pool=?")
                .run(now(), scope, job.pool); blocked++;
            }
          }
        }
        store.setMeta(checkpointKey, nextCheckpoint);
        const unresolved = store.db.prepare("SELECT status,error_code,COUNT(*) AS count FROM community_announcements WHERE scope=? AND status IN ('blocked','sending') GROUP BY status,error_code")
          .all(scope);
        const blockedPending = unresolved.reduce((sum, row) => sum + row.count, 0);
        const manualInspectionPending = unresolved.filter(row => row.status === 'sending' || row.error_code === 'telegram_outcome_unknown')
          .reduce((sum, row) => sum + row.count, 0);
        return { status: manualInspectionPending ? 'outcome_unknown'
          : blockedPending ? 'delivery_blocked' : invalid ? 'degraded' : 'ok',
          sent, edited, retried, blocked, outcomeUnknown, blockedPending, manualInspectionPending,
          invalidPools: invalid,
          sourceBlock: verified.indexedThrough };
      } finally { running = false; store.releaseLease(scope, owner); }
    },
  };
}
