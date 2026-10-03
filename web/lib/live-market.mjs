import { ZeroAddress, getAddress, toQuantity } from 'ethers';
import { abi, CHAIN_ID, uint } from './chain-client.mjs';

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_SHARES = 100n;
const MIN_PRICE_PER_UNIT_WEI = 10000000000000n;
const PAGE_SIZE = 20;
const same = (left, right) => getAddress(left) === getAddress(right);
const requireMarket = (condition, message) => { if (!condition) throw new Error(message); };
const nonzero = value => {
  const result = getAddress(value);
  requireMarket(result !== ZeroAddress, 'Zero address is not a market identity.');
  return result;
};
const shares = value => {
  const amount = uint(value);
  requireMarket(amount >= 1n && amount <= MAX_SHARES, 'Share amount must be 1–100.');
  return amount;
};
const orderId = value => {
  const id = uint(value);
  requireMarket(id > 0n, 'Order ID must be positive.');
  return id;
};

async function batches(items, size, fn) {
  const result = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(...await Promise.all(items.slice(start, start + size).map(fn)));
  }
  return result;
}

/**
 * Discovery IDs are untrusted. Read them from the reviewed Factory's Market at
 * one block before quoting. The caller must recheck the order before signing.
 */
export async function readMarketSnapshot(provider, {
  factory: configuredFactory, market: configuredMarket, account = ZeroAddress,
  orderIds = [], pools = [], blockNumber,
}) {
  requireMarket(provider?.request, 'An EIP-1193 provider is required.');
  const factory = nonzero(configuredFactory), market = nonzero(configuredMarket), owner = getAddress(account);
  requireMarket(Array.isArray(orderIds) && orderIds.length <= PAGE_SIZE && Array.isArray(pools) && pools.length <= PAGE_SIZE,
    'At most 20 orders and 20 pools may be read together.');
  const ids = [...new Set(orderIds.map(value => orderId(value).toString()))].map(BigInt);
  const namedPools = [...new Set(pools.map(value => nonzero(value)))];
  const request = (method, params = []) => provider.request({ method, params });
  requireMarket(BigInt(await request('eth_chainId')) === CHAIN_ID, 'Switch to BSC mainnet (56).');
  const block = await request('eth_getBlockByNumber', [blockNumber === undefined ? 'latest' : toQuantity(uint(blockNumber)), false]);
  requireMarket(block?.number && block?.hash && block?.timestamp, 'Market block is unavailable.');
  const number = BigInt(block.number), timestamp = BigInt(block.timestamp), tag = toQuantity(number);
  requireMarket(blockNumber === undefined || number === uint(blockNumber), 'RPC returned the wrong market block.');
  async function call(to, contract, method, args = []) {
    const data = contract.encodeFunctionData(method, args);
    return contract.decodeFunctionResult(method, await request('eth_call', [{ to, data }, tag]))[0];
  }
  const [factoryCode, marketCode, linkedMarket, factoryTimelock, marketFactory, marketTimelock, feeBps, buyerFeeBps, nextOrderId, credit] = await Promise.all([
    request('eth_getCode', [factory, tag]), request('eth_getCode', [market, tag]),
    call(factory, abi.PoolFactory, 'shareMarket'), call(factory, abi.PoolFactory, 'timelock'),
    call(market, abi.ShareMarket, 'factory'), call(market, abi.ShareMarket, 'timelock'),
    call(market, abi.ShareMarket, 'feeBps'), call(market, abi.ShareMarket, 'buyerFeeBps').catch(() => null), call(market, abi.ShareMarket, 'nextOrderId'),
    call(market, abi.ShareMarket, 'bnbOwed', [owner]),
  ]);
  requireMarket(factoryCode && factoryCode !== '0x' && marketCode && marketCode !== '0x', 'Factory or Market has no code.');
  requireMarket(same(linkedMarket, market) && same(marketFactory, factory) && same(factoryTimelock, marketTimelock),
    'Factory and ShareMarket bindings changed.');
  requireMarket(feeBps === 100n && nextOrderId >= 1n, 'Unsupported market fee or order state.');
  requireMarket(ids.every(id => id < nextOrderId), 'An order ID is not registered by this market.');

  const orders = await batches(ids, 4, async id => {
    const [raw, expiresAt] = await Promise.all([
      call(market, abi.ShareMarket, 'orders', [id]),
      call(market, abi.ShareMarket, 'orderExpiresAt', [id]),
    ]);
    requireMarket(raw.seller !== ZeroAddress && raw.pool !== ZeroAddress, 'Order is not registered by this market.');
    return Object.freeze({ id, seller: getAddress(raw.seller), pool: nonzero(raw.pool),
      remaining: raw.remaining, pricePerUnitWei: raw.pricePerUnit, active: raw.active, expiresAt });
  });
  const targets = [...new Set([...namedPools, ...orders.map(order => order.pool)])];
  const positions = await batches(targets, 4, async pool => {
    const [registered, code, poolFactory, officialFactory, state, tradingAllowed, balance, locked, available] = await Promise.all([
      call(factory, abi.PoolFactory, 'isPool', [pool]), request('eth_getCode', [pool, tag]),
      call(pool, abi.PoolVault, 'factory'), call(pool, abi.PoolVault, 'OFFICIAL_FACTORY'),
      call(pool, abi.PoolVault, 'state'), call(pool, abi.PoolVault, 'shareTradingAllowed'),
      call(pool, abi.PoolVault, 'balanceOf', [owner]), call(pool, abi.PoolVault, 'lockedShares', [owner]),
      call(pool, abi.PoolVault, 'availableShares', [owner]),
    ]);
    requireMarket(registered === true && code && code !== '0x' && same(poolFactory, factory) && same(officialFactory, factory),
      'Order pool is not registered by the reviewed Factory.');
    requireMarket(state <= 5n && balance <= MAX_SHARES && locked <= balance && available === balance - locked,
      'Pool share state is inconsistent.');
    return Object.freeze({ pool, state, tradingAllowed, balance, locked, available });
  });
  const again = await request('eth_getBlockByNumber', [tag, false]);
  requireMarket(again?.hash === block.hash && BigInt(await request('eth_chainId')) === CHAIN_ID,
    'Chain changed during market read; refresh.');
  return Object.freeze({ chainId: CHAIN_ID, factory, market, account: owner, blockNumber: number,
    blockHash: block.hash, timestamp, feeBps, buyerFeeBps, nextOrderId, bnbOwed: credit,
    orders: Object.freeze(orders), pools: Object.freeze(positions) });
}

