import { getAddress, keccak256, toQuantity } from 'ethers';
import { abi } from './chain-client.mjs';
import { hash, insist, liveAddress, validateManifest } from './live-config.mjs';

const BEM = getAddress('0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a');
const EVENT = abi.PlatformAuthority.getEvent('FeesClaimed');
const WINDOW = 5000n, MIN_WINDOW = 1000n, MAX_WINDOWS = 6;
const CACHE_MS = 30000, MAX_CACHE_PAGES = 32;
const cache = new Map(), providers = new WeakMap();
let nextProviderId = 0;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const need = (ok, message) => insist(ok, 'fee_history', message);
const abortError = () => Object.assign(new Error('手续费领取记录读取已取消。'), { name: 'AbortError' });
const abortCheck = signal => { if (signal?.aborted) throw abortError(); };
const quantity = (value, label) => {
  need(typeof value === 'string' && /^0x(?:0|[1-9a-f][\da-f]*)$/i.test(value), `${label}格式无效。`);
  return BigInt(value);
};
const decimal = (value, label) => {
  need(typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value), `${label}格式无效。`);
  return BigInt(value);
};

// Both read providers share one actual RPC limit. EIP-1193 cannot cancel a
// running request, but cancellation rejects consumers and stops queued calls.
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

function header(block, expectedNumber) {
  need(block && hash(block.hash), '手续费记录区块暂不可用。');
  const number = quantity(block.number, '区块号'), timestamp = quantity(block.timestamp, '区块时间');
  need(expectedNumber === undefined || number === expectedNumber, '手续费记录区块号不一致。');
  return { number, timestamp, hash: block.hash.toLowerCase() };
}

function validateCursor(cursor, manifest) {
  if (cursor === null) return null;
  need(cursor && cursor.schemaVersion === 1 && same(cursor.authority, manifest.authority)
    && same(cursor.deploymentTxHash, manifest.freshAuthority.deploymentTxHash)
    && hash(cursor.anchorHash), '领取记录分页不属于当前正式部署。');
  const anchor = decimal(cursor.anchorBlock, '分页锚点'), upper = decimal(cursor.nextBlock, '分页区块');
  need(upper <= anchor, '领取记录分页范围无效。');
  const before = cursor.before === null ? null : {
    blockNumber: decimal(cursor.before?.blockNumber, '分页事件区块'),
    transactionIndex: decimal(cursor.before?.transactionIndex, '分页交易序号'),
    logIndex: decimal(cursor.before?.logIndex, '分页事件序号'),
  };
  need(!before || before.blockNumber === upper, '领取记录分页事件范围无效。');
  return { anchor, upper, before, anchorHash: cursor.anchorHash.toLowerCase() };
}

const compare = (left, right) => {
  for (const key of ['blockNumber', 'transactionIndex', 'logIndex']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? -1 : 1;
  }
  return 0;
};

function parseEvent(log, authority, lower, upper) {
  need(log && same(log.address, authority) && same(log.topics?.[0], EVENT.topicHash)
    && log.removed !== true && hash(log.transactionHash) && hash(log.blockHash), '领取事件身份或链上状态无效。');
  const blockNumber = quantity(log.blockNumber, '事件区块'), transactionIndex = quantity(log.transactionIndex, '事件交易序号');
  const logIndex = quantity(log.logIndex, '事件序号');
  need(blockNumber >= lower && blockNumber <= upper, '领取事件超出已核验区块范围。');
  const decoded = abi.PlatformAuthority.parseLog(log), encoded = abi.PlatformAuthority.encodeEventLog(EVENT, decoded.args);
  need(same(encoded.data, log.data) && encoded.topics.length === log.topics.length
    && encoded.topics.every((topic, index) => same(topic, log.topics[index])), '领取事件编码不一致。');
  return { administrator: liveAddress(decoded.args.administrator), bnbAmountWei: decoded.args.bnbAmount,
    bemAmountWei: decoded.args.bemAmount, transactionHash: log.transactionHash.toLowerCase(),
    blockNumber, transactionIndex, logIndex, blockHash: log.blockHash.toLowerCase(), log };
}

