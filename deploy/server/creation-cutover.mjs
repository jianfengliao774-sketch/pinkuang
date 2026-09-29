import { Interface, ZeroAddress, getAddress } from 'ethers';

const abi = new Interface(['function poolCount() view returns(uint256)', 'function creationPaused() view returns(bool)']);
const creationActions = { factory: new Set(['createPool', 'createFlexiblePoolChecked', 'createBudgetChildPool']),
  portfolioFactory: new Set(['createPortfolio']) };

export function legacyFactoryConfiguration(value) {
  if (value === undefined) return undefined;
  try {
    const address = getAddress(value);
    if (address !== ZeroAddress) return address;
  } catch { /* Invalid explicit configuration must not disable the guard. */ }
  throw new Error('BEMINE_LEGACY_FACTORY must be an explicit nonzero contract address.');
}

/** Creation-only cutover guard. The caller verifies chain and block canonicality
 * around this read and still performs its normal simulation/nonce/signing checks. */
export async function verifyCreationCutover(provider, record, decoded, block, legacyFactory, fail,
  { freshGraphVerified = false } = {}) {
  // A verified independent fresh graph has no migration relationship with an
  // older Factory. This guard is only for the legacy upgrade path.
  if (freshGraphVerified) return;
  if (legacyFactory === undefined || !creationActions[record.targetType]?.has(decoded.name)) return;
  const old = legacyFactoryConfiguration(legacyFactory);
  if (getAddress(record.factory) === old) fail(409, '旧项目仍在迁移中，暂不能创建新项目。');
  const tag = `0x${block.number.toString(16)}`;
  let count, paused;
  try {
    if (await provider.getCode(old, block.number) === '0x') throw new Error('Legacy Factory code unavailable');
    const results = await Promise.allSettled(['poolCount', 'creationPaused'].map(async method =>
      abi.decodeFunctionResult(method, await provider.send('eth_call', [
        { to: old, data: abi.encodeFunctionData(method) }, tag]))[0]));
    if (results.some(result => result.status !== 'fulfilled')) throw new Error('Legacy Factory read failed');
    [count, paused] = results.map(result => result.value);
  } catch { fail(503, '暂时无法核对旧项目状态，请稍后再试；本次尚未创建项目。'); }
  if (count !== 0n)
    fail(409, '旧版本已有项目；只有完成跨版本矿机查重的新部署图才能创建新项目。');
  if (paused !== true) fail(409, '旧版本尚未停建，请运营方先暂停旧版本建池，再创建新项目。');
}
