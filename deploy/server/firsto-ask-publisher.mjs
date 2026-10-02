/** Publish only a pool's already-authorized native Firsto ask. No wallet, signing or chain writes. */
import { dirname, isAbsolute } from 'node:path';
import { Contract, Interface, getAddress } from 'ethers';
import { createFirstoNativeAsk, parseFirstoNativeAskPublication, findFirstoNativeAskRecord } from '../shared/firsto-native-ask.mjs';
import { readFirstoAskJournal, writeFirstoAskJournal, writeFirstoAskStatus, firstoAskMessages,
  pendingFirstoSaleIntentFromDatabase, acquireFirstoAskJournalLock } from './firsto-ask-publisher-store.mjs';

export const FIRSTO_ASK_API_ORIGIN = 'https://api-tapeout.firsto.ai';
export const FIRSTO_ASK_EXCHANGE = '0x33423244F9a5bF81b12B1a018aF6F4e079B97f29';
export const FIRSTO_NATIVE_SIGNATURE = `0x${'00'.repeat(65)}`;
const hash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const same = (a, b) => getAddress(a) === getAddress(b);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const nativeAbi = new Interface([
  'function nativeFirstoSaleVersion() pure returns(uint8)',
  'function state() view returns(uint8)',
  'function nativeFirstoAsk() view returns(tuple(address maker,address collection,uint256 tokenId,uint256 nonce,uint128 price,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion) ask,bytes32 orderHash,bool active)',
]);
const names = ['maker', 'collection', 'tokenId', 'nonce', 'price', 'expiry', 'payoutRecipient', 'feeBps', 'feeEpoch', 'schemaVersion'];

export function firstoAskPublisherConfiguration(env, { dbPath } = {}) {
  if (env.BEMINE_NATIVE_FIRSTO_ASKS_ENABLE !== '1') return null;
  const path = env.BEMINE_NATIVE_FIRSTO_ASKS_JOURNAL, statusPath = env.BEMINE_NATIVE_FIRSTO_ASKS_STATUS_PATH;
  need(isAbsolute(path ?? '') && isAbsolute(dbPath ?? '') && dirname(path) === dirname(dbPath)
    && path !== dbPath, 'Native ask publisher requires an isolated API-owned private journal beside its buyer-intent database.');
  need(isAbsolute(statusPath ?? '') && ![path, dbPath].includes(statusPath), 'Native ask publisher requires an isolated public status path.');
  if (env.BEMINE_NATIVE_FIRSTO_ASKS_API_ORIGIN)
    need(env.BEMINE_NATIVE_FIRSTO_ASKS_API_ORIGIN === FIRSTO_ASK_API_ORIGIN, 'Native asks may only use the fixed official Firsto API origin.');
  return { journal: path, statusPath, intentDbPath: dbPath, apiOrigin: FIRSTO_ASK_API_ORIGIN,
    timeoutMs: 10_000, maxResponseBytes: 1024 * 1024, intervalMs: 30_000, batch: 10, maxPools: 1000 };
}

/** No credentials or reverse IPC: publication runs beside the API's private DB. */
export function createFirstoAskApiWorker({ config, provider, factory, verifyDeployment, store, dependencies = {},
  publishStatus = writeFirstoAskStatus }) {
  need(store?.db && typeof store.db.prepare === 'function', 'Native ask publisher requires the API-owned journal store.');
  const hasPendingSaleIntent = pendingFirstoSaleIntentFromDatabase(store.db, { factory });
  return createFirstoAskPublisher({ config, provider, factory, verifyDeployment, hasPendingSaleIntent, dependencies, publishStatus });
}

export async function readNativeFirstoAsk(provider, pool) {
  const call = async name => nativeAbi.decodeFunctionResult(name,
    await provider.send('eth_call', [{ to: pool, data: nativeAbi.encodeFunctionData(name) }, 'latest']));
  const [version] = await call('nativeFirstoSaleVersion');
  if (version !== 1n) return { nativeVersion: Number(version), active: false };
  const [raw, orderHash, active] = await call('nativeFirstoAsk');
  const state = active ? 3n : (await call('state'))[0];
  return { nativeVersion: 1, active, state, orderHash, ask: Object.fromEntries(names.map((name, i) => [name, raw[i]])) };
}

