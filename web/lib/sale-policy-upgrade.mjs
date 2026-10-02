import { AbiCoder, Interface, ZeroHash, getAddress, keccak256, toQuantity, toUtf8Bytes } from 'ethers';
import { decodeFreshSingleCallEnvelope, FRESH_BALANCE_ENFORCER, FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR }
  from '../../deploy/shared/fresh-activation-execution.mjs';

const HASH = /^0x[\da-f]{64}$/i;
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const saleUpgradeDeploymentOrder = ['SaleGovernance', 'PoolVault', 'BudgetPortfolioVault', 'ShareMarket'];
const ORDER = saleUpgradeDeploymentOrder;
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const timelock = new Interface(['function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  'function executeBatch(address[],uint256[],bytes[],bytes32,bytes32) payable',
  'function getMinDelay() view returns(uint256)', 'function PROPOSER_ROLE() view returns(bytes32)',
  'function hasRole(bytes32,address) view returns(bool)', 'function getTimestamp(bytes32) view returns(uint256)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)']);
const beacon = new Interface(['function upgradeTo(address)', 'function implementation() view returns(address)']);
const market = new Interface(['function upgradeToAndCall(address,bytes)']);

export function validateSaleUpgradeCatalog(catalog, { profile } = {}) {
  need(catalog?.schemaVersion === 1 && catalog.kind === 'fresh-sale-policy-upgrade-v1'
    && catalog.chainId === 56 && ['formal', 'full-test'].includes(catalog.profile)
    && (!profile || profile === catalog.profile), '升级资料与当前网站不一致。');
  need(HASH.test(catalog.genesisArtifactDigest) && HASH.test(catalog.candidateArtifactDigest), '升级编译资料无效。');
  for (const name of ['factory', 'portfolioFactory', 'beacon', 'portfolioBeacon', 'shareMarket', 'timelock', 'authority', 'gasWallet', 'proposer'])
    need(getAddress(catalog.bindings?.[name]) !== '0x0000000000000000000000000000000000000000', `升级地址无效：${name}。`);
  for (const name of ['PoolVault', 'BudgetPortfolioVault', 'ShareMarket']) getAddress(catalog.expectedImplementations?.[name]);
  for (const name of ORDER) need(catalog.artifacts?.[name]?.bytecode?.startsWith('0x')
    && Array.isArray(catalog.artifacts[name].abi), `缺少 ${name} 编译资料。`);
  return catalog;
}

export function upgradeSalt(catalog) {
  return keccak256(toUtf8Bytes(`bemine.sale-policy.v1:${catalog.bindings.factory.toLowerCase()}:${catalog.candidateArtifactDigest.toLowerCase()}`));
}

export function upgradeDeployment(catalog, name, deployed = {}) {
  need(ORDER.includes(name), '升级步骤无效。');
  if (name === 'PoolVault') need(deployed.SaleGovernance, '请先确认本次出售规则合约。');
  const artifact = catalog.artifacts[name], links = { ...catalog.libraries, ...deployed };
  let bytes = artifact.bytecode.slice(2);
  for (const [source, names] of Object.entries(artifact.linkReferences ?? {}))
    for (const [library, slots] of Object.entries(names)) {
      const address = getAddress(links[`${source}:${library}`] ?? links[library]).slice(2).toLowerCase();
      for (const slot of slots) {
        need(slot.length === 20 && Number.isInteger(slot.start) && slot.start >= 0 && (slot.start + 20) * 2 <= bytes.length, '编译链接位置无效。');
        bytes = bytes.slice(0, slot.start * 2) + address + bytes.slice((slot.start + 20) * 2);
      }
    }
  need(/^[\da-f]+$/i.test(bytes) && bytes.length % 2 === 0, '编译链接尚未完成。');
  const factory = name === 'PoolVault' ? catalog.bindings.factory : name === 'BudgetPortfolioVault' ? catalog.bindings.portfolioFactory : null;
  return '0x' + bytes + (factory ? AbiCoder.defaultAbiCoder().encode(['address'], [factory]).slice(2) : '');
}

