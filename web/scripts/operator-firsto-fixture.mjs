/** Offline only: real pinned runtime bytes, deterministic test signatures, simulated chain/API. */
import { ZeroAddress, getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { machineRegistryAbi } from '../lib/operator-quotes.mjs';
import { FIRSTO_SIGNED_EXCHANGE } from '../../deploy/src/firsto-purchase.mjs';
import { signedSource, firstoProvider, now, runtime } from '../../deploy/scripts/fixtures/firsto-order.mjs';
import { parseQuotePage, verifyQuoteDetail } from '../../deploy/src/pricing.ts';
import { createLiveBrowserFixture, FIXTURE_CONTRACTS, FIXTURE_POOLS } from './live-browser-fixture.mjs';
import { dataFixture, chainFixture, apiFixture, MARKET, MINING } from './operator-quotes-fixture.mjs';

export async function operatorFirstoFixture(options = {}) {
  const source = await signedSource();
  const data = dataFixture();
  data.row.tokenId = '7'; data.row.owner = source.account; data.row.bestAsk = source;
  data.page.rows = [data.row]; data.detail.asset = structuredClone(data.row);
  data.detail.orders.signedAsks = [{ askHash: source.id, maker: source.account, status: 'open', priceWei: source.priceWei, buyerCostWei: source.buyerCostWei }];
  data.quote = verifyQuoteDetail(parseQuotePage(data.page).rows[0], data.detail);
  const legacy = chainFixture(data.quote, { owner: source.account, listing: { valid: false } });
  const live = createLiveBrowserFixture({ isOperator: true, timestamp: now / 1000 });
  const row = live.rows[0];
  Object.assign(row, { state: 1n, totalRaised: 20000000000000000n, totalSupply: 100n });
  Object.assign(row.params, { circuits: getAddress(source.execution.collection), circuitId: 7n, targetRaise: row.totalRaised, priceCap: 10000000000000000n });
  const state = { registryPool: ZeroAddress, ready: true, old: false, cancelled: false, ...options };
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
      if (target === MARKET || target === MINING) return legacy.provider.request(input);
      if (target === getAddress(source.execution.collection) || target === FIRSTO_SIGNED_EXCHANGE) return firsto.provider.request(input);
      if (target === FIXTURE_POOLS.funding) {
        const parsed = abi.PoolVault.parseTransaction(tx);
        if (parsed?.name === 'buyFromFirsto') {
          simulations.push(input); return abi.PoolVault.encodeFunctionResult(parsed.fragment, []);
        }
      }
    }
    return live.request(input);
  } };
  return { ...live, provider, data, source, api, state, calls, simulations,
    config: { status: 'ready', chainId: 56, ...FIXTURE_CONTRACTS }, pool: FIXTURE_POOLS.funding };
}
