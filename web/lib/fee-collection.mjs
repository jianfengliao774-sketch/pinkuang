import { Interface, getAddress, keccak256, toQuantity } from 'ethers';
import { uint } from './chain-client.mjs';
import { hash, insist, liveAddress, validateManifest } from './live-config.mjs';
import { createDisplayReadCache, displayConfigIdentity, displayProviderIdentity } from './display-read-cache.mjs';

const BEM = getAddress('0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a');
const MAX_BATCH_SOURCES = 24;
const displayReads = createDisplayReadCache();
const bindings = new Interface([
  'function coreFactory() view returns(address)',
  'function budgetFactory() view returns(address)',
  'function gasWallet() view returns(address)',
  'function BEM() view returns(address)',
  'function shareMarket() view returns(address)',
  'function factory() view returns(address)',
  'function legacyFactory() view returns(address)',
  'function OFFICIAL_FACTORY() view returns(address)',
  'function treasury() view returns(address)',
  'function isPool(address) view returns(bool)',
  'function poolCount() view returns(uint256)',
  'function allPools(uint256) view returns(address)',
  'function portfolioCount() view returns(uint256)',
  'function portfolioAt(uint256) view returns(address)',
  'function bnbOwed(address) view returns(uint256)',
  'function balanceOf(address) view returns(uint256)',
]);
const same = (a, b) => getAddress(a) === getAddress(b);
const check = (condition, message) => insist(condition, 'fee_collection', message);
const abortError = () => Object.assign(new Error('手续费读取已取消。'), { name: 'AbortError' });
const abortCheck = signal => { if (signal?.aborted) throw abortError(); };

// EIP-1193 has no cancellation primitive. Abort rejects all consumers promptly
// and prevents queued requests from starting; already-running view calls settle
// independently and are never used by a cancelled collection plan.
function readQueue(provider, signal) {
  let active = 0, stopped = false;
  const waiting = [], running = new Set(), jobs = new Set();
  function stop(error = abortError()) {
    stopped = true;
    for (const job of jobs) job.reject(error);
    jobs.clear(); waiting.length = 0;
  }
  const onAbort = () => stop();
  signal?.addEventListener('abort', onAbort, { once: true });
  function pump() {
    while (!stopped && active < 4 && waiting.length) {
      const job = waiting.shift(); active++;
      const task = Promise.resolve().then(() => {
        abortCheck(signal);
        return job.provider.request(job.input);
      }).then(job.resolve, job.reject).finally(() => {
        active--; jobs.delete(job); running.delete(task); pump();
      });
      running.add(task);
    }
  }
  return {
    request(input, rpcProvider = provider) {
      abortCheck(signal);
      if (stopped) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const job = { input, provider: rpcProvider, resolve, reject };
        jobs.add(job); waiting.push(job); pump();
      });
    },
    async close() {
      stop(); signal?.removeEventListener('abort', onAbort);
      if (!signal?.aborted) await Promise.allSettled([...running]);
    },
  };
}

async function scanCount(count, task, signal) {
  let next = 0n;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < count) {
      abortCheck(signal);
      const index = next++;
      await task(index);
    }
  }));
}

function collectionBatches(markets, pools, directBnbWei, directBemWei) {
  const sources = [...markets.map(address => ({ kind: 'markets', address })),
    ...pools.map(address => ({ kind: 'pools', address }))];
  const batches = [];
  for (let index = 0; index < sources.length; index += MAX_BATCH_SOURCES) {
    const batch = { markets: [], pools: [] };
    for (const source of sources.slice(index, index + MAX_BATCH_SOURCES)) batch[source.kind].push(source.address);
    batches.push(batch);
  }
  if (!batches.length && (directBnbWei > 0n || directBemWei > 0n)) batches.push({ markets: [], pools: [] });
  return batches;
}

/**
 * Discover every claimable fee source belonging to the current formal deployment.
 * Only view RPCs are issued. Every registry, binding and balance uses one block;
 * any incomplete read rejects the entire plan instead of returning assumed zero.
 */
export function readFeeCollection(input = {}) {
  const { config, provider, balanceProvider = provider, account = '', signal,
    force = false, refreshToken = 0, cacheMs = 120_000, now = Date.now } = input;
  if (config?.displayOnly !== true || !provider?.request || !balanceProvider?.request)
    return readFeeCollectionUncached(input);
  const key = JSON.stringify([displayConfigIdentity(config), (account || '').toLowerCase(), displayProviderIdentity(balanceProvider)]);
  return displayReads(provider, key, sharedSignal => readFeeCollectionUncached({ ...input, signal: sharedSignal }),
    { signal, force, refreshToken, cacheMs, now });
}

