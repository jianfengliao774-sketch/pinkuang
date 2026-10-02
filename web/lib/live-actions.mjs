import { Interface, getAddress, parseEther, toQuantity, ZeroAddress } from 'ethers';
import { abi, uint, poolKey, readPoolSnapshot, personalPoolAction } from './chain-client.mjs';
import { readGovernanceSnapshot, governanceAction, nativeGovernanceViews } from './live-governance.mjs';
import { settleReadRound } from './read-retry.mjs';
import { FIRSTO_SIGNED_EXCHANGE } from '../../deploy/src/firsto-purchase.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);
const address = value => { const result = getAddress(value); assert(result !== ZeroAddress, '地址不能为零 / Zero address.'); return result; };
const ACTIONS = new Set(['deposit', 'claim', 'harvest', 'withdrawBnb', 'withdrawDeposit', 'finalizeFailure',
  'list', 'fill', 'cancel', 'expire', 'marketWithdraw', 'propose', 'vote', 'executeSale', 'cancelExpired', 'completeFirstoSale', 'delist']);
const MARKET_ACTIONS = new Set(['list', 'fill', 'cancel', 'expire', 'marketWithdraw']);
const MIN_SHARE_PRICE_WEI = 10000000000000n;
const HASH = /^0x[0-9a-f]{64}$/i;
const firstoFees = new Interface(['function defaultTakerFeeBps() view returns(uint16)', 'function feeEpoch() view returns(uint256)']);