/** Exact calldata and wei only; no signer, wallet request or browser cache. */
export function marketAction(snapshot, from, action) {
  const account = nonzero(from);
  requireMarket(snapshot?.chainId === CHAIN_ID && same(snapshot.account, account)
    && snapshot.feeBps === 100n,
    'Market snapshot belongs to another wallet, chain or fee version.');
  if (action?.kind === 'list' || action?.kind === 'fill') requireMarket(snapshot.buyerFeeBps === 100n,
    'Bilateral 1% market upgrade is required before listing or buying shares.');
  const position = pool => snapshot.pools.find(item => same(item.pool, pool));
  const selectedOrder = id => snapshot.orders.find(item => item.id === id);
  let method, args = [], gross = 0n, pool = null, selected = null, amount = null, unitPriceWei = null;
  if (action?.kind === 'list') {
    pool = nonzero(action.pool); amount = shares(action.amount);
    unitPriceWei = uint(action.pricePerUnitWei);
    requireMarket(unitPriceWei <= MAX_UINT256 / amount, 'Share listing price overflows the market.');
    const listingGross = unitPriceWei * amount;
    requireMarket(listingGross + listingGross / 100n <= MAX_UINT256,
      'Share listing plus buyer fee overflows the market.');
    requireMarket(unitPriceWei >= MIN_PRICE_PER_UNIT_WEI, 'The listing price must be at least 0.00001 BNB per share.');
    const holding = position(pool);
    requireMarket(holding && holding.state === 2n && holding.tradingAllowed === true,
      'Pool is not active or share trading is frozen.');
    requireMarket(holding.available >= amount, 'Not enough unlocked shares to list.');
    method = 'list'; args = [pool, amount, unitPriceWei];
  } else if (action?.kind === 'fill') {
    const id = orderId(action.orderId); amount = shares(action.amount);
    selected = selectedOrder(id);
    requireMarket(selected && selected.active && selected.remaining >= amount,
      'Order was filled, cancelled or has fewer shares remaining.');
    requireMarket(selected.expiresAt > snapshot.timestamp, 'Order expired; refresh.');
    pool = selected.pool;
    requireMarket(same(action.expectedPool, pool) && same(action.expectedSeller, selected.seller) &&
      uint(action.expectedPricePerUnitWei) === selected.pricePerUnitWei,
    'Order pool, seller or price changed; refresh.');
    requireMarket(!same(account, selected.seller), 'Do not buy your own order.');
    const holding = position(pool);
    requireMarket(holding && holding.state === 2n && holding.tradingAllowed === true,
      'Pool is not active or share trading is frozen.');
    requireMarket(selected.pricePerUnitWei >= MIN_PRICE_PER_UNIT_WEI,
      'This historical order is below the minimum price and cannot be filled; the seller may cancel it.');
    requireMarket(selected.pricePerUnitWei <= MAX_UINT256 / amount, 'Order amount overflows the market.');
    unitPriceWei = selected.pricePerUnitWei;
    gross = selected.pricePerUnitWei * amount;
    method = 'fill'; args = [id, amount];
  } else if (action?.kind === 'cancel') {
    const id = orderId(action.orderId); selected = selectedOrder(id);
    requireMarket(selected?.active && same(account, selected.seller), 'Only the seller can cancel an active order.');
    pool = selected.pool; method = 'cancel'; args = [id];
  } else if (action?.kind === 'expire') {
    const id = orderId(action.orderId); selected = selectedOrder(id);
    requireMarket(selected?.active && (selected.expiresAt === 0n || selected.expiresAt <= snapshot.timestamp),
      'Order is not yet expired.');
    pool = selected.pool; method = 'expire'; args = [id];
  } else if (action?.kind === 'withdrawBnb') {
    requireMarket(snapshot.bnbOwed > 0n, 'No Market BNB is owed to this wallet.');
    method = 'withdrawBnb';
  } else throw new Error('Unsupported ShareMarket action.');
  const buyerFeeWei = gross / 100n, sellerFeeWei = gross / 100n;
  requireMarket(gross <= MAX_UINT256 - buyerFeeWei, 'Buyer payment overflows the market.');
  const buyerPaymentWei = gross + buyerFeeWei;
  return Object.freeze({ transaction: Object.freeze({ chainId: '0x38', from: account, to: snapshot.market,
    data: abi.ShareMarket.encodeFunctionData(method, args), value: toQuantity(buyerPaymentWei) }),
    quote: Object.freeze({ action: method, pool, orderId: selected?.id ?? null, amount, unitPriceWei,
      grossWei: gross, buyerFeeWei, sellerFeeWei, buyerPaymentWei,
      sellerNetWei: gross - sellerFeeWei, marketCreditWei: snapshot.bnbOwed,
      blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash }) });
}

/** Re-read immediately before simulation and journal creation. Never sends. */
export async function prepareMarketAction(provider, { factory, market, account, action }) {
  const orderIds = action?.orderId === undefined ? [] : [action.orderId];
  const pools = action?.kind === 'list' ? [action.pool] : [];
  const snapshot = await readMarketSnapshot(provider, { factory, market, account, orderIds, pools });
  return Object.freeze({ snapshot, ...marketAction(snapshot, account, action) });
}