export function upgradeBatch(catalog, deployed) {
  for (const name of ORDER) getAddress(deployed[name]);
  const targets = [catalog.bindings.beacon, catalog.bindings.portfolioBeacon, catalog.bindings.shareMarket];
  const values = [0n, 0n, 0n];
  const payloads = [beacon.encodeFunctionData('upgradeTo', [deployed.PoolVault]),
    beacon.encodeFunctionData('upgradeTo', [deployed.BudgetPortfolioVault]),
    market.encodeFunctionData('upgradeToAndCall', [deployed.ShareMarket, '0x'])];
  const salt = upgradeSalt(catalog);
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]', 'uint256[]', 'bytes[]', 'bytes32', 'bytes32'], [targets, values, payloads, ZeroHash, salt]));
  return { targets, values, payloads, predecessor: ZeroHash, salt, operationId };
}

async function view(provider, to, iface, method, args = []) {
  const result = await provider.request({ method: 'eth_call', params: [{ to, data: iface.encodeFunctionData(method, args) }, 'latest'] });
  return iface.decodeFunctionResult(method, result)[0];
}

export async function readUpgradeStatus(provider, catalog, deployed = {}) {
  const [delay, role, pool, budget, slot] = await Promise.all([
    view(provider, catalog.bindings.timelock, timelock, 'getMinDelay'),
    view(provider, catalog.bindings.timelock, timelock, 'PROPOSER_ROLE'),
    view(provider, catalog.bindings.beacon, beacon, 'implementation'),
    view(provider, catalog.bindings.portfolioBeacon, beacon, 'implementation'),
    provider.request({ method: 'eth_getStorageAt', params: [catalog.bindings.shareMarket, SLOT, 'latest'] }),
  ]);
  need(delay >= BigInt(catalog.minimumDelaySeconds ?? (catalog.profile === 'formal' ? 172800 : 0)), '当前升级等待时间与本网站不一致。');
  need(/^0x0{24}[\da-f]{40}$/i.test(slot), '当前市场实现无效。');
  const current = { PoolVault: pool, BudgetPortfolioVault: budget, ShareMarket: getAddress('0x' + slot.slice(-40)) };
  const activated = ['PoolVault', 'BudgetPortfolioVault', 'ShareMarket'].every(name => deployed[name] && same(current[name], deployed[name]));
  const unchanged = ['PoolVault', 'BudgetPortfolioVault', 'ShareMarket'].every(name => same(current[name], catalog.expectedImplementations[name]));
  need(unchanged || activated, '当前合约已发生其他升级，暂停本次操作。');
  const proposer = await view(provider, catalog.bindings.timelock, timelock, 'hasRole', [role, catalog.bindings.proposer]);
  const batch = ORDER.every(name => deployed[name]) ? upgradeBatch(catalog, deployed) : null;
  const timestamp = batch ? await view(provider, catalog.bindings.timelock, timelock, 'getTimestamp', [batch.operationId]) : 0n;
  need(timestamp !== 1n || activated, '已执行升级的状态尚未同步，请稍后继续查询。');
  return { delay, proposer, current, activated, timestamp, batch };
}

/** Compare exact compiler runtime; constructor-bound Factory is checked separately. */
export async function verifyUpgradeDeploymentRuntime(provider, catalog, name, address, deployed = {}) {
  const artifact = catalog.artifacts[name];
  need(ORDER.includes(name) && artifact?.deployedBytecode, '缺少升级运行代码资料。');
  const ownAddress = getAddress(address);
  let actual = (await provider.request({ method: 'eth_getCode', params: [ownAddress, 'latest'] })).slice(2).toLowerCase();
  let expected = artifact.deployedBytecode.slice(2).toLowerCase();
  const links = { ...catalog.libraries, ...deployed };
  for (const names of Object.values(artifact.deployedLinkReferences ?? {})) for (const [library, slots] of Object.entries(names)) {
    const linked = getAddress(links[library]).slice(2).toLowerCase();
    for (const { start, length } of slots) {
      need(length === 20 && Number.isInteger(start) && start >= 0 && (start + length) * 2 <= expected.length,
        '升级运行代码链接位置无效。');
      expected = expected.slice(0, start * 2) + linked + expected.slice((start + length) * 2);
    }
  }
  if (name === 'SaleGovernance') {
    need(expected.startsWith('73'), '出售规则运行代码无效。');
    expected = expected.slice(0, 2) + ownAddress.slice(2).toLowerCase() + expected.slice(42);
  }
  for (const slots of Object.values(artifact.immutableReferences ?? {})) for (const { start, length } of slots) {
    need(Number.isInteger(start) && start >= 0 && Number.isInteger(length) && length > 0
      && (start + length) * 2 <= expected.length, '升级构造绑定位置无效。');
    expected = expected.slice(0, start * 2) + '0'.repeat(length * 2) + expected.slice((start + length) * 2);
    actual = actual.slice(0, start * 2) + '0'.repeat(length * 2) + actual.slice((start + length) * 2);
  }
  need(actual.length > 0 && actual === expected, `${name} 链上运行代码与本次编译不一致。`);
  if (name === 'PoolVault' || name === 'BudgetPortfolioVault') {
    const factory = name === 'PoolVault' ? catalog.bindings.factory : catalog.bindings.portfolioFactory;
    const binding = await view(provider, ownAddress, new Interface(['function OFFICIAL_FACTORY() view returns(address)']), 'OFFICIAL_FACTORY');
    need(same(binding, factory), '升级合约的工厂绑定不一致。');
  }
  return ownAddress;
}

