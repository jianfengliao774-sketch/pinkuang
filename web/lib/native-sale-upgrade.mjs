import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { decodeFreshSingleCallEnvelope } from '../../deploy/shared/fresh-activation-execution.mjs';
import { readUpgradeWrapperRuntime, submitUpgradeTransaction } from './sale-policy-upgrade.mjs';

export { readUpgradeWrapperRuntime, submitUpgradeTransaction };
export const nativeUpgradeDeploymentOrder = Object.freeze(['SaleSettlement', 'FirstoSale', 'PoolVault']);
const ORDER = nativeUpgradeDeploymentOrder;
const HASH = /^0x[\da-f]{64}$/i;
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
const native = new Interface(['function nativeFirstoSaleVersion() pure returns(uint8)',
  'function enableNativeFirstoSale(uint256 proposalId,uint256 price,uint16 feeBps,uint256 feeEpoch)']);

function address(value, name) {
  const result = getAddress(value); need(result !== ZeroAddress, `原生升级地址无效：${name}。`); return result;
}
function uint(value, bits, name, positive = false) {
  need(typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value)
    || typeof value === 'string' && /^(?:0|[1-9]\d{0,77})$/.test(value), `原生升级参数无效：${name}。`);
  const result = BigInt(value);
  need(result >= (positive ? 1n : 0n) && result < (1n << BigInt(bits)), `原生升级参数无效：${name}。`);
  return result;
}
function activation(catalog) {
  if (catalog.activation == null) return null;
  need(catalog.profile === 'full-test' && typeof catalog.activation === 'object' && !Array.isArray(catalog.activation),
    '正式版升级不能附带测试矿机挂牌。');
  const value = catalog.activation;
  return { pool: address(value.pool, '挂牌矿池'), proposalId: uint(value.proposalId, 256, '提案编号', true),
    priceWei: uint(value.priceWei, 128, '整机价格', true), feeBps: uint(value.feeBps, 16, 'Firsto 手续费'),
    feeEpoch: uint(value.feeEpoch, 256, 'Firsto 费率版本', true) };
}

export function validateNativeUpgradeCatalog(catalog, { profile } = {}) {
  need(catalog?.schemaVersion === 1 && catalog.kind === 'fresh-native-firsto-sale-upgrade-v1'
    && catalog.chainId === 56 && ['formal', 'full-test'].includes(catalog.profile)
    && (!profile || profile === catalog.profile), '原生升级资料与当前网站不一致。');
  need(HASH.test(catalog.genesisArtifactDigest) && HASH.test(catalog.candidateArtifactDigest), '原生升级编译资料无效。');
  for (const name of ['factory', 'beacon', 'timelock', 'proposer']) address(catalog.bindings?.[name], name);
  address(catalog.expectedImplementations?.PoolVault, '当前矿池实现');
  const delay = uint(catalog.minimumDelaySeconds, 256, '升级等待时间');
  need(catalog.profile === 'formal' ? delay >= 172800n : delay === 0n, '原生升级等待时间与当前网站不一致。');
  for (const name of ORDER) {
    const artifact = catalog.artifacts?.[name];
    need(artifact?.bytecode?.startsWith('0x') && artifact.bytecode.length > 2
      && artifact?.deployedBytecode?.startsWith('0x') && artifact.deployedBytecode.length > 2
      && Array.isArray(artifact.abi), `缺少 ${name} 原生升级编译资料。`);
  }
  const expected = activation(catalog);
  if (expected) need(expected.feeBps <= 200n && !['beacon', 'timelock', 'factory'].some(name => same(expected.pool, catalog.bindings[name])),
    '测试挂牌参数无效。');
  if (catalog.salt != null) need(same(catalog.salt, nativeUpgradeSalt(catalog)), '原生升级盐值不一致。');
  return catalog;
}

export function nativeUpgradeSalt(catalog) {
  return keccak256(toUtf8Bytes(`bemine.native-firsto.v1:${catalog.bindings.factory.toLowerCase()}:${catalog.candidateArtifactDigest.toLowerCase()}`));
}

