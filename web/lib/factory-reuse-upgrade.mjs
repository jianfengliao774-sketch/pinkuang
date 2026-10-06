import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { confirmNativeUpgradeTransaction, executeNativeUpgradeTransaction, scheduleNativeUpgradeTransaction }
  from './native-sale-upgrade.mjs';
import { readUpgradeWrapperRuntime, submitUpgradeTransaction } from './sale-policy-upgrade.mjs';

export { readUpgradeWrapperRuntime, submitUpgradeTransaction };
export const FACTORY_REUSE_UPGRADE_KIND = 'fresh-sold-machine-reuse-upgrade-v1';
export const FACTORY_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const factoryReuseDeploymentOrder = Object.freeze(['FreshPoolFactory']);
const HASH = /^0x[\da-f]{64}$/i;
const BYTES = /^0x(?:[\da-f]{2})+$/i;
const need = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const factory = new Interface(['function upgradeToAndCall(address,bytes)', 'function proxiableUUID() view returns(bytes32)',
  'function soldMachineReuseVersion() pure returns(uint8)', 'function timelock() view returns(address)', 'function owner() view returns(address)']);
const timelock = new Interface(['function getMinDelay() view returns(uint256)', 'function PROPOSER_ROLE() view returns(bytes32)',
  'function hasRole(bytes32,address) view returns(bool)', 'function getTimestamp(bytes32) view returns(uint256)']);
function address(value, name) {
  const normalized = getAddress(value); need(normalized !== ZeroAddress, `工厂升级地址无效：${name}。`); return normalized;
}
function delaySeconds(value) {
  need(typeof value === 'string' && /^(?:0|[1-9]\d{0,77})$/.test(value), '工厂升级等待时间无效。');
  const result = BigInt(value); need(result < 1n << 256n, '工厂升级等待时间无效。'); return result;
}
function immutableSlots(artifact) {
  const slots = Object.values(artifact.immutableReferences ?? {}).flat();
  need(slots.length > 0 && slots.every(({ start, length }) => Number.isSafeInteger(start) && start >= 0
    && length === 32 && (start + length) * 2 <= artifact.deployedBytecode.length - 2), '缺少工厂 UUPS 构造绑定资料。');
  return slots;
}

export function validateFactoryReuseCatalog(catalog, { profile } = {}) {
  need(catalog?.schemaVersion === 1 && catalog.kind === FACTORY_REUSE_UPGRADE_KIND && catalog.chainId === 56
    && ['formal', 'full-test'].includes(catalog.profile) && (!profile || catalog.profile === profile), '工厂升级资料与当前网站不一致。');
  need(HASH.test(catalog.genesisArtifactDigest) && HASH.test(catalog.candidateArtifactDigest), '工厂升级编译资料无效。');
  for (const name of ['factory', 'timelock', 'proposer']) address(catalog.bindings?.[name], name);
  need(new Set(['factory', 'timelock', 'proposer'].map(name => catalog.bindings[name].toLowerCase())).size === 3, '工厂升级地址不能重复。');
  address(catalog.expectedImplementations?.FreshPoolFactory, '当前工厂实现');
  const delay = delaySeconds(catalog.minimumDelaySeconds);
  need(catalog.profile === 'formal' ? delay >= 172800n : delay === 0n, '工厂升级等待时间与当前网站不一致。');
  need(catalog.artifacts && Object.keys(catalog.artifacts).join(',') === 'FreshPoolFactory', '本次只允许升级工厂。');
  const artifact = catalog.artifacts.FreshPoolFactory;
  need(artifact.contractName === 'FreshPoolFactory' && BYTES.test(artifact.bytecode) && BYTES.test(artifact.deployedBytecode)
    && artifact.deployedBytecode.length <= 24576 * 2 + 2 && Array.isArray(artifact.abi), '缺少独立工厂升级编译资料。');
  need(Object.keys(artifact.linkReferences ?? {}).length === 0 && Object.keys(artifact.deployedLinkReferences ?? {}).length === 0,
    '工厂升级不能修改外部库。');
  const iface = new Interface(artifact.abi);
  need(iface.deploy.inputs.length === 0 && iface.getFunction('soldMachineReuseVersion()') && iface.getFunction('proxiableUUID()'),
    '工厂升级构造参数或版本接口无效。');
  immutableSlots(artifact);
  if (catalog.salt != null) need(same(catalog.salt, factoryReuseSalt(catalog)), '工厂升级盐值不一致。');
  return catalog;
}

