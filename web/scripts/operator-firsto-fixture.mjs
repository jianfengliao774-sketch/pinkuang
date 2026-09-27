/** Offline only: real pinned runtime bytes, deterministic test signatures, simulated chain/API. */
import { Interface, ZeroAddress, getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { machineRegistryAbi } from '../lib/operator-quotes.mjs';
import { FIRSTO_SIGNED_EXCHANGE } from '../../deploy/src/firsto-purchase.mjs';
import { signedSource, firstoProvider, now, runtime } from '../../deploy/scripts/fixtures/firsto-order.mjs';
import { parseQuotePage, verifyQuoteDetail } from '../../deploy/src/pricing.ts';
import { createLiveBrowserFixture, FIXTURE_CONTRACTS, FIXTURE_POOLS } from './live-browser-fixture.mjs';
import { dataFixture, chainFixture, apiFixture, MARKET, MINING } from './operator-quotes-fixture.mjs';

const officialAbi = new Interface([
  'function listingFor(address,uint256) view returns(uint256 id,address seller,uint96 price,bool valid)',
  'function listingView(uint256) view returns(address seller,address circuits,uint256 tokenId,uint96 price,uint16 feeBps,bool valid)',
]);
const nftAbi = new Interface(['function ownerOf(uint256) view returns(address)']);

export async function operatorFirstoFixture(options = {}) {
  const source = await signedSource();
  const data = dataFixture();
  data.row.tokenId = '7'; data.row.owner = source.account; data.row.bestAsk = source;
  data.page.rows = [data.row]; data.detail.asset = structuredClone(data.row);
  data.detail.orders.signedAsks = [{ askHash: source.id, maker: source.account, status: 'open', priceWei: source.priceWei, buyerCostWei: source.buyerCostWei }];
  data.quote = verifyQuoteDetail(parseQuotePage(data.page).rows[0], data.detail);
  const officialMarket = chainFixture(data.quote, { owner: options.originalOwner ?? source.account,
    listing: { valid: options.officialListing === true, seller: source.account, price: 4000000000000000n },
    miner: options.originalMiner });
  const live = createLiveBrowserFixture({ isOperator: true, timestamp: now / 1000 });
  const row = live.rows[0];
  Object.assign(row, { state: 1n, totalRaised: 20000000000000000n, totalSupply: 100n });
  Object.assign(row.params, { circuits: getAddress(source.execution.collection), circuitId: 7n, targetRaise: row.totalRaised, priceCap: 10000000000000000n });
  const state = { registryPool: ZeroAddress, ready: true, old: false, cancelled: false, flexible: false,
    originalExecutable: true, alternativeExecutable: true, ...options };
  const api = apiFixture(data), calls = [], simulations = [];
  const provider = { request: async input => {
    calls.push(input); const { method, params = [] } = input;
    if (/send|sign|wallet_/i.test(method)) throw new Error(`Forbidden fixture write ${method}`);
    const firsto = firstoProvider(source, { values: { isSignedAskNonceInvalidated: state.cancelled } });
    if (method === 'eth_getBlockByNumber' && !['latest', '0x64'].includes(params[0])) return live.request(input);
    if (method === 'eth_getStorageAt' && getAddress(params[0]) !== FIRSTO_SIGNED_EXCHANGE) return live.request(input);
    if (['eth_chainId', 'eth_getBlockByNumber', 'eth_getStorageAt'].includes(method)) return firsto.provider.request(input);
    if (method === 'eth_getCode') return [FIRSTO_SIGNED_EXCHANGE, getAddress(runtime.implementation)].includes(getAddress(params[0]))
      ? firsto.provider.request(input) : live.request(input);
    if (method === 'eth_call') {
      const [tx] = params, target = getAddress(tx.to);
      if (target === FIXTURE_CONTRACTS.factory) {
        const parsed = machineRegistryAbi.parseTransaction(tx);
        if (parsed?.name === 'machineRegistryStatus') return state.old ? '0x'
          : machineRegistryAbi.encodeFunctionResult(parsed.fragment, [true, state.ready, state.ready ? 0n : 0n, state.ready ? 0n : 1n]);
        if (parsed?.name === 'machinePool') return machineRegistryAbi.encodeFunctionResult(parsed.fragment, [state.registryPool]);
      }
      if (target === MARKET && state.flexible && state.alternativeListing) {
        const parsed = officialAbi.parseTransaction(tx);
        if (parsed?.name === 'listingFor' && parsed.args[1] === 8n) return officialAbi.encodeFunctionResult(parsed.fragment,
          [46n, source.account, state.alternativeListing.price, state.alternativeListing.valid]);
        if (parsed?.name === 'listingView' && parsed.args[0] === 46n) return officialAbi.encodeFunctionResult(parsed.fragment,
          [source.account, source.execution.collection, 8n, state.alternativeListing.price, 100n, state.alternativeListing.valid]);
      }
      if (target === MARKET) {
        const parsed = officialAbi.parseTransaction(tx);
        if (parsed?.name === 'listingView' && parsed.args[0] === 45n) return officialAbi.encodeFunctionResult(parsed.fragment,
          [source.account, source.execution.collection, 7n, 4000000000000000n, 100n, state.officialListing === true]);
      }
      if (target === MARKET || target === MINING) return officialMarket.provider.request(input);
      if (target === getAddress(source.execution.collection) && options.originalOwner) {
        const parsed = nftAbi.parseTransaction(tx);
        if (parsed?.name === 'ownerOf') return nftAbi.encodeFunctionResult(parsed.fragment, [options.originalOwner]);
      }
      if (target === getAddress(source.execution.collection) || target === FIRSTO_SIGNED_EXCHANGE) return firsto.provider.request(input);
      if (target === FIXTURE_POOLS.funding) {
        const parsed = abi.PoolVault.parseTransaction(tx);
        if (parsed?.name === 'flexiblePurchase') return abi.PoolVault.encodeFunctionResult(parsed.fragment,
          [state.flexible, 7n, [50n, 10000000000000000n, 1n, 1000n, 1n, 1n, `0x${'11'.repeat(32)}`]]);
        if (parsed?.name === 'purchaseModel') return abi.PoolVault.encodeFunctionResult(parsed.fragment, [state.flexible, 220n]);
        if (parsed?.name === 'purchaseReferenceWeight') return abi.PoolVault.encodeFunctionResult(parsed.fragment, [61n]);
        if (parsed?.name === 'buyFromFirsto' || parsed?.name === 'buyFromMarket' || parsed?.name === 'buyAlternativeFromMarket') {
          if (parsed.name === 'buyFromMarket' && !state.originalExecutable) {
            throw Object.assign(new Error('execution reverted: original unavailable'), { code: 3, data: '0x' });
          }
          if (parsed.name === 'buyAlternativeFromMarket' && !state.alternativeExecutable) {
            throw Object.assign(new Error('execution reverted: alternative unavailable'), { code: 3, data: '0x' });
          }
          simulations.push(input); return abi.PoolVault.encodeFunctionResult(parsed.fragment, []);
        }
      }
    }
    return live.request(input);
  } };
  return { ...live, provider, data, source, api, state, calls, simulations, officialMarket,
    config: { status: 'ready', chainId: 56, ...FIXTURE_CONTRACTS }, pool: FIXTURE_POOLS.funding };
}
