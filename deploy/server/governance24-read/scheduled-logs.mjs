import { clientAddress, createRequestLimiter } from '../upgrade-read/request-limiter.mjs';

export const GOVERNANCE24_OLD_TIMELOCK = '0x2c0aae63302a7bf7caf5322cdfc9da67d4ec8f97';
export const GOVERNANCE24_CALL_SCHEDULED_TOPIC = '0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca';
export const GOVERNANCE24_LOG_CHUNK_BLOCKS = 2048;
const HASH = /^0x[\da-f]{64}$/i, QUANTITY = /^0x(?:0|[1-9a-f][\da-f]{0,13})$/i, DATA = /^0x(?:[\da-f]{2})*$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeQuantity = value => typeof value === 'string' && QUANTITY.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
export class Governance24ReadError extends Error { constructor(status, message) { super(message); this.status = status; } }
const need = (condition, status, message) => { if (!condition) throw new Governance24ReadError(status, message); };

/** A single event signature, one fixed old48 timelock, and explicit finalized numeric chunks. */
export function validateGovernance24Logs(payload, reviewAnchorBlock) {
  need(Number.isSafeInteger(reviewAnchorBlock) && reviewAnchorBlock > 0, 503, 'A reviewed log anchor is required.');
  need(record(payload) && Object.keys(payload).every(key => ['jsonrpc', 'id', 'method', 'params'].includes(key))
    && payload.jsonrpc === '2.0' && (Number.isSafeInteger(payload.id) && payload.id >= 0
      || typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 64)
    && payload.method === 'eth_getLogs' && Array.isArray(payload.params) && payload.params.length === 1,
  400, 'A single identified log request is required.');
  const filter = payload.params[0];
  need(record(filter) && Object.keys(filter).every(key => ['address', 'topics', 'fromBlock', 'toBlock'].includes(key))
    && typeof filter.address === 'string' && filter.address.toLowerCase() === GOVERNANCE24_OLD_TIMELOCK
    && Array.isArray(filter.topics) && filter.topics.length >= 1 && filter.topics.length <= 3
    && typeof filter.topics[0] === 'string' && filter.topics[0].toLowerCase() === GOVERNANCE24_CALL_SCHEDULED_TOPIC
    && filter.topics.slice(1).every(topic => topic === null || typeof topic === 'string' && HASH.test(topic)),
  400, 'Only the pinned old timelock CallScheduled event and scalar indexed topics are enabled.');
  need(safeQuantity(filter.fromBlock) && safeQuantity(filter.toBlock)
    && BigInt(filter.fromBlock) > BigInt(reviewAnchorBlock) && BigInt(filter.toBlock) >= BigInt(filter.fromBlock)
    && BigInt(filter.toBlock) - BigInt(filter.fromBlock) < BigInt(GOVERNANCE24_LOG_CHUNK_BLOCKS),
  400, 'Logs require a numeric range after the review anchor containing at most 2048 blocks.');
  return { jsonrpc: '2.0', id: payload.id, method: 'eth_getLogs', params: [{ address: GOVERNANCE24_OLD_TIMELOCK,
    topics: filter.topics.map(topic => topic === null ? null : topic.toLowerCase()),
    fromBlock: `0x${BigInt(filter.fromBlock).toString(16)}`, toBlock: `0x${BigInt(filter.toBlock).toString(16)}` }] };
}

/** Refuse removed, duplicate, unrelated or malformed upstream rows instead of dropping any row. */
export function normalizeGovernance24Logs(value, filter) {
  need(Array.isArray(value) && value.length <= 4096, 502, 'Invalid bounded scheduled log result.');
  const seen = new Set();
  return value.map(row => {
    need(record(row) && row.removed === false && typeof row.address === 'string'
      && row.address.toLowerCase() === GOVERNANCE24_OLD_TIMELOCK
      && Array.isArray(row.topics) && row.topics.length === 3 && row.topics.every(topic => typeof topic === 'string' && HASH.test(topic))
      && row.topics[0].toLowerCase() === GOVERNANCE24_CALL_SCHEDULED_TOPIC
      && filter.topics.every((topic, index) => topic === null || row.topics[index].toLowerCase() === topic)
      && safeQuantity(row.blockNumber) && BigInt(row.blockNumber) >= BigInt(filter.fromBlock) && BigInt(row.blockNumber) <= BigInt(filter.toBlock)
      && safeQuantity(row.transactionIndex) && safeQuantity(row.logIndex)
      && typeof row.transactionHash === 'string' && HASH.test(row.transactionHash)
      && typeof row.blockHash === 'string' && HASH.test(row.blockHash)
      && typeof row.data === 'string' && DATA.test(row.data) && row.data.length <= 65538,
    502, 'Upstream scheduled logs are outside the pinned canonical event scope.');
    const key = `${row.blockHash.toLowerCase()}:${row.logIndex.toLowerCase()}`;
    need(!seen.has(key), 502, 'Upstream returned duplicate scheduled logs.'); seen.add(key);
    return { address: GOVERNANCE24_OLD_TIMELOCK, topics: row.topics.map(topic => topic.toLowerCase()), data: row.data.toLowerCase(),
      blockNumber: row.blockNumber.toLowerCase(), transactionHash: row.transactionHash.toLowerCase(),
      transactionIndex: row.transactionIndex.toLowerCase(), blockHash: row.blockHash.toLowerCase(), logIndex: row.logIndex.toLowerCase(), removed: false };
  });
}

