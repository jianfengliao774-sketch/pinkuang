import { ZeroAddress } from 'ethers';
import { LiveDataError } from './live-config.mjs';
import { settleReadRound } from './read-retry.mjs';

const SOURCE_NUMBERS = ['startBlock', 'confirmations', 'indexedThrough', 'indexedTimestamp', 'observedSafeHead'];
const SOURCE_IDENTITIES = ['factory', 'market', 'indexedBlockHash'];
const address = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && value.toLowerCase() !== ZeroAddress;
const blockHash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
function checkedSource(result) {
  const source = result?.source;
  if (!source || source.complete !== true || source.unknownReason !== null)
    throw new LiveDataError('index_incomplete', '索引尚未完整核验，请稍后刷新。');
  if (source.chainId !== 56 || !address(source.factory) || !address(source.market) || !blockHash(source.indexedBlockHash)
    || SOURCE_NUMBERS.some(key => !Number.isSafeInteger(source[key]) || source[key] < 0)
    || source.confirmations < 1 || source.startBlock > source.indexedThrough || source.indexedThrough !== source.observedSafeHead)
    throw new LiveDataError('invalid_data', '页面读取缺少有效的同块来源。');
  return source;
}

/** Every branch keeps its own full verification; only a complete, same-source round may reach the UI. */
export async function readPageRound(client, { route, account, marketTab } = {}) {
  // Copy the route/account before asynchronous work; cancellation remains the caller's epoch guard.
  const name = typeof route === 'string' ? route : route?.route;
  const pool = typeof route === 'object' ? route?.pool : undefined;
  const owner = account || undefined;
  // Operator permissions, quotes and portfolio creation have independent chain reads.
  // A moving public index must not disable unrelated administrative controls.
  if (name === 'operator') return { catalog: null };
  const tasks = { catalog: () => client.readPools({ account: owner || ZeroAddress }) };
  if (name === 'home') tasks.stats = () => client.readStats();
  if (owner && ['overview', 'rewards', 'market', 'governance'].includes(name))
    tasks.positions = () => client.readPositions({ account: owner });
  if (name === 'detail' && pool) {
    tasks.detail = () => client.readPool({ pool, account: owner || ZeroAddress });
    tasks.governance = () => client.readGovernance({ pool, account: owner || ZeroAddress });
    tasks.activity = () => client.readActivity({ pool });
  }
  if (name === 'market' && (marketTab !== 'mine' || owner))
    tasks.orders = () => client.readOrders(marketTab === 'mine' ? { seller: owner } : { active: true });
  if (['records', 'overview', 'rewards'].includes(name))
    tasks.activity = () => client.readActivity({ account: name === 'records' ? undefined : owner });

  // Fetch index documents together, before any branch's RPC verification can consume the snapshot window.
  // An integrity/permission failure takes priority over transient failures; all started reads are drained.
  const result = await settleReadRound(tasks);
  const expected = checkedSource(result.catalog);
  for (const branch of Object.values(result)) {
    const source = checkedSource(branch);
    if (SOURCE_NUMBERS.some(key => source[key] !== expected[key])
      || SOURCE_IDENTITIES.some(key => source[key].toLowerCase() !== expected[key].toLowerCase()))
      throw new LiveDataError('source_changed', '索引已更新，正在重新读取同一区块的页面。');
  }
  return result;
}
