import { ZeroAddress, getAddress, id, keccak256, verifyTypedData } from 'ethers';
import { abi } from './chain-client.mjs';
import { authorityAction } from './authority-client.mjs';
import { readPortfolioContext } from './live-portfolios.mjs';
import { validateBudgetQueue } from '../../deploy/shared/budget-queue.mjs';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const HASH = /^0x[\da-f]{64}$/i;
const canonicalCall = (contract, data) => {
  const parsed = contract.parseTransaction({ data });
  need(parsed && same(contract.encodeFunctionData(parsed.fragment, parsed.args), data), '管理员交易 calldata 不规范。');
  return parsed;
};

/** Reconstruct the only authorized inner call from the persisted, reviewed queue. */
export function expectedAuthorityQueueCall(config, plan, index) {
  validateBudgetQueue(plan, { config, account: plan.account, parent: plan.parent });
  need(config.stage === 'fresh-active', '当前项目不是新部署的管理员采购队列。');
  need(plan.snapshot?.complete === true && Number.isSafeInteger(plan.snapshot.blockNumber)
    && plan.snapshot.blockNumber >= 0 && HASH.test(plan.snapshot.blockHash ?? ''), '采购队列缺少完整的原始链上快照。');
  const item = plan.items[index], intent = item?.intent, command = intent?.authority;
  need(item && ['creating', 'buying', 'pending'].includes(item.status) && command,
    '采购队列缺少已保存的逐笔管理员意图。');
  need(same(intent.transaction.from, plan.account) && BigInt(intent.transaction.value) === 0n
    && BigInt(intent.transaction.chainId) === 56n, '采购队列钱包或网络意图不一致。');
  if (item.pendingPhase === 'create') {
    const parsed = canonicalCall(abi.PoolFactory, intent.transaction.data), params = parsed.args[0];
    need(parsed.name === 'createBudgetChildPool' && same(intent.transaction.to, plan.factory)
      && intent.action.kind === 'createBudgetChildPool' && same(parsed.args[1], plan.parent)
      && same(params.circuits, item.collection) && params.circuitId === BigInt(item.tokenId)
      && params.targetRaise === BigInt(item.targetRaiseWei) && params.priceCap === BigInt(item.maxCostWei)
      && same(params.directSeller, ZeroAddress) && params.directPrice === 0n
      && params.fundingDeadline === BigInt(plan.purchaseDeadline) - 1n
      && params.purchaseDeadline === BigInt(plan.purchaseDeadline)
      && command.kind === 'executeApprovedOperation' && same(command.args.target, plan.factory)
      && same(command.args.data, intent.transaction.data), '建池签名不属于本批已确认的矿机与预算项目。');
    return { command, arguments: [plan.factory, intent.transaction.data], target: plan.factory,
      eventKind: id('APPROVED_OPERATION'), item };
  }
  need(item.pendingPhase === 'purchase' && item.child && same(intent.transaction.to, plan.parent), '采购子池身份不一致。');
  const parsed = canonicalCall(abi.BudgetPortfolioVault, intent.transaction.data), args = command.args;
  need(same(parsed.args[0], item.child) && same(args.portfolio, plan.parent) && same(args.child, item.child)
    && BigInt(args.maxCost) > 0n && BigInt(args.maxCost) <= BigInt(item.maxCostWei), '采购签名超过本台矿机限额。');
  if (parsed.name === 'buyOfficial') {
    need(item.venue === 'official' && item.listingId !== undefined && intent.action.kind === 'buyOfficial'
      && command.kind === 'buyBudgetOfficial' && BigInt(args.listingId) === parsed.args[1]
      && BigInt(item.listingId) === parsed.args[1], '官网采购挂单与保存意图不一致。');
    return { command, arguments: [plan.parent, item.child, args.listingId, args.maxCost],
      target: plan.parent, eventKind: id('BUY_BUDGET_OFFICIAL'), item };
  }
  need(parsed.name === 'buyFirsto' && intent.action.kind === 'buyFirsto' && command.kind === 'buyBudgetFirsto'
    && item.venue === 'firsto' && same(args.encodedOrder, parsed.args[1])
    && same(args.encodedOrder, item.encodedOrder), 'Firsto 原始签名订单与保存意图不一致。');
  return { command, arguments: [plan.parent, item.child, args.encodedOrder, args.maxCost],
    target: plan.parent, eventKind: id('BUY_BUDGET_FIRSTO'), item };
}

function exactEvent(receipt, contract, address, name) {
  const topic = contract.getEvent(name).topicHash;
  const logs = receipt.logs.filter(log => same(log.address, address) && same(log.topics?.[0], topic));
  need(logs.length === 1, `缺少唯一的 ${name} 链上事件。`);
  const log = logs[0], decoded = contract.parseLog(log);
  const encoded = contract.encodeEventLog(decoded.fragment, decoded.args);
  need(log.removed !== true && same(log.transactionHash, receipt.transactionHash)
    && same(log.blockHash, receipt.blockHash) && same(encoded.data, log.data)
    && encoded.topics.length === log.topics.length
    && encoded.topics.every((value, index) => same(value, log.topics[index])), `${name} 事件身份或编码不一致。`);
  return decoded.args;
}

/** Read-only reconciliation: relay status alone never advances a persisted step.
 * The returned inner-call identity is proven by canonical Authority calldata,
 * the administrator signature, exact business events and finalized receipts. */
