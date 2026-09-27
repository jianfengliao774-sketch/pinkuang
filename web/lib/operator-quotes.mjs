import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { OFFICIAL_COLLECTIONS, fetchQuotePage, fetchMineQuote, fetchCapacityReference, quoteIssue, createQuotePlan } from '../../deploy/src/pricing.ts';
import { createReadOnlyHttpProvider } from './live-config.mjs';
import { settleReadRound } from './read-retry.mjs';
import { uint, referenceQuote } from './chain-client.mjs';
import { parseFirstoSignedAsk, verifyFirstoSignedAsk } from '../../deploy/src/firsto-purchase.mjs';

const MARKET = '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f';
const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const marketAbi = new Interface(['function listingFor(address,uint256) view returns(uint256 id,address seller,uint96 price,bool valid)']);
const nftAbi = new Interface(['function ownerOf(uint256) view returns(address)']);
export const machineRegistryAbi = new Interface([
  'function machineRegistryStatus() view returns(bool initialized,bool ready,uint256 cursor,uint256 cutoff)',
  'function machinePool(address,uint256) view returns(address)',
]);
const miningAbi = new Interface([
  'function minerKey(address,uint256) view returns(bytes32)',
  'function getMiner(bytes32) view returns(tuple(address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
]);
const requireValue = (value, text) => { if (!value) throw new Error(text); };
const same = (a, b) => getAddress(a) === getAddress(b);
export const QUOTE_BASE = '/pinkuang-deploy/firsto-api';
export const QUOTE_SOURCE = 'https://tapeout.firsto.ai/circuits';
export function operatorQuoteError(error) {
  if (error instanceof SyntaxError) return '报价内容不完整，请重新获取；手动导入时请使用完整的报价 JSON。';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '报价读取超时，请重新获取。';
  return error?.shortMessage || error?.message || '报价暂时无法读取，请重试。';
}
export function listOperatorQuotes(input = {}, options = {}) {
  return fetchQuotePage({ sort: 'price_low', ...input }, { baseUrl: QUOTE_BASE, ...options });
}

/** A missing selector is an old deployment; transport failures must not downgrade capability. */
export async function readMachineRegistry(provider, { factory, collection, tokenId, blockTag = 'latest' } = {}) {
  const unsupported = Object.freeze({ supported: false, ready: false, pool: null });
  if (!factory) return unsupported;
  const call = (name, args = []) => provider.request({ method: 'eth_call', params: [{ to: getAddress(factory),
    data: machineRegistryAbi.encodeFunctionData(name, args) }, blockTag] });
  let encoded;
  try { encoded = await call('machineRegistryStatus'); }
  catch (error) {
    if ((error?.code === 3 || error?.code === 'CALL_EXCEPTION') && (error.data === '0x' || error.data == null)) return unsupported;
    throw error;
  }
  if (encoded === '0x') return unsupported;
  const [initialized, ready, cursor, cutoff] = machineRegistryAbi.decodeFunctionResult('machineRegistryStatus', encoded);
  requireValue(cursor <= cutoff && (!ready || initialized && cursor === cutoff), '矿机登记状态不一致，请暂停操作。');
  const pool = collection === undefined ? null : getAddress(machineRegistryAbi.decodeFunctionResult('machinePool',
    await call('machinePool', [getAddress(collection), uint(tokenId)]))[0]);
  return Object.freeze({ supported: true, initialized, ready, cursor: cursor.toString(), cutoff: cutoff.toString(), pool });
}