async function readFeeCollectionUncached({ config, provider, balanceProvider = provider, signal } = {}) {
  abortCheck(signal);
  check(config?.stage === 'fresh-active', '手续费归集仅用于当前正式部署。');
  check(typeof provider?.request === 'function', '手续费只读服务暂不可用。');
  check(typeof balanceProvider?.request === 'function', '手续费余额只读服务暂不可用。');
  const manifest = validateManifest(config.manifest);
  check(manifest.kind === 'integrated-v2' && manifest.freshAuthority, '当前部署缺少完整手续费管理员接线。');
  const authority = manifest.authority;
  for (const key of ['authority', 'factory', 'shareMarket', 'portfolioFactory', 'portfolioMarket', 'gasWallet'])
    check(same(config[key], manifest[key]), '手续费配置与当前正式部署不一致。');
  const direct = config.displayOnly === true;
  if (!direct) check(config.stale !== true, '请先读取当前正式部署状态。');
  const queue = readQueue(provider, signal);
  const request = (method, params = []) => queue.request({ method, params });
  const balanceRequest = (method, params = []) => queue.request({ method, params }, balanceProvider);
  try {
    const [chain, block] = direct ? [null, null] : await Promise.all([
      request('eth_chainId'), request('eth_getBlockByNumber', ['latest', false]),
    ]);
    if (!direct) {
      check(BigInt(chain) === 56n, '请切换至 BSC 主网。');
      check(block?.number && block?.timestamp && hash(block.hash), '当前手续费区块暂不可用。');
    }
    const blockNumber = direct ? null : BigInt(block.number), tag = direct ? 'latest' : toQuantity(blockNumber);
    if (!direct) check(blockNumber >= BigInt(manifest.verifiedBlockNumber), 'RPC 尚未同步到当前正式部署。');
    async function verifyBalanceProvider() {
      if (direct || balanceProvider === provider) return;
      const [balanceChain, balanceBlock] = await Promise.all([
        balanceRequest('eth_chainId'), balanceRequest('eth_getBlockByNumber', [tag, false]),
      ]);
      check(BigInt(balanceChain) === 56n && balanceBlock?.number
        && BigInt(balanceBlock.number) === blockNumber
        && balanceBlock?.hash?.toLowerCase() === block.hash.toLowerCase(),
      '手续费余额服务的网络或区块与当前链上数据不一致。');
    }
    // The public view proxy intentionally does not expose eth_getBalance. A
    // connected wallet may supply this one balance read, after proving the same
    // chain and pinned block. Both providers share the four-request queue.
    await verifyBalanceProvider();
    const read = async (to, name, args = []) => bindings.decodeFunctionResult(name,
      await request('eth_call', [{ to, data: bindings.encodeFunctionData(name, args) }, tag]))[0];
    if (!direct) {
    const roots = ['factory', 'shareMarket', 'portfolioFactory', 'portfolioMarket'];
    const values = await Promise.all([
      read(authority, 'coreFactory'), read(authority, 'budgetFactory'), read(authority, 'gasWallet'), read(authority, 'BEM'),
      read(manifest.factory, 'shareMarket'), read(manifest.shareMarket, 'factory'),
      read(manifest.portfolioFactory, 'shareMarket'), read(manifest.portfolioMarket, 'factory'),
      read(manifest.portfolioFactory, 'legacyFactory'),
      ...[authority, ...roots.map(key => manifest[key])].map(address => request('eth_getCode', [address, tag])),
    ]);
    check(same(values[0], manifest.factory) && same(values[1], manifest.portfolioFactory)
      && same(values[2], manifest.gasWallet) && same(values[3], BEM), '管理员手续费绑定与当前正式部署不一致。');
    check(same(values[4], manifest.shareMarket) && same(values[5], manifest.factory)
      && same(values[6], manifest.portfolioMarket) && same(values[7], manifest.portfolioFactory)
      && same(values[8], manifest.factory), '手续费市场与当前正式工厂不一致。');
    const expectedCodes = [manifest.freshAuthority.codehash, ...roots.map(key => manifest.codehash[key])];
    check(values.slice(9).every((code, index) => code && code !== '0x'
      && keccak256(code).toLowerCase() === expectedCodes[index]), '手续费合约代码与正式部署不一致。');
    }

    const [coreCount, budgetCount, directBnb, directBem, marketBnb, portfolioMarketBnb] = await Promise.all([
      read(manifest.factory, 'poolCount'), read(manifest.portfolioFactory, 'portfolioCount'),
      balanceRequest('eth_getBalance', [authority, tag]), read(BEM, 'balanceOf', [authority]),
      read(manifest.shareMarket, 'bnbOwed', [authority]), read(manifest.portfolioMarket, 'bnbOwed', [authority]),
    ]);
    const directBnbWei = uint(BigInt(directBnb)), directBemWei = uint(directBem);
    const markets = [], owed = new Map(), candidates = new Map();
    for (const [address, amount] of [[manifest.shareMarket, marketBnb], [manifest.portfolioMarket, portfolioMarketBnb]]) {
      const exact = uint(amount);
      if (exact > 0n) { markets.push(address); owed.set(address, exact); }
    }
    async function enumerate(factory, count, getter, offset = 0n) {
      await scanCount(uint(count), async index => {
        const address = liveAddress(await read(factory, getter, [index]));
        const key = address.toLowerCase();
        if (!candidates.has(key)) candidates.set(key, { address, factories: new Set(), ordinal: offset + index });
        else if (offset + index < candidates.get(key).ordinal) candidates.get(key).ordinal = offset + index;
        candidates.get(key).factories.add(factory);
      }, signal);
    }
    // Enumerate all registry entries, including closed pools and purchased or
    // reserved budget children. There is deliberately no first-page ceiling.
    await enumerate(manifest.factory, coreCount, 'allPools');
    await enumerate(manifest.portfolioFactory, budgetCount, 'portfolioAt', uint(coreCount));
    const directory = [...candidates.values()].sort((a, b) => a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0);
    const poolOwed = new Map();
    await scanCount(BigInt(directory.length), async index => {
      const entry = directory[Number(index)], registeredFactories = [...entry.factories];
      if (!direct) {
      const [binding, treasury, ...registered] = await Promise.all([
        read(entry.address, 'OFFICIAL_FACTORY'), read(entry.address, 'treasury'),
        ...registeredFactories.map(factory => read(factory, 'isPool', [entry.address])),
      ]);
      check(registered.every(value => value === true)
        && registeredFactories.some(factory => same(binding, factory)), '手续费池未在当前正式工厂登记。');
      if (!same(treasury, authority)) return;
      const [token, amount] = await Promise.all([
        read(entry.address, 'BEM'), read(entry.address, 'bnbOwed', [authority]),
      ]);
      check(same(token, BEM), '手续费池的 BEM 资产绑定不一致。');
      const exact = uint(amount);
      if (exact > 0n) poolOwed.set(entry.address, exact);
      } else {
        const exact = uint(await read(entry.address, 'bnbOwed', [authority]));
        if (exact > 0n) poolOwed.set(entry.address, exact);
      }
    }, signal);
    // Preserve registry order even when RPC requests complete in another order.
    const pools = directory.map(entry => entry.address).filter(address => poolOwed.has(address));
    const totalBnbWei = directBnbWei + [...owed.values(), ...poolOwed.values()].reduce((sum, value) => sum + value, 0n);
    const [again, finalChain] = direct ? [null, null] : await Promise.all([
      request('eth_getBlockByNumber', [tag, false]), request('eth_chainId'),
    ]);
    abortCheck(signal);
    if (!direct) check(BigInt(finalChain) === 56n && again?.number && BigInt(again.number) === blockNumber
      && again?.hash?.toLowerCase() === block.hash.toLowerCase(), '读取期间手续费区块发生变化，请刷新。');
    await verifyBalanceProvider();
    abortCheck(signal);
    return { markets, pools, directBnbWei, directBemWei, totalBnbWei, totalBemWei: directBemWei,
      sourceCount: markets.length + pools.length, blockNumber, blockHash: direct ? null : block.hash.toLowerCase(),
      ...(direct ? { displayOnly: true } : {}),
      batches: collectionBatches(markets, pools, directBnbWei, directBemWei) };
  } finally { await queue.close(); }
}
