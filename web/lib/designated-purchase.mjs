import { Interface, ZeroAddress, getAddress, keccak256, toQuantity, toUtf8Bytes } from 'ethers';
import { DESIGNATED_CREATE, DESIGNATED_GETTER } from '../../deploy/shared/designated-purchase-abi.mjs';
import { designatedFundingAmounts, estimateDesignatedDailyOutput } from '../../deploy/shared/designated-purchase-runtime.mjs';
import contracts from './contracts.generated.json' with { type: 'json' };

export const DESIGNATED_PURCHASE_MODE = 'createDesignatedPoolChecked';
export const designatedFactoryAbi = new Interface([DESIGNATED_CREATE, 'function designatedPurchaseVersion() pure returns(uint256)']);
export const designatedVaultAbi = new Interface([DESIGNATED_GETTER]);
const economics = new Interface(['function currentRate() view returns(uint256)',
  'function totalVerifWeight() view returns(uint256)', 'function UNVERIFIED_BPS() view returns(uint16)']);
const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const need = (condition, message) => { if (!condition) throw new Error(message); };
const exact = value => { need(typeof value === 'bigint' || typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), '购机参数必须为精确整数。');
  const n = BigInt(value); need(n >= 0n && n < (1n << 256n), '购机参数超出范围。'); return n; };

const compiledCapability = ['PoolFactory', 'PoolVault', 'PlatformAuthority'].every(name =>
  contracts.abis[name]?.some(entry => entry.type === 'function' && entry.name === 'designatedPurchaseVersion'));
/** Disabled on existing builds. A future static build pins its reviewed fresh
 * manifest; it does not need a paid live-graph request merely to show the mode.
 * Runtime version is read before creating a basis, and relay proves all targets. */
export function designatedPurchaseEnabled(config) {
  // Explicit opt-in is for isolated offline fixtures. A production manifest can
  // never turn an old compiled/deployed graph into a new contract capability.
  if (!config?.manifest && !config?.pinnedManifest && !config?.productFamily) {
    return config?.designatedPurchaseFallback === true;
  }
  return compiledCapability && config?.status === 'ready'
    && config.stage === 'fresh-active' && (config.freshFactoryVerified === true
      || config.displayOnly === true && config.pinnedManifest?.freshAuthority && config.manifest?.freshAuthority)
    && config.artifactDigest === contracts.artifactDigest;
}

/** Only requested for the new mode; all economics belong to the NFT's verified block. */
export async function readDesignatedBaseline(provider, chain, config) {
  need(designatedPurchaseEnabled(config) && chain?.blockNumber && chain?.blockHash,
    '当前合约尚未启用指定购机替代规则。');
  const tag = toQuantity(exact(chain.blockNumber));
  const call = async (to, abi, name) => abi.decodeFunctionResult(name, await provider.request({
    method: 'eth_call', params: [{ to, data: abi.encodeFunctionData(name) }, tag] }))[0];
  const [rate, totalWeight, bps, version, block] = await Promise.all([
    call(MINING, economics, 'currentRate'), call(MINING, economics, 'totalVerifWeight'),
    call(MINING, economics, 'UNVERIFIED_BPS'), call(getAddress(config.factory), designatedFactoryAbi, 'designatedPurchaseVersion'),
    provider.request({ method: 'eth_getBlockByNumber', params: [tag, false] }),
  ]);
  need(version === 1n && block?.hash === chain.blockHash && exact(BigInt(block.number)) === exact(chain.blockNumber)
    && /^0x[\da-f]+$/i.test(block.timestamp), '指定购机替代能力或参考区块已变化。');
  const daily = estimateDesignatedDailyOutput({ currentRate: rate, unverifiedBps: bps,
    totalVerifiedWeight: totalWeight, verifiedWeight: chain.verifiedWeight });
  need(daily > 0n, '当前矿机预计日产出为零，无法生成替代基准。');
  return Object.freeze({ dailyOutputAtomic: daily.toString(), observedAt: BigInt(block.timestamp).toString(),
    blockNumber: chain.blockNumber, blockHash: chain.blockHash, checkedAt: Date.now() });
}

