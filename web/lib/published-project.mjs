import { ZeroAddress, getAddress, id } from 'ethers';
import { abi, decodePoolRow } from './chain-client.mjs';
import { livePoolModel } from './live-data.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const HASH = /^0x[\da-f]{64}$/i;
const need = (ok, message) => { if (!ok) throw new Error(message); };

/** Remember the reviewed creation, rather than inferring success from a relay hash. */
export function publishedProjectIntent(config, transaction, { account, command } = {}) {
  if (!transaction || command?.kind !== 'executeApprovedOperation') return null;
  const factory = getAddress(transaction.to), portfolio = same(factory, config.portfolioFactory);
  if (!portfolio && !same(factory, config.factory)) return null;
  const contract = portfolio ? abi.BudgetPortfolioFactory : abi.PoolFactory;
  const parsed = contract.parseTransaction({ data: transaction.data });
  if (!parsed || !(portfolio ? ['createPortfolio'] : ['createPool', 'createPoolWithExpiry',
    'createFlexiblePool', 'createFlexiblePoolChecked', 'createBudgetChildPool']).includes(parsed.name)) return null;
  need(BigInt(transaction.value) === 0n && BigInt(transaction.chainId) === 56n
    && same(transaction.from, account) && same(command.args.target, factory)
    && same(command.args.data, transaction.data)
    && same(contract.encodeFunctionData(parsed.fragment, parsed.args), transaction.data), '项目发布内容已改变。');
  const params = parsed.args[0];
  return { kind: portfolio ? 'portfolio' : 'single', action: portfolio ? 'createPortfolio' : 'createPool',
    factory, account: getAddress(account), authority: getAddress(config.authority), gasWallet: getAddress(config.gasWallet),
    nonce: BigInt(command.nonce).toString(), callData: transaction.data, child: parsed.name === 'createBudgetChildPool',
    expected: portfolio ? { budgetWei: parsed.args[0], absoluteCapWei: parsed.args[1], unitCapWei: parsed.args[2] }
      : { circuits: params.circuits, circuitId: params.circuitId, targetRaise: params.targetRaise, priceCap: params.priceCap } };
}

function event(receipt, contract, address, name) {
  const topic = contract.getEvent(name).topicHash;
  const logs = receipt.logs.filter(log => same(log.address, address) && same(log.topics?.[0], topic));
  need(logs.length === 1, `项目发布回执缺少唯一的 ${name} 事件。`);
  const log = logs[0], parsed = contract.parseLog(log), encoded = contract.encodeEventLog(parsed.fragment, parsed.args);
  need(log.removed !== true && same(log.transactionHash, receipt.transactionHash)
    && same(log.blockHash, receipt.blockHash) && same(log.data, encoded.data)
    && log.topics.length === encoded.topics.length && log.topics.every((value, index) => same(value, encoded.topics[index])),
  '项目发布事件与交易回执不一致。');
  return parsed.args;
}

