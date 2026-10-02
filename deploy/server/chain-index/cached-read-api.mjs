import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { Interface, ZeroAddress, ZeroHash, getAddress, toQuantity } from 'ethers';
import { cacheDecode, cacheEncode } from './pool-display-cache.mjs';
import { SALE_REVIEW_THRESHOLD_VIEW, normalizeSaleReviewThresholdBps, effectiveSaleReviewThresholdBps, readSaleReviewThresholdBps,
  requiresSaleReview } from '../../shared/sale-review-policy.mjs';

const artifacts = JSON.parse(readFileSync(new URL('../../public/deployment-artifacts.json', import.meta.url)));
const vaultAbi = new Interface(artifacts.artifacts.BudgetPortfolioVault.abi);
const poolAbi = new Interface(artifacts.artifacts.PoolVault.abi);
const marketAbi = new Interface(artifacts.artifacts.ShareMarket.abi);
const thresholdAbi = new Interface([SALE_REVIEW_THRESHOLD_VIEW]);
const publicNames = ['OFFICIAL_FACTORY', 'legacyFactory', 'state', 'budgetWei', 'absoluteCapWei', 'unitCapWei',
  'spentWei', 'totalSupply', 'memberCount', 'childCount', 'activeChildCount', 'fundingDeadline', 'purchaseDeadline',
  'fundingFailed', 'refundPerShareWei', 'salePerShareWei', 'activeProposalId', 'nextProposalId', 'shareTradingAllowed', 'nextRoundAt'];
