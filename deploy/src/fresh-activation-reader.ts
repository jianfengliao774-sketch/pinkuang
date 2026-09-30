import type { Eip1193Provider } from 'ethers';

/** Only block headers use the existing same-origin, method-restricted reader.
 * Account selection, chain checks, calls, fees, nonces and signing stay with
 * the selected wallet. A failed reader never falls back to a fabricated tag.
 */
export function freshActivationReadWallet(wallet: Eip1193Provider, options: {
  pageUrl?: string; fetcher?: typeof fetch;
} = {}): Eip1193Provider {
  const pageUrl = options.pageUrl ?? (typeof window === 'undefined' ? undefined : window.location.href);
  if (!pageUrl) return wallet; // Node/disposable EVM tests have no deployment HTTP mount.
  const page = new URL(pageUrl);
  if (page.protocol !== 'https:' && !(page.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(page.hostname)))
    throw new Error('部署台只读连接必须使用 HTTPS。');
  const endpoint = new URL('api/rpc', page);
  const fetcher = options.fetcher ?? fetch;
  let sequence = 0;
  return { request: async request => {
    const params = request.params;
    if (request.method !== 'eth_getBlockByNumber' || !Array.isArray(params)
      || params.length !== 2 || params[1] !== false) return wallet.request(request);
    const id = ++sequence;
    const response = await fetcher(endpoint.href, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ jsonrpc: '2.0', id, method: request.method, params }),
    });
    if (!response.ok) throw new Error(`部署台只读区块服务暂不可用（HTTP ${response.status}），请稍后重试。`);
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new Error('部署台只读区块服务返回了无效数据，请稍后重试。'); }
    const reply = value as {jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown} | null;
    if (!reply || reply.jsonrpc !== '2.0' || reply.id !== id || reply.error !== undefined
      || !Object.hasOwn(reply, 'result')) throw new Error('部署台只读区块服务未能确认请求，请稍后重试。');
    return reply.result;
  } };
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
type Anchor = {number: number; hash: string | null};
const valid = (value: Anchor | null): value is Anchor => !!value
  && Number.isSafeInteger(value.number) && value.number >= 0 && !!value.hash && HASH.test(value.hash);

/** Sequential tags avoid one parallel latest response preceding finalized.
 * Retry only empty/lagging tag snapshots; canonical ancestry remains the
 * caller's independent check, and a real RPC error is never swallowed.
 */
export async function readFreshActivationAnchors<T extends Anchor>(provider: {
  getBlock(tag: 'finalized' | 'latest'): Promise<T | null>;
}, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const finalized = await provider.getBlock('finalized');
    const head = await provider.getBlock('latest');
    if (valid(finalized) && valid(head) && head.number >= finalized.number) return {finalized, head};
    if (attempt < 2) await wait(250);
  }
  throw new Error('BSC 只读节点暂未返回一致的最终确认区块，请稍后重试；当前操作已暂停。');
}