export function factoryReuseSalt(catalog) {
  return keccak256(toUtf8Bytes(`bemine.sold-machine-reuse.v1:${catalog.bindings.factory.toLowerCase()}:${catalog.candidateArtifactDigest.toLowerCase()}`));
}
export function factoryReuseProgressKey(catalog, account) {
  return `bemine.sold-machine-reuse.v1:${catalog.profile}:${catalog.bindings.factory.toLowerCase()}:${catalog.candidateArtifactDigest.toLowerCase()}:${getAddress(account).toLowerCase()}`;
}
export function factoryReuseDeployment(catalog, name = 'FreshPoolFactory') {
  need(name === 'FreshPoolFactory', '本次只允许部署工厂实现。');
  validateFactoryReuseCatalog(catalog); return catalog.artifacts.FreshPoolFactory.bytecode;
}
export function factoryReuseBatch(catalog, deployed) {
  const replacement = address(deployed.FreshPoolFactory, '新工厂实现');
  need(!['factory', 'timelock', 'proposer'].some(name => same(replacement, catalog.bindings[name]))
    && !same(replacement, catalog.expectedImplementations.FreshPoolFactory), '新工厂实现不能复用当前地址。');
  const targets = [catalog.bindings.factory], values = [0n], predecessor = ZeroHash, salt = factoryReuseSalt(catalog);
  const payloads = [factory.encodeFunctionData('upgradeToAndCall', [replacement, '0x'])];
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]', 'uint256[]', 'bytes[]', 'bytes32', 'bytes32'], [targets, values, payloads, predecessor, salt]));
  return { targets, values, payloads, predecessor, salt, operationId };
}
async function view(provider, to, iface, method, args = [], tag = 'latest') {
  return iface.decodeFunctionResult(method, await provider.request({ method: 'eth_call',
    params: [{ to, data: iface.encodeFunctionData(method, args) }, tag] }))[0];
}

export async function verifyFactoryReuseDeploymentRuntime(provider, catalog, name, deployedAddress) {
  need(name === 'FreshPoolFactory', '本次只允许升级工厂。');
  const replacement = address(deployedAddress, '新工厂实现'), artifact = catalog.artifacts.FreshPoolFactory;
  let expected = artifact.deployedBytecode.slice(2).toLowerCase();
  for (const { start, length } of immutableSlots(artifact)) {
    expected = expected.slice(0, start * 2) + replacement.slice(2).toLowerCase().padStart(length * 2, '0')
      + expected.slice((start + length) * 2);
  }
  const [code, uuid, version] = await Promise.all([
    provider.request({ method: 'eth_getCode', params: [replacement, 'latest'] }),
    view(provider, replacement, factory, 'proxiableUUID'), view(provider, replacement, factory, 'soldMachineReuseVersion'),
  ]);
  need(code.slice(2).toLowerCase() === expected, '工厂链上运行代码与本次编译不一致。');
  need(same(uuid, FACTORY_IMPLEMENTATION_SLOT) && version === 1n, '工厂实现的 UUPS 类型或版本不一致。');
  return replacement;
}