function sameLog(left, right) {
  return ['address', 'transactionHash', 'blockHash', 'blockNumber', 'transactionIndex', 'logIndex', 'data']
    .every(key => same(left[key], right[key])) && Array.isArray(left.topics) && Array.isArray(right.topics)
    && left.topics.length === right.topics.length && left.topics.every((topic, index) => same(topic, right.topics[index]))
    && right.removed !== true;
}

function rangeRejected(error) {
  const messages = [error?.message, error?.shortMessage, error?.data?.message,
    error?.error?.message, error?.error?.data?.message, error?.info?.error?.message].filter(value => typeof value === 'string').join(' ');
  // Timeouts, rate limits and unsupported-method failures must never become an
  // empty page. Only an explicit block-range restriction can reduce the window.
  return /(?:block (?:range|span)|range of blocks|[\d,]+ blocks|blocks per (?:request|query)|fromblock.{0,80}toblock)/i.test(messages)
    && /(?:limit|max|exceed|too (?:wide|large|many)|at most|only|allow|up to)/i.test(messages)
    && !/(?:timeout|timed out|rate limit|too many requests)/i.test(messages);
}

function providerId(provider) {
  if (!providers.has(provider)) providers.set(provider, ++nextProviderId);
  return providers.get(provider);
}

function scopeKey(manifest, provider, logsProvider, cursor, limit) {
  return JSON.stringify([providerId(provider), providerId(logsProvider), manifest.authority,
    manifest.freshAuthority.deploymentTxHash, manifest.freshAuthority.codehash, manifest.artifactDigest,
    manifest.factory, manifest.portfolioFactory, manifest.gasWallet, manifest.verifiedBlockNumber,
    cursor && [cursor.anchor.toString(), cursor.anchorHash, cursor.upper.toString(), cursor.before
      && [cursor.before.blockNumber.toString(), cursor.before.transactionIndex.toString(), cursor.before.logIndex.toString()]], limit]);
}

function cursorFor(manifest, anchor, nextBlock, before = null) {
  return Object.freeze({ schemaVersion: 1, authority: manifest.authority,
    deploymentTxHash: manifest.freshAuthority.deploymentTxHash, anchorBlock: anchor.number.toString(),
    anchorHash: anchor.hash, nextBlock: nextBlock.toString(), before: before && Object.freeze({
      blockNumber: before.blockNumber.toString(), transactionIndex: before.transactionIndex.toString(), logIndex: before.logIndex.toString(),
    }) });
}

/** Display logs directly; receipts and deployment proofs are not needed to render this history. */
async function directHistory({ manifest, parsedCursor, key, cached, queue, request, logsRequest, limit, signal, now, startedAt }) {
  try {
    if (cached) return Object.freeze({ ...cached, cached: true });
    // A just-produced head can reach the normal RPC before the logs node.
    // Start at the settled head so the same range is available on both nodes.
    const anchor = parsedCursor ? { number: parsedCursor.anchor, hash: parsedCursor.anchorHash }
      : header(await request('eth_getBlockByNumber', ['finalized', false]));
    const firstBlock = BigInt(manifest.deployment.blockNumber), authority = manifest.authority;
    const upper = parsedCursor?.upper ?? anchor.number;
    need(upper >= firstBlock, '领取记录分页早于当前部署。');
    const events = new Map();
    let nextBlock = upper, width = WINDOW, windows = 0, fromBlock = upper, exhausted = false;
    while (windows < MAX_WINDOWS && !exhausted && events.size <= limit) {
      abortCheck(signal);
      const lower = nextBlock - width + 1n > firstBlock ? nextBlock - width + 1n : firstBlock;
      let logs;
      try {
        logs = await logsRequest('eth_getLogs', [{ address: authority, topics: [EVENT.topicHash],
          fromBlock: toQuantity(lower), toBlock: toQuantity(nextBlock) }]);
      } catch (error) {
        if (!signal?.aborted && width > MIN_WINDOW && rangeRejected(error)) {
          width = width / 2n > MIN_WINDOW ? width / 2n : MIN_WINDOW; continue;
        }
        throw error;
      }
      need(Array.isArray(logs), '领取记录日志响应不完整。');
      for (const log of logs) {
        const event = parseEvent(log, authority, lower, nextBlock);
        if (parsedCursor?.before && compare(event, parsedCursor.before) <= 0) continue;
        const eventKey = `${event.transactionHash}:${event.logIndex}`, previous = events.get(eventKey);
        need(!previous || sameLog(previous.log, log), '重复领取事件内容不一致。');
        if (!previous) events.set(eventKey, event);
      }
      windows++; fromBlock = lower; exhausted = lower === firstBlock; nextBlock = lower - 1n;
    }
    const sorted = [...events.values()].sort(compare), selected = sorted.slice(0, limit), timestamps = new Map();
    const timestampFor = number => {
      const blockKey = number.toString();
      if (!timestamps.has(blockKey)) timestamps.set(blockKey,
        request('eth_getBlockByNumber', [toQuantity(number), false]).then(block => block?.timestamp
          ? quantity(block.timestamp, '记录时间') : null));
      return timestamps.get(blockKey);
    };
    const rows = await Promise.all(selected.map(async ({ log, ...event }) => Object.freeze({ ...event,
      timestamp: await timestampFor(event.blockNumber) })));
    abortCheck(signal);
    const extra = sorted.length > limit, last = rows.at(-1), complete = exhausted && !extra;
    const nextCursor = complete ? null : extra ? cursorFor(manifest, anchor, last.blockNumber, last)
      : cursorFor(manifest, anchor, nextBlock);
    const checkedAt = now();
    need(Number.isSafeInteger(checkedAt) && checkedAt >= startedAt, '领取记录读取时间无效。');
    const result = Object.freeze({ rows: Object.freeze(rows), nextCursor, complete, fromBlock, toBlock: upper,
      safeBlockNumber: anchor.number, safeBlockHash: anchor.hash, checkedAt, cached: false,
      displayOnly: true, transactionReady: false });
    cache.delete(key); cache.set(key, result);
    while (cache.size > MAX_CACHE_PAGES) cache.delete(cache.keys().next().value);
    return result;
  } catch (error) { cache.delete(key); throw error; }
  finally { await queue.close(); }
}

