import { Interface, getAddress, ZeroAddress, toQuantity } from 'ethers';
import { abi, uint, checkedPoolCreation, readPoolSnapshot } from './chain-client.mjs';
import { loadOperatorQuote, readMachineRegistry } from './operator-quotes.mjs';
import { decodeFirstoOrder, verifyFirstoSignedAsk } from '../../deploy/src/firsto-purchase.mjs';

const need = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);
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
  let transaction, normalizedParams, frozenFirstoOrder, details = {}, requestKind = kind;
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
    if (kind === 'buyFromFirsto') {
      need(row.state === 1n && row.params && status.timestamp < row.params.purchaseDeadline, '矿池未募满或购机期限已过。');
      const registry = await readMachineRegistry(provider, { factory, collection: row.params.circuits, tokenId: row.params.circuitId, blockTag: tag });
      need(registry.supported && registry.ready, '当前工厂版本尚未开放 Firsto 采购，或矿机唯一性登记未完成。');
      need(same(registry.pool, target), `矿机登记不属于此矿池，当前登记项目：${registry.pool}。`);
      let order;
      if (firstoOrder !== undefined) {
        // Reconfirmation verifies the frozen bytes, never replaces them with a different market order.
        order = decodeFirstoOrder(firstoOrder);
        need(same(order.ask.collection, row.params.circuits) && BigInt(order.ask.tokenId) === row.params.circuitId,
          'Firsto 订单不是矿池原目标矿机。');
        order = await verifyFirstoSignedAsk(provider, order, { blockTag: tag });
      } else {
        const checked = await loadOperatorQuote({ collection: row.params.circuits, tokenId: row.params.circuitId.toString(), config, provider, blockTag: tag });
        need(checked.chain.blockHash === status.blockHash, 'Firsto 报价核对区块不一致。');
        need(checked.chain.firsto, checked.chain.firstoError || '原目标暂无可执行的 Firsto 单笔签名挂单。');
        order = checked.chain.firsto;
      }
      need(order.checkedBlock.hash === status.blockHash, 'Firsto 订单核对区块不一致。');
      need(BigInt(order.grossWei) <= row.params.priceCap && BigInt(order.grossWei) <= row.totalRaised,
        'Firsto 含来源手续费的总价超过矿池购机上限或募集金额。');
      frozenFirstoOrder = order.encodedOrder;
      transaction = tx(target, abi.PoolVault, 'buyFromFirsto', [0, frozenFirstoOrder]);
      details = { firsto: order };
    } else if (kind === 'buyFromMarket' || kind === 'buyAlternativeFromMarket') {
      need(row.state === 1n && row.params && status.timestamp < row.params.purchaseDeadline, '矿池未募满或购机期限已过。');
      transaction = tx(target, abi.PoolVault, kind, [uint(listingId)]);
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
  return Object.freeze({ transaction, kind, requestKind, ...details,
    predictedPool: normalizedParams ? result[0] : undefined,
    request: Object.freeze({ kind, params: normalizedParams, flexible, expectedTaskId, expectedReferenceWeight, pool, listingId, miningAction, firstoOrder: frozenFirstoOrder }),
    checkedBlock: Object.freeze({ blockNumber: status.blockNumber, blockHash: status.blockHash, timestamp: status.timestamp }) });
}