export function nativeUpgradeProgressKey(catalog, account) {
  return `bemine.native-firsto.v1:${catalog.profile}:${catalog.bindings.factory.toLowerCase()}:${catalog.candidateArtifactDigest.toLowerCase()}:${getAddress(account).toLowerCase()}`;
}

function linkedAddress(catalog, deployed, source, library) {
  if (ORDER.includes(library)) return address(deployed[library], library);
  const named = catalog.libraries?.[library], qualified = catalog.libraries?.[`${source}:${library}`];
  if (named && qualified) need(same(named, qualified), '原生升级库地址冲突。');
  return address(qualified ?? named, library);
}
function linkBytes(bytes, references, catalog, deployed) {
  for (const [source, names] of Object.entries(references ?? {})) for (const [library, slots] of Object.entries(names)) {
    const linked = linkedAddress(catalog, deployed, source, library).slice(2).toLowerCase();
    for (const { start, length } of slots) {
      need(length === 20 && Number.isInteger(start) && start >= 0 && (start + 20) * 2 <= bytes.length, '原生升级编译链接位置无效。');
      bytes = bytes.slice(0, start * 2) + linked + bytes.slice((start + 20) * 2);
    }
  }
  return bytes;
}

export function nativeUpgradeDeployment(catalog, name, deployed = {}) {
  const position = ORDER.indexOf(name); need(position >= 0, '原生升级步骤无效。');
  for (const dependency of ORDER.slice(0, position)) need(deployed[dependency], `请先确认本次 ${dependency} 合约。`);
  const artifact = catalog.artifacts[name];
  const bytes = linkBytes(artifact.bytecode.slice(2), artifact.linkReferences, catalog, deployed);
  need(/^[\da-f]+$/i.test(bytes) && bytes.length % 2 === 0, '原生升级编译链接尚未完成。');
  return '0x' + bytes + (name === 'PoolVault' ? AbiCoder.defaultAbiCoder().encode(['address'], [catalog.bindings.factory]).slice(2) : '');
}

export function nativeUpgradeBatch(catalog, deployed) {
  for (const name of ORDER) address(deployed[name], name);
  const targets = [catalog.bindings.beacon], values = [0n];
  const payloads = [beacon.encodeFunctionData('upgradeTo', [deployed.PoolVault])];
  const expected = activation(catalog);
  if (expected) {
    targets.push(expected.pool); values.push(0n);
    payloads.push(native.encodeFunctionData('enableNativeFirstoSale',
      [expected.proposalId, expected.priceWei, expected.feeBps, expected.feeEpoch]));
  }
  const salt = nativeUpgradeSalt(catalog);
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]', 'uint256[]', 'bytes[]', 'bytes32', 'bytes32'], [targets, values, payloads, ZeroHash, salt]));
  return { targets, values, payloads, predecessor: ZeroHash, salt, operationId };
}

async function view(provider, to, iface, method, args = []) {
  const result = await provider.request({ method: 'eth_call', params: [{ to, data: iface.encodeFunctionData(method, args) }, 'latest'] });
  return iface.decodeFunctionResult(method, result)[0];
}

export async function readNativeUpgradeStatus(provider, catalog, deployed = {}) {
  const [delay, role, implementation] = await Promise.all([
    view(provider, catalog.bindings.timelock, timelock, 'getMinDelay'),
    view(provider, catalog.bindings.timelock, timelock, 'PROPOSER_ROLE'),
    view(provider, catalog.bindings.beacon, beacon, 'implementation'),
  ]);
  need(delay >= BigInt(catalog.minimumDelaySeconds), '当前升级等待时间与本网站不一致。');
  const activated = !!deployed.PoolVault && same(implementation, deployed.PoolVault);
  need(same(implementation, catalog.expectedImplementations.PoolVault) || activated,
    '当前矿池合约已发生其他升级，暂停本次操作。');
  const proposer = await view(provider, catalog.bindings.timelock, timelock, 'hasRole', [role, catalog.bindings.proposer]);
  const batch = ORDER.every(name => deployed[name]) ? nativeUpgradeBatch(catalog, deployed) : null;
  const timestamp = batch ? await view(provider, catalog.bindings.timelock, timelock, 'getTimestamp', [batch.operationId]) : 0n;
  need(timestamp !== 1n || activated, '原生升级执行状态尚未同步，请稍后继续查询。');
  if (activated) need(await view(provider, implementation, native, 'nativeFirstoSaleVersion') === 1n, '原生出售能力尚未启用。');
  return { delay, proposer, current: { PoolVault: implementation }, activated, timestamp, batch };
}

