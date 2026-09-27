import { Interface, getAddress, ZeroAddress, toQuantity } from 'ethers';
import { abi, ARTIFACT_DIGEST, uint, checkedPoolCreation, readPoolSnapshot } from './chain-client.mjs';
import { loadOperatorQuote, readMachineRegistry, readOfficialMinerOnchain } from './operator-quotes.mjs';
import { fetchLiveJson } from './live-config.mjs';
import { decodeFirstoOrder, verifyFirstoSignedAsk } from '../../deploy/src/firsto-purchase.mjs';

const need = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);
const OFFICIAL_MARKET = '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f';
const officialMarket = new Interface([
  'function listingFor(address,uint256) view returns(uint256 id,address seller,uint96 price,bool valid)',
  'function listingView(uint256) view returns(address seller,address circuits,uint256 tokenId,uint96 price,uint16 feeBps,bool valid)',
]);
const readVault = async (request, pool, method, blockTag) => abi.PoolVault.decodeFunctionResult(method,
  await request('eth_call', [{ to: pool, data: abi.PoolVault.encodeFunctionData(method) }, blockTag]));

function officialCandidateRevert(error) {
  const data = error?.data ?? error?.error?.data;
  return error?.code === 3 || error?.code === 'CALL_EXCEPTION'
    || typeof data === 'string' && /^0x[\da-f]*$/i.test(data) && /revert/i.test(String(error?.message ?? ''))
    || /^execution reverted(?:\b|:)/i.test(String(error?.message ?? ''));
}

async function readFlexiblePurchaseModel({ request, pool, row, tag }) {
  const selection = await readVault(request, pool, 'flexiblePurchase', tag);
  if (!selection.enabled) return null; // Fixed pools may only buy their original NFT.
  const [model, referenceWeight] = await Promise.all([
    readVault(request, pool, 'purchaseModel', tag), readVault(request, pool, 'purchaseReferenceWeight', tag),
  ]);
  need(selection.referenceCircuitId === row.params.circuitId && model.initialized && referenceWeight[0] > 0n,
    '矿池灵活购机模型未完成链上锁定。');
  const policy = selection.config;
  const expected = { circuits: row.params.circuits, taskId: model.taskId.toString(),
    minVerifiedWeight: policy.minVerifiedWeight.toString(), referenceVerifiedWeight: referenceWeight[0].toString(),
    referencePriceWei: policy.referencePriceWei.toString(), priceCap: row.params.priceCap.toString() };
  need(uint(expected.minVerifiedWeight) > 0n && uint(expected.referencePriceWei) > 0n,
    '矿池灵活购机约束无效。');
  return expected;
}

function flexiblePriceLimit(model, verifiedWeight) {
  const weight = uint(verifiedWeight), reference = uint(model.referenceVerifiedWeight);
  return weight >= reference ? uint(model.referencePriceWei)
    : uint(model.referencePriceWei) * weight / reference;
}

