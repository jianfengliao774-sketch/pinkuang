import { Interface, ZeroAddress, getAddress } from 'ethers';

const registry = new Interface(['function machinePool(address,uint256) view returns(address)']);
const UINT256 = 1n << 256n;

/** One current Factory read; a failed or malformed response never means available. */
export async function readMachineReservation(provider, { factory, collection, tokenId, blockTag = 'latest' } = {}) {
  const target = getAddress(factory), circuits = getAddress(collection);
  if (typeof tokenId === 'number' && !Number.isSafeInteger(tokenId)) throw new Error('矿机编号必须是精确整数。');
  const id = BigInt(tokenId);
  if (id < 0n || id >= UINT256) throw new Error('矿机编号超出 uint256 范围。');
  if (typeof blockTag !== 'string' || blockTag !== 'latest' && !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(blockTag))
    throw new Error('矿机登记读取区块无效。');
  const params = [{ to: target, data: registry.encodeFunctionData('machinePool', [circuits, id]) }, blockTag];
  const encoded = typeof provider?.request === 'function'
    ? await provider.request({ method: 'eth_call', params })
    : typeof provider?.send === 'function' ? await provider.send('eth_call', params)
      : (() => { throw new Error('矿机登记读取器不可用。'); })();
  if (typeof encoded !== 'string' || !/^0x[0-9a-f]{64}$/i.test(encoded))
    throw new Error('矿机登记返回值无效。');
  const [pool] = registry.decodeFunctionResult('machinePool', encoded);
  if (registry.encodeFunctionResult('machinePool', [pool]).toLowerCase() !== encoded.toLowerCase())
    throw new Error('矿机登记返回值不规范。');
  return getAddress(pool);
}

export async function requireMachineAvailable(provider, options) {
  const pool = await readMachineReservation(provider, options);
  if (pool !== ZeroAddress) throw Object.assign(new Error(`此矿机已有拼矿项目：${pool}，不能重复创建。`),
    { code: 'MachineAlreadyReserved', pool });
  return pool;
}