const memberNames = ['balanceOf', 'claimableBem', 'bnbOwed', 'refundSettled', 'saleDebt', 'lockedShares'];
const topics = Object.freeze(['pools', 'portfolios', 'orders', 'stats', 'activity']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const need = (ok, message) => { if (!ok) throw new DisplayReadError(503, message); };
const address = value => { try { return getAddress(value); } catch { throw new DisplayReadError(400, 'Invalid address.'); } };
function indexedBusinessRevision(index) {
  const count = index.db.prepare('SELECT COUNT(*) AS count FROM logs').get().count;
  const tip = index.db.prepare('SELECT block_number,tx_hash,log_index FROM logs ORDER BY block_number DESC,tx_index DESC,log_index DESC LIMIT 1').get() ?? null;
  const logBlockHash = tip ? index._header?.(tip.block_number)?.hash ?? null : null;
  return createHash('sha256').update(JSON.stringify([index.factory, index.portfolioFactory, count, tip, logBlockHash])).digest('hex');
}
export class DisplayReadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** A bounded shared cache. Expiry starts one refresh while readers keep the previous display value. */
export class DisplayReadCache {
  constructor({ ttlMs = 20_000, staleMs = 30 * 60_000, maxEntries = 256, now = Date.now } = {}) {
    this.ttlMs = ttlMs; this.staleMs = staleMs; this.maxEntries = maxEntries; this.now = now;
    this.entries = new Map(); this.stopped = false;
  }
  restore(key, value, savedAt) {
    if (this.stopped || !Number.isSafeInteger(savedAt) || savedAt > this.now() || this.now() - savedAt > this.staleMs) return;
    this.room(key); this.entries.set(key, { value, savedAt, lastUsed: this.now(), loading: null });
  }
  room(key) {
    if (this.entries.has(key) || this.entries.size < this.maxEntries) return;
    const candidates = [...this.entries].filter(([, item]) => !item.loading).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    if (!candidates.length) throw new DisplayReadError(503, 'Display reads are busy.');
    this.entries.delete(candidates[0][0]);
  }
  get(key, load, { force = false } = {}) {
    if (this.stopped) return Promise.reject(new DisplayReadError(503, 'Display cache is closing.'));
    this.room(key);
    let entry = this.entries.get(key);
    if (!entry) { entry = { value: undefined, savedAt: 0, lastUsed: this.now(), loading: null }; this.entries.set(key, entry); }
    entry.lastUsed = this.now();
    const age = this.now() - entry.savedAt;
    const usable = entry.value !== undefined && age >= 0 && age <= this.staleMs;
    if (!force && usable && age < this.ttlMs) return Promise.resolve(entry.value);
    if (!entry.loading) {
      entry.loading = Promise.resolve().then(load).then(value => {
        if (!this.stopped) { entry.value = value; entry.savedAt = this.now(); }
        return value;
      }).finally(() => { entry.loading = null; if (entry.value === undefined) this.entries.delete(key); });
      // A stale read is deliberately independent of a failed background refresh.
      void entry.loading.catch(() => {});
    }
    return !force && usable ? Promise.resolve(entry.value) : entry.loading;
  }
  metadata(key) {
    const entry = this.entries.get(key), age = entry ? this.now() - entry.savedAt : null;
    return { cacheAgeMs: age, stale: age === null || age >= this.ttlMs, refreshing: Boolean(entry?.loading) };
  }
  async close() { this.stopped = true; await Promise.allSettled([...this.entries.values()].map(item => item.loading)); }
}

function referenceState([priceWei, observedAt, sourceDigest], timestamp) {
  const available = priceWei > 0n && sourceDigest !== ZeroHash && observedAt <= timestamp && timestamp - observedAt <= 900n;
  return { available, priceWei, observedAt, sourceDigest,
    reason: available ? null : 'Firsto 市场参考价缺失或超过 15 分钟有效期。' };
}
function proposalGate(candidate, openerExecuted, row) {
  const passed = candidate.yesShares >= candidate.threshold && candidate.yesMembers * 2n > candidate.memberCount;
  const open = row.state === 2n && !openerExecuted && !candidate.executed && row.timestamp < candidate.endsAt;
  const reference = candidate.saleReference, review = candidate.saleReview;
  const saleReviewThresholdBps = normalizeSaleReviewThresholdBps(candidate.saleReviewThresholdBps ?? row.saleReviewThresholdBps);
  const discounted = reference?.available ? candidate.price < reference.priceWei : null;
  const reviewRequired = reference?.available ? requiresSaleReview(candidate.price, reference.priceWei, saleReviewThresholdBps) : null;
  const reviewApproved = review?.available === true && review.status === 1n;
  let executionBlockReason = null;
  if (!reference?.available) executionBlockReason = reference?.reason || 'Firsto 市场参考价不可用，暂不能挂牌。';
  else if (reviewRequired && !review?.available) executionBlockReason = review?.reason || '平台审核状态不可用，暂不能挂牌。';
  else if (reviewRequired && review.status === 2n) executionBlockReason = '平台已驳回这项子矿机出售提案。';
  else if (reviewRequired && !reviewApproved) executionBlockReason = '低于 Firsto 市场参考价的审核门槛，尚待平台审核通过。';
  return { passed, discounted, reviewRequired, reviewApproved, saleReviewThresholdBps,
    canExecute: open && passed && executionBlockReason === null, executionBlockReason };
}

/** Business getters are centralized here; HTTP reads never repeat code, storage or canonical proofs. */
export class PortfolioDisplayReads {
  constructor(index, provider, { path, now = Date.now, ttlMs = 20_000, staleMs = 30 * 60_000,
    maxEntries = 256, concurrency = 8, maxQueuedReads = 512 } = {}) {
    this.index = index; this.provider = provider; this.path = path; this.now = now;
    this.cache = new DisplayReadCache({ now, ttlMs, staleMs, maxEntries });
    this.shared = new DisplayReadCache({ now, ttlMs: staleMs, staleMs, maxEntries: maxEntries * 2 });
    this.active = 0; this.waiting = []; this.concurrency = concurrency; this.maxQueuedReads = maxQueuedReads;
    this.watched = new Map(); this.stopped = false; this.running = null;
    this.lastBusinessRevision = null;
    if (!index.portfolioFactory || !index.portfolioMarket) throw new Error('Portfolio display requires its configured Factory and market.');
    try {
      const bytes = readFileSync(path); if (bytes.length > 8 * 1024 * 1024) throw new Error('Oversized display snapshot.');
      const saved = JSON.parse(bytes, cacheDecode);
      if (saved.schemaVersion === 1 && same(saved.factory, index.factory) && same(saved.portfolioFactory, index.portfolioFactory)
        && same(saved.portfolioMarket, index.portfolioMarket) && Array.isArray(saved.entries)) {
        for (const item of saved.entries.slice(0, maxEntries)) {
          if (/^(?:page|row):/.test(item.key) && this.validSaved(item.value)) this.cache.restore(item.key, item.value, item.savedAt);
        }
      }
    } catch { /* Missing or corrupt files are seeded by the first background pass. */ }
  }
  validSaved(value) {
    return value?.source && same(value.source.factory, this.index.factory)
      && same(value.source.portfolioFactory, this.index.portfolioFactory)
      && same(value.source.portfolioMarket, this.index.portfolioMarket)
      && (Array.isArray(value.data?.items) || value.data?.item?.kind === 'portfolio');
  }
  snapshot() {
    const snapshot = this.index.verifiedDisplaySnapshot();
    need(snapshot?.source && Array.isArray(snapshot.portfolios), 'Portfolio display directory is warming.');
    return snapshot;
  }
  async read(to, iface, name, args, block) {
    if (this.stopped) throw new DisplayReadError(503, 'Display reads are closing.');
    if (this.active < this.concurrency) this.active++;
    else {
      if (this.waiting.length >= this.maxQueuedReads) throw new DisplayReadError(503, 'Display reads are busy.');
      await new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
    }
    try {
      if (this.stopped) throw new DisplayReadError(503, 'Display reads are closing.');
      const raw = await this.provider.send('eth_call', [{ to, data: iface.encodeFunctionData(name, args) }, toQuantity(block)]);
      return iface.decodeFunctionResult(name, raw);
    } finally { const next = this.waiting.shift(); if (next) next.resolve(); else this.active--; }
  }
  async round(tasks) {
    const results = await Promise.allSettled(tasks);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map(result => result.value);
  }
  source(source, key) {
    return { ...source, ...this.cache.metadata(key), readMode: 'display', displayOnly: true,
      transactionReady: false, cacheOrigin: 'server' };
  }
  async publicRow(pool, source) {
    const block = source.indexedThrough, timestamp = BigInt(source.indexedTimestamp);
    const key = `base:${pool.toLowerCase()}:${block}:${source.indexedBlockHash}`;
    return this.shared.get(key, async () => {
      const [values, saleReviewThresholdBps] = await Promise.all([
        this.round(publicNames.map(name => this.read(pool, vaultAbi, name, [], block))),
        readSaleReviewThresholdBps(async () => (await this.read(pool, thresholdAbi, 'saleReviewThresholdBps', [], block))[0]),
      ]);
      const row = Object.fromEntries(publicNames.map((name, i) => [name, values[i][0]]));
      row.saleReviewThresholdBps = saleReviewThresholdBps;
      need(same(row.OFFICIAL_FACTORY, this.index.portfolioFactory) && same(row.legacyFactory, this.index.factory)
        && row.state <= 5n && row.totalSupply <= 100n && row.budgetWei > 0n && row.budgetWei % 100n === 0n,
      'Portfolio display fields are inconsistent.');
      Object.assign(row, { kind: 'portfolio', pool: address(pool), timestamp, unitPriceWei: row.budgetWei / 100n,
        blockNumber: BigInt(block), blockHash: source.indexedBlockHash, children: [], proposal: null, proposals: [] });
      const childThresholds = new Map();
      const childThreshold = child => {
        const key = child.toLowerCase();
        if (!childThresholds.has(key)) childThresholds.set(key,
          readSaleReviewThresholdBps(async () => (await this.read(child, thresholdAbi, 'saleReviewThresholdBps', [], block))[0]));
        return childThresholds.get(key);
      };
      if (row.activeProposalId > 0n) {
        need(row.nextProposalId > row.activeProposalId && row.nextProposalId - row.activeProposalId <= 16n,
          'Portfolio proposal range is unavailable.');
        const entries = await this.round(Array.from({ length: Number(row.nextProposalId - row.activeProposalId) }, (_, offset) => (async () => {
          const id = row.activeProposalId + BigInt(offset), p = await this.read(pool, vaultAbi, 'proposals', [id], block);
          const [referenceResult, reviewResult, childThresholdResult] = await Promise.allSettled([
            this.read(this.index.market, marketAbi, 'saleReference', [p.child], block),
            this.read(pool, vaultAbi, 'childSaleReview', [id], block),
            childThreshold(p.child),
          ]);
          const status = reviewResult.status === 'fulfilled' ? reviewResult.value[0] : null;
          return { id, child: address(p.child), price: p.price, referencePrice: p.referencePrice, referenceAt: p.referenceAt,
            endsAt: p.endsAt, memberCount: p.memberCount, yesMembers: p.yesMembers, yesShares: p.yesShares,
            executed: p.executed, hasVoted: false, threshold: 51n,
            saleReviewThresholdBps: effectiveSaleReviewThresholdBps(row.saleReviewThresholdBps,
              childThresholdResult.status === 'fulfilled' ? childThresholdResult.value : undefined),
            saleReference: referenceResult.status === 'fulfilled' ? referenceState(referenceResult.value, timestamp)
              : { available: false, reason: 'Firsto 市场参考价暂不可读取。' },
            saleReview: status !== null && status <= 2n ? { available: true, status }
              : { available: false, status: null, reason: '平台审核状态暂不可读取。' } };
        })()));
        row.proposals = entries.filter(p => p.endsAt === entries[0].endsAt)
          .map(p => ({ ...p, ...proposalGate(p, entries[0].executed, row) }));
        row.proposal = row.proposals[0];
      }
      return row;
    });
  }
  async memberRow(pool, account, source, base) {
    const key = `member:${pool.toLowerCase()}:${account.toLowerCase()}:${source.indexedThrough}:${source.indexedBlockHash}`;
    return this.shared.get(key, async () => {
      const names = memberNames, values = await this.round([...names.map(name => this.read(pool, vaultAbi, name, [account], source.indexedThrough)),
        ...base.proposals.map(p => this.read(pool, vaultAbi, 'hasVoted', [p.id, account], source.indexedThrough))]);
      const member = Object.fromEntries(names.map((name, i) => [name, values[i][0]]));
      need(member.balanceOf <= 100n && member.lockedShares <= member.balanceOf, 'Portfolio member fields are inconsistent.');
      return { ...member, voted: values.slice(names.length).map(result => result[0]) };
    });
  }
  async children(pool, source, count) {
    const block = source.indexedThrough, key = `children:${pool.toLowerCase()}:${block}:${source.indexedBlockHash}`;
    return this.shared.get(key, async () => {
      const size = Number(count < 100n ? count : 100n), children = [];
      for (let offset = 0; offset < size; offset += 4) children.push(...await this.round(Array.from({ length: Math.min(4, size - offset) }, (_, i) => (async () => {
        const child = address((await this.read(pool, vaultAbi, 'childAt', [BigInt(offset + i)], block))[0]);
        const [info, state, expiresAt, activatedAt] = await this.round([
          this.read(pool, vaultAbi, 'childInfo', [child], block), this.read(child, poolAbi, 'state', [], block),
          this.read(child, poolAbi, 'expiresAt', [], block), this.read(child, poolAbi, 'activatedAt', [], block),
        ]);
        return { pool: child, collection: address(info.collection), tokenId: info.tokenId, costWei: info.purchaseCost,
          official: info.official, sold: info.sold, state: state[0], expiresAt: expiresAt[0], activatedAt: activatedAt[0] };
      })())));
      return children;
    });
  }
  async row(pool, account, source, includeChildren) {
    const base = await this.publicRow(pool, source), member = await this.memberRow(pool, account, source, base);
    const shares = member.balanceOf, accrued = shares * base.salePerShareWei;
    need(accrued >= member.saleDebt, 'Portfolio BNB fields are inconsistent.');
    const refund = !member.refundSettled && base.state !== 0n && base.state !== 1n ? shares * base.refundPerShareWei : 0n;
    const { voted, ...memberFields } = member;
    const proposals = base.proposals.map((p, i) => ({ ...p, hasVoted: voted[i] }));
    return { ...base, ...memberFields, account, shares, availableShares: shares - member.lockedShares,
      withdrawableBnb: member.bnbOwed + refund + accrued - member.saleDebt,
      children: includeChildren ? await this.children(pool, source, base.childCount) : [], proposals,
      proposal: proposals[0] ?? null, displayOnly: true };
  }
  async page({ account = ZeroAddress, cursor = 0, limit = 20, mine = false } = {}, { force = false } = {}) {
    account = address(account);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new DisplayReadError(400, 'Invalid display pagination.');
    const key = `page:${account.toLowerCase()}:${cursor}:${limit}:${mine}`;
    const load = async () => {
      const snapshot = this.snapshot();
      let all = snapshot.portfolios;
      if (mine) {
        all = [];
        for (let offset = 0; offset < 500; offset += 50) {
          const page = this.index.portfolios({ account, cursor: offset, limit: 50 });
          all.push(...page.items);
          if (page.nextCursor === null) break;
        }
        need(all.length <= 500, 'Portfolio directory is too large.');
      }
      // The public snapshot and local directory are bounded. Read only this visible page.
      const entries = all.filter(item => item.createdBlock <= snapshot.source.indexedThrough), selected = entries.slice(cursor, cursor + limit);
      const items = [];
      for (let offset = 0; offset < selected.length; offset += 4) items.push(...await this.round(selected.slice(offset, offset + 4)
        .map(item => this.row(address(item.address), account, snapshot.source, false))));
      return { source: snapshot.source, data: { items, nextCursor: cursor + limit < entries.length ? cursor + limit : null } };
    };
    this.watch(key, load);
    const result = await this.cache.get(key, load, { force }), source = this.source(result.source, key);
    return { source, data: { ...result.data, items: result.data.items.map(item => ({ ...item, displaySource: source })) } };
  }
  async detail(pool, { account = ZeroAddress, includeChildren = true } = {}, { force = false } = {}) {
    pool = address(pool); account = address(account);
    const key = `row:${pool.toLowerCase()}:${account.toLowerCase()}:${includeChildren}`;
    const load = async () => {
      const snapshot = this.snapshot();
      if (!snapshot.portfolios.some(item => same(item.address, pool))) throw new DisplayReadError(404, 'Unknown portfolio.');
      return { source: snapshot.source, data: { item: await this.row(pool, account, snapshot.source, includeChildren) } };
    };
    this.watch(key, load);
    const result = await this.cache.get(key, load, { force }), source = this.source(result.source, key);
    return { source, data: { item: { ...result.data.item, displaySource: source } } };
  }
  watch(key, load) {
    this.watched.delete(key); this.watched.set(key, { load, seenAt: this.now() });
    if (this.watched.size > 64) this.watched.delete(this.watched.keys().next().value);
  }
  refresh() {
    if (this.stopped || this.running) return this.running ?? Promise.resolve();
    this.running = (async () => {
      const revision = indexedBusinessRevision(this.index), changed = revision !== this.lastBusinessRevision;
      await this.page({}, { force: true });
      const watched = [...this.watched].filter(([, item]) => this.now() - item.seenAt < 5 * 60_000).slice(-32);
      for (let i = 0; i < watched.length && !this.stopped; i += 4)
        await Promise.allSettled(watched.slice(i, i + 4).map(async ([key, item]) => {
          await this.cache.get(key, item.load, { force: changed });
          // A SWR result returns immediately; the push must wait for its background value.
          await this.cache.entries.get(key)?.loading;
        }));
      this.lastBusinessRevision = revision;
      this.persist();
    })().finally(() => { this.running = null; });
    void this.running.catch(() => {}); return this.running;
  }
  persist() {
    if (!this.path || this.stopped) return;
    const entries = [...this.cache.entries].filter(([, item]) => item.value !== undefined)
      .map(([key, item]) => ({ key, value: item.value, savedAt: item.savedAt }));
    const bytes = JSON.stringify({ schemaVersion: 1, factory: this.index.factory, portfolioFactory: this.index.portfolioFactory,
      portfolioMarket: this.index.portfolioMarket, entries }, cacheEncode);
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) return;
    const temporary = this.path + '.tmp'; writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, this.path);
  }
  async close() {
    this.stopped = true;
    for (const item of this.waiting.splice(0)) item.reject(new DisplayReadError(503, 'Display reads are closing.'));
    await Promise.allSettled([this.running, this.cache.close(), this.shared.close()]);
  }
}

