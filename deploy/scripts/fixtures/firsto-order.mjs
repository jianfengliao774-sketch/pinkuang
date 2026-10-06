import { readFileSync } from 'node:fs';
import { Wallet, Interface, TypedDataEncoder, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { FIRSTO_ASK_FIELDS, FIRSTO_SIGNED_EXCHANGE } from '../../src/firsto-purchase.mjs';
export const runtime = JSON.parse(readFileSync(new URL('./firsto-signed-runtime.json',import.meta.url),'utf8'));
export const collection = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
export const now = 1800000000000;
const wallet = new Wallet(`0x${'11'.repeat(32)}`); // Public deterministic test fixture only.
export async function signedSource({ signature, maker = wallet.address, price = '5000000000000001' } = {}) {
  const ask = { maker,collection,tokenId:'7',nonce:'1',price,expiry:'1800000600',payoutRecipient:maker,feeBps:100,feeEpoch:'1',schemaVersion:'2' };
  const domain = { name:'Firsto Circuit Signed Ask',version:'2',chainId:56,verifyingContract:FIRSTO_SIGNED_EXCHANGE };
  const types = { SignedAsk:FIRSTO_ASK_FIELDS };
  const askHash = TypedDataEncoder.hash(domain,types,ask);
  return { id:askHash,account:maker,venue:'firsto',status:'open',priceWei:price,
    buyerCostWei:(BigInt(price) + BigInt(price) / 100n).toString(),expiresAt:new Date(Number(ask.expiry) * 1000).toISOString(),
    execution:{ ...ask,price:undefined,priceWei:price,kind:'signed_ask',chainId:56,exchange:FIRSTO_SIGNED_EXCHANGE,askHash,
      signature:signature ?? await wallet.signTypedData(domain,types,ask) } };
}
const functions = new Interface([
  'function factory() view returns(address)','function paused() view returns(bool)','function defaultTakerFeeBps() view returns(uint16)',
  'function feeEpoch() view returns(uint256)','function feeBpsAtEpoch(uint256) view returns(uint16)','function SIGNED_ASK_SCHEMA_VERSION() view returns(uint16)',
  'function isSignedAskNonceInvalidated(address,uint256) view returns(bool)','function ownerOf(uint256) view returns(address)',
  'function getApproved(uint256) view returns(address)','function isApprovedForAll(address,address) view returns(bool)',
  'function isValidSignature(bytes32,bytes) view returns(bytes4)',
]);
export function firstoProvider(source, overrides = {}) {
  const calls = [];
  const block = { number:'0x64',hash:`0x${'12'.repeat(32)}`,timestamp:toQuantity(BigInt(now / 1000)) };
  const values = { factory:'0x68224F668083c29e9800Be2a646d42d18cedF7e2',paused:false,defaultTakerFeeBps:100n,feeEpoch:1n,
    feeBpsAtEpoch:100n,SIGNED_ASK_SCHEMA_VERSION:2n,isSignedAskNonceInvalidated:false,ownerOf:source.account,
    getApproved:ZeroAddress,isApprovedForAll:true,isValidSignature:'0x1626ba7e', ...overrides.values };
  return { calls, provider:{ request:async ({method,params = []}) => {
    calls.push({method,params});
    if (method === 'eth_chainId') return overrides.chain ?? '0x38';
    if (method === 'eth_getBlockByNumber') return { ...block,...(params[0] !== 'latest' ? overrides.finalBlock : {}) };
    if (method === 'eth_getStorageAt') return overrides.slot ?? `0x${runtime.implementation.slice(2).toLowerCase().padStart(64,'0')}`;
    if (method === 'eth_getCode') {
      if (getAddress(params[0]) === FIRSTO_SIGNED_EXCHANGE) return overrides.proxy ?? runtime.proxy;
      return overrides.implementationCode ?? runtime.implementationCode;
    }
    if (method === 'eth_call') {
      const parsed = functions.parseTransaction(params[0]);
      if (!parsed || !(parsed.name in values)) throw new Error('Unknown fixture call');
      return functions.encodeFunctionResult(parsed.fragment,[values[parsed.name]]);
    }
    throw new Error(`Read-only fixture refused ${method}`);
  } } };
}
