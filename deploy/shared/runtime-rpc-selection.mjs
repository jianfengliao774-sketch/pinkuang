import { FetchRequest, JsonRpcProvider } from 'ethers';
import { isRpcTransportFailure, readOnlyRpcFallbackUrl } from './read-only-rpc-fallback.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const READ_METHODS = new Set(['eth_chainId', 'net_version', 'eth_blockNumber',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt',
  'eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs',
  'eth_feeHistory', 'eth_gasPrice', 'eth_maxPriorityFeePerGas']);
const RETRY_DELAYS = [1100, 2200];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const http429 = error => (error?.response?.statusCode ?? error?.info?.response?.statusCode
  ?? Number(String(error?.info?.responseStatus ?? '').match(/^\d{3}/)?.[0])) === 429;
const quotaLimited = row => row?.error?.code === -32005 && typeof row.error.message === 'string'
  && /\bCUPS\b|\bCompute Units Per Second\b|\brate[\s_-]?limit(?:ed|ing)?\b/i.test(row.error.message);
const idKey = id => `${typeof id}:${id}`;
const pureRead = rows => rows.length > 0 && rows.every(row => row?.jsonrpc === '2.0'
  && READ_METHODS.has(row.method) && Array.isArray(row.params)
  && (typeof row.id === 'string' || Number.isSafeInteger(row.id)))
  && new Set(rows.map(row => idKey(row.id))).size === rows.length;
const unavailableRead = row => ({ jsonrpc: '2.0', id: row.id,
  error: { code: -32098, message: 'Runtime RPC read transport failed; retry the read later.' } });

async function readWithBackoff(rows, send, retryWait, isBatch) {
  const results = new Map();
  const preserveOrThrow = error => {
    if (!results.size) throw error;
    // Keep the last validated quota error for a failed retry. Never overwrite
    // an already received success or business error with a transport failure.
    return rows.map(row => results.get(idKey(row.id)) ?? unavailableRead(row));
  };
  let pending = rows;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try { response = await send(isBatch ? pending : pending[0]); }
    catch (error) {
      if (!http429(error) || attempt === 2) return preserveOrThrow(error);
      await retryWait(RETRY_DELAYS[attempt]); continue;
    }
    // Never retry a malformed or mismatched reply, even if it includes a quota
    // error. Exact IDs keep partial batches bound to their original requests.
    try { check(Array.isArray(response) && response.length === pending.length
      && response.every(row => row?.jsonrpc === '2.0' && pending.some(request => request.id === row.id)
        && Object.hasOwn(row, 'result') !== Object.hasOwn(row, 'error')
        && (!Object.hasOwn(row, 'error') || Number.isInteger(row.error?.code) && typeof row.error.message === 'string'))
      && new Set(response.map(row => idKey(row.id))).size === pending.length,
    'Runtime RPC response does not match the read batch.'); }
    catch (error) { return preserveOrThrow(error); }
    const retryIds = new Set();
    for (const row of response) {
      results.set(idKey(row.id), row);
      if (attempt < 2 && quotaLimited(row)) retryIds.add(idKey(row.id));
    }
    if (!retryIds.size) return rows.map(row => results.get(idKey(row.id)));
    pending = pending.filter(row => retryIds.has(idKey(row.id)));
    await retryWait(RETRY_DELAYS[attempt]);
  }
}

