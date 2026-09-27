import { getAddress, parseEther, toQuantity, ZeroAddress } from 'ethers';
import { abi, uint, poolKey, readPoolSnapshot, personalPoolAction } from './chain-client.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);
const address = value => { const result = getAddress(value); assert(result !== ZeroAddress, '地址不能为零 / Zero address.'); return result; };
const ACTIONS = new Set(['deposit', 'claim', 'harvest', 'withdrawBnb', 'withdrawDeposit', 'finalizeFailure',
  'list', 'fill', 'cancel', 'expire', 'marketWithdraw', 'propose', 'vote', 'executeSale', 'cancelExpired', 'completeSale']);
const MARKET_ACTIONS = new Set(['list', 'fill', 'cancel', 'expire', 'marketWithdraw']);
const DAY = 86400n, WEEK = 7n * DAY;
const HASH = /^0x[0-9a-f]{64}$/i;
const good = (status, ...bits) => status?.trustError === 0n && bits.every(bit =>
  (status.validMask & (1n << BigInt(bit))) !== 0n && (status.errorMask & (1n << BigInt(bit))) === 0n);

export function shareQuantity(value) {
  assert(typeof value === 'string' || typeof value === 'bigint' || Number.isSafeInteger(value), '请输入整数份额 / Enter whole shares.');
  const text = String(value);
  assert(text === text.trim() && /^[1-9]\d{0,2}$/.test(text), '请输入 1–100 的整数份额 / Enter 1–100 whole shares.');
  const result = BigInt(text); assert(result <= 100n, '最多 100 份 / Maximum 100 shares.'); return result;
}

/** Prices are decimal BNB strings (or whole-BNB bigint), never binary floating-point Numbers. */
export function exactPrice(value, { allowZero = false } = {}) {
  assert(typeof value === 'string' || typeof value === 'bigint', '金额须使用精确十进制字符串 / Use an exact decimal amount.');
  const text = String(value);
  assert(text === text.trim() && /^(0|[1-9]\d{0,77})(\.\d{1,18})?$/.test(text), '请输入精确 BNB 金额，最多 18 位小数 / Enter an exact BNB amount.');
  const result = parseEther(text);
  assert(result < 2n ** 256n && (allowZero ? result >= 0n : result > 0n), '价格超出范围 / Price is outside the allowed range.');
  return result;
}

function id(value) {
  assert(typeof value === 'bigint' || typeof value === 'string' && value === value.trim() && /^[1-9]\d{0,77}$/.test(value), '编号须为精确正整数 / Use an exact positive ID.');
  const result = uint(value); assert(result > 0n, '编号须大于零 / ID must be positive.'); return result;
}

function currentProposal(p, timestamp) {
  return p && p.proposer !== ZeroAddress && p.snapshotTs <= timestamp && p.snapshotTs + DAY === p.endsAt
    && p.snapshotTotalShares === 100n && p.snapshotMemberCount > 0n && p.snapshotMemberCount <= 100n
    && p.yesCount <= p.snapshotMemberCount && p.yesShares <= 100n && p.price > 0n;
}
function passed(p, purchaseCost) {
  return p.yesCount * 2n > p.snapshotMemberCount
    && (p.price < purchaseCost ? p.yesShares >= 60n : p.yesShares * 2n > p.snapshotTotalShares);
}

/**
 * All reads and the initial simulation use one canonical latest block. This returns an unsigned
 * preview, never a signature or send; the transaction service must simulate latest again before signing.
 */
