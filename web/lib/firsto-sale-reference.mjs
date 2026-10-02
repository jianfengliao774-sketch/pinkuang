import { Interface, getAddress } from 'ethers';
import { abi } from './chain-client.mjs';
import { QUOTE_BASE } from './quote-base.mjs';
import { readFirstoSaleReference } from '../../deploy/shared/firsto-sale-reference.mjs';
import { authorityActionStatus } from './authority-client.mjs';

const referenceViews = new Interface(['function saleReference(address) view returns(uint128 marketPriceWei,uint64 observedAt,bytes32 sourceDigest)']);
const need = (condition, message) => { if (!condition) throw new Error(message); };
const cancelled = signal => { if (signal?.aborted) throw Object.assign(new Error('参考价读取已取消。'), { name: 'AbortError' }); };
const same = (a, b) => getAddress(a) === getAddress(b);
const HASH = /^0x[0-9a-f]{64}$/i;

/** Both formal administrators may sign independently; a single-admin profile repeats the same address. */
export function isSaleReferenceAdministrator(config, account) {
  try {
    const roles = config?.freshAuthority ?? config?.manifest?.freshAuthority;
    return config?.stage === 'fresh-active' && !!roles && same(roles.address, config.authority)
      && [roles.administratorOne, roles.administratorTwo].some(value => same(account, value));
  } catch { return false; }
}

/** The browser wrapper authorizes the optional manual API; the automatic worker uses the shared reader. */
export async function prepareFirstoSaleReference({ config, provider, account, pool: poolInput, params, ...options } = {}) {
  need(isSaleReferenceAdministrator(config, account), '当前钱包不是登记的参考价管理员。');
  need(typeof provider?.request === 'function', '只读链上服务暂不可用。');
  const pool = getAddress(poolInput);
  const identity = params ?? abi.PoolVault.decodeFunctionResult('params', await provider.request({
    method: 'eth_call', params: [{ to: pool, data: abi.PoolVault.encodeFunctionData('params') }, 'latest'],
  }))[0];
  return readFirstoSaleReference({ provider, pool, market: config.shareMarket, params: identity,
    baseUrl: QUOTE_BASE, ...options });
}

export function matchingReferenceStatus(status, hash) {
  return HASH.test(hash ?? '') && status?.kind === 'setSaleReference'
    && typeof status.hash === 'string' && status.hash.toLowerCase() === hash.toLowerCase();
}

/** Confirm the business value once, so an older same-kind Authority receipt cannot report this update as done. */
export async function confirmFirstoSaleReference(provider, args) {
  const value = referenceViews.decodeFunctionResult('saleReference', await provider.request({ method: 'eth_call',
    params: [{ to: args.market, data: referenceViews.encodeFunctionData('saleReference', [args.pool]) }, 'latest'] }));
  need(value.marketPriceWei === BigInt(args.priceWei) && value.observedAt === BigInt(args.observedAt)
    && value.sourceDigest.toLowerCase() === args.digest.toLowerCase(), '链上参考价尚未对应本次更新，请继续查看交易状态。');
  return true;
}

function delay(ms, signal) {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      reject(Object.assign(new Error('已停止查看交易。'), { name: 'AbortError' })); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Bounded receipt tracking only. Foreign hashes are ignored; failures and timeouts never resubmit. */
export async function waitForFirstoSaleReference({ config, account, hash, signal, onStatus,
  statusReader = authorityActionStatus, now = Date.now, sleep = delay, timeoutMs = 120_000, intervalMs = 3000 }) {
  need(HASH.test(hash ?? ''), '代付交易编号暂不可用，请在运营工作台查看。');
  const until = now() + timeoutMs;
  while (now() < until) {
    cancelled(signal);
    let timer, abort;
    try {
      const status = await Promise.race([statusReader(config, account), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('交易状态读取超时。')), Math.min(15_000, until - now()));
      }), new Promise((_, reject) => {
        abort = () => reject(Object.assign(new Error('已停止查看交易。'), { name: 'AbortError' }));
        signal?.addEventListener('abort', abort, { once: true });
      })]);
      cancelled(signal);
      if (matchingReferenceStatus(status, hash)) {
        onStatus?.(status);
        if (status.status === 'confirmed') return status;
        if (status.status === 'failed') throw Object.assign(new Error('参考价更新交易失败，请在运营工作台查看该交易。'), { terminal: true, hash });
      }
    } catch (error) {
      if (signal?.aborted || error.terminal) throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    await sleep(Math.min(intervalMs, Math.max(0, until - now())), signal);
  }
  throw Object.assign(new Error('交易仍待确认。已保留交易编号，请继续查看，勿重复签名。'), { pending: true, hash });
}