/** Direct mode builds exact calldata. Contract execution determines availability and permission. */
async function prepareDirectAction(input, { from, market }) {
  const { provider, pool, kind, quantity, price, proposalId, support, orderId } = input;
  const call = async (to, contract, name, args = []) => contract.decodeFunctionResult(name,
    await provider.request({ method: 'eth_call', params: [{ to, data: contract.encodeFunctionData(name, args) }, 'latest'] }))[0];
  const tx = (to, contract, name, args = [], value = 0n) => Object.freeze({ chainId: '0x38', from,
    to: address(to), data: contract.encodeFunctionData(name, args), value: toQuantity(uint(value)) });
  const finish = (transaction, details = {}) => Object.freeze({ transaction,
    kind: kind === 'marketWithdraw' ? 'withdrawBnb' : kind, requestKind: kind,
    pool: null, ...details, direct: true, displayOnly: true, checkedBlock: null });
  if (kind === 'marketWithdraw') return finish(tx(market, abi.ShareMarket, 'withdrawBnb'));
  if (['fill', 'cancel', 'expire'].includes(kind)) {
    const number = id(orderId);
    if (kind !== 'fill') return finish(tx(market, abi.ShareMarket, kind, [number]), { pool: pool ? address(pool) : null, orderId: number });
    const qty = shareQuantity(quantity);
    const [order, buyerFeeBps, sellerFeeBps] = await Promise.all([
      call(market, abi.ShareMarket, 'orders', [number]), call(market, abi.ShareMarket, 'buyerFeeBps'),
      call(market, abi.ShareMarket, 'feeBps'),
    ]);
    const target = address(order.pool), seller = address(order.seller), unitPrice = uint(order.pricePerUnit);
    if (pool) assert(same(target, pool), '订单对应矿池已变化 / Order pool mismatch.');
    if (input.expectedSeller !== undefined) assert(same(seller, input.expectedSeller), '卖方已变化，请重新确认 / Seller changed.');
    if (input.expectedPricePerUnitWei !== undefined) assert(unitPrice === uint(input.expectedPricePerUnitWei), '挂单价格已变化，请重新确认 / Order price changed.');
    assert(unitPrice > 0n && uint(buyerFeeBps, 16) <= 10000n && uint(sellerFeeBps, 16) <= 10000n, '挂单金额或手续费无效 / Invalid order amount or fee.');
    const grossWei = uint(unitPrice * qty), buyerFeeWei = grossWei * buyerFeeBps / 10000n;
    const sellerFeeWei = grossWei * sellerFeeBps / 10000n;
    const buyerPaymentWei = uint(grossWei + buyerFeeWei);
    return finish(tx(market, abi.ShareMarket, 'fill', [number, qty], buyerPaymentWei), { pool: target, quantity: qty, orderId: number,
      order: Object.freeze({ seller, pricePerUnitWei: unitPrice, remaining: order.remaining }),
      marketTrade: Object.freeze({ grossWei, buyerFeeWei, sellerFeeWei, buyerPaymentWei, sellerNetWei: grossWei - sellerFeeWei }) });
  }
  const target = address(pool), details = { pool: target };
  if (kind === 'deposit') {
    const qty = shareQuantity(quantity), unitPriceWei = uint(await call(target, abi.PoolVault, 'unitPriceWei'));
    assert(unitPriceWei > 0n, '认购金额不可用 / Subscription amount unavailable.');
    return finish(tx(target, abi.PoolVault, kind, [qty], uint(unitPriceWei * qty)), { ...details, quantity: qty, unitPriceWei });
  }
  if (kind === 'list') {
    const qty = shareQuantity(quantity), listingPrice = exactPrice(price), listingGrossWei = uint(listingPrice * qty);
    assert(listingPrice >= MIN_SHARE_PRICE_WEI, '每份挂单价不得低于 0.00001 BNB / Minimum listing price is 0.00001 BNB per share.');
    uint(listingGrossWei + listingGrossWei / 100n);
    return finish(tx(market, abi.ShareMarket, kind, [target, qty, listingPrice]), { ...details, quantity: qty, listingGrossWei });
  }
  if (['claim', 'harvest', 'withdrawBnb', 'withdrawDeposit', 'finalizeFailure', 'cancelExpired'].includes(kind))
    return finish(tx(target, abi.PoolVault, kind), details);
  if (kind === 'propose') {
    const sellingPrice = input.priceWei === undefined ? exactPrice(price) : uint(input.priceWei);
    const reference = uint(input.refPriceWei), at = uint(input.refAt, 64);
    assert(sellingPrice > 0n && reference > 0n, '出售价格和参考价必须大于零 / Prices must be positive.');
    if (input.expectedPriceWei !== undefined) assert(sellingPrice === uint(input.expectedPriceWei), '价格已变化 / Price changed.');
    return finish(tx(target, abi.PoolVault, kind, [sellingPrice, reference, at]), details);
  }
  if (['vote', 'executeSale'].includes(kind)) {
    const number = id(proposalId);
    if (input.expectedProposalId !== undefined) assert(number === uint(input.expectedProposalId), '提案已变化 / Proposal changed.');
    if (kind === 'vote') assert(typeof support === 'boolean', '投票选项无效 / Invalid vote.');
    return finish(tx(target, abi.PoolVault, kind, kind === 'vote' ? [number, support] : [number]), details);
  }
  if (kind === 'delist') {
    const operation = uint(input.delistAction, 8), cancellationId = uint(input.cancellationId);
    const expectedListedProposalId = id(input.expectedListedProposalId);
    assert(operation <= 2n && typeof support === 'boolean'
      && (operation === 0n ? cancellationId === 0n : cancellationId > 0n), '下架投票参数无效 / Invalid delisting vote.');
    const [state, listedProposalId] = await Promise.all([
      call(target, abi.PoolVault, 'state'), call(target, abi.PoolVault, 'listedProposalId'),
    ]);
    assert(state === 3n && listedProposalId === expectedListedProposalId,
      '挂牌已成交或提案已变化，请刷新 / Listing completed or changed. Refresh.');
    return finish(tx(target, nativeGovernanceViews, 'delist', [operation, cancellationId, expectedListedProposalId, support]),
      { ...details, quote: { action: 'delist', cancellationId, delistAction: operation, listedProposalId } });
  }
  const [number, salePrice, feeBps, feeEpoch] = await Promise.all([
    call(target, abi.PoolVault, 'listedProposalId'), call(target, abi.PoolVault, 'salePrice'),
    call(FIRSTO_SIGNED_EXCHANGE, firstoFees, 'defaultTakerFeeBps'), call(FIRSTO_SIGNED_EXCHANGE, firstoFees, 'feeEpoch'),
  ]);
  id(number); uint(salePrice); uint(feeBps, 16); uint(feeEpoch);
  assert(salePrice > 0n && feeBps <= 10000n, '成交金额或手续费无效 / Invalid sale amount or fee.');
  for (const [key, actual] of [['expectedProposalId', number], ['expectedPriceWei', salePrice], ['expectedFeeBps', feeBps], ['expectedFeeEpoch', feeEpoch]])
    if (input[key] !== undefined) assert(uint(input[key]) === actual, '成交报价已变化，请重新确认 / Sale quote changed.');
  const sourceFeeWei = salePrice * feeBps / 10000n, paymentWei = uint(salePrice + sourceFeeWei);
  return finish(tx(target, abi.PoolVault, kind, [number, salePrice, feeBps, feeEpoch], paymentWei), { ...details,
    quote: Object.freeze({ action: kind, proposalId: number, pool: target, priceWei: salePrice, paymentWei,
      feeWei: salePrice / 100n, holderNetWei: salePrice - salePrice / 100n, sourceFeeWei, feeBps, feeEpoch,
      blockNumber: null, blockHash: null }) });
}