class ReadBackoffRpcProvider extends JsonRpcProvider {
  #readQueue = Promise.resolve();
  #retryWait;
  #serializeReads;
  #readOnly;
  #maxConcurrentReads;
  #activeReads = 0;
  #queuedReads = [];
  #unsettledReads = new Set();
  #closed = false;
  constructor(request, network, providerOptions, retryWait, serializeReads = true,
    { readOnly = false, maxConcurrentReads = null } = {}) {
    super(request, network, providerOptions); this.#retryWait = retryWait;
    this.#serializeReads = serializeReads;
    check(!readOnly || serializeReads === false && Number.isSafeInteger(maxConcurrentReads)
      && maxConcurrentReads >= 1 && maxConcurrentReads <= 4,
    'Read-only proof lane requires an explicit one-to-four request concurrency bound.');
    check(readOnly || maxConcurrentReads === null,
      'A concurrency bound is only available to a read-only proof lane.');
    this.#readOnly = readOnly; this.#maxConcurrentReads = maxConcurrentReads;
  }
  #boundedRead(run) {
    const result = new Promise((resolve, reject) => {
      const start = () => {
        if (this.#closed || this.destroyed) { reject(new Error('Read-only proof lane is closed.')); return; }
        this.#activeReads += 1;
        void Promise.resolve().then(run).then(
          value => { this.#finishRead(); resolve(value); },
          error => { this.#finishRead(); reject(error); });
      };
      if (this.#closed || this.destroyed) reject(new Error('Read-only proof lane is closed.'));
      else if (this.#activeReads < this.#maxConcurrentReads) start();
      else this.#queuedReads.push({ start, reject });
    });
    this.#unsettledReads.add(result);
    void result.then(() => this.#unsettledReads.delete(result), () => this.#unsettledReads.delete(result));
    return result;
  }
  #finishRead() {
    this.#activeReads -= 1;
    if (!this.#closed) this.#queuedReads.shift()?.start();
  }
  destroy() {
    if (this.#closed) return;
    this.#closed = true;
    for (const queued of this.#queuedReads.splice(0))
      queued.reject(new Error('Read-only proof lane is closed.'));
    super.destroy();
  }
  async settleAndDestroy() {
    const pending = [...this.#unsettledReads];
    this.destroy();
    await Promise.allSettled(pending);
  }
  _send(payload) {
    const rows = Array.isArray(payload) ? payload : [payload];
    if (this.#readOnly) check(rows.length === 1 && pureRead(rows),
      'Read-only proof lane blocked a non-read or batched RPC method.');
    // Writes, signing methods, unknown methods and mixed batches preserve the
    // original one-attempt transport. They never enter a read retry queue.
    if (!pureRead(rows)) return super._send(payload);
    const run = async () => {
      const values = [];
      for (let offset = 0; offset < rows.length; offset += 4) {
        try { values.push(...await readWithBackoff(rows.slice(offset, offset + 4),
          request => { check(!this.destroyed, 'Runtime RPC provider is closed.'); return super._send(request); },
          this.#retryWait, Array.isArray(payload))); }
        catch (error) {
          if (!values.length) throw error;
          // Ethers resolves each ID independently. A later transport failure
          // must not reject the successes from earlier four-request groups.
          return [...values, ...rows.slice(offset).map(unavailableRead)];
        }
      }
      return values;
    };
    if (this.#readOnly) return this.#boundedRead(run);
    // Interactive signer reads form a small bounded concurrent group. They
    // must not wait behind a historical graph scan or another read's backoff.
    if (!this.#serializeReads) return run();
    const result = this.#readQueue.then(run);
    this.#readQueue = result.catch(() => {});
    return result;
  }
}

function singleAttempt(request) {
  const value = request.clone();
  value.setThrottleParams({ maxAttempts: 1 });
  value.retryFunc = async () => false;
  return value;
}

async function verifyBsc(request) {
  const probe = singleAttempt(request);
  probe.method = 'POST';
  probe.setHeader('content-type', 'application/json');
  probe.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  const response = await probe.send();
  response.assertOk();
  check(response.body?.length > 0 && response.body.length <= 16384, 'Runtime RPC identity response size is invalid.');
  // A non-JSON HTTP body is a transport failure. A JSON-RPC error or malformed
  // identity is a business reply and must never be concealed by another node.
  const result = response.bodyJson;
  check(result && !Array.isArray(result) && result.jsonrpc === '2.0' && result.id === 1 && !result.error,
    'Runtime RPC identity response is invalid.');
  check(typeof result.result === 'string' && /^0x[\da-f]+$/i.test(result.result)
    && BigInt(result.result) === 56n, 'Runtime RPC is not BSC mainnet (56).');
}

/** Select once, before signing or submission. Neither a later read failure nor
 * an unknown broadcast outcome is permission to select another node. */
export async function selectRuntimeRpcRequest(request, { env = process.env } = {}) {
  const primary = singleAttempt(typeof request === 'string' ? new FetchRequest(request) : request);
  const backupUrl = readOnlyRpcFallbackUrl(primary.url, env);
  try {
    await verifyBsc(primary);
    return { request: primary, source: 'configured-primary' };
  } catch (error) {
    if (!backupUrl || !isRpcTransportFailure(error)) throw error;
    const backup = new FetchRequest(backupUrl);
    backup.timeout = Math.min(primary.timeout, 8000);
    const selected = singleAttempt(backup);
    await verifyBsc(selected);
    return { request: selected, source: 'configured-fallback' };
  }
}

/** Async worker startup: a single selected transport owns every nonce, receipt,
 * chain read and broadcast for the lifetime of this provider. */
export async function createRuntimeRpcProvider(request, { env = process.env, network, providerOptions = {}, retryWait = wait, serializeReads = true } = {}) {
  const selected = await selectRuntimeRpcRequest(request, { env });
  return new ReadBackoffRpcProvider(selected.request, network, providerOptions, retryWait, serializeReads);
}

class DeferredRuntimeRpcProvider extends ReadBackoffRpcProvider {
  #selection;
  #selected;
  #outstandingSends = new Set();
  constructor(request, { env, network, providerOptions, retryWait, serializeReads, selection,
    readOnly = false, maxConcurrentReads = null }) {
    super(request, network, { batchMaxCount: 1, ...providerOptions }, retryWait, serializeReads,
      { readOnly, maxConcurrentReads });
    this.#selection = (selection ?? selectRuntimeRpcRequest(request, { env }))
      .then(value => { this.#selected = value; return value; });
    // Sync service construction can finish before its first awaited readiness
    // check. Preserve the failure for that check without an unhandled rejection.
    this.#selection.catch(() => {});
  }
  ready() { return this.#selection.then(() => undefined); }
  // Separate queues, the same already selected transport and chain proof. This
  // adds no second startup request and cannot silently choose another node.
  forkReadLane({ providerOptions = {}, serializeReads = true, retryWait = wait,
    readOnly = false, maxConcurrentReads = null } = {}) {
    return new DeferredRuntimeRpcProvider(this._getConnection(), {
      network: 56, providerOptions, retryWait, serializeReads, readOnly,
      maxConcurrentReads, selection: this.#selection,
    });
  }
  _getConnection() { return this.#selected ? this.#selected.request.clone() : super._getConnection(); }
  async _send(payload) {
    const send=(async()=>{await this.ready();return super._send(payload);})();
    this.#outstandingSends.add(send);
    try{return await send;}finally{this.#outstandingSends.delete(send);}
  }
  async settleAndDestroy() {
    const pending=[...this.#outstandingSends];
    await super.settleAndDestroy();
    await Promise.allSettled(pending);
  }
}

/** Sync service factory compatibility. Selection starts immediately, and all
 * provider I/O waits for it. A failed selection is sticky and fails closed. */
export function createDeferredRuntimeRpcProvider(request, { env = process.env, network, providerOptions = {}, retryWait = wait, serializeReads = true } = {}) {
  const primary = typeof request === 'string' ? new FetchRequest(request) : request;
  return new DeferredRuntimeRpcProvider(primary, { env, network, providerOptions, retryWait, serializeReads });
}