export async function readFactoryReuseStatus(provider, catalog, deployed = {}) {
  const block = await provider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
  need(HASH.test(block?.hash) && /^0x[\da-f]+$/i.test(block?.number), '工厂升级状态暂不可读。');
  const tag = block.number;
  const [delay, role, raw, owner, boundTimelock] = await Promise.all([
    view(provider, catalog.bindings.timelock, timelock, 'getMinDelay', [], tag),
    view(provider, catalog.bindings.timelock, timelock, 'PROPOSER_ROLE', [], tag),
    provider.request({ method: 'eth_getStorageAt', params: [catalog.bindings.factory, FACTORY_IMPLEMENTATION_SLOT, tag] }),
    view(provider, catalog.bindings.factory, factory, 'owner', [], tag), view(provider, catalog.bindings.factory, factory, 'timelock', [], tag),
  ]);
  need(delay >= delaySeconds(catalog.minimumDelaySeconds), '当前工厂升级等待时间与本网站不一致。');
  need(same(owner, catalog.bindings.timelock) && same(boundTimelock, catalog.bindings.timelock), '当前工厂升级权限与本网站不一致。');
  need(/^0x0{24}[\da-f]{40}$/i.test(raw), '当前工厂实现地址无效。');
  const implementation = getAddress('0x' + raw.slice(-40));
  const activated = !!deployed.FreshPoolFactory && same(implementation, deployed.FreshPoolFactory);
  need(same(implementation, catalog.expectedImplementations.FreshPoolFactory) || activated, '当前工厂已发生其他升级，暂停本次操作。');
  const batch = deployed.FreshPoolFactory ? factoryReuseBatch(catalog, deployed) : null;
  const [proposer, timestamp] = await Promise.all([
    view(provider, catalog.bindings.timelock, timelock, 'hasRole', [role, catalog.bindings.proposer], tag),
    batch ? view(provider, catalog.bindings.timelock, timelock, 'getTimestamp', [batch.operationId], tag) : 0n,
  ]);
  need(timestamp !== 1n || activated, '工厂升级执行状态尚未同步，请稍后继续查询。');
  if (activated) {
    need(timestamp === 1n && await view(provider, catalog.bindings.factory, factory, 'soldMachineReuseVersion', [], tag) === 1n,
      '工厂复用功能或升级批次尚未启用。');
    await verifyFactoryReuseDeploymentRuntime(provider, catalog, 'FreshPoolFactory', implementation);
  }
  const canonical = await provider.request({ method: 'eth_getBlockByNumber', params: [tag, false] });
  need(same(canonical?.hash, block.hash), '工厂升级状态正在变化，请稍后继续。');
  return { delay, proposer, current: { FreshPoolFactory: implementation }, activated, timestamp, batch };
}

export const confirmFactoryReuseTransaction = confirmNativeUpgradeTransaction;
export const scheduleFactoryReuseTransaction = scheduleNativeUpgradeTransaction;
export const executeFactoryReuseTransaction = executeNativeUpgradeTransaction;

export async function reconcileFactoryReuseDeployment(provider, catalog, steps, from,
  { current = () => true, retryStep = null, onChecking = () => {}, onConfirmed = () => {}, ...options } = {}) {
  const name = 'FreshPoolFactory', step = steps?.[name];
  need(current(), '钱包或页面已变化，工厂升级进度已保存。');
  if (!step || step.status === 'rejected' && !step.hash) return { deployed: {}, retryName: null };
  need(step.hash || !['unknown', 'awaiting-wallet'].includes(step.status), '请先填写工厂实现的交易哈希；不能重复发送未知交易。');
  if (!step.hash) return { deployed: {}, retryName: null };
  onChecking(name);
  let receipt;
  try { receipt = await confirmFactoryReuseTransaction(provider, step, { from, data: factoryReuseDeployment(catalog) }, { ...options, current }); }
  catch (error) { error.stepName = name;
    if (error.confirmedFailure && retryStep === name) return { deployed: {}, retryName: name }; throw error; }
  need(current(), '钱包或页面已变化，工厂升级进度已保存。');
  const replacement = await verifyFactoryReuseDeploymentRuntime(provider, catalog, name, receipt.contractAddress);
  need(current(), '钱包或页面已变化，工厂升级进度已保存。');
  onConfirmed(name, { ...step, status: 'confirmed', address: replacement, blockNumber: receipt.blockNumber });
  return { deployed: { FreshPoolFactory: replacement }, retryName: null };
}