export function shareQuantity(value) {
  assert(typeof value === 'string' || typeof value === 'bigint' || Number.isSafeInteger(value), '请输入整数份额 / Enter whole shares.');
  const text = String(value);
  assert(text === text.trim() && /^[1-9]\d{0,2}$/.test(text), '请输入 1–100 的整数份额 / Enter 1–100 whole shares.');
  const result = BigInt(text); assert(result <= 100n, '最多 100 份 / Maximum 100 shares.'); return result;
}

/** Prices are decimal BNB strings (or whole-BNB bigint), never binary floating-point Numbers. */
export function exactPrice(value) {
  assert(typeof value === 'string' || typeof value === 'bigint', '金额须使用精确十进制字符串 / Use an exact decimal amount.');
  const text = String(value);
  assert(text === text.trim() && /^(0|[1-9]\d{0,77})(\.\d{1,18})?$/.test(text), '请输入精确 BNB 金额，最多 18 位小数 / Enter an exact BNB amount.');
  const result = parseEther(text);
  assert(result < 2n ** 256n && result > 0n, '价格必须大于零 / Price must be greater than zero.');
  return result;
}

function id(value) {
  assert(typeof value === 'bigint' || typeof value === 'string' && value === value.trim() && /^[1-9]\d{0,77}$/.test(value), '编号须为精确正整数 / Use an exact positive ID.');
  const result = uint(value); assert(result > 0n, '编号须大于零 / ID must be positive.'); return result;
}

/**
 * All read-only checks use one canonical latest block. This returns an unsigned
 * preview, never a signature or send. The journal checks exact calldata before signing.
 */
