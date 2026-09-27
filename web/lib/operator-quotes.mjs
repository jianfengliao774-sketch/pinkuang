import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { fetchQuotePage, fetchMineQuote, fetchCapacityReference, quoteIssue, createQuotePlan } from '../../deploy/src/pricing.ts';
import { createReadOnlyHttpProvider } from './live-config.mjs';
import { settleReadRound } from './read-retry.mjs';
import { uint, referenceQuote } from './chain-client.mjs';

const MARKET = '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f';
const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const marketAbi = new Interface(['function listingFor(address,uint256) view returns(uint256 id,address seller,uint96 price,bool valid)']);
const nftAbi = new Interface(['function ownerOf(uint256) view returns(address)']);
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

/** Public quotes are discovery only. Verify the actual NFT, active verified miner and supported market at one block. */
export async function checkMinerOnchain(provider, quote) {
  requireValue(['0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c'].includes(quote?.collection?.toLowerCase()), '仅接受已核验的官方矿机合约。');
  uint(quote.tokenId);
  const request = (method, params = []) => provider.request({ method, params });
  const { chain, block } = await settleReadRound({ chain: () => request('eth_chainId'), block: () => request('eth_getBlockByNumber', ['latest', false]) });
  requireValue(BigInt(chain) === 56n && /^0x[\da-f]{64}$/i.test(block?.hash ?? '')
    && /^0x[\da-f]+$/i.test(block?.number ?? '') && /^0x[\da-f]+$/i.test(block?.timestamp ?? ''), '无法核对 BSC 矿机区块。');
  const tag = toQuantity(BigInt(block.number));
  const call = async (to, abi, name, args) => abi.decodeFunctionResult(name, await request('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, tag]));
  const { owner, listing, key } = await settleReadRound({
    owner: () => call(quote.collection, nftAbi, 'ownerOf', [quote.tokenId]),
    listing: () => call(MARKET, marketAbi, 'listingFor', [quote.collection, quote.tokenId]),
    key: () => call(MINING, miningAbi, 'minerKey', [quote.collection, quote.tokenId]),
  });
  const miner = (await call(MINING, miningAbi, 'getMiner', [key[0]]))[0];
  requireValue(same(owner[0], quote.owner), '矿机持有人已变化，请刷新报价。');
  requireValue(same(miner.circuits, quote.collection) && miner.circuitId === BigInt(quote.tokenId), '矿机链上身份不一致。');
  requireValue(miner.status === 1n && !miner.optimal && miner.verifWeight > 0n && miner.unverWeight === 0n, '仅支持链上正在挖矿、纯验证权重的非最优矿机。');
  requireValue(quote.status === 'verified' && miner.taskId.toString() === quote.taskId && miner.verifWeight.toString() === quote.verifiedWeight
    && quote.unverifiedWeight === '0', '矿机任务或权重已变化，请重新获取。');
  const official = listing.valid && listing.id > 0n && listing.price > 0n && same(listing.seller, owner[0])
    ? Object.freeze({ id: listing.id.toString(), seller: getAddress(listing.seller), priceWei: listing.price.toString() }) : null;
  const { after, finalChain } = await settleReadRound({ after: () => request('eth_getBlockByNumber', [tag, false]), finalChain: () => request('eth_chainId') });
  requireValue(after?.hash === block.hash && after?.number === block.number && after?.timestamp === block.timestamp
    && BigInt(finalChain) === 56n, '矿机核对期间区块或网络变化，请重试。');
  return Object.freeze({ official, blockNumber: BigInt(block.number).toString(), blockHash: block.hash, checkedAt: Date.now() });
}

export async function loadOperatorQuote({ collection, tokenId, config, provider, ...options }) {
  const opts = { baseUrl: QUOTE_BASE, ...options };
  const results = await Promise.allSettled([fetchMineQuote(collection, tokenId, opts), fetchCapacityReference(opts)]);
  if (results[0].status === 'rejected') throw results[0].reason;
  const quote = results[0].value;
  requireValue(!quoteIssue(quote), quoteIssue(quote));
  const chain = await checkMinerOnchain(provider ?? createReadOnlyHttpProvider(config), quote);
  return Object.freeze({ quote, chain, reference: results[1].status === 'fulfilled' ? results[1].value : null,
    referenceError: results[1].status === 'rejected' ? operatorQuoteError(results[1].reason) : null });
}

/** Only drafts; no signing or broadcasts. Relative deadlines remain operator choices. */
export function operatorQuoteDraft(checked, { mode = 'createPool', extraBps = 1000, fundingHours = '24', purchaseHours = '48' } = {}, now = Date.now()) {
  const { quote, chain, reference } = checked;
  requireValue(!quoteIssue(quote, now), quoteIssue(quote, now));
  requireValue(chain && Number.isFinite(chain.checkedAt) && chain.checkedAt <= now + 30000 && now - chain.checkedAt <= 300000, '链上矿机核对已过期，请重新获取。');
  requireValue(Number.isInteger(extraBps) && extraBps >= 0 && extraBps <= 10000, '额外预算需在 0%–100% 之间。');
  requireValue(uint(fundingHours, 32) > 0n && uint(purchaseHours, 32) > 0n, '请填写有效的募集和购机时长。');
  const params = { circuits: getAddress(quote.collection), circuitId: quote.tokenId, fundingHours, purchaseHours };
  if (mode === 'createPool') {
    requireValue(chain.official, '这台矿机当前没有本项目可购买的官网挂单。Firsto 挂单只能作为参考，不能直接采购。');
    const amounts = referenceQuote(chain.official.priceWei, BigInt(extraBps));
    return Object.freeze({ kind: mode, params: { ...params, targetRaiseWei: amounts.targetRaise.toString(), priceCapWei: chain.official.priceWei } });
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