/** Saved addresses/statuses are hints only. Rebuild addresses from confirmed exact deployment transactions. */
export async function reconcileUpgradeDeployments(provider, catalog, steps, from,
  { current = () => true, retryStep = null, onChecking = () => {}, onConfirmed = () => {}, ...options } = {}) {
  const deployed = {};
  for (const name of ORDER) {
    need(current(), '钱包或页面已变化，升级进度已保存。');
    const step = steps?.[name];
    if (!step || step.status === 'rejected' && !step.hash) break;
    if (!step.hash) {
      need(step.status !== 'unknown' && step.status !== 'awaiting-wallet',
        `请先填写${name}在钱包中的交易哈希，核对后继续；不能重复发送未知交易。`);
      break;
    }
    onChecking(name);
    const data = upgradeDeployment(catalog, name, deployed);
    let receipt;
    try { receipt = await confirmUpgradeTransaction(provider, step, { from, data }, { ...options, current }); }
    catch (error) {
      error.stepName = name;
      if (error.confirmedFailure && retryStep === name) return { deployed, retryName: name };
      throw error;
    }
    need(current(), '钱包或页面已变化，升级进度已保存。');
    deployed[name] = await verifyUpgradeDeploymentRuntime(provider, catalog, name, receipt.contractAddress, deployed);
    need(current(), '钱包或页面已变化，升级进度已保存。');
    onConfirmed(name, { ...step, status: 'confirmed', address: deployed[name], blockNumber: receipt.blockNumber });
  }
  return { deployed, retryName: null };
}

export async function readUpgradeWrapperRuntime(provider) {
  const fixed = [['managerCode', FRESH_DELEGATION_MANAGER], ['delegatorCode', FRESH_DELEGATOR], ['enforcerCode', FRESH_BALANCE_ENFORCER]];
  return Object.fromEntries(await Promise.all(fixed.map(async ([name, contract]) =>
    [name, await provider.request({ method: 'eth_getCode', params: [contract.address, 'latest'] })])));
}

/** A wallet wrapper is accepted only when the fixed Timelock emitted this complete, exact batch. */
export function verifyUpgradeBatchReceipt(receipt, to, { kind, batch, delay }) {
  need(['schedule', 'execute'].includes(kind) && Array.isArray(receipt.logs), '升级批次回执不完整。');
  need(batch.targets.length === 3 && batch.values.length === 3 && batch.payloads.length === 3, '升级批次无效。');
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]', 'uint256[]', 'bytes[]', 'bytes32', 'bytes32'],
    [batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt]));
  need(same(operationId, batch.operationId), '升级批次编号不一致。');
  const topics = ['CallScheduled', 'CallExecuted', 'CallSalt'].map(name => timelock.getEvent(name).topicHash.toLowerCase());
  const logs = receipt.logs.filter(log => same(log.address, to) && topics.includes(log.topics?.[0]?.toLowerCase()));
  const expected = batch.targets.map((target, index) => timelock.encodeEventLog(
    timelock.getEvent(kind === 'schedule' ? 'CallScheduled' : 'CallExecuted'),
    kind === 'schedule' ? [operationId, index, target, batch.values[index], batch.payloads[index], batch.predecessor, delay]
      : [operationId, index, target, batch.values[index], batch.payloads[index]]));
  if (kind === 'schedule') expected.push(timelock.encodeEventLog(timelock.getEvent('CallSalt'), [operationId, batch.salt]));
  need(logs.length === expected.length && logs.every(log => log.removed !== true
    && same(log.transactionHash, receipt.transactionHash ?? receipt.hash) && same(log.blockHash, receipt.blockHash)
    && BigInt(log.blockNumber) === BigInt(receipt.blockNumber))
    && expected.every(event => logs.some(log => log.topics.length === event.topics.length
      && log.topics.every((topic, index) => same(topic, event.topics[index])) && same(log.data, event.data))),
  '链上升级批次事件与本次升级不一致。');
  return operationId;
}