export async function verifyNativeUpgradeDeploymentRuntime(provider, catalog, name, deployedAddress, deployed = {}) {
  need(ORDER.includes(name) && catalog.artifacts[name]?.deployedBytecode, '缺少原生升级运行代码资料。');
  const artifact = catalog.artifacts[name], ownAddress = address(deployedAddress, name);
  let actual = (await provider.request({ method: 'eth_getCode', params: [ownAddress, 'latest'] })).slice(2).toLowerCase();
  let expected = linkBytes(artifact.deployedBytecode.slice(2).toLowerCase(), artifact.deployedLinkReferences, catalog, deployed);
  if (name === 'SaleSettlement' || name === 'FirstoSale') {
    need(expected.startsWith('73') && expected.length >= 42, '原生出售库运行代码无效。');
    expected = expected.slice(0, 2) + ownAddress.slice(2).toLowerCase() + expected.slice(42);
  }
  for (const slots of Object.values(artifact.immutableReferences ?? {})) for (const { start, length } of slots) {
    need(name === 'PoolVault' && Number.isInteger(start) && start >= 0 && Number.isInteger(length)
      && length > 0 && (start + length) * 2 <= expected.length, '原生升级构造绑定位置无效。');
    expected = expected.slice(0, start * 2) + '0'.repeat(length * 2) + expected.slice((start + length) * 2);
    actual = actual.slice(0, start * 2) + '0'.repeat(length * 2) + actual.slice((start + length) * 2);
  }
  need(actual.length > 0 && actual === expected, `${name} 链上运行代码与本次编译不一致。`);
  if (name === 'PoolVault') {
    const binding = await view(provider, ownAddress, new Interface(['function OFFICIAL_FACTORY() view returns(address)']), 'OFFICIAL_FACTORY');
    need(same(binding, catalog.bindings.factory), '原生升级合约的工厂绑定不一致。');
  }
  return ownAddress;
}

export async function reconcileNativeUpgradeDeployments(provider, catalog, steps, from,
  { current = () => true, retryStep = null, onChecking = () => {}, onConfirmed = () => {}, ...options } = {}) {
  const deployed = {};
  for (const name of ORDER) {
    need(current(), '钱包或页面已变化，升级进度已保存。');
    const step = steps?.[name];
    if (!step || step.status === 'rejected' && !step.hash) break;
    if (!step.hash) {
      need(step.status !== 'unknown' && step.status !== 'awaiting-wallet',
        `请先填写 ${name} 在钱包中的交易哈希；不能重复发送未知交易。`); break;
    }
    onChecking(name);
    let receipt;
    try { receipt = await confirmNativeUpgradeTransaction(provider, step,
      { from, data: nativeUpgradeDeployment(catalog, name, deployed) }, { ...options, current }); }
    catch (error) { error.stepName = name;
      if (error.confirmedFailure && retryStep === name) return { deployed, retryName: name }; throw error; }
    need(current(), '钱包或页面已变化，升级进度已保存。');
    deployed[name] = await verifyNativeUpgradeDeploymentRuntime(provider, catalog, name, receipt.contractAddress, deployed);
    need(current(), '钱包或页面已变化，升级进度已保存。');
    onConfirmed(name, { ...step, status: 'confirmed', address: deployed[name], blockNumber: receipt.blockNumber });
  }
  return { deployed, retryName: null };
}