/** The relay already establishes finality. Read its exact receipt once to identify the new project. */
export async function readPublishedProject({ provider, intent, status, hash = status?.hash } = {}) {
  if (!intent || !['confirmed', 'failed'].includes(status?.status) || !HASH.test(hash ?? '')
    || !same(status.hash, hash)) return null;
  const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
  if (!receipt) return null;
  need(same(receipt.transactionHash, hash) && same(receipt.to, intent.authority)
    && same(receipt.from, intent.gasWallet) && HASH.test(receipt.blockHash ?? '')
    && /^0x[\da-f]+$/i.test(receipt.blockNumber ?? '') && Array.isArray(receipt.logs), '项目发布交易回执身份不一致。');
  const successful = receipt.status === '0x1';
  need(successful || receipt.status === '0x0', '项目发布回执状态不可用。');
  if (!successful) {
    need(status.status === 'failed' && receipt.logs.length === 0, '项目发布失败状态与回执不一致。');
    const tx = await provider.request({ method: 'eth_getTransactionByHash', params: [hash] });
    const call = abi.PlatformAuthority.parseTransaction({ data: tx?.input ?? tx?.data });
    need(same(tx?.hash, hash) && same(tx.to, intent.authority) && same(tx.from, intent.gasWallet)
      && call?.name === 'executeApprovedOperation' && same(call.args[0], intent.factory)
      && same(call.args[1], intent.callData) && call.args.at(-3) === BigInt(intent.nonce), '失败回执不属于本次项目发布。');
    return { status: 'failed', finalized: true, hash, action: intent.action, receipt: { ...receipt, status: 0 } };
  }
  need(status.status === 'confirmed', '项目发布尚未确认。');
  const admin = event(receipt, abi.PlatformAuthority, intent.authority, 'AdminAction');
  need(same(admin.administrator, intent.account) && same(admin.target, intent.factory)
    && same(admin.kind, id('APPROVED_OPERATION')) && admin.nonce === BigInt(intent.nonce), '回执不属于本次项目发布。');
  const created = event(receipt, intent.kind === 'portfolio' ? abi.BudgetPortfolioFactory : abi.PoolFactory,
    intent.factory, intent.kind === 'portfolio' ? 'PortfolioCreated' : 'PoolCreated');
  const expected = intent.expected;
  need(intent.kind === 'portfolio' ? created.budgetWei === expected.budgetWei
    && created.absoluteCapWei === expected.absoluteCapWei && created.unitCapWei === expected.unitCapWei
    : same(created.circuits, expected.circuits) && created.circuitId === expected.circuitId
      && created.targetRaise === expected.targetRaise && created.priceCap === expected.priceCap,
  '新项目与已确认发布内容不一致。');
  const poolAddress = getAddress(intent.kind === 'portfolio' ? created.portfolio : created.pool);
  need(poolAddress !== ZeroAddress, '新项目地址不可用。');
  return { status: 'confirmed', finalized: true, hash, action: intent.action, poolAddress,
    projectKind: intent.kind, child: intent.child, blockNumber: Number(BigInt(receipt.blockNumber)),
    receipt: { ...receipt, status: 1 } };
}

/** Only a confirmed new address may bypass an older directory snapshot. One
 * fixed, registered Lens aggregate supplies actual fields; no invented row. */
export async function readPublishedPoolDisplay(client, confirmation, intent, account) {
  need(confirmation?.status === 'confirmed' && confirmation.projectKind === 'single'
    && same(client.manifest?.factory, intent.factory), '缺少已确认的新项目身份。');
  try {
    const result = await client.readDisplayPool({ pool: confirmation.poolAddress, account });
    if (Number(result.source?.indexedThrough) >= confirmation.blockNumber) return result;
  } catch (problem) {
    if (!['http_unavailable', 'network_unavailable', 'untrusted_pool', 'index_incomplete', 'index_stale'].includes(problem?.code)) throw problem;
  }
  const raw = await client.provider.request({ method: 'eth_call', params: [{ to: client.manifest.lens,
    data: abi.PoolLens.encodeFunctionData('positions', [[confirmation.poolAddress], account]) }, 'latest'] });
  const aggregate = abi.PoolLens.decodeFunctionResult('positions', raw)[0];
  need(aggregate.pools.length === 1 && same(aggregate.pools[0].pool, confirmation.poolAddress)
    && aggregate.blockNumber >= BigInt(confirmation.blockNumber), '新项目聚合结果与创建回执不一致。');
  const row = decodePoolRow(aggregate.pools[0], intent.factory), expected = intent.expected;
  need(row.trusted && row.params && same(row.params.circuits, expected.circuits)
    && row.params.circuitId === expected.circuitId && row.params.targetRaise === expected.targetRaise
    && row.params.priceCap === expected.priceCap, '新项目尚未返回可信的 Factory 注册资料。');
  return { item: livePoolModel(row, aggregate), source: { chainId: 56, factory: intent.factory,
    indexedThrough: Number(aggregate.blockNumber), indexedTimestamp: Number(aggregate.timestamp),
    displayOnly: true, readMode: 'display_direct' } };
}

/** A stale directory cannot erase a row read from a genuinely confirmed creation. */
export function mergePublishedProjects(rows, published) {
  const found = new Set(rows.map(row => row.pool?.toLowerCase()));
  return [...rows, ...published.filter(row => row?.pool && !found.has(row.pool.toLowerCase()))];
}