/** A saved hash is reconciled; it is never submitted again when a receipt is late. */
export async function confirmUpgradeTransaction(provider, step, { from, to = null, data, batchProof }, { now = Date.now, timeoutMs = 120_000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), current = () => true, runtimeProof } = {}) {
  need(HASH.test(step.hash), '交易回执尚未明确，请在钱包中核对，不能重复提交。');
  const deadline = now() + timeoutMs;
  while (current()) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [step.hash] });
    if (receipt) {
      const tx = await provider.request({ method: 'eth_getTransactionByHash', params: [step.hash] });
      if (batchProof) {
        need(to && same(tx?.hash, step.hash), '交易内容与本次升级不一致。');
        const expectedData = batchProof.kind === 'schedule'
          ? timelock.encodeFunctionData('scheduleBatch', [batchProof.batch.targets, batchProof.batch.values,
            batchProof.batch.payloads, batchProof.batch.predecessor, batchProof.batch.salt, batchProof.delay])
          : timelock.encodeFunctionData('executeBatch', [batchProof.batch.targets, batchProof.batch.values,
            batchProof.batch.payloads, batchProof.batch.predecessor, batchProof.batch.salt]);
        need(same(expectedData, data), '升级批次内容不一致。');
        const proof = same(tx.to, to) ? undefined : typeof runtimeProof === 'function' ? await runtimeProof()
          : runtimeProof ?? await readUpgradeWrapperRuntime(provider);
        decodeFreshSingleCallEnvelope({ account: from, target: to, data,
          tx: { ...tx, data: tx.input ?? tx.data, type: tx.type == null ? null : Number(BigInt(tx.type)) },
          receipt: { ...receipt, status: Number(BigInt(receipt.status)) }, runtimeProof: proof });
      } else {
        need(tx && same(tx.from, from) && (to ? same(tx.to, to) : tx.to === null)
          && same(tx.input ?? tx.data, data) && BigInt(tx.value) === 0n && tx.chainId != null && BigInt(tx.chainId) === 56n,
        '交易内容与本次升级不一致。');
      }
      need(current(), '钱包或页面已变化，升级进度已保存。');
      if (BigInt(receipt.status) !== 1n) {
        const failure = new Error('升级交易已确认失败；可明确重试这一步。');
        failure.confirmedFailure = true; failure.hash = step.hash; throw failure;
      }
      if (batchProof) verifyUpgradeBatchReceipt(receipt, to, batchProof);
      if (!to) getAddress(receipt.contractAddress);
      return receipt;
    }
    need(now() < deadline, '交易尚未确认；稍后点击继续会查询同一笔交易。');
    await pause(3_000);
  }
  throw new Error('钱包或页面已变化，升级进度已保存。');
}

export async function submitUpgradeTransaction(provider, account, transaction, persist, { current = () => true } = {}) {
  const [chain, accounts] = await Promise.all([provider.request({ method: 'eth_chainId' }), provider.request({ method: 'eth_accounts' })]);
  need(current() && BigInt(chain) === 56n && accounts?.some(value => same(value, account)), '请连接指定部署钱包和 BNB 主网。');
  const step = { status: 'awaiting-wallet', dataHash: keccak256(transaction.data), hash: null };
  persist(step);
  try {
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...transaction, from: getAddress(account), value: toQuantity(0n), chainId: toQuantity(56n) }] });
    need(HASH.test(hash), '钱包没有返回明确交易哈希。');
    step.hash = hash; step.status = 'submitted'; persist(step); return step;
  } catch (error) {
    const codes = [error?.code, error?.info?.error?.code, error?.error?.code, error?.data?.originalError?.code];
    if (codes.some(code => Number(code) === 4001 || code === 'ACTION_REJECTED')) { step.status = 'rejected'; persist(step); }
    else { step.status = 'unknown'; persist(step); }
    throw error;
  }
}

export function scheduleUpgradeTransaction(catalog, batch, delay) {
  return { to: catalog.bindings.timelock, data: timelock.encodeFunctionData('scheduleBatch', [batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, delay]) };
}
export function executeUpgradeTransaction(catalog, batch) {
  return { to: catalog.bindings.timelock, data: timelock.encodeFunctionData('executeBatch', [batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt]) };
}