export async function recoverAuthorityQueueStep({ config, provider, plan, index, hash,
  readContext = readPortfolioContext } = {}) {
  const expected = expectedAuthorityQueueCall(config, plan, index), { command, item } = expected;
  need(HASH.test(hash ?? ''), '缺少可核对的管理员代付哈希；保留原步骤，不会重发。');
  const context = await readContext(config, provider);
  const rpc = (method, params = []) => provider.request({ method, params });
  const authority = getAddress(config.authority), gasWallet = getAddress(config.gasWallet);
  need(same(context.manifest.factory, plan.factory) && same(context.manifest.portfolioFactory, plan.portfolioFactory)
    && same(context.manifest.authority, authority) && same(context.manifest.gasWallet, gasWallet), '当前新合约图与采购队列不一致。');
  const [tx, receipt] = await Promise.all([
    rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash]),
  ]);
  if (!tx) return { status: 'pending', message: '交易尚未可读；保留原意图，稍后只读核对。' };
  need(same(tx.hash, hash) && same(tx.from, gasWallet) && same(tx.to, authority)
    && BigInt(tx.chainId) === 56n && BigInt(tx.value) === 0n, '该交易不是本项目 Gas 钱包的管理员代付。');
  const parsed = canonicalCall(abi.PlatformAuthority, tx.input ?? tx.data);
  need(parsed.name === command.kind, '管理员交易操作与待核对步骤不一致。');
  const nonce = parsed.args.at(-3), deadline = parsed.args.at(-2), signature = parsed.args.at(-1);
  need(same(abi.PlatformAuthority.encodeFunctionData(command.kind, [...expected.arguments, nonce, deadline, signature]),
    tx.input ?? tx.data), '管理员交易的目标、订单或最高支出与原预览不一致。');
  const signing = authorityAction(authority, command.kind, command.args, nonce, deadline);
  need(same(verifyTypedData(signing.domain, signing.types, signing.message, signature), plan.account),
    '链上管理员签名不属于本队列的钱包。');
  if (!receipt) return { status: 'pending', hash, message: '管理员代付已广播，等待链上确认。' };
  need(same(receipt.transactionHash, hash) && same(receipt.from, gasWallet) && same(receipt.to, authority)
    && same(tx.blockHash, receipt.blockHash) && BigInt(tx.blockNumber) === BigInt(receipt.blockNumber)
    && BigInt(receipt.blockNumber) >= BigInt(plan.snapshot.blockNumber)
    && ['0x0', '0x1'].includes(receipt.status) && Array.isArray(receipt.logs), '管理员交易回执身份不一致。');
  const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
  if (!finalized || BigInt(finalized.number) < BigInt(receipt.blockNumber))
    return { status: 'pending', hash, message: '交易已出块，等待最终性核验。' };
  need(HASH.test(finalized.hash ?? ''), '最终性区块不可用。');
  const [block, code] = await Promise.all([rpc('eth_getBlockByNumber', [receipt.blockNumber, false]),
    rpc('eth_getCode', [authority, finalized.number])]);
  need(same(block?.hash, receipt.blockHash) && BigInt(block.number) === BigInt(receipt.blockNumber)
    && (receipt.status === '0x0' || deadline >= BigInt(block.timestamp))
    && same(keccak256(code), context.manifest.freshAuthority?.codehash), '回执区块或管理员合约代码核验未通过。');
  let poolAddress;
  if (receipt.status === '0x1') {
    const admin = exactEvent(receipt, abi.PlatformAuthority, authority, 'AdminAction');
    need(same(admin.administrator, plan.account) && same(admin.kind, expected.eventKind)
      && same(admin.target, expected.target) && admin.nonce === nonce, '管理员授权事件与原签名不一致。');
    if (item.pendingPhase === 'create') {
      const created = exactEvent(receipt, abi.PoolFactory, plan.factory, 'PoolCreated');
      need(same(created.circuits, item.collection) && created.circuitId === BigInt(item.tokenId)
        && created.targetRaise === BigInt(item.targetRaiseWei) && created.priceCap === BigInt(item.maxCostWei)
        && same(created.treasury, authority) && !same(created.pool, ZeroAddress), '子矿池创建事件不属于原矿机或预算。');
      poolAddress = getAddress(created.pool);
      const subscriber = (await context.read(plan.factory, abi.PoolFactory, 'designatedSubscriber', [poolAddress]))[0];
      need(same(subscriber, plan.parent), '已创建子矿池未绑定本预算项目。');
    } else {
      const bought = exactEvent(receipt, abi.BudgetPortfolioVault, plan.parent, 'ChildPurchased');
      need(same(bought.child, item.child) && same(bought.collection, item.collection)
        && bought.tokenId === BigInt(item.tokenId) && bought.cost > 0n && bought.cost <= BigInt(command.args.maxCost)
        && bought.official === (command.kind === 'buyBudgetOfficial'), '采购事件的矿机、来源或支出与原预览不一致。');
    }
  } else need(receipt.logs.length === 0, '失败回执不能包含执行成功的事件。');
  const [canonicalReceipt, canonicalFinalized] = await Promise.all([
    rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_getBlockByNumber', [finalized.number, false]),
  ]);
  need(same(canonicalReceipt?.hash, receipt.blockHash) && same(canonicalFinalized?.hash, finalized.hash), '回执核验期间区块发生变化。');
  await context.canonical();
  const gasNonce = Number(BigInt(tx.nonce));
  need(Number.isSafeInteger(gasNonce) && gasNonce >= 0, 'Gas 钱包 nonce 无效。');
  return { status: receipt.status === '0x1' ? 'confirmed' : 'reverted', finalized: true,
    account: plan.account, target: item.intent.transaction.to, factory: item.pendingPhase === 'create' ? plan.factory : plan.portfolioFactory,
    action: item.intent.action.kind, hash, transactionHash: hash, nonce: gasNonce,
    ...(poolAddress ? { poolAddress } : {}), receipt: { ...receipt, status: receipt.status === '0x1' ? 1 : 0 } };
}