/** This handler has no fallback, cache, index, signer or mutable state destination. */
export function createGovernance24ScheduledLogs({ rpcUrl, reviewAnchorBlock, fetcher = globalThis.fetch,
  timeoutMs = 13000, maxResponseBytes = 1048576, maxConcurrent = 4, maxConcurrentPerClient = 2, archiveReadStartIntervalMs = 100 } = {}) {
  const url = new URL(rpcUrl);
  need(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash, 503, 'A fixed archive destination is required.');
  need(Number.isSafeInteger(reviewAnchorBlock) && reviewAnchorBlock > 0, 503, 'A reviewed log anchor is required.');
  need([timeoutMs, maxResponseBytes, maxConcurrent, maxConcurrentPerClient, archiveReadStartIntervalMs].every(value => Number.isSafeInteger(value) && value > 0),
    503, 'Invalid scheduled log limits.');
  const allow = createRequestLimiter({ perClient: 180 }), clients = new Map(); let active = 0, nextStart = 0, pacing = Promise.resolve();
  const pace = async signal => {
    const previous = pacing; let release; pacing = new Promise(resolve => { release = resolve; });
    try {
      await previous; if (signal.aborted) throw new Error('Read canceled.');
      const delay = nextStart - Date.now();
      if (delay > 0) await new Promise((resolveWait, reject) => {
        const cancel = () => { clearTimeout(timer); reject(new Error('Read canceled.')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolveWait(); }, delay);
        signal.addEventListener('abort', cancel, { once: true });
      });
      nextStart = Date.now() + archiveReadStartIntervalMs;
    } finally { release(); }
  };
  return async (payload, req) => {
    const normalized = validateGovernance24Logs(payload, reviewAnchorBlock), client = clientAddress(req), count = clients.get(client) ?? 0;
    need(allow(req), 429, 'Scheduled log request rate exceeded.');
    need(active < maxConcurrent && count < maxConcurrentPerClient, 503, 'Scheduled log reads are busy.');
    active++; clients.set(client, count + 1);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const read = async (method, params, id) => {
      await pace(controller.signal);
      const response = await fetcher(url.href, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      need(response.ok && !response.redirected && /\bapplication\/([\w.+-]*\+)?json\b/i.test(response.headers.get('content-type') ?? ''),
        502, 'Archive scheduled log read unavailable.');
      const declared = Number(response.headers.get('content-length') ?? 0);
      need(Number.isFinite(declared) && declared >= 0 && declared <= maxResponseBytes, 502, 'Archive response exceeds its limit.');
      const reader = response.body?.getReader(); need(reader, 502, 'Archive response body unavailable.');
      const chunks = []; let size = 0;
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; need(size <= maxResponseBytes, 502, 'Archive response exceeds its limit.'); chunks.push(Buffer.from(chunk.value)); } }
      catch (error) { void reader.cancel().catch(() => {}); throw error; }
      let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Governance24ReadError(502, 'Archive response is invalid.'); }
      need(record(value) && value.jsonrpc === '2.0' && value.id === id && Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error'),
        502, 'Archive response did not match the read request.'); return value.result;
    };
    try {
      need(await read('eth_chainId', [], 'gov24-log-chain') === '0x38', 502, 'Archive is not on BSC.');
      const header = await read('eth_getBlockByNumber', ['finalized', false], 'gov24-log-finalized');
      need(record(header) && safeQuantity(header.number) && typeof header.hash === 'string' && HASH.test(header.hash)
        && BigInt(normalized.params[0].toBlock) <= BigInt(header.number), 400, 'Scheduled logs must end at or before the finalized archive head.');
      const logs = normalizeGovernance24Logs(await read('eth_getLogs', normalized.params, normalized.id), normalized.params[0]);
      const after = await read('eth_getBlockByNumber', [header.number, false], 'gov24-log-canonical');
      need(record(after) && after.number === header.number && typeof after.hash === 'string' && after.hash.toLowerCase() === header.hash.toLowerCase()
        && await read('eth_chainId', [], 'gov24-log-chain-after') === '0x38', 502, 'Finalized archive anchor changed during the log read.');
      return { jsonrpc: '2.0', id: normalized.id, result: logs };
    } catch (error) { if (error instanceof Governance24ReadError) throw error;
      throw new Governance24ReadError(controller.signal.aborted ? 504 : 502, 'Archive scheduled log read unavailable.'); }
    finally { clearTimeout(timer); controller.abort(); active--; const remaining = (clients.get(client) ?? 1) - 1;
      if (remaining) clients.set(client, remaining); else clients.delete(client); }
  };
}