/** The exact NFT can be checked on the official market without an indexer or Firsto API. */
export async function readOfficialMinerOnchain(provider, collectionValue, tokenValue,
  { config, blockTag = 'latest', allowIneligible = false } = {}) {
  const collection = getAddress(collectionValue), tokenId = uint(tokenValue);
  requireValue(Object.values(OFFICIAL_COLLECTIONS).some(value => same(value, collection)), '仅接受已核验的官方矿机合约。');
  const request = (method, params = []) => provider.request({ method, params });
  const { chain, block } = await settleReadRound({ chain: () => request('eth_chainId'), block: () => request('eth_getBlockByNumber', [blockTag, false]) });
  requireValue(BigInt(chain) === 56n && /^0x[\da-f]{64}$/i.test(block?.hash ?? '')
    && /^0x[\da-f]+$/i.test(block?.number ?? '') && /^0x[\da-f]+$/i.test(block?.timestamp ?? ''), '无法核对 BSC 矿机区块。');
  const tag = toQuantity(BigInt(block.number));
  requireValue(blockTag === 'latest' || BigInt(blockTag) === BigInt(tag), '矿机返回区块与请求不一致。');
  const call = async (to, abi, name, args) => abi.decodeFunctionResult(name, await request('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, tag]));
  const { owner, listing, key } = await settleReadRound({
    owner: () => call(collection, nftAbi, 'ownerOf', [tokenId]),
    listing: () => call(MARKET, marketAbi, 'listingFor', [collection, tokenId]),
    key: () => call(MINING, miningAbi, 'minerKey', [collection, tokenId]),
  });
  const miner = (await call(MINING, miningAbi, 'getMiner', [key[0]]))[0];
  requireValue(same(miner.circuits, collection) && miner.circuitId === tokenId, '矿机链上身份不一致。');
  const eligible = miner.status === 1n && !miner.optimal && miner.verifWeight > 0n && miner.unverWeight === 0n;
  requireValue(allowIneligible || eligible, '仅支持链上正在挖矿、纯验证权重的非最优矿机。');
  const official = eligible && listing.valid && listing.id > 0n && listing.price > 0n && same(listing.seller, owner[0])
    ? Object.freeze({ id: listing.id.toString(), seller: getAddress(listing.seller), priceWei: listing.price.toString() }) : null;
  const registry = await readMachineRegistry(provider, { factory: config?.factory ?? config?.manifest?.factory, collection, tokenId, blockTag: tag });
  const { after, finalChain } = await settleReadRound({ after: () => request('eth_getBlockByNumber', [tag, false]), finalChain: () => request('eth_chainId') });
  requireValue(after?.hash === block.hash && after?.number === block.number && after?.timestamp === block.timestamp
    && BigInt(finalChain) === 56n, '矿机核对期间区块或网络变化，请重试。');
  return Object.freeze({ collection, tokenId: tokenId.toString(), owner: getAddress(owner[0]), taskId: miner.taskId.toString(),
    verifiedWeight: miner.verifWeight.toString(), eligible, official, firsto: null, firstoError: null, registry,
    blockNumber: BigInt(block.number).toString(), blockHash: block.hash, checkedAt: Date.now() });
}

function matchQuoteToMiner(quote, chain) {
  requireValue(same(quote.owner, chain.owner), '矿机持有人已变化，请刷新报价。');
  requireValue(quote.status === 'verified' && quote.taskId === chain.taskId && quote.verifiedWeight === chain.verifiedWeight
    && quote.unverifiedWeight === '0', '矿机任务或权重已变化，请重新获取。');
}

/** Public quotes are discovery only; an official listing always takes purchase priority. */
export async function checkMinerOnchain(provider, quote, { config, blockTag = 'latest', officialPriceCapWei } = {}) {
  const chain = await readOfficialMinerOnchain(provider, quote?.collection, quote?.tokenId, { config, blockTag });
  matchQuoteToMiner(quote, chain);
  let firsto = null, firstoError = null;
  const officialWithinCap = chain.official && (officialPriceCapWei === undefined
    || BigInt(chain.official.priceWei) <= uint(officialPriceCapWei));
  if (!officialWithinCap && quote.ask?.venue === 'firsto') {
    if (!chain.registry.supported) firstoError = '当前工厂版本尚未开放 Firsto 合约采购。';
    else if (!chain.registry.ready) firstoError = '矿机唯一性登记尚未完成，Firsto 采购暂不可用。';
    else {
      try {
        const order = parseFirstoSignedAsk(quote.ask, { collection: chain.collection, tokenId: chain.tokenId, owner: chain.owner });
        firsto = await verifyFirstoSignedAsk(provider, order, { blockTag: toQuantity(BigInt(chain.blockNumber)) });
        requireValue(firsto.checkedBlock.hash === chain.blockHash, 'Firsto 订单与矿机核对区块不一致。');
      } catch (error) { firsto = null; firstoError = operatorQuoteError(error); }
    }
  }
  return Object.freeze({ ...chain, firsto, firstoError });
}

export async function loadOperatorQuote({ collection, tokenId, config, provider, blockTag,
  mode = 'createPool', officialPriceCapWei, ...options }) {
  const reader = provider ?? createReadOnlyHttpProvider(config);
  const officialChain = await readOfficialMinerOnchain(reader, collection, tokenId, { config, blockTag });
  // A fixed official purchase needs no Firsto availability, estimate or buyer-fee quote.
  const officialWithinCap = officialChain.official && (officialPriceCapWei === undefined
    || BigInt(officialChain.official.priceWei) <= uint(officialPriceCapWei));
  if (officialWithinCap && mode === 'createPool') return Object.freeze({ quote: null, chain: officialChain, reference: null, referenceError: null });
  const opts = { baseUrl: QUOTE_BASE, ...options };
  const results = await Promise.allSettled([fetchMineQuote(collection, tokenId, opts), fetchCapacityReference(opts)]);
  if (results[0].status === 'rejected') throw results[0].reason;
  const quote = results[0].value;
  requireValue(!quoteIssue(quote), quoteIssue(quote));
  matchQuoteToMiner(quote, officialChain);
  const chain = officialWithinCap ? officialChain : await checkMinerOnchain(reader, quote,
    { config, blockTag, officialPriceCapWei });
  return Object.freeze({ quote, chain, reference: results[1].status === 'fulfilled' ? results[1].value : null,
    referenceError: results[1].status === 'rejected' ? operatorQuoteError(results[1].reason) : null });
}

/** Only drafts; no signing or broadcasts. Relative deadlines remain operator choices. */
export function operatorQuoteDraft(checked, { mode = 'createPool', extraBps = 1000, fundingHours = '24', purchaseHours = '48' } = {}, now = Date.now()) {
  const { quote, chain, reference } = checked;
  if (quote) requireValue(!quoteIssue(quote, now), quoteIssue(quote, now));
  else requireValue(mode === 'createPool' && chain?.official, 'Firsto 报价不可用，请重新获取。');
  requireValue(chain && Number.isFinite(chain.checkedAt) && chain.checkedAt <= now + 30000 && now - chain.checkedAt <= 300000, '链上矿机核对已过期，请重新获取。');
  requireValue(Number.isInteger(extraBps) && extraBps >= 0 && extraBps <= 10000, '额外预算需在 0%–100% 之间。');
  requireValue(uint(fundingHours, 32) > 0n && uint(purchaseHours, 32) > 0n, '请填写有效的募集和购机时长。');
  requireValue(chain.registry?.supported, '当前工厂尚未支持矿机唯一性登记，请等待合约升级后创建。');
  requireValue(chain.registry.ready, '矿机唯一性登记尚未完成，请稍后创建。');
  requireValue(chain.registry.pool && same(chain.registry.pool, ZeroAddress), `此矿机已有拼矿项目：${chain.registry.pool}，不能重复创建。`);
  const params = { circuits: getAddress(chain.collection ?? quote.collection), circuitId: chain.tokenId ?? quote.tokenId, fundingHours, purchaseHours };
  if (mode === 'createPool') {
    requireValue(chain.firsto || chain.official, `这台矿机当前没有本项目可购买的官网挂单或已核验 Firsto 订单。${chain.firstoError || ''}`);
    const priceCapWei = chain.official?.priceWei ?? chain.firsto.grossWei;
    const amounts = referenceQuote(priceCapWei, BigInt(extraBps));
    return Object.freeze({ kind: mode, params: { ...params, targetRaiseWei: amounts.targetRaise.toString(), priceCapWei } });
  }
  requireValue(mode === 'createFlexiblePoolChecked' && reference, checked.referenceError || '日产能参考价不可用，请刷新报价。');
  const plan = createQuotePlan(quote, reference, extraBps, quote.verifiedWeight, now);
  return Object.freeze({ kind: mode, params: { ...params, targetRaiseWei: plan.funding.targetRaiseWei, priceCapWei: plan.funding.priceCapWei,
    directSeller: ZeroAddress, directPrice: '0' }, flexible: plan.flexiblePurchase,
    expectedTaskId: plan.eligibility.expectedTaskId, expectedReferenceWeight: plan.eligibility.expectedReferenceVerifiedWeight });
}

export function parseOperatorImport(text) {
  requireValue(typeof text === 'string' && text.trim(), '请先选择矿机自动生成方案，或在高级导入中粘贴完整报价。');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('报价 JSON 不完整或格式错误，请重新导入完整文件。'); }
  requireValue(raw && raw.params && raw.flexible && raw.expectedTaskId !== undefined && raw.expectedReferenceWeight !== undefined, '报价缺少建池参数，请重新生成完整方案。');
  return raw;
}
