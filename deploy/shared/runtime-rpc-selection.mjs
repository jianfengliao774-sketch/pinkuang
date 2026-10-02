import { FetchRequest, JsonRpcProvider } from 'ethers';
import { isRpcTransportFailure, readOnlyRpcFallbackUrl } from './read-only-rpc-fallback.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };

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
export async function createRuntimeRpcProvider(request, { env = process.env, network, providerOptions = {} } = {}) {
  const selected = await selectRuntimeRpcRequest(request, { env });
  return new JsonRpcProvider(selected.request, network, providerOptions);
}

class DeferredRuntimeRpcProvider extends JsonRpcProvider {
  #selection;
  #selected;
  constructor(request, { env, network, providerOptions }) {
    super(request, network, { batchMaxCount: 1, ...providerOptions });
    this.#selection = selectRuntimeRpcRequest(request, { env }).then(value => { this.#selected = value; return value; });
    // Sync service construction can finish before its first awaited readiness
    // check. Preserve the failure for that check without an unhandled rejection.
    this.#selection.catch(() => {});
  }
  ready() { return this.#selection.then(() => undefined); }
  _getConnection() { return this.#selected ? this.#selected.request.clone() : super._getConnection(); }
  async _send(payload) { await this.ready(); return super._send(payload); }
}

/** Sync service factory compatibility. Selection starts immediately, and all
 * provider I/O waits for it. A failed selection is sticky and fails closed. */
export function createDeferredRuntimeRpcProvider(request, { env = process.env, network, providerOptions = {} } = {}) {
  const primary = typeof request === 'string' ? new FetchRequest(request) : request;
  return new DeferredRuntimeRpcProvider(primary, { env, network, providerOptions });
}