/** Freeze the executable original ask, never a global market capacity average. */
export function designatedQuoteDraft(checked, params, now = Date.now()) {
  const { chain, designatedBaseline: baseline } = checked;
  need(chain?.official || chain?.firsto, '原矿机没有可核验卖单，无法锁定替代基准。');
  need(baseline && baseline.blockNumber === chain.blockNumber && baseline.blockHash === chain.blockHash
    && Number.isFinite(baseline.checkedAt) && baseline.checkedAt <= now && now - baseline.checkedAt <= 300_000,
  '指定购机基准已过期，请重新选择矿机。');
  const observedMs = exact(baseline.observedAt) * 1000n;
  need(observedMs > 0n && observedMs <= BigInt(now) && BigInt(now) - observedMs <= 300_000n,
    '链上产能基准已过期，请重新选择矿机。');
  const price = chain.official?.priceWei ?? chain.firsto.priceWei;
  const cost = chain.official?.priceWei ?? chain.firsto.grossWei;
  const { priceCapWei, targetRaiseWei } = designatedFundingAmounts(cost);
  const basis = { collection: getAddress(chain.collection), tokenId: chain.tokenId,
    seller: getAddress(chain.owner), taskId: chain.taskId, weight: chain.verifiedWeight,
    priceWei: exact(price).toString(), costWei: exact(cost).toString(),
    dailyOutputAtomic: baseline.dailyOutputAtomic, block: baseline.blockNumber, blockHash: baseline.blockHash,
    observedAt: baseline.observedAt };
  const designated = Object.freeze({ referenceSeller: basis.seller, referencePriceWei: basis.priceWei,
    referenceCostWei: basis.costWei, referenceDailyOutputAtomic: basis.dailyOutputAtomic,
    referenceObservedAt: basis.observedAt, referenceBlock: basis.block,
    referenceDigest: keccak256(toUtf8Bytes(JSON.stringify(basis))) });
  return Object.freeze({ kind: DESIGNATED_PURCHASE_MODE, params: { ...params,
    targetRaiseWei: targetRaiseWei.toString(), priceCapWei: priceCapWei.toString(), directSeller: ZeroAddress, directPrice: '0' },
    designated, expectedTaskId: basis.taskId, expectedReferenceWeight: basis.weight });
}

export function checkedDesignatedCreation({ factory, from, params, config, expectedTaskId, expectedReferenceWeight }) {
  need(config && getAddress(config.referenceSeller) !== ZeroAddress, '指定购机缺少原机持有人基准。');
  const { priceCapWei, targetRaiseWei } = designatedFundingAmounts(config.referenceCostWei);
  need(exact(params.priceCap) === priceCapWei && exact(params.targetRaise) === targetRaiseWei
    && getAddress(params.directSeller) === ZeroAddress && exact(params.directPrice) === 0n,
  '指定购机替代预算与已预览基准不一致。');
  need(exact(config.referencePriceWei) > 0n && exact(config.referencePriceWei) <= exact(config.referenceCostWei)
    && exact(config.referenceDailyOutputAtomic) > 0n && exact(expectedReferenceWeight) > 0n,
  '指定购机价格或产能基准无效。');
  return Object.freeze({ chainId: '0x38', from: getAddress(from), to: getAddress(factory), value: '0x0',
    data: designatedFactoryAbi.encodeFunctionData(DESIGNATED_PURCHASE_MODE, [params, config, expectedTaskId, expectedReferenceWeight]) });
}

export const DESIGNATED_PURCHASE_TERMS = '优先购买原矿机。原机已转手且无可执行卖单时，允许购买同系列、同任务的纯验证矿机；挂牌价与挂牌价÷链上当前预计日产出均须在原基准的 90%–110%，含费支出仍不得超过购机上限。无合格矿机则等待，到期可退款。';

/** One immutable policy read at subscription preview, never a polling loop. */
export async function readDesignatedPurchaseTerms(provider, config, pool, blockTag = 'latest') {
  // Existing opted-in pools keep their terms even if new creation is paused.
  const isolated = !config?.manifest && !config?.pinnedManifest && !config?.productFamily;
  if (!(isolated ? config?.designatedPurchaseFallback === true
    : compiledCapability && config?.artifactDigest === contracts.artifactDigest)) return null;
  const raw = await provider.request({ method: 'eth_call', params: [{ to: getAddress(pool),
    data: designatedVaultAbi.encodeFunctionData('designatedPurchase') }, blockTag] });
  const policy = designatedVaultAbi.decodeFunctionResult('designatedPurchase', raw);
  if (!policy.enabled) return null;
  need(policy.config.referencePriceWei > 0n && policy.config.referenceDailyOutputAtomic > 0n
    && policy.config.referenceSeller !== ZeroAddress, '项目替代购机基准不完整，暂不能认购。');
  return Object.freeze({ terms: DESIGNATED_PURCHASE_TERMS, referenceCircuitId: policy.referenceCircuitId,
    referencePriceWei: policy.config.referencePriceWei,
    referenceDailyOutputAtomic: policy.config.referenceDailyOutputAtomic });
}
