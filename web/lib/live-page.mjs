import { ZeroAddress } from 'ethers';
import { LiveDataError } from './live-config.mjs';

const SOURCE_NUMBERS = ['startBlock', 'confirmations', 'indexedThrough', 'indexedTimestamp', 'observedSafeHead'];
const address = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && value.toLowerCase() !== ZeroAddress;
const blockHash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
function checkedSource(result) {
  const source = result?.source;
  if (source?.displayOnly === true) {
    if (source.chainId !== 56 || !address(source.factory) || !address(source.market)
      || !Number.isSafeInteger(source.indexedThrough) || !Number.isSafeInteger(source.indexedTimestamp))
      throw new LiveDataError('invalid_data', '页面数据格式无效。');
    return source;
  }
  if (!source || source.complete !== true || source.unknownReason !== null)
    throw new LiveDataError('index_incomplete', '索引尚未完整核验，请稍后刷新。');
  if (source.chainId !== 56 || !address(source.factory) || !address(source.market) || !blockHash(source.indexedBlockHash)
    || SOURCE_NUMBERS.some(key => !Number.isSafeInteger(source[key]) || source[key] < 0)
    || source.confirmations < 1 || source.startBlock > source.indexedThrough || source.indexedThrough !== source.observedSafeHead)
    throw new LiveDataError('invalid_data', '页面读取缺少有效的同块来源。');
  if (source.readMode === 'verified_snapshot'
    ? source.stale !== true || source.transactionReady !== false || typeof source.refreshing !== 'boolean'
    : source.stale === true || source.transactionReady === false && source.displayOnly !== true)
    throw new LiveDataError('index_stale', '历史展示快照缺少明确的过期或交易限制标记。');
  return source;
}

/** Only the route's catalog is awaited here; other page sections read independently. */
export async function readPageRound(client, { route, account, marketTab = 'whole' } = {}) {
  // Copy the route/account before asynchronous work; cancellation remains the caller's epoch guard.
  const name = typeof route === 'string' ? route : route?.route;
  const pool = typeof route === 'object' ? route?.pool : undefined;
  const owner = account || undefined;
  // Operator permissions, quotes and portfolio creation have independent chain reads.
  // A moving public index must not disable unrelated administrative controls.
  if (name === 'operator') return { catalog: null };
  // Share orders and personal listings own their own read. The whole-miner tab
  // is the only market tab that needs the public pool catalog.
  if (name === 'market' && marketTab !== 'whole') return { catalog: null };
  if (['overview', 'rewards', 'records', 'portfolio'].includes(name) || (name === 'governance' && owner))
    return { catalog: null };
  // The detail itself is a complete, independently verified pool read. Do not
  // hold it behind unrelated catalog, governance or activity snapshots: those
  // can cross an index sync boundary while this pool remains perfectly valid.
  if (name === 'detail' && pool) {
    const detail = await (client.readDisplayPool ?? client.readPool)({ pool, account: owner || ZeroAddress });
    checkedSource(detail);
    return { detail };
  }
  const catalog = await (client.readDisplayPools ?? client.readPools)({ account: owner || ZeroAddress });
  checkedSource(catalog);
  return { catalog };
}