export async function prepareProductAction({ provider, config, account, pool, kind, quantity, price, proposalId, support, orderId }) {
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
  const market = MARKET_ACTIONS.has(kind) ? configured('shareMarket') : null;
  assert(!same(factory, lens) && (!market || !same(market, factory) && !same(market, lens)), '部署地址重复 / Duplicate deployment addresses.');
  const request = (method, params = []) => provider.request({ method, params });
  assert(BigInt(await request('eth_chainId')) === 56n, '请切换到 BSC / Switch to BSC.');
  const block = await request('eth_getBlockByNumber', ['latest', false]);
  assert(block && HASH.test(block.hash ?? '') && /^0x[\da-f]+$/i.test(block.number ?? '')
    && /^0x[\da-f]+$/i.test(block.timestamp ?? ''), '区块信息无效 / Invalid block header.');
  const blockNumber = uint(BigInt(block.number)), timestamp = uint(BigInt(block.timestamp)), blockTag = toQuantity(blockNumber);
  const call = async (to, contract, method, args = []) => contract.decodeFunctionResult(method,
    await request('eth_call', [{ to, data: contract.encodeFunctionData(method, args) }, blockTag]));
  const tx = (to, contract, method, args = [], value = 0n) => Object.freeze({ chainId: '0x38', from,
    to: address(to), data: contract.encodeFunctionData(method, args), value: toQuantity(uint(value)) });

  async function finish(transaction, details = {}) {
    const { chainId: _chainId, ...unsigned } = transaction;
    // The return bytes must also match the ABI, including calls returning booked amounts/order IDs.
    const contract = market && same(transaction.to, market) ? abi.ShareMarket : abi.PoolVault;
    const parsed = contract.parseTransaction(transaction);
    const output = await request('eth_call', [unsigned, blockTag]);
    contract.decodeFunctionResult(parsed.fragment, output);
    const after = await request('eth_getBlockByNumber', [blockTag, false]);
    assert(after?.hash?.toLowerCase() === block.hash.toLowerCase() && BigInt(after?.number ?? -1) === blockNumber
      && BigInt(after?.timestamp ?? -1) === timestamp && BigInt(await request('eth_chainId')) === 56n,
    '读取期间区块或网络已变化，请重新确认 / Chain changed; prepare again.');
    return Object.freeze({ transaction, kind: kind === 'marketWithdraw' ? 'withdrawBnb' : kind,
      requestKind: kind, pool: null, ...details, checkedBlock: Object.freeze({ blockNumber, blockHash: block.hash, timestamp }) });
  }

  async function poolSnapshot(target) {
    const snapshot = await readPoolSnapshot(provider, { factory, account: from, pools: [target], blockNumber });
    const row = snapshot.pools[0];
    assert(same(snapshot.lens, lens) && snapshot.blockHash.toLowerCase() === block.hash.toLowerCase() && snapshot.timestamp === timestamp,
      '矿池读取与部署或区块不一致 / Pool deployment or block mismatch.');
    assert(snapshot.pools.length === 1 && row?.trusted && same(row.pool, target) && row.key === poolKey(factory, target),
      '矿池身份未验证 / Unverified pool.');
    return { row, snapshot };
  }

  if (market) {
    assert(same((await call(market, abi.ShareMarket, 'factory'))[0], factory), '市场身份不匹配 / Market identity mismatch.');
    assert(same((await call(factory, abi.PoolFactory, 'shareMarket'))[0], market), '市场登记不匹配 / Market registration mismatch.');
    if (kind === 'marketWithdraw') {
      assert((await call(market, abi.ShareMarket, 'bnbOwed', [from]))[0] > 0n, '暂无可领取市场余额 / No market BNB to withdraw.');
      return finish(tx(market, abi.ShareMarket, 'withdrawBnb'));
    }
    if (kind !== 'list') {
      const orderNumber = id(orderId), order = (await call(market, abi.ShareMarket, 'orders', [orderNumber]))[0];
      const expiry = (await call(market, abi.ShareMarket, 'orderExpiresAt', [orderNumber]))[0];
      assert(order.active === true && order.remaining > 0n && order.remaining <= 100n, '订单已结束 / Order is no longer active.');
      const target = address(order.pool); address(order.seller);
      if (pool !== undefined && pool !== null) assert(same(target, pool), '订单对应矿池已变化 / Order pool mismatch.');
      const { row, snapshot } = await poolSnapshot(target);
      if (kind === 'fill') {
        const qty = shareQuantity(quantity);
        assert(row.state === 2n && row.shareTradingAllowed === true && expiry > timestamp && qty <= order.remaining
          && row.shares !== null && row.shares + qty <= 100n && !same(order.seller, from), '订单当前不可购买 / Order cannot be filled now.');
        return finish(tx(market, abi.ShareMarket, 'fill', [orderNumber, qty], uint(order.pricePerUnit * qty)),
          { pool: target, quantity: qty, row, snapshot, orderId: orderNumber });
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
    return finish(tx(market, abi.ShareMarket, 'list', [target, qty, exactPrice(price, { allowZero: true })]), { ...details, quantity: qty });
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

  const gov = (await call(lens, abi.PoolLens, 'governance', [target, from]))[0];
  assert(good(gov.status, 0, 1) && row.state !== null && gov.state === row.state, '治理信息无法验证 / Governance unavailable.');
  const p = gov.proposal;
  if (kind === 'propose') {
    assert(row.state === 2n && row.shares !== null && row.shares > 0n && row.activatedAt !== null
      && timestamp >= row.activatedAt + WEEK && good(gov.status, 2), '尚不可发起出售提案 / Proposal unavailable.');
    if (gov.activeProposalId !== 0n) {
      assert(good(gov.status, 3) && (p.executed || timestamp >= p.endsAt) && timestamp >= p.endsAt + WEEK - DAY,
        '当前提案仍有效或处于提案冷却期 / Active proposal or proposal cooldown.');
    }
    const lastProposed = (await call(target, abi.PoolVault, 'lastProposed', [from]))[0];
    assert(lastProposed === 0n || timestamp >= lastProposed + WEEK, '尚在个人提案冷却期 / Proposal cooldown.');
    return finish(tx(target, abi.PoolVault, kind, [exactPrice(price), 0n, 0n]), details);
  }
  if (kind === 'vote' || kind === 'executeSale') {
    const proposalNumber = id(proposalId);
    assert(good(gov.status, 2, 3, 4, 10) && gov.activeProposalId === proposalNumber, '提案已变化或数据不完整 / Proposal changed or incomplete.');
    assert(row.state === 2n && currentProposal(p, timestamp) && !p.executed && timestamp < p.endsAt,
      '提案已结束或版本不受支持 / Proposal expired or unsupported.');
    if (kind === 'vote') {
      assert(typeof support === 'boolean', '投票选项无效 / Invalid vote.');
      assert(good(gov.status, 5, 6, 11) && gov.canVote === true && !gov.hasVoted && gov.snapshotShares > 0n,
        '当前不能投票 / Voting unavailable.');
    } else assert(good(gov.status, 13) && gov.canExecute === true && gov.passed === true && passed(p, gov.purchaseCost),
      '提案尚未通过 / Proposal has not passed.');
    return finish(tx(target, abi.PoolVault, kind, kind === 'vote' ? [proposalNumber, support] : [proposalNumber]), details);
  }
  if (kind === 'cancelExpired') {
    assert(good(gov.status, 7, 8, 12) && row.state === 3n && gov.listedProposalId > 0n
      && timestamp >= gov.expiresAt && gov.canCancelExpired === true, '尚不可解除挂牌 / Listing cannot be cleared.');
    return finish(tx(target, abi.PoolVault, kind), details);
  }
  if (kind === 'completeSale') {
    assert(good(gov.status, 2, 3, 4, 7, 8, 9, 10) && row.state === 3n && gov.listedProposalId > 0n
      && gov.activeProposalId === gov.listedProposalId && currentProposal(p, timestamp) && p.executed === true
      && gov.passed === true && passed(p, gov.purchaseCost) && gov.salePrice === p.price && gov.salePrice > 0n
      && gov.expiresAt > timestamp, '整机挂牌不可成交 / Listing is unavailable.');
    return finish(tx(target, abi.PoolVault, kind, [], gov.salePrice), details);
  }
  throw new Error('不支持的操作 / Unsupported action.');
}