export async function prepareProductAction({ provider, config, account, pool, kind, quantity, price, proposalId, support, orderId,
  priceWei, refPriceWei, refAt, expectedPool, expectedAccount, expectedProposalId, expectedPriceWei, expectedFeeBps, expectedFeeEpoch,
  expectedSeller, expectedPricePerUnitWei, delistAction, cancellationId, expectedListedProposalId }) {
  assert(ACTIONS.has(kind), '不支持的操作 / Unsupported action.');
  assert(config?.status === 'ready' && [56, 56n, '56', '0x38'].includes(config.chainId ?? config.manifest?.chainId), '尚未配置正式 BSC 部署 / Verified BSC deployment required.');
  assert(config.manifest?.chainId === undefined || config.manifest.chainId === 56, '部署清单网络不一致 / Manifest chain mismatch.');
  const configured = key => {
    const result = address(config[key] ?? config.manifest?.[key]);
    if (config[key] !== undefined && config.manifest?.[key] !== undefined)
      assert(same(result, config.manifest[key]), '部署配置不一致 / Deployment configuration mismatch.');
    return result;
  };
  const factory = configured('factory'), lens = configured('lens'), from = address(account);
  if (expectedAccount !== undefined) assert(same(from, expectedAccount), '钱包已变化，请重新确认 / Wallet changed.');
  if (expectedPool !== undefined) assert(pool && same(pool, expectedPool), '矿池已变化，请重新确认 / Pool changed.');
  const market = MARKET_ACTIONS.has(kind) ? configured('shareMarket') : null;
  assert(!same(factory, lens) && (!market || !same(market, factory) && !same(market, lens)), '部署地址重复 / Duplicate deployment addresses.');
  if (config.displayOnly === true) return prepareDirectAction({ provider, config, account, pool, kind, quantity, price,
    proposalId, support, orderId, priceWei, refPriceWei, refAt, expectedPool, expectedAccount, expectedProposalId,
    expectedPriceWei, expectedFeeBps, expectedFeeEpoch, expectedSeller, expectedPricePerUnitWei,
    delistAction, cancellationId, expectedListedProposalId }, { from, factory, market });
  const request = (method, params = []) => provider.request({ method, params });
  const { chain, block } = await settleReadRound({
    chain: () => request('eth_chainId'),
    block: () => request('eth_getBlockByNumber', ['latest', false]),
  });
  assert(BigInt(chain) === 56n, '请切换到 BSC / Switch to BSC.');
  assert(block && HASH.test(block.hash ?? '') && /^0x[\da-f]+$/i.test(block.number ?? '')
    && /^0x[\da-f]+$/i.test(block.timestamp ?? ''), '区块信息无效 / Invalid block header.');
  const blockNumber = uint(BigInt(block.number)), timestamp = uint(BigInt(block.timestamp)), blockTag = toQuantity(blockNumber);
  const call = async (to, contract, method, args = []) => contract.decodeFunctionResult(method,
    await request('eth_call', [{ to, data: contract.encodeFunctionData(method, args) }, blockTag]));
  const tx = (to, contract, method, args = [], value = 0n) => Object.freeze({ chainId: '0x38', from,
    to: address(to), data: contract.encodeFunctionData(method, args), value: toQuantity(uint(value)) });

  async function finish(transaction, details = {}) {
    const { after, finalChain } = await settleReadRound({
      after: () => request('eth_getBlockByNumber', [blockTag, false]),
      finalChain: () => request('eth_chainId'),
    });
    assert(after?.hash?.toLowerCase() === block.hash.toLowerCase() && BigInt(after?.number ?? -1) === blockNumber
      && BigInt(after?.timestamp ?? -1) === timestamp && BigInt(finalChain) === 56n,
    '读取期间区块或网络已变化，请重新确认 / Chain changed; prepare again.');
    return Object.freeze({ transaction, kind: kind === 'marketWithdraw' ? 'withdrawBnb' : kind,
      requestKind: kind, pool: null, ...details, checkedBlock: Object.freeze({ blockNumber, blockHash: block.hash, timestamp }) });
  }

  async function poolSnapshot(target) {
    const snapshot = await readPoolSnapshot(provider, { factory, lens, account: from, pools: [target], blockNumber });
    const row = snapshot.pools[0];
    assert(same(snapshot.lens, lens) && snapshot.blockHash.toLowerCase() === block.hash.toLowerCase() && snapshot.timestamp === timestamp,
      '矿池读取与部署或区块不一致 / Pool deployment or block mismatch.');
    assert(snapshot.pools.length === 1 && row?.trusted && same(row.pool, target) && row.key === poolKey(factory, target),
      '矿池身份未验证 / Unverified pool.');
    return { row, snapshot };
  }

  if (market) {
    const orderNumber = kind !== 'list' && kind !== 'marketWithdraw' ? id(orderId) : null;
    // Back references, order and expiry are independent reads at the same pinned block.
    // Validate both market bindings before using any concurrent order/balance results.
    const marketReads = await settleReadRound({
      marketFactory: () => call(market, abi.ShareMarket, 'factory'),
      registeredMarket: () => call(factory, abi.PoolFactory, 'shareMarket'),
      ...(['list', 'fill'].includes(kind) ? {
        sellerFeeBps: () => call(market, abi.ShareMarket, 'feeBps'),
        buyerFeeBps: async () => {
          try { return await call(market, abi.ShareMarket, 'buyerFeeBps'); }
          catch { throw new Error('当前市场尚未通过买方 1% 手续费版本核验，暂不可新增挂单或买入 / Bilateral 1% Market upgrade required.'); }
        },
      } : {}),
      ...(kind === 'marketWithdraw' ? { owed: () => call(market, abi.ShareMarket, 'bnbOwed', [from]) } : {}),
      ...(orderNumber !== null ? {
        order: () => call(market, abi.ShareMarket, 'orders', [orderNumber]),
        expiry: () => call(market, abi.ShareMarket, 'orderExpiresAt', [orderNumber]),
      } : {}),
    });
    assert(same(marketReads.marketFactory[0], factory), '市场身份不匹配 / Market identity mismatch.');
    assert(same(marketReads.registeredMarket[0], market), '市场登记不匹配 / Market registration mismatch.');
    if (['list', 'fill'].includes(kind)) assert(marketReads.sellerFeeBps[0] === 100n && marketReads.buyerFeeBps[0] === 100n,
      '当前市场不支持买卖双方各 1% 手续费，请使用升级后的市场 / Bilateral 1% market upgrade required.');
    if (kind === 'marketWithdraw') {
      assert(marketReads.owed[0] > 0n, '暂无可领取市场余额 / No market BNB to withdraw.');
      return finish(tx(market, abi.ShareMarket, 'withdrawBnb'));
    }
    if (kind !== 'list') {
      const order = marketReads.order[0], expiry = marketReads.expiry[0];
      assert(order.active === true && order.remaining > 0n && order.remaining <= 100n, '订单已结束 / Order is no longer active.');
      const target = address(order.pool); address(order.seller);
      if (pool !== undefined && pool !== null) assert(same(target, pool), '订单对应矿池已变化 / Order pool mismatch.');
      const { row, snapshot } = await poolSnapshot(target);
      if (kind === 'fill') {
        const qty = shareQuantity(quantity);
        if (expectedSeller !== undefined) assert(same(order.seller, expectedSeller), '卖方已变化，请重新确认 / Seller changed.');
        if (expectedPricePerUnitWei !== undefined) assert(order.pricePerUnit === uint(expectedPricePerUnitWei), '挂单价格已变化，请重新确认 / Order price changed.');
        assert(order.pricePerUnit >= MIN_SHARE_PRICE_WEI,
          '旧挂单低于最低价 0.00001 BNB/份，不能成交；卖家仍可撤单 / Historical order is below the minimum price.');
        assert(row.state === 2n && row.shareTradingAllowed === true && expiry > timestamp && qty <= order.remaining
          && row.shares !== null && row.shares + qty <= 100n && !same(order.seller, from), '订单当前不可购买 / Order cannot be filled now.');
        const grossWei = uint(order.pricePerUnit * qty), buyerFeeWei = grossWei / 100n;
        const buyerPaymentWei = uint(grossWei + buyerFeeWei);
        return finish(tx(market, abi.ShareMarket, 'fill', [orderNumber, qty], buyerPaymentWei),
          { pool: target, quantity: qty, row, snapshot, orderId: orderNumber,
            marketTrade: Object.freeze({ grossWei, buyerFeeWei, sellerFeeWei: buyerFeeWei,
              buyerPaymentWei, sellerNetWei: grossWei - buyerFeeWei }),
            order: Object.freeze({ seller: order.seller, pricePerUnitWei: order.pricePerUnit, remaining: order.remaining }) });
      }
      if (kind === 'cancel') assert(same(order.seller, from), '只能撤销自己的挂单 / Only the seller can cancel.');
      if (kind === 'expire') assert(expiry <= timestamp, '挂单尚未到期 / Order has not expired.');
      // Cancellation/expiry intentionally remain available in Listed/Closed and for legacy expiry=0 orders.
      return finish(tx(market, abi.ShareMarket, kind, [orderNumber]), { pool: target, row, snapshot, orderId: orderNumber });
    }
  }

  const target = address(pool), { row, snapshot } = await poolSnapshot(target);
  const details = { pool: target, row, snapshot };
  if (['deposit', 'claim', 'harvest', 'withdrawBnb'].includes(kind)) {
    const qty = kind === 'deposit' ? shareQuantity(quantity) : undefined;
    if (kind === 'claim') assert(row.claimableBEM !== null && row.claimableBEM > 0n, '可领取收益待核对或为零 / No verified claimable BEM.');
    if (kind === 'withdrawBnb') assert(row.bnbOwed !== null && row.bnbOwed > 0n, '可领取 BNB 待核对或为零 / No verified withdrawable BNB.');
    if (kind === 'deposit') assert(row.unitPriceWei !== null && row.unitPriceWei > 0n && row.shares !== null
      && row.shares + qty <= 100n, '认购金额或持仓待核对 / Subscription amount or balance unavailable.');
    return finish(personalPoolAction(snapshot, target, from, kind, qty), { ...details, quantity: qty });
  }
  if (kind === 'list') {
    const qty = shareQuantity(quantity);
    assert(row.state === 2n && row.shareTradingAllowed === true && row.availableShares !== null && row.availableShares >= qty,
      '可售份额不足或当前暂停转让 / Shares unavailable or trading paused.');
    const priceWei = exactPrice(price);
    assert(priceWei >= MIN_SHARE_PRICE_WEI,
      '每份挂单价不得低于 0.00001 BNB / Minimum listing price is 0.00001 BNB per share.');
    const listingGross = priceWei * qty;
    assert(listingGross + listingGross / 100n < 2n ** 256n,
      '挂牌金额加买方手续费超出合约范围 / Listing plus buyer fee overflows the market.');
    return finish(tx(market, abi.ShareMarket, 'list', [target, qty, priceWei]),
      { ...details, quantity: qty, listingGrossWei: listingGross });
  }
  if (kind === 'withdrawDeposit') {
    assert(row.state === 0n && row.shares !== null && row.shares > 0n, '当前不可撤回认购 / Subscription cannot be withdrawn now.');
    return finish(tx(target, abi.PoolVault, kind), details);
  }
  if (kind === 'finalizeFailure') {
    assert(row.params && ((row.state === 0n && timestamp >= row.params.fundingDeadline)
      || (row.state === 1n && timestamp >= row.params.purchaseDeadline)), '尚未到退款时间 / Refund deadline not reached.');
    return finish(tx(target, abi.PoolVault, kind), details);
  }

  const governance = await readGovernanceSnapshot(provider, { factory, pool: target, account: from, blockNumber,
    stage: config.stage });
  assert(governance.blockHash.toLowerCase() === block.hash.toLowerCase() && governance.state === row.state,
    '治理区块与矿池快照不一致 / Governance snapshot mismatch.');
  const action = { kind, proposalId, support, priceWei: priceWei ?? (price === undefined ? undefined : exactPrice(price)),
    refPriceWei, refAt, expectedPool, expectedAccount, expectedProposalId, expectedPriceWei, expectedFeeBps, expectedFeeEpoch,
    delistAction, cancellationId, expectedListedProposalId };
  const prepared = governanceAction(governance, from, action);
  return finish(prepared.transaction, { ...details, governance, quote: prepared.quote });
}