async function officialRequest(config, fetcher, path, { body } = {}) {
  const url = new URL(path, FIRSTO_ASK_API_ORIGIN);
  need(url.origin === FIRSTO_ASK_API_ORIGIN && !url.username && !url.password && !url.hash,
    'Native ask publication destination changed.');
  const controller = new AbortController(); let timer;
  const work = async () => {
    const response = await fetcher(url.href, { method: body === undefined ? 'GET' : 'POST',
      body, redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
    need(!response.redirected && ![301, 302, 303, 307, 308].includes(response.status), 'Official ask API redirected.');
    need(/\bapplication\/([\w.+-]*\+)?json\b/i.test(response.headers?.get('content-type') ?? ''), 'Official ask API returned non-JSON.');
    const declared = Number(response.headers?.get('content-length') || 0);
    need(Number.isFinite(declared) && declared >= 0 && declared <= config.maxResponseBytes, 'Official ask API response exceeds its limit.');
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
        need(size <= config.maxResponseBytes, 'Official ask API response exceeds its limit.'); chunks.push(Buffer.from(part.value)); } }
      catch (error) { void reader.cancel().catch(() => {}); throw error; }
      text = Buffer.concat(chunks).toString('utf8');
    } else { text = await response.text(); need(Buffer.byteLength(text) <= config.maxResponseBytes, 'Official ask API response exceeds its limit.'); }
    const value = JSON.parse(text);
    need(value && typeof value === 'object' && !Array.isArray(value), 'Official ask API returned an invalid object.');
    return { status: response.status, value };
  };
  try { return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('Official ask API request timed out.')); }, config.timeoutMs); })]); }
  finally { clearTimeout(timer); controller.abort(); }
}