/** Read finalized FeesClaimed events for the current formal Authority only.
 * The same-origin provider reads scoped Authority logs, deployment bindings,
 * canonical headers and receipts. An independent read provider can be injected.
 * Rows include every historical administrator, including rotated-out addresses.
 * Empty rows with a nextCursor mean older windows remain, not empty history.
 */
export async function readFeeCollectionHistory({ config, provider, logsProvider = provider,
  cursor = null, limit = 20, signal, refresh = false, now = Date.now } = {}) {
  abortCheck(signal);
  need(config?.stage === 'fresh-active', '领取记录仅用于当前正式部署。');
  need(typeof provider?.request === 'function' && typeof logsProvider?.request === 'function', '领取记录只读服务暂不可用。');
  need(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, '领取记录分页大小无效。');
  const manifest = validateManifest(config.manifest);
  need(manifest.kind === 'integrated-v2' && manifest.freshAuthority, '当前部署缺少手续费管理员合约。');
  for (const key of ['authority', 'factory', 'portfolioFactory', 'gasWallet'])
    need(same(config[key], manifest[key]), '领取记录配置与当前正式部署不一致。');
  // A verified product-graph snapshot does not gate this independent read:
  // the finalized node, exact Authority identity and every receipt are proved below.
  const parsedCursor = validateCursor(cursor, manifest), key = `${scopeKey(manifest, provider, logsProvider, parsedCursor, limit)}:${config.displayOnly === true ? 'display' : 'checked'}`;
  const startedAt = now();
  need(Number.isSafeInteger(startedAt) && startedAt >= 0, '领取记录核验时间无效。');
  const candidate = refresh ? null : cache.get(key);
  const cached = candidate && startedAt >= candidate.checkedAt && startedAt - candidate.checkedAt < CACHE_MS ? candidate : null;
  const queue = readQueue(provider, signal);
  const request = (method, params = []) => queue.request({ method, params });
  const logsRequest = (method, params = []) => queue.request({ method, params }, logsProvider);
  if (config.displayOnly === true) return directHistory({ manifest, parsedCursor, key, cached, queue,
    request, logsRequest, limit, signal, now, startedAt });
  try {
    const [chain, finalizedRaw] = await Promise.all([
      request('eth_chainId'), request('eth_getBlockByNumber', ['finalized', false]),
    ]);
    need(quantity(chain, '链号') === 56n, '请切换至 BSC 主网。');
    const finalized = header(finalizedRaw);
    need(finalized.number >= BigInt(manifest.verifiedBlockNumber), 'RPC 尚未同步到当前正式部署。');
    const pinnedNumber = parsedCursor?.anchor ?? cached?.safeBlockNumber ?? finalized.number;
    need(pinnedNumber <= finalized.number, '领取记录锚点尚未最终确认。');
    const anchor = pinnedNumber === finalized.number ? finalized
      : header(await request('eth_getBlockByNumber', [toQuantity(pinnedNumber), false]), pinnedNumber);
    need(!parsedCursor || same(anchor.hash, parsedCursor.anchorHash), '领取记录分页区块已变化，请刷新重新读取。');
    need(!cached || same(anchor.hash, cached.safeBlockHash), '已缓存领取记录区块已变化，请刷新重新读取。');
    const tag = toQuantity(anchor.number), stateTag = toQuantity(finalized.number), authority = manifest.authority;
    async function proveLogsProvider() {
      if (logsProvider === provider) return;
      const [logsChain, logsBlock] = await Promise.all([
        logsRequest('eth_chainId'), logsRequest('eth_getBlockByNumber', [tag, false]),
      ]);
      need(quantity(logsChain, '日志链号') === 56n && same(header(logsBlock, anchor.number).hash, anchor.hash),
        '领取记录日志服务的网络或区块与正式链上数据不一致。');
    }
    await proveLogsProvider();
    // Authority is directly deployed; the exact runtime hash and immutable
    // factory/token bindings identify every historical event. Read that
    // identity at this request's finalized block, rather than requiring an
    // archive node for an old pagination anchor. Logs and receipts keep the
    // original historical anchor and canonical checks.
    const read = async name => abi.PlatformAuthority.decodeFunctionResult(name,
      await request('eth_call', [{ to: authority, data: abi.PlatformAuthority.encodeFunctionData(name) }, stateTag]))[0];
    const [deployment, code, coreFactory, budgetFactory, token] = await Promise.all([
      request('eth_getTransactionReceipt', [manifest.freshAuthority.deploymentTxHash]),
      request('eth_getCode', [authority, stateTag]), read('coreFactory'), read('budgetFactory'), read('BEM'),
    ]);
    need(same(deployment?.transactionHash, manifest.freshAuthority.deploymentTxHash)
      && deployment?.status === '0x1' && same(deployment.contractAddress, authority) && deployment.to === null
      && hash(deployment.blockHash), '管理员合约部署回执未通过核验。');
    const firstBlock = quantity(deployment.blockNumber, '管理员合约部署区块');
    need(firstBlock <= anchor.number, '管理员合约部署尚未最终确认。');
    const origin = header(await request('eth_getBlockByNumber', [toQuantity(firstBlock), false]), firstBlock);
    need(same(origin.hash, deployment.blockHash), '管理员合约部署区块不在当前规范链上。');
    need(code && code !== '0x' && same(keccak256(code), manifest.freshAuthority.codehash)
      && same(coreFactory, manifest.factory) && same(budgetFactory, manifest.portfolioFactory) && same(token, BEM),
      '管理员手续费合约代码或绑定与当前正式部署不一致。');
    const upper = parsedCursor?.upper ?? anchor.number;
    need(upper >= firstBlock, '领取记录分页早于管理员合约部署。');

    async function finalProof() {
      const [endChain, endAnchorRaw, endFinalizedRaw, endStateRaw] = await Promise.all([
        request('eth_chainId'), request('eth_getBlockByNumber', [tag, false]),
        request('eth_getBlockByNumber', ['finalized', false]),
        stateTag === tag ? null : request('eth_getBlockByNumber', [stateTag, false]),
      ]);
      need(quantity(endChain, '链号') === 56n && same(header(endAnchorRaw, anchor.number).hash, anchor.hash)
        && header(endFinalizedRaw).number >= finalized.number, '领取记录规范链或最终性区块已变化，请重新读取。');
      need(same(header(stateTag === tag ? endAnchorRaw : endStateRaw, finalized.number).hash, finalized.hash),
        '领取记录管理员状态规范链已变化，请重新读取。');
      await proveLogsProvider();
      abortCheck(signal);
    }
    if (cached) {
      await finalProof();
      cache.delete(key); cache.set(key, cached);
      return Object.freeze({ ...cached, cached: true });
    }

    const events = new Map();
    let nextBlock = upper, width = WINDOW, windows = 0, fromBlock = upper, exhausted = false;
    while (windows < MAX_WINDOWS && !exhausted && events.size <= limit) {
      abortCheck(signal);
      const lower = nextBlock - width + 1n > firstBlock ? nextBlock - width + 1n : firstBlock;
      let raw;
      try {
        raw = await logsRequest('eth_getLogs', [{ address: authority, topics: [EVENT.topicHash],
          fromBlock: toQuantity(lower), toBlock: toQuantity(nextBlock) }]);
      } catch (error) {
        if (!signal?.aborted && width > MIN_WINDOW && rangeRejected(error)) {
          width = width / 2n > MIN_WINDOW ? width / 2n : MIN_WINDOW;
          continue;
        }
        throw error;
      }
      need(Array.isArray(raw), '领取记录日志响应不完整。');
      for (const log of raw) {
        const event = parseEvent(log, authority, lower, nextBlock);
        if (parsedCursor?.before && compare(event, parsedCursor.before) <= 0) continue;
        const eventKey = `${event.transactionHash}:${event.logIndex}`;
        const previous = events.get(eventKey);
        need(!previous || sameLog(previous.log, log), '重复领取事件内容不一致。');
        if (!previous) events.set(eventKey, event);
      }
      windows++; fromBlock = lower; exhausted = lower === firstBlock;
      nextBlock = lower - 1n;
    }
    const sorted = [...events.values()].sort(compare), selected = sorted.slice(0, limit);
    const receipts = new Map(), blocks = new Map();
    const receiptFor = transactionHash => {
      if (!receipts.has(transactionHash)) receipts.set(transactionHash,
        request('eth_getTransactionReceipt', [transactionHash]));
      return receipts.get(transactionHash);
    };
    const blockFor = number => {
      const blockKey = number.toString();
      if (!blocks.has(blockKey)) blocks.set(blockKey,
        request('eth_getBlockByNumber', [toQuantity(number), false]).then(value => header(value, number)));
      return blocks.get(blockKey);
    };
    const rows = await Promise.all(selected.map(async event => {
      const [receipt, block] = await Promise.all([receiptFor(event.transactionHash), blockFor(event.blockNumber)]);
      need(receipt?.status === '0x1' && same(receipt.transactionHash, event.transactionHash)
        && same(receipt.to, authority) && same(receipt.blockHash, event.blockHash)
        && quantity(receipt.blockNumber, '回执区块') === event.blockNumber
        && quantity(receipt.transactionIndex, '回执交易序号') === event.transactionIndex
        && Array.isArray(receipt.logs), '手续费领取回执未通过核验。');
      const receiptLogs = receipt.logs.filter(log => log && same(log.address, authority)
        && same(log.topics?.[0], EVENT.topicHash) && log.logIndex === event.log.logIndex);
      need(receiptLogs.length === 1 && sameLog(event.log, receiptLogs[0]) && same(block.hash, event.blockHash),
        '领取事件与链上回执或规范区块不一致。');
      // msg.sender is normally the Gas wallet. FeesClaimed records the actual
      // recipient; do not filter by today's administrator roles or sender.
      const { log, ...row } = event;
      return Object.freeze({ ...row, timestamp: block.timestamp });
    }));
    await finalProof();
    const extra = sorted.length > limit, last = rows.at(-1);
    const complete = exhausted && !extra;
    const nextCursor = complete ? null : extra ? cursorFor(manifest, anchor, last.blockNumber, last)
      : cursorFor(manifest, anchor, nextBlock);
    const checkedAt = now();
    need(Number.isSafeInteger(checkedAt) && checkedAt >= startedAt, '领取记录核验时间无效。');
    const result = Object.freeze({ rows: Object.freeze(rows), nextCursor, complete, fromBlock, toBlock: upper,
      safeBlockNumber: anchor.number, safeBlockHash: anchor.hash, checkedAt, cached: false });
    cache.delete(key); cache.set(key, result);
    while (cache.size > MAX_CACHE_PAGES) cache.delete(cache.keys().next().value);
    return result;
  } catch (error) {
    cache.delete(key);
    throw error;
  } finally { await queue.close(); }
}
