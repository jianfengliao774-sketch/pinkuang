import { getAddress, ZeroAddress, toQuantity } from 'ethers';
import { abi } from './chain-client.mjs';
import { settleReadRound } from './read-retry.mjs';

const BLOCK_HASH = /^0x[0-9a-f]{64}$/i;

/** Read holder addresses from one current canonical block, independent of index history. */
export async function readCurrentPoolMembers(provider, { factory, pool }) {
  const expectedFactory = getAddress(factory), target = getAddress(pool);
  const request = (method, params = []) => provider.request({ method, params });
  const { chain, block } = await settleReadRound({
    chain: () => request('eth_chainId'),
    block: () => request('eth_getBlockByNumber', ['latest', false]),
  });
  if (BigInt(chain) !== 56n || !BLOCK_HASH.test(block?.hash ?? '') || !/^0x[0-9a-f]+$/i.test(block?.number ?? ''))
    throw new Error('最新链上区块暂不可核对。');
  const blockNumber = BigInt(block.number), tag = toQuantity(blockNumber);
  const call = async (to, iface, method, args = []) => iface.decodeFunctionResult(method,
    await request('eth_call', [{ to, data: iface.encodeFunctionData(method, args) }, tag]))[0];
  const { registered, binding, addresses, count } = await settleReadRound({
    registered: () => call(expectedFactory, abi.PoolFactory, 'isPool', [target]),
    binding: () => call(target, abi.PoolVault, 'factory'),
    addresses: () => call(target, abi.PoolVault, 'activeMembers'),
    count: () => call(target, abi.PoolVault, 'memberCount'),
  });
  const members = [...addresses].map(getAddress);
  if (registered !== true || getAddress(binding) !== expectedFactory || members.length > 100
    || BigInt(members.length) !== count || members.includes(ZeroAddress)
    || new Set(members.map(value => value.toLowerCase())).size !== members.length)
    throw new Error('矿池持有人数据未通过链上核对。');
  const { again, finalChain } = await settleReadRound({
    again: () => request('eth_getBlockByNumber', [tag, false]),
    finalChain: () => request('eth_chainId'),
  });
  if (BigInt(finalChain) !== 56n || again?.hash?.toLowerCase() !== block.hash.toLowerCase())
    throw new Error('读取期间链上区块发生变化，请重试。');
  return Object.freeze({ members: Object.freeze(members), blockNumber });
}