/** All observations are hints for publication, never instructions to close or hide a pool. */
export function createFirstoAskPublisher({ config, provider, factory, verifyDeployment, hasPendingSaleIntent,
  publishStatus = writeFirstoAskStatus, dependencies = {} } = {}) {
  need(config && typeof verifyDeployment === 'function' && typeof hasPendingSaleIntent === 'function'
    && typeof publishStatus === 'function', 'Native ask publication requires trusted graph, buyer-intent gate and public status writer.');
  need(config.apiOrigin === FIRSTO_ASK_API_ORIGIN, 'Native asks require the fixed official API origin.');
  for (const [name, ceiling] of Object.entries({ timeoutMs: 10_000, maxResponseBytes: 1024 * 1024, batch: 10, maxPools: 1000 }))
    need(Number.isSafeInteger(config[name]) && config[name] > 0 && config[name] <= ceiling, `Native ask ${name} exceeds its reviewed bound.`);
  factory = getAddress(factory);
  const now = dependencies.now ?? Date.now, fetcher = dependencies.fetcher ?? fetch,
    lock = dependencies.lockJournal ?? acquireFirstoAskJournalLock, read = dependencies.readJournal ?? readFirstoAskJournal,
    write = dependencies.writeJournal ?? writeFirstoAskJournal, readNative = dependencies.readNativeAsk ?? readNativeFirstoAsk;
  let stopped = false, task = null, cursor = 0; const pools = [], rows = {};
  const status = { schemaVersion: 1, kind: 'firsto-native-ask-publisher-v1', chainId: 56, factory,
    exchange: FIRSTO_ASK_EXCHANGE, enabled: false, updatedAt: new Date(now()).toISOString(), pools: rows };
  const row = (pool, state, fields = {}) => {
    rows[pool.toLowerCase()] = { ...rows[pool.toLowerCase()], pool, status: state,
      verifiedInOfficialBook: false, message: firstoAskMessages[state], ...fields };
    status.updatedAt = new Date(now()).toISOString(); publishStatus(config.statusPath, status);
  };
  async function discover() {
    if (dependencies.discoverPools) {
      pools.splice(0, pools.length, ...(await dependencies.discoverPools()).map(getAddress));
    } else {
      const registry = new Contract(factory, ['function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)'], provider);
      const count = Number(await registry.poolCount());
      need(Number.isSafeInteger(count) && count <= config.maxPools && count >= pools.length, 'Native ask pool registry changed.');
      for (let n = pools.length; n < count; n++) pools.push(getAddress(await registry.allPools(n)));
    }
    need(pools.length <= config.maxPools && new Set(pools.map(p => p.toLowerCase())).size === pools.length, 'Native ask registry is incomplete or duplicated.');
  }
  const canonical = (pool, native) => {
    if (native.nativeVersion !== 1 || native.active !== true) return null;
    const value = createFirstoNativeAsk(native.ask, { pool, collection: native.ask.collection, tokenId: native.ask.tokenId,
      nativeAuthorized: true, nativeVersion: 1, signature: FIRSTO_NATIVE_SIGNATURE, expectedAskHash: native.orderHash });
    need(hash(native.orderHash) && value.askHash.toLowerCase() === native.orderHash.toLowerCase(), 'Native ask hash differs from the pool authorization.');
    need(BigInt(value.ask.expiry) > BigInt(Math.floor(now() / 1000)), 'Native ask authorization expired.');
    return value;
  };
  async function tick() {
    if (stopped) return;
    let release;
    try { release = lock(config.journal); }
    catch (error) { if (/Native ask lock already exists:/.test(error.message ?? '')) return; throw error; }
    try {
      const journal = read(config.journal, { factory, exchange: FIRSTO_ASK_EXCHANGE });
      const graph = await verifyDeployment();
      if (graph?.nativeSaleUpgrade?.version !== 1) {
        status.enabled = false; status.updatedAt = new Date(now()).toISOString();
        for (const pool of pools) row(pool, 'upgrade-required');
        publishStatus(config.statusPath, status); return;
      }
      need(BigInt(await provider.send('eth_chainId', [])) === 56n, 'Native ask RPC is not BSC mainnet.');
      await discover();
      const selected = Array.from({ length: Math.min(config.batch, pools.length) }, (_, i) => pools[(cursor + i) % pools.length]);
      cursor = pools.length ? (cursor + selected.length) % pools.length : 0;
      for (const pool of selected) {
        if (stopped) return;
        try {
          if (await hasPendingSaleIntent(pool)) { row(pool, 'buyer-pending'); continue; }
          let native;
          try { native = await readNative(provider, pool); }
          catch { row(pool, 'read-unavailable'); continue; }
          if (native.nativeVersion === 1) status.enabled = true;
          if (native.nativeVersion !== 1 || native.active !== true) {
            const expired = native.nativeVersion === 1 && native.state === 3n && native.ask?.expiry > 0n
              && BigInt(native.ask.expiry) <= BigInt(Math.floor(now() / 1000));
            if (expired && journal.pools[pool.toLowerCase()]) {
              journal.pools[pool.toLowerCase()].publicationStatus = 'expired'; write(config.journal, journal);
            }
            row(pool, native.nativeVersion !== 1 ? 'upgrade-required' : expired ? 'expired' : 'inactive'); continue;
          }
          const ask = canonical(pool, native), key = pool.toLowerCase();
          let saved = journal.pools[key];
          if (saved && saved.askHash.toLowerCase() !== ask.askHash.toLowerCase()) {
            // A different hash on the same nonce must be explicitly resolved;
            // relisting with a new on-chain proposal/nonce is a new authority.
            if (saved.nonce === ask.ask.nonce) { row(pool, 'order-conflict', { askHash: saved.askHash }); continue; }
            saved = null;
          }
          const lookup = await officialRequest(config, fetcher, `/v1/account/${pool}/circuit-orders?kind=listings`);
          need(lookup.status === 200, 'Official ask lookup is unavailable.');
          const existing = findFirstoNativeAskRecord(lookup.value, ask, { kind: 'account' });
          if (existing) {
            if (!['open', 'pending_approval'].includes(existing.status)) {
              row(pool, 'external-awaiting-chain', { askHash: ask.askHash, apiStatus: existing.status }); continue;
            }
            const parsed = parseFirstoNativeAskPublication(existing, ask);
            const phase = parsed.published ? 'published' : 'pending-approval';
            journal.pools[key] = { ...(saved ?? {}), pool, askHash: ask.askHash, nonce: ask.ask.nonce,
              envelope: ask.payload, phase, lastObservedAt: new Date(now()).toISOString() };
            write(config.journal, journal); row(pool, phase, { askHash: ask.askHash, priceWei: ask.priceWei,
              verifiedInOfficialBook: parsed.published }); continue;
          }
          if (saved && saved.phase !== 'prepared') {
            row(pool, saved.phase === 'rejected' ? 'publication-rejected'
              : saved.phase === 'published' && !saved.lastObservedAt ? 'publication-accepted' : 'publication-unknown',
            { askHash: saved.askHash }); continue;
          }
          // GET can span a sale or wallet-send. Re-read the one authorized
          // tuple and the local buyer reservation immediately before the POST.
          if (stopped || await hasPendingSaleIntent(pool)) { row(pool, 'buyer-pending'); continue; }
          const current = canonical(pool, await readNative(provider, pool));
          if (!current || current.askHash.toLowerCase() !== ask.askHash.toLowerCase()) { row(pool, 'authorization-changed'); continue; }
          // The RPC read may itself span a local wallet-send. This final
          // synchronous database observation precedes our durable HTTP intent.
          if (stopped || await hasPendingSaleIntent(pool)) { row(pool, 'buyer-pending'); continue; }
          const attempted = { pool, askHash: ask.askHash, nonce: ask.ask.nonce, envelope: ask.payload,
            phase: 'submitting', attemptedAt: new Date(now()).toISOString() };
          journal.pools[key] = attempted;
          // Durable attempted bytes precede the request. A crash, timeout or
          // unknown response resumes with a GET, never an automatic second POST.
          write(config.journal, journal); row(pool, 'publishing', { askHash: ask.askHash, priceWei: ask.priceWei });
          try {
            const response = await officialRequest(config, fetcher, '/v1/circuit-asks', { body: ask.body });
            if (response.status >= 400 && response.status < 500) {
              attempted.phase = 'rejected'; row(pool, 'publication-rejected', { askHash: ask.askHash });
            } else {
              need(response.status === 200 || response.status === 201, 'Official ask publication outcome is unknown.');
              const parsed = parseFirstoNativeAskPublication(response.value, ask);
              attempted.phase = parsed.published ? 'published' : 'pending-approval';
              attempted.acknowledgedAt = new Date(now()).toISOString();
              row(pool, parsed.published ? 'publication-accepted' : 'pending-approval', { askHash: ask.askHash });
            }
          } catch { attempted.phase = 'ambiguous'; row(pool, 'publication-unknown', { askHash: ask.askHash }); }
          write(config.journal, journal);
        } catch { row(pool, 'source-unavailable'); }
      }
    } finally { release?.(); }
  }
  return {
    tick() { if (task) return task; task = tick().finally(() => { task = null; }); return task; },
    snapshot() { return structuredClone(status); },
    async close() { stopped = true; await task; },
  };
}

/** Independent timer; it never invokes the price-reference publisher. */
export function trackFirstoAsks(publisher, { intervalMs = 30_000, onError = () =>
  console.error('Native Firsto ask publication unavailable; retaining exact publication state.') } = {}) {
  let stopped = false, timer, task;
  const check = () => { if (stopped) return; task = Promise.resolve().then(() => publisher.tick()).catch(onError)
    .finally(() => { if (!stopped) { timer = setTimeout(check, intervalMs); timer.unref?.(); } }); };
  check(); return async () => { stopped = true; clearTimeout(timer); await task; };
}