async function findOfficialAlternative({ request, config, pool, row, status, tag, tx, model: expected }) {
  if (!expected) return null;
  const query = new URLSearchParams({ pool, block: status.blockNumber.toString(), hash: status.blockHash });
  const journalBase = (config.journalBase ?? `${config.basePath ?? ''}/api/journal`).replace(/\/$/, '');
  let result;
  try {
    result = await fetchLiveJson(`${journalBase}/official-candidates?${query}`,
      { maxBytes: 512000, timeoutMs: 40000 });
  } catch (error) {
    if (error?.details?.status === 429) throw new Error('官网候选扫描繁忙，请稍后重试。');
    throw error;
  }
  need(result?.complete === true && result.chainId === 56 && same(result.factory, config.factory ?? config.manifest?.factory)
    && result.artifactDigest?.toLowerCase() === ARTIFACT_DIGEST.toLowerCase()
    && (config.manifest?.artifactDigest === undefined || config.manifest.artifactDigest.toLowerCase() === ARTIFACT_DIGEST.toLowerCase())
    && same(result.pool, pool) && BigInt(result.blockNumber) === status.blockNumber
    && result.blockHash === status.blockHash && result.flexible === true,
  '官网候选扫描不完整或不属于当前链上矿池与区块。');
  need(Object.entries(expected).every(([key, value]) => key === 'circuits' ? same(result.model?.[key], value)
    : result.model?.[key] === value), '官网候选模型与矿池锁定参数不一致。');
  need(Array.isArray(result.candidates) && result.candidates.length <= 1000, '官网候选数据无效。');
  const seen = new Set();
  let rejectedOfficialSimulation = false;
  for (const hint of result.candidates) {
    const tokenId = uint(hint.tokenId), listingId = uint(hint.listingId), priceWei = uint(hint.priceWei);
    const verifiedWeight = uint(hint.verifiedWeight);
    need(same(hint.collection, expected.circuits) && listingId > 0n
      && priceWei > 0n && priceWei <= row.params.priceCap && priceWei <= row.totalRaised
      && verifiedWeight >= uint(expected.minVerifiedWeight)
      && priceWei <= flexiblePriceLimit(expected, verifiedWeight)
      && !seen.has(tokenId.toString()), '官网候选身份、报价或权重无效。');
    if (tokenId === row.params.circuitId) continue; // The original was checked with NFT ownership above.
    seen.add(tokenId.toString());
    const listingFor = officialMarket.decodeFunctionResult('listingFor', await request('eth_call',
      [{ to: OFFICIAL_MARKET, data: officialMarket.encodeFunctionData('listingFor', [expected.circuits, tokenId]) }, tag]));
    need(listingFor.valid && listingFor.id === listingId && same(listingFor.seller, hint.seller)
      && listingFor.price === priceWei, '官网候选挂单已变化，请重新扫描。');
    const live = officialMarket.decodeFunctionResult('listingView', await request('eth_call',
      [{ to: OFFICIAL_MARKET, data: officialMarket.encodeFunctionData('listingView', [listingId]) }, tag]));
    need(live.valid && same(live.seller, hint.seller) && same(live.circuits, expected.circuits)
      && live.tokenId === tokenId && live.price === priceWei, '官网候选挂单明细与当前矿机不一致。');
    const transaction = tx(pool, abi.PoolVault, 'buyAlternativeFromMarket', [listingId]);
    const { chainId: _chainId, ...unsigned } = transaction;
    try { await request('eth_call', [unsigned, tag]); }
    catch (error) {
      if (!officialCandidateRevert(error)) throw error;
      rejectedOfficialSimulation = true;
      continue;
    }
    return { transaction, official: { id: listingId.toString(), seller: getAddress(live.seller),
      collection: getAddress(live.circuits), tokenId: tokenId.toString(), priceWei: priceWei.toString(),
      verifiedWeight: verifiedWeight.toString() } };
  }
  need(!rejectedOfficialSimulation, '官网候选购机模拟未通过，不能据此判定官网无货；请重新扫描或人工核对。');
  return null;
}

/** An unchanged listing ID can still be repriced before the wallet confirmation. */
export function sameAdminPurchasePreview(previous, current) {
  if (!previous?.official && !current?.official) return true;
  return !!previous.official && !!current.official
    && previous.official.id === current.official.id
    && previous.official.priceWei === current.official.priceWei
    && same(previous.official.seller, current.official.seller)
    && (previous.official.tokenId ?? null) === (current.official.tokenId ?? null)
    && (previous.official.collection ?? null) === (current.official.collection ?? null)
    && (previous.official.verifiedWeight ?? null) === (current.official.verifiedWeight ?? null);
}
export const OFFICIAL_COLLECTIONS = Object.freeze([
  '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
  '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
]);
const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const mining = new Interface(['function arm(address,uint256)', 'function reclaim(bytes32)',
  'function minerKey(address,uint256) view returns(bytes32)']);
