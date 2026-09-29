import { Interface, keccak256, getAddress } from 'ethers';
import { FIRSTO_SIGNED_EXCHANGE, FIRSTO_PROXY_HASH, FIRSTO_IMPLEMENTATION_HASH } from '../src/firsto-purchase.mjs';
import { settleReads } from '../shared/firsto-upgrade-proof.mjs';

const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const poolAbi = new Interface([
  'function listedProposalId() view returns(uint256)', 'function salePrice() view returns(uint256)',
  'function expiresAt() view returns(uint64)',
]);
const exchangeAbi = new Interface([
  'function paused() view returns(bool)', 'function defaultTakerFeeBps() view returns(uint16)',
  'function feeEpoch() view returns(uint256)', 'function feeBpsAtEpoch(uint256) view returns(uint16)',
]);
const requireValue = (condition,message) => { if (!condition) throw new Error(message); };

/** Controlled, payable Pool entry only. It never signs an external listing or
 * claims that Firsto's publication API accepts a contract maker. */
export async function verifyControlledFirstoSale(provider, record, decoded, block) {
  const tag = `0x${block.number.toString(16)}`;
  const read = async (to,abi,name,args=[]) => abi.decodeFunctionResult(name,
    await provider.send('eth_call',[{to,data:abi.encodeFunctionData(name,args)},tag]))[0];
  const [proposal,price,expiry,paused,fee,epoch,proxy,stored] = await settleReads([
    read(record.target,poolAbi,'listedProposalId'), read(record.target,poolAbi,'salePrice'),
    read(record.target,poolAbi,'expiresAt'), read(FIRSTO_SIGNED_EXCHANGE,exchangeAbi,'paused'),
    read(FIRSTO_SIGNED_EXCHANGE,exchangeAbi,'defaultTakerFeeBps'),read(FIRSTO_SIGNED_EXCHANGE,exchangeAbi,'feeEpoch'),
    provider.getCode(FIRSTO_SIGNED_EXCHANGE,block.number), provider.getStorage(FIRSTO_SIGNED_EXCHANGE,slot,block.number),
  ]);
  requireValue(proxy !== '0x' && keccak256(proxy) === FIRSTO_PROXY_HASH && /^0x0{24}[a-f\d]{40}$/i.test(stored),
    'Firsto exchange proxy identity changed.');
  const implementation = getAddress(`0x${stored.slice(-40)}`);
  const code = await provider.getCode(implementation,block.number);
  requireValue(code !== '0x' && keccak256(code) === FIRSTO_IMPLEMENTATION_HASH,'Firsto exchange implementation changed.');
  const epochFee = await read(FIRSTO_SIGNED_EXCHANGE,exchangeAbi,'feeBpsAtEpoch',[epoch]);
  requireValue(!paused && fee === epochFee && fee <= 10000n,'Firsto sale fee is unavailable or changed.');
  requireValue(proposal > 0n && price > 0n && Number.isSafeInteger(block.timestamp) && expiry > BigInt(block.timestamp),
    'The approved miner sale is absent or expired.');
  requireValue(decoded.args[0] === proposal && decoded.args[1] === price && decoded.args[2] === fee && decoded.args[3] === epoch,
    'Approved proposal, sale price or Firsto fee changed after the preview.');
  const total = price + price * fee / 10000n;
  requireValue(total < 2n ** 256n && BigInt(record.value) === total,'Firsto sale payment differs from the exact approved gross amount.');
  return {proposalId:proposal.toString(),salePriceWei:price.toString(),buyerFeeWei:(total-price).toString(),totalWei:total.toString(),feeEpoch:epoch.toString()};
}
