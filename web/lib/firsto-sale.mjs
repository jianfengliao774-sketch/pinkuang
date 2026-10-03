import { Interface, getAddress, keccak256 } from 'ethers';
import { FIRSTO_SIGNED_EXCHANGE, FIRSTO_PROXY_HASH, FIRSTO_IMPLEMENTATION_HASH } from '../../deploy/src/firsto-purchase.mjs';

const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const FACTORY = '0x68224F668083c29e9800Be2a646d42d18cedF7e2';
const exchange = new Interface([
  'function factory() view returns(address)', 'function paused() view returns(bool)',
  'function defaultTakerFeeBps() view returns(uint16)', 'function feeEpoch() view returns(uint256)',
  'function feeBpsAtEpoch(uint256) view returns(uint16)', 'function SIGNED_ASK_SCHEMA_VERSION() view returns(uint16)',
]);
const capability = new Interface(['function controlledFirstoSaleVersion() view returns(uint8)']);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

/** This is a read-only capability/fee quote, never an externally reusable sell signature. */
export async function readControlledFirstoSale(provider, pool, blockTag) {
  const request = (method, params) => provider.request({ method, params });
  const read = async (to, abi, name, args = []) => abi.decodeFunctionResult(name,
    await request('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, blockTag]))[0];
  const version = await read(pool, capability, 'controlledFirstoSaleVersion');
  requireValue(version === 1n, '当前矿池尚未支持受控 Firsto 成交，请先完成合约升级。');
  const [proxy, stored, factory, paused, schema, feeBps, feeEpoch] = await Promise.all([
    request('eth_getCode', [FIRSTO_SIGNED_EXCHANGE, blockTag]),
    request('eth_getStorageAt', [FIRSTO_SIGNED_EXCHANGE, SLOT, blockTag]),
    read(FIRSTO_SIGNED_EXCHANGE, exchange, 'factory'), read(FIRSTO_SIGNED_EXCHANGE, exchange, 'paused'),
    read(FIRSTO_SIGNED_EXCHANGE, exchange, 'SIGNED_ASK_SCHEMA_VERSION'),
    read(FIRSTO_SIGNED_EXCHANGE, exchange, 'defaultTakerFeeBps'), read(FIRSTO_SIGNED_EXCHANGE, exchange, 'feeEpoch'),
  ]);
  requireValue(proxy !== '0x' && keccak256(proxy) === FIRSTO_PROXY_HASH
    && /^0x0{24}[a-f\d]{40}$/i.test(stored), 'Firsto 交易合约身份已变化，暂停成交。');
  const implementation = getAddress(`0x${stored.slice(-40)}`);
  const [code, epochFee] = await Promise.all([
    request('eth_getCode', [implementation, blockTag]),
    read(FIRSTO_SIGNED_EXCHANGE, exchange, 'feeBpsAtEpoch', [feeEpoch]),
  ]);
  requireValue(code !== '0x' && keccak256(code) === FIRSTO_IMPLEMENTATION_HASH
    && getAddress(factory) === FACTORY && schema === 2n, 'Firsto 当前版本尚未核验，暂停成交。');
  requireValue(!paused && feeBps === epochFee && feeBps <= 10000n, 'Firsto 已暂停或手续费状态不一致，请刷新。');
  return Object.freeze({ available: true, version, exchange: FIRSTO_SIGNED_EXCHANGE, feeBps, feeEpoch });
}