export function verifyNativeUpgradeBatchReceipt(receipt, to, { kind, batch, delay }) {
  need(['schedule', 'execute'].includes(kind) && Array.isArray(receipt.logs), '原生升级批次回执不完整。');
  need([1, 2].includes(batch.targets.length) && batch.values.length === batch.targets.length
    && batch.payloads.length === batch.targets.length && batch.values.every(value => BigInt(value) === 0n), '原生升级批次无效。');
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]', 'uint256[]', 'bytes[]', 'bytes32', 'bytes32'],
    [batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt]));
  need(same(operationId, batch.operationId), '原生升级批次编号不一致。');
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
  '链上原生升级批次事件与本次升级不一致。');
  return operationId;
}

export async function confirmNativeUpgradeTransaction(provider, step, { from, to = null, data, batchProof },
  { now = Date.now, timeoutMs = 120_000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), current = () => true, runtimeProof } = {}) {
  need(HASH.test(step.hash), '交易回执尚未明确，请在钱包中核对，不能重复提交。');
  const deadline = now() + timeoutMs;
  while (current()) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [step.hash] });
    if (receipt) {
      const tx = await provider.request({ method: 'eth_getTransactionByHash', params: [step.hash] });
      if (batchProof) {
        need(to && same(tx?.hash, step.hash), '交易内容与本次原生升级不一致。');
        const expectedData = batchProof.kind === 'schedule'
          ? timelock.encodeFunctionData('scheduleBatch', [batchProof.batch.targets, batchProof.batch.values,
            batchProof.batch.payloads, batchProof.batch.predecessor, batchProof.batch.salt, batchProof.delay])
          : timelock.encodeFunctionData('executeBatch', [batchProof.batch.targets, batchProof.batch.values,
            batchProof.batch.payloads, batchProof.batch.predecessor, batchProof.batch.salt]);
        need(same(expectedData, data), '原生升级批次内容不一致。');
        const proof = same(tx.to, to) ? undefined : typeof runtimeProof === 'function' ? await runtimeProof()
          : runtimeProof ?? await readUpgradeWrapperRuntime(provider);
        decodeFreshSingleCallEnvelope({ account: from, target: to, data,
          tx: { ...tx, data: tx.input ?? tx.data, type: tx.type == null ? null : Number(BigInt(tx.type)) },
          receipt: { ...receipt, status: Number(BigInt(receipt.status)) }, runtimeProof: proof });
      } else {
        need(tx && same(tx.hash, step.hash) && same(receipt.transactionHash ?? receipt.hash, step.hash)
          && same(receipt.from, tx.from) && (tx.to == null ? receipt.to == null : same(receipt.to, tx.to))
          && HASH.test(receipt.blockHash) && same(receipt.blockHash, tx.blockHash)
          && BigInt(receipt.blockNumber) > 0n && BigInt(receipt.blockNumber) === BigInt(tx.blockNumber)
          && same(tx.from, from) && (to ? same(tx.to, to) : tx.to === null)
          && same(tx.input ?? tx.data, data) && BigInt(tx.value) === 0n && tx.chainId != null && BigInt(tx.chainId) === 56n,
        '交易内容与本次原生升级不一致。');
      }
      need(current(), '钱包或页面已变化，升级进度已保存。');
      if (BigInt(receipt.status) !== 1n) {
        const failure = new Error('原生升级交易已确认失败；可明确重试这一步。');
        failure.confirmedFailure = true; failure.hash = step.hash; throw failure;
      }
      if (batchProof) verifyNativeUpgradeBatchReceipt(receipt, to, batchProof);
      if (!to) address(receipt.contractAddress, '部署回执');
      return receipt;
    }
    need(now() < deadline, '交易尚未确认；稍后点击继续会查询同一笔交易。'); await pause(3_000);
  }
  throw new Error('钱包或页面已变化，升级进度已保存。');
}

export function scheduleNativeUpgradeTransaction(catalog, batch, delay) {
  return { to: catalog.bindings.timelock, data: timelock.encodeFunctionData('scheduleBatch',
    [batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, delay]) };
}
export function executeNativeUpgradeTransaction(catalog, batch) {
  return { to: catalog.bindings.timelock, data: timelock.encodeFunctionData('executeBatch',
    [batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt]) };
}