const addr = value => { const a = getAddress(value); need(a !== ZeroAddress, '地址不能为零。'); return a; };
const configured = (config, key) => {
  const result = addr(config[key] ?? config.manifest?.[key]);
  if (config[key] && config.manifest?.[key]) need(same(config[key], config.manifest[key]), '部署配置不一致。');
  return result;
};
async function context(provider, config, account) {
  need(config?.status === 'ready' && Number(config.chainId ?? config.manifest?.chainId) === 56, '请先加载已验证部署。');
  const from = addr(account), factory = configured(config, 'factory');
  const request = (method, params = []) => provider.request({ method, params });
  need(BigInt(await request('eth_chainId')) === 56n, '请切换到 BSC 主网。');
  const block = await request('eth_getBlockByNumber', ['latest', false]);
  need(/^0x[0-9a-f]{64}$/i.test(block?.hash ?? ''), '区块不可用。');
  const blockNumber = BigInt(block.number), timestamp = BigInt(block.timestamp), tag = toQuantity(blockNumber);
  const call = async (to, contract, name, args = []) => contract.decodeFunctionResult(name,
    await request('eth_call', [{ to, data: contract.encodeFunctionData(name, args) }, tag]))[0];
  const [operator, creationPaused, code] = await Promise.all([
    call(factory, abi.PoolFactory, 'operator'), call(factory, abi.PoolFactory, 'creationPaused'), request('eth_getCode', [factory, tag]),
  ]);
  need(code && code !== '0x', '工厂合约不可用。');
  const status = Object.freeze({ configured: true, isOperator: same(operator, from), operator, account: from,
    creationPaused, factory, blockNumber, timestamp, blockHash: block.hash });
  const verify = async () => {
    const after = await request('eth_getBlockByNumber', [tag, false]);
    need(after?.hash === block.hash && BigInt(await request('eth_chainId')) === 56n, '链上状态已变化，请重新确认。');
  };
  return { from, factory, request, call, tag, status, verify };
}
export async function readOperatorStatus({ provider, config, account }) {
  const ctx = await context(provider, config, account);
  const machineRegistry = await readMachineRegistry(provider, { factory: ctx.factory, blockTag: ctx.tag });
  await ctx.verify(); return Object.freeze({ ...ctx.status, machineRegistry });
}