/** One shared stream hub. Connections subscribe to local index invalidations, never to RPC requests. */
export class DisplayEvents {
  constructor(index, { now = Date.now, heartbeatMs = 20_000, throttleMs = 15_000, maxClients = 128, displayRevision = null } = {}) {
    this.index = index; this.now = now; this.throttleMs = throttleMs; this.maxClients = maxClients;
    this.displayRevision = displayRevision;
    this.clients = new Set(); this.closed = false; this.revision = 'initial'; this.lastSentAt = -Infinity; this.pending = null; this.timer = null;
    this.heartbeat = setInterval(() => { for (const client of [...this.clients]) this.write(client, ': heartbeat\n\n'); }, heartbeatMs);
    this.heartbeat.unref?.();
  }
  revisionFromIndex() {
    const source = this.index.status(); if (!source.complete || this.index.syncing) return null;
    const business = indexedBusinessRevision(this.index);
    if (!this.displayRevision) return business;
    const display = this.displayRevision();
    return display ? createHash('sha256').update(JSON.stringify([business,display])).digest('hex') : null;
  }
  publish() {
    if (this.closed) return;
    const revision = this.revisionFromIndex();
    if (!revision) return;
    if (revision === this.revision) { this.pending = null; clearTimeout(this.timer); this.timer = null; return; }
    if (revision === this.pending) return;
    this.pending = revision;
    const delay = Math.max(0, this.throttleMs - (this.now() - this.lastSentAt));
    if (!delay) this.flush();
    else if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay); this.timer.unref?.(); }
  }
  flush() {
    if (this.closed || !this.pending) return;
    this.revision = this.pending; this.pending = null; this.lastSentAt = this.now();
    const frame = this.frame(); for (const client of [...this.clients]) this.write(client, frame);
  }
  frame() { return `event: update\nid: ${this.revision}\ndata: ${JSON.stringify({ revision: this.revision, topics })}\n\n`; }
  write(client, data) {
    try {
      if (client.res.destroyed || client.res.writableLength > 8 * 1024 || !client.res.write(data)) {
        client.cleanup(); client.res.end();
      }
    } catch { client.cleanup(); client.res.destroy(); }
  }
  subscribe(req, res) {
    if (this.closed || this.clients.size >= this.maxClients) {
      res.statusCode = 503; res.setHeader('Retry-After', '15'); res.end(JSON.stringify({ error: 'Display stream is busy.' })); return;
    }
    res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    if (req.method === 'HEAD') { res.end(); return; }
    const client = { res, cleanup: null };
    client.cleanup = () => { this.clients.delete(client); req.off('aborted', client.cleanup); res.off('close', client.cleanup); };
    req.once('aborted', client.cleanup); res.once('close', client.cleanup); this.clients.add(client);
    this.write(client, `retry: 5000\n${this.frame()}`);
  }
  close() {
    this.closed = true; clearInterval(this.heartbeat); clearTimeout(this.timer);
    for (const client of [...this.clients]) { client.cleanup(); client.res.end(); }
  }
}
