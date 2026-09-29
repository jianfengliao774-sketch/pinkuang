// Read-only BSC inspection: eth_call never signs, broadcasts, or retains state.
// Optional --simulate uses a fictitious caller and temporary eth_call balance overrides.
// Many public RPCs reject overrides/archive requests; a failed probe proves no fee behavior.
import { Contract, Interface, JsonRpcProvider, keccak256, toBeHex } from 'ethers';
const rpc = process.env.BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const provider = new JsonRpcProvider(rpc, 56, { staticNetwork: true });
if (BigInt(await provider.send('eth_chainId', [])) !== 56n) throw new Error('BSC mainnet required for this read-only inspection');
const block = await provider.getBlockNumber();
const header = await provider.getBlock(block);
const official = '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f';
const router = '0x36DF3423472E03490f6440E7AF485BE7649B3564';
const v2 = '0x33423244F9a5bF81b12B1a018aF6F4e079B97f29';
const v1 = '0x81dE876Ab97C65F156D896A24a76D48C015E6b6E';
const market = new Contract(official, [
  'function feeBps() view returns(uint16)',
  'function protocolWallet() view returns(address)',
  'function listingView(uint256) view returns(address seller,address circuits,uint256 tokenId,uint96 price,uint16 feeBps,bool valid)',
  'function buy(uint256,uint96) payable',
], provider);
const listingId = BigInt(process.env.LISTING_ID || '17768');
const listing = await market.listingView(listingId, { blockTag: block });
const signedV2 = new Contract(v2, ['function defaultTakerFeeBps() view returns(uint16)', 'function feeEpoch() view returns(uint256)', 'function feeBpsAtEpoch(uint256) view returns(uint16)'], provider);
const signedV1 = new Contract(v1, ['function TAKER_FEE_BPS() view returns(uint16)'], provider);
const epoch = await signedV2.feeEpoch({ blockTag: block });
const report = {
  checkedAt: new Date().toISOString(), chainId: 56, block,
  official: { address: official, feeBps: await market.feeBps({ blockTag: block }), protocolWallet: await market.protocolWallet({ blockTag: block }), listing: { listingId, seller: listing.seller, collection: listing.circuits, tokenId: listing.tokenId, priceWei: listing.price, feeBps: listing.feeBps, valid: listing.valid } },
  firsto: { router, signedV2: v2, v2DefaultTakerFeeBps: await signedV2.defaultTakerFeeBps({ blockTag: block }), feeEpoch: epoch, epochFeeBps: await signedV2.feeBpsAtEpoch(epoch, { blockTag: block }), signedV1: v1, v1TakerFeeBps: await signedV1.TAKER_FEE_BPS({ blockTag: block }) },
  codeHashes: {}, simulations: [],
};
for (const address of [official, router, v2, v1]) report.codeHashes[address] = keccak256(await provider.getCode(address, block));
if (listing.valid && process.argv.includes('--simulate')) {
  const abi = new Interface(['function buyOfficialCircuit((uint256 listingId,address seller,address collection,uint256 tokenId,uint96 price,uint16 expectedOfficialFeeBps,uint16 expectedFirstoFeeBps,uint64 deadline,bytes32 optimalMinerKey) intent) payable']);
  const intent = { listingId, seller: listing.seller, collection: listing.circuits, tokenId: listing.tokenId, price: listing.price, expectedOfficialFeeBps: listing.feeBps, expectedFirstoFeeBps: 100, deadline: header.timestamp + 600, optimalMinerKey: '0x' + '00'.repeat(32) };
  const officialData = market.interface.encodeFunctionData('buy', [listingId, listing.price]);
  const routerData = abi.encodeFunctionData('buyOfficialCircuit', [intent]);
  const withServiceFee = listing.price + listing.price / 100n;
  const from = '0x000000000000000000000000000000000000dEaD';
  for (const [label, to, data, value] of [
    ['official_exact_ask', official, officialData, listing.price],
    ['official_ask_plus_one_percent', official, officialData, withServiceFee],
    ['firsto_router_exact_ask', router, routerData, listing.price],
    ['firsto_router_ask_plus_one_percent', router, routerData, withServiceFee],
  ]) {
    try {
      const result = await provider.send('eth_call', [{ from, to, data, value: toBeHex(value) }, toBeHex(block), { [from]: { balance: toBeHex(withServiceFee + 10n ** 18n) } }]);
      report.simulations.push({ label, valueWei: value, result: 'success', returned: result });
    } catch (error) {
      report.simulations.push({ label, valueWei: value, result: 'failed_or_unavailable', error: error.shortMessage || error.message, revertData: error.data || null });
    }
  }
}
console.log(JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
provider.destroy();