/** Read and simulate only. The returned immutable request freezes relative deadlines for confirmation. */
export async function prepareAdminAction(input) {
  const { provider, config, account, kind, params = {}, flexible, expectedTaskId, expectedReferenceWeight, pool, listingId, miningAction, firstoOrder } = input;
  const ctx = await context(provider, config, account), { from, factory, request, call, tag, status } = ctx;
  need(status.isOperator, '仅当前运营钱包可操作。');
  let transaction, normalizedParams, frozenFirstoOrder, details = {}, resolvedKind = kind;
  let selectedListingId = listingId;
  const tx = (to, contract, name, args) => Object.freeze({ chainId: '0x38', from, to,
    data: contract.encodeFunctionData(name, args), value: '0x0' });
  if (kind === 'createPool' || kind === 'createFlexiblePoolChecked') {
    need(!status.creationPaused, '当前已暂停创建矿池。');
    const circuits = addr(params.circuits);
    need(OFFICIAL_COLLECTIONS.some(a => same(a, circuits)), '请选择官方矿机合约。');
    const registry = await readMachineRegistry(provider, { factory, collection: circuits, tokenId: params.circuitId, blockTag: tag });
    need(registry.supported, '当前工厂尚未支持矿机唯一性登记，请等待合约升级后创建。');
    need(registry.ready, '矿机唯一性登记尚未完成，请稍后创建。');
    need(same(registry.pool, ZeroAddress), `此矿机已有拼矿项目：${registry.pool}，不能重复创建。`);
    const targetRaise = uint(params.targetRaiseWei ?? params.targetRaise), priceCap = uint(params.priceCapWei ?? params.priceCap);
    need(targetRaise > 0n && targetRaise % 100n === 0n && priceCap > 0n && priceCap <= targetRaise, '募集金额须能整分为 100 份，购机上限不得超过募集额。');
    const fundingDeadline = params.fundingDeadline !== undefined ? uint(params.fundingDeadline, 64)
      : status.timestamp + uint(String(params.fundingHours), 32) * 3600n;
    const purchaseDeadline = params.purchaseDeadline !== undefined ? uint(params.purchaseDeadline, 64)
      : fundingDeadline + uint(String(params.purchaseHours), 32) * 3600n;
    need(fundingDeadline > status.timestamp && purchaseDeadline > fundingDeadline, '募集和购机截止时间无效。');
    normalizedParams = Object.freeze({ circuits, circuitId: uint(params.circuitId), targetRaise, priceCap,
      directSeller: ZeroAddress, directPrice: 0n, fundingDeadline, purchaseDeadline });
    transaction = kind === 'createPool' ? tx(factory, abi.PoolFactory, kind, [normalizedParams])
      : checkedPoolCreation({ factory, from, params: normalizedParams, config: flexible, expectedTaskId, expectedReferenceWeight });
    details = { params: normalizedParams, unitPriceWei: targetRaise / 100n };
  } else {
    const target = addr(pool), snap = await readPoolSnapshot(provider, { factory, account: from, pools: [target], blockNumber: status.blockNumber });
    const row = snap.pools[0];
    need(row?.trusted && same(row.pool, target) && same(snap.lens, configured(config, 'lens')) && snap.blockHash === status.blockHash, '矿池身份或读取区块不一致。');
    if (kind === 'autoPurchase' || kind === 'buyFromFirsto') {
      need(row.state === 1n && row.params && status.timestamp < row.params.purchaseDeadline, '矿池未募满或购机期限已过。');
      const frozenOrder = firstoOrder === undefined ? null : decodeFirstoOrder(firstoOrder);
      if (frozenOrder) need(same(frozenOrder.ask.collection, row.params.circuits)
        && BigInt(frozenOrder.ask.tokenId) === row.params.circuitId, 'Firsto 订单不是矿池原目标矿机。');
      const officialCheck = await readOfficialMinerOnchain(provider, row.params.circuits, row.params.circuitId,
        { config, blockTag: tag, allowIneligible: true });
      need(officialCheck.blockHash === status.blockHash, '官网矿机核对区块不一致。');
      const flexibleModel = await readFlexiblePurchaseModel({ request, pool: target, row, tag });
      let official = officialCheck.official && BigInt(officialCheck.official.priceWei) <= row.params.priceCap
        && BigInt(officialCheck.official.priceWei) <= row.totalRaised ? officialCheck.official : null;
      if (official && flexibleModel && (officialCheck.taskId !== flexibleModel.taskId
        || uint(officialCheck.verifiedWeight) < uint(flexibleModel.minVerifiedWeight)
        || uint(official.priceWei) > flexiblePriceLimit(flexibleModel, officialCheck.verifiedWeight))) official = null;
      if (official) {
        const direct = tx(target, abi.PoolVault, 'buyFromMarket', [uint(official.id)]);
        const { chainId: _chainId, ...unsigned } = direct;
        try { await request('eth_call', [unsigned, tag]); }
        catch (error) {
          if (!officialCandidateRevert(error)) throw error;
          throw new Error('官网原目标挂单仍符合价格与身份条件，但购机模拟未通过；请重新扫描或人工核对。');
        }
      }
      if (official) {
        need(kind !== 'buyFromFirsto', '官网原目标仍有符合价格上限的挂单，请先从官网采购。');
        resolvedKind = 'buyFromMarket'; selectedListingId = official.id;
        transaction = tx(target, abi.PoolVault, resolvedKind, [uint(official.id)]);
        details = { official: { ...official, collection: row.params.circuits, tokenId: row.params.circuitId.toString(),
          verifiedWeight: officialCheck.verifiedWeight }, procurementRoute: 'official' };
      } else {
        const alternative = await findOfficialAlternative({ request, config, pool: target, row, status, tag, tx, model: flexibleModel });
        if (alternative) {
          need(kind !== 'buyFromFirsto', '官网市场仍有可执行的同任务替代矿机，请先从官网采购。');
          resolvedKind = 'buyAlternativeFromMarket'; selectedListingId = alternative.official.id;
          transaction = alternative.transaction;
          details = { official: alternative.official, procurementRoute: 'official-alternative' };
        } else {
        const registry = officialCheck.registry;
        need(registry.supported && registry.ready, '当前工厂版本尚未开放 Firsto 采购，或矿机唯一性登记未完成。');
        need(same(registry.pool, target), `矿机登记不属于此矿池，当前登记项目：${registry.pool}。`);
        let order;
        if (frozenOrder) {
          // Reconfirmation verifies the frozen bytes, never replaces them with a different market order.
          order = await verifyFirstoSignedAsk(provider, frozenOrder, { blockTag: tag });
        } else {
          const checked = await loadOperatorQuote({ collection: row.params.circuits, tokenId: row.params.circuitId.toString(),
            config, provider, blockTag: tag, mode: 'createPool', officialPriceCapWei: row.params.priceCap.toString() });
          need(checked.chain.blockHash === status.blockHash, 'Firsto 报价核对区块不一致。');
          need(checked.chain.firsto, checked.chain.firstoError || '原目标暂无可执行的 Firsto 单笔签名挂单。');
          order = checked.chain.firsto;
        }
        need(order.checkedBlock.hash === status.blockHash, 'Firsto 订单核对区块不一致。');
        need(BigInt(order.grossWei) <= row.params.priceCap && BigInt(order.grossWei) <= row.totalRaised,
          'Firsto 含来源手续费的总价超过矿池购机上限或募集金额。');
        frozenFirstoOrder = order.encodedOrder;
        resolvedKind = 'buyFromFirsto';
        transaction = tx(target, abi.PoolVault, resolvedKind, [0, frozenFirstoOrder]);
        details = { firsto: order, procurementRoute: 'firsto' };
        }
      }
    } else if (kind === 'buyFromMarket' || kind === 'buyAlternativeFromMarket') {
      need(row.state === 1n && row.params && status.timestamp < row.params.purchaseDeadline, '矿池未募满或购机期限已过。');
      const id = uint(listingId);
      const listed = officialMarket.decodeFunctionResult('listingView', await request('eth_call',
        [{ to: OFFICIAL_MARKET, data: officialMarket.encodeFunctionData('listingView', [id]) }, tag]));
      need(listed.valid && same(listed.circuits, row.params.circuits), '官网挂单无效或矿机系列与矿池不一致。');
      const quality = await readOfficialMinerOnchain(provider, listed.circuits, listed.tokenId,
        { config, blockTag: tag });
      need(quality.blockHash === status.blockHash, '官网矿机核对区块不一致。');
      need(kind !== 'buyFromMarket' || listed.tokenId === row.params.circuitId,
        '官网挂单不是当前矿池的指定矿机。');
      transaction = tx(target, abi.PoolVault, kind, [id]);
    } else if (kind === 'mine') {
      need(row.state === 2n && row.params, '矿池尚未持有可操作矿机。');
      let data;
      if (miningAction === 'arm') data = mining.encodeFunctionData('arm', [row.params.circuits, row.params.circuitId]);
      else if (miningAction === 'reclaim') {
        const key = await call(MINING, mining, 'minerKey', [row.params.circuits, row.params.circuitId]);
        data = mining.encodeFunctionData('reclaim', [key]);
      } else throw new Error('启动挖矿需要有效计算证明，当前入口只支持预备和回收。');
      transaction = tx(target, abi.PoolVault, 'mine', [data]);
    } else throw new Error('不支持的运营操作。');
    details = { ...details, pool: target, row, snapshot: snap, miningAction };
  }
  const contract = same(transaction.to, factory) ? abi.PoolFactory : abi.PoolVault;
  const { chainId: _chainId, ...unsigned } = transaction;
  const parsed = contract.parseTransaction(transaction);
  const result = contract.decodeFunctionResult(parsed.fragment, await request('eth_call', [unsigned, tag]));
  await ctx.verify();
  return Object.freeze({ transaction, kind: resolvedKind, requestKind: resolvedKind, ...details,
    predictedPool: normalizedParams ? result[0] : undefined,
    request: Object.freeze({ kind, params: normalizedParams, flexible, expectedTaskId, expectedReferenceWeight, pool,
      listingId: selectedListingId, miningAction, firstoOrder: frozenFirstoOrder }),
    checkedBlock: Object.freeze({ blockNumber: status.blockNumber, blockHash: status.blockHash, timestamp: status.timestamp }) });
}
