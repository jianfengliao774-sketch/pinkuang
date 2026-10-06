import { displayPreciseAmount } from './amount-display.mjs';

// Presentation only. The index serializes uint fields as decimal strings; never
// infer an actor, a payment, or an amount from the transaction/contract address.
const uint = value => {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (typeof text !== 'string' || !/^(0|[1-9]\d*)$/.test(text) || text.length > 78) return null;
  const result = BigInt(text);
  return result < 2n ** 256n ? result : null;
};
const address = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? value : null;
const money = (key, zh, en, symbol = 'BNB') => ({ key, zh, en, symbol, type: 'money' });
const count = (key, zh, en) => ({ key, zh, en, type: 'count' });
const who = (key, zh, en) => ({ key, zh, en, type: 'address' });
const proposal = count('proposalId', '提案', 'Proposal');
const order = count('orderId', '订单', 'Order');
const member = who(['user', 'member'], '账户', 'Account');
const child = who('child', '子矿池', 'Child pool');
const shares = count('shares', '份数', 'Shares');
const definition = (zh, en, zhDescription, enDescription, details = []) => ({
  label: [zh, en], description: [zhDescription, enDescription], details,
});

// Mirrors the public index event allowlist, not every possible contract event.
// Each field below is named in that event's ABI. Missing/invalid fields are omitted.
const definitions = Object.freeze({
  PoolCreated: definition('创建单矿机项目', 'Single-miner project created',
    '创建单矿机项目并设定募集条件；此记录不是认购付款。', 'Created a single-miner project and its funding terms; this is not a subscription payment.',
    [who('pool', '项目', 'Project'), count('circuitId', '矿机编号', 'Miner ID'), money('targetRaise', '募集目标', 'Funding target'), money('priceCap', '购机上限', 'Purchase cap')]),
  PortfolioCreated: definition('创建多矿机项目', 'Multi-miner project created',
    '创建按预算采购多台矿机的项目；此记录不是认购付款。', 'Created a budget project for multiple miners; this is not a subscription payment.',
    [who('portfolio', '项目', 'Project'), money('budgetWei', '募集预算', 'Funding budget'), money('absoluteCapWei', '单机总价上限', 'Per-miner price cap')]),
  Deposited: definition('认购项目份额', 'Project shares subscribed',
    '账户支付 BNB 认购项目份额。', 'The account paid BNB to subscribe for project shares.', [member, shares, money('amount', '认购款', 'Subscription payment')]),
  DepositWithdrawn: definition('撤回认购并记入退款', 'Subscription withdrawn; refund credited',
    '撤回全部认购；退款已记入账户待领取 BNB，尚不代表钱包收到款项。', 'Withdrew the subscription and credited claimable BNB; this does not itself pay the wallet.', [member, shares, money('amount', '待领取退款', 'Refund credit')]),
  Funded: definition('项目募集完成', 'Project fully funded',
    '已达到募集目标，进入购机阶段。', 'The funding target was reached and the purchase phase started.', [money('totalRaised', '已募集', 'Raised'), count('totalShares', '总份数', 'Total shares'), count('memberCount', '成员数', 'Members')]),
  Failed: definition('项目进入退款阶段', 'Project entered refund phase',
    '项目进入退款阶段；成员仍需领取已记账 BNB。', 'The project entered the refund phase; members still need to withdraw credited BNB.'),
  Purchased: definition('矿机购入项目', 'Miner purchased by project',
    '项目完成购机，矿机已进入矿池；不代表挖矿已启动。', 'The project completed a miner purchase; this does not by itself confirm mining has started.', [money('cost', '采购成本', 'Purchase cost')]),
  FirstoPurchased: definition('Firsto 采购明细', 'Firsto purchase breakdown',
    '记录同一次购机的卖价、来源费用和总成本，不是另一次付款。', 'Breaks down the same purchase into seller price, source fee and total cost; not another payment.', [count('circuitId', '矿机编号', 'Miner ID'), money('sellerPrice', '卖方价格', 'Seller price'), money('sourceFee', '来源费用', 'Source fee'), money('totalCost', '总成本', 'Total cost')]),
  ChildPurchased: definition('多矿机项目购入矿机', 'Miner added to multi-miner project',
    '预算项目完成该台矿机采购，并登记对应子矿池。', 'The budget project purchased this miner and registered its child pool.', [child, count('tokenId', '矿机编号', 'Miner ID'), money('cost', '采购成本', 'Purchase cost')]),
  AcquisitionFinalized: definition('结束购机并结算余款', 'Acquisition ended; surplus allocated',
    '购机阶段结束并计算可退余款；成员仍需领取 BNB。', 'The purchase phase ended and refundable surplus was calculated; members still need to withdraw BNB.', [count('children', '已购矿机数', 'Miners purchased'), money('spent', '购机支出', 'Purchase spending'), money('officialFee', '官网采购费用', 'Official purchase fee'), money('refundableToMembers', '成员可退余款', 'Member refundable surplus')]),
  PurchaseSurplusSettled: definition('购机余款记入账户', 'Purchase surplus credited',
    '购机余款记入该账户待领取 BNB；尚不代表钱包收到款项。', 'Purchase surplus was credited as claimable BNB; this does not itself pay the wallet.', [member, shares, money('amount', '余款入账', 'Surplus credit')]),
  Harvested: definition('矿池归集挖矿收益', 'Mining rewards collected by pool',
    '矿池归集 BEM，并记录平台、销毁和成员分配；个人领取另有记录。', 'The pool collected BEM and recorded platform, burn and member allocations; wallet claims are separate.', [money('gross', '归集总额', 'Gross collected', 'BEM'), money('toPlatform', '平台分配', 'Platform allocation', 'BEM'), money('burned', '销毁', 'Burned', 'BEM'), money('toMembers', '成员分配', 'Member allocation', 'BEM')]),
  BemCollected: definition('多矿机项目归集收益', 'Multi-miner project collected rewards',
    'BEM 从子矿池转入预算项目，供项目成员按权益领取。', 'BEM moved from the child pool into the budget project for members to claim.', [child, money('received', '项目收到', 'Project received', 'BEM')]),
  ChildHarvestFailed: definition('子矿池收益归集未完成', 'Child reward harvest did not complete',
    '本次尝试归集子矿池新增收益未完成；不代表已有收益丢失。', 'This attempt to harvest new child-pool rewards did not complete; it does not mean existing rewards were lost.', [child]),
  BemClaimed: definition('账户领取 BEM', 'BEM paid to account',
    '已记账的 BEM 收益转入领取账户。', 'Booked BEM rewards were transferred to the claiming account.', [member, money('amount', '已领取', 'Claimed', 'BEM')]),
  BnbWithdrawn: definition('账户领取 BNB', 'BNB paid to account',
    '合约将待领取 BNB 转入账户；本事件未单独区分退款、余款或卖款。', 'The contract paid claimable BNB to the account; this event does not separately identify refunds, surplus or sale proceeds.', [member, money('amount', '已领取', 'Withdrawn')]),
  Transfer: definition('项目份额变更', 'Project shares changed',
    '记录项目份额从转出地址到转入地址的变化；本事件不记录成交价。', 'Records a change in project shares between addresses; this event does not record a sale price.', [who('from', '转出', 'From'), who('to', '转入', 'To'), count('value', '份数', 'Shares')]),
  OrderListed: definition('挂卖项目份额', 'Project shares listed for sale',
    '卖方挂出项目份额，等待买方成交。', 'The seller listed project shares for buyers to fill.', [order, who('seller', '卖方', 'Seller'), count('amount', '挂卖份数', 'Shares listed'), money('pricePerUnit', '每份基价', 'Base price per share')]),
  OrderExpirySet: definition('设置份额挂单到期时间', 'Share order expiry set',
    '为份额挂单记录链上到期时间。', 'Recorded the share order expiration time on-chain.', [order]),
  OrderFilled: definition('项目份额成交', 'Project shares traded',
    '买方购入份额；成交基价与卖方费用如下，买方额外费用另有记录。', 'The buyer acquired shares; the base price and seller fee are below. Any additional buyer fee is recorded separately.', [order, who('buyer', '买方', 'Buyer'), count('amount', '成交份数', 'Shares traded'), money('gross', '成交基价', 'Base price'), money('fee', '卖方费用', 'Seller fee')]),
  BuyerFeeCharged: definition('收取份额买方费用', 'Share buyer fee charged',
    '记录买方在份额成交基价之外支付的额外费用。', 'Records the extra fee paid by the buyer in addition to the share trade base price.', [order, who('buyer', '买方', 'Buyer'), money('buyerFee', '买方费用', 'Buyer fee')]),
  OrderCancelled: definition('份额挂单已解除', 'Share order released',
    '撤销或清理到期挂单，剩余未成交份额解除锁定；本事件不区分两种触发方式。', 'Cancelled or expired the order and unlocked unfilled shares; this event does not distinguish the trigger.', [order, who('seller', '卖方', 'Seller'), count('remaining', '未成交份数', 'Unfilled shares')]),
  SaleProposed: definition('发起整机出售提案', 'Miner sale proposed',
    '成员提出矿机出售价格，等待治理表决。', 'A member proposed a miner sale price for governance voting.', [proposal, who('proposer', '发起人', 'Proposer'), money('price', '提议售价', 'Proposed price')]),
  Voted: definition('提交整机出售表决', 'Miner-sale vote submitted',
    '成员对整机出售提案提交表决。', 'A member voted on the miner-sale proposal.', [proposal, who('voter', '投票人', 'Voter'), count('weight', '表决份数', 'Voting shares')]),
  SaleSnapshotRecorded: definition('记录出售表决快照', 'Sale voting snapshot recorded',
    '记录本次提案使用的成员数与份额快照，不是资金支付。', 'Recorded member and share counts for this proposal; this is not a payment.', [proposal, count('members', '成员数', 'Members'), shares]),
  SaleListed: definition('整机进入出售状态', 'Miner offered for sale',
    '提案已执行，矿机按记录价格等待成交；不代表已成交。', 'The proposal was executed and the miner awaits a buyer at the recorded price; it has not yet sold.', [proposal, money('price', '出售价格', 'Sale price')]),
  SaleCompleted: definition('整机出售完成', 'Miner sale completed',
    '记录整机成交收入及分配；成员所得需按合约领取。', 'Records miner-sale proceeds and allocations; members still claim their entitlement through the contract.', [money('gross', '成交基价', 'Base sale price'), money('toPlatform', '平台分配', 'Platform allocation'), money('toMembers', '成员分配', 'Member allocation'), money('burnedBem', '销毁', 'Burned', 'BEM')]),
  FirstoSaleCompleted: definition('Firsto 整机成交明细', 'Firsto miner-sale breakdown',
    '记录同一次整机出售的买方、成交基价和额外买方费用，不是第二次出售。', 'Records the buyer, base price and extra buyer fee of the same miner sale; this is not another sale.', [proposal, who('buyer', '买方', 'Buyer'), money('gross', '成交基价', 'Base sale price'), money('takerFee', 'Firsto 买方费用', 'Firsto buyer fee')]),
  SaleExpired: definition('整机出售到期解除', 'Miner sale expired',
    '整机出售已到期并解除挂牌，本事件不是成交记录。', 'The expired miner offer was released; this is not a sale.', [proposal]),
  SaleDelistingProposed: definition('发起整机撤单提案', 'Miner delisting proposed',
    '成员提出撤销当前整机挂单，等待表决。', 'A member proposed cancelling the current miner listing, pending a vote.', [count('cancellationId', '撤单提案', 'Cancellation proposal'), count('listedProposalId', '出售提案', 'Sale proposal'), who('proposer', '发起人', 'Proposer')]),
  SaleDelistingVoted: definition('提交整机撤单表决', 'Miner-delisting vote submitted',
    '成员对撤销整机挂单提交表决。', 'A member voted on cancelling the miner listing.', [count('cancellationId', '撤单提案', 'Cancellation proposal'), who('voter', '投票人', 'Voter'), count('weight', '表决份数', 'Voting shares')]),
  SaleDelisted: definition('整机挂单已撤销', 'Miner listing cancelled',
    '撤单提案已执行，整机解除挂牌；本事件不是成交记录。', 'The delisting proposal was executed and the miner listing cancelled; this is not a sale.', [proposal, count('cancellationId', '撤单提案', 'Cancellation proposal')]),
  SaleProceedsSettled: definition('整机卖款记入账户', 'Miner-sale proceeds credited',
    '卖款记入该账户待领取 BNB；尚不代表钱包收到款项。', 'Sale proceeds were credited as claimable BNB; this does not itself pay the wallet.', [member, shares, money('amount', '卖款入账', 'Sale credit')]),
  SaleReviewed: definition('审核整机出售提案', 'Miner-sale proposal reviewed',
    '运营账户记录出售审核结果；审核不等于成交。', 'An operator recorded a sale review decision; a review is not a sale.', [proposal, who('operator', '审核账户', 'Reviewer'), money('priceWei', '审核售价', 'Reviewed price')]),
  ChildSaleProposed: definition('发起项目内矿机出售', 'Child-miner sale proposed',
    '为多矿机项目中的一台矿机提出出售提案。', 'Proposed selling one miner in the multi-miner project.', [proposal, child, money('price', '提议售价', 'Proposed price')]),
  ChildSaleVoted: definition('提交项目内矿机表决', 'Child-miner sale vote submitted',
    '项目成员对指定子矿机的出售提案提交表决。', 'A project member voted on selling the specified child miner.', [proposal, member, shares]),
  ChildSaleApproved: definition('执行项目内矿机挂牌', 'Child-miner sale listing executed',
    '出售提案已执行，指定子矿机进入出售流程；不代表已成交。', 'The sale proposal was executed for the child miner; this does not mean it has sold.', [proposal, child]),
  ChildSaleSettled: definition('子矿机卖款归集到项目', 'Child-miner proceeds received by project',
    '子矿机卖款已转入预算项目，成员再按权益领取 BNB。', 'Child-miner sale proceeds moved into the budget project; members then claim their BNB entitlement.', [child, money('netProceeds', '项目收到净额', 'Net received by project')]),
  ChildSaleExpired: definition('解除项目内到期出售提案', 'Expired child-sale proposal released',
    '清理到期子矿机出售提案，本事件不是成交记录。', 'Released an expired child-miner sale proposal; this is not a sale.', [proposal]),
  ChildSaleReviewed: definition('审核项目内矿机出售', 'Child-miner sale reviewed',
    '运营账户记录该子矿机提案的审核结果；审核不等于成交。', 'An operator recorded the child-sale review decision; a review is not a sale.', [proposal, who('operator', '审核账户', 'Reviewer')]),
  LockedSharesChanged: definition('更新份额锁定数量', 'Locked share count updated',
    '记录账户的锁定份额变化，本事件不是份额成交。', 'Records a change in locked shares; this is not a share trade.', [member, count('previousLocked', '此前锁定', 'Previously locked'), count('currentLocked', '当前锁定', 'Currently locked')]),
  FlexiblePurchaseConfigured: definition('设置灵活替代购机条件', 'Flexible replacement terms configured',
    '记录参考矿机与最低已验证算力条件，本事件不是采购。', 'Recorded the reference miner and minimum verified weight; this is not a purchase.', [count('referenceCircuitId', '参考矿机编号', 'Reference miner ID'), count('minVerifiedWeight', '最低已验证权重', 'Minimum verified weight')]),
  AlternativeMinerSelected: definition('选用替代矿机', 'Replacement miner selected',
    '记录本次采购的替代矿机与原参考矿机。', 'Records the replacement miner acquired and the original reference miner.', [count('referenceCircuitId', '参考矿机编号', 'Reference miner ID'), count('acquiredCircuitId', '购入矿机编号', 'Acquired miner ID')]),
  PurchaseModelLocked: definition('锁定购机任务型号', 'Purchase task model locked',
    '记录项目锁定的矿机任务型号约束，本事件不是采购。', 'Recorded the project purchase task-model restriction; this is not a purchase.', [count('taskId', '任务编号', 'Task ID')]),
  PurchaseReferenceWeightLocked: definition('锁定购机参考权重', 'Purchase reference weight locked',
    '记录购机参考矿机的已验证权重，本事件不是采购。', 'Recorded the purchase reference miner verified weight; this is not a purchase.', [count('verifiedWeight', '已验证权重', 'Verified weight')]),
});

export const DESCRIBED_ACTIVITY_EVENTS = Object.freeze(Object.keys(definitions));

export function describeActivity(row, locale = 'zh') {
  const en = locale === 'en', text = (zh, english) => en ? english : zh;
  const rawEvent = typeof (row?.event ?? row?.name) === 'string' ? row.event ?? row.name : '';
  const d = Object.hasOwn(definitions, rawEvent) ? definitions[rawEvent] : null;
  if (!d) return { label: text('其他链上记录', 'Other on-chain record'), description: text('该事件暂未提供操作说明，请查看原始事件或交易详情。', 'No description is available for this event; see the raw event or transaction.'), rawEvent, facts: [] };
  const fields = row.fields ?? row.args ?? {}, facts = [];
  for (const spec of d.details) {
    const keys = Array.isArray(spec.key) ? spec.key : [spec.key];
    const value = keys.map(key => fields[key]).find(value => value !== undefined);
    const parsed = spec.type === 'address' ? address(value) : uint(value);
    if (parsed === null) continue;
    const shown = spec.type === 'money' ? `${displayPreciseAmount(parsed, spec.symbol === 'BEM' ? 8 : 18)} ${spec.symbol}`
      : spec.type === 'address' ? `${parsed.slice(0, 6)}…${parsed.slice(-4)}` : parsed.toString();
    facts.push({ label: text(spec.zh, spec.en), value: shown, exact: String(parsed) });
  }
  if (['Voted', 'ChildSaleVoted'].includes(rawEvent) && typeof fields.support === 'boolean')
    facts.push({ label: text('表决', 'Vote'), value: fields.support ? text('赞成', 'For') : text('反对', 'Against') });
  if (['SaleReviewed', 'ChildSaleReviewed'].includes(rawEvent) && typeof fields.approved === 'boolean')
    facts.push({ label: text('审核结果', 'Review decision'), value: fields.approved ? text('通过', 'Approved') : text('未通过', 'Not approved') });
  if (rawEvent === 'ChildPurchased' && typeof fields.official === 'boolean')
    facts.push({ label: text('采购来源', 'Purchase venue'), value: fields.official ? text('官网市场', 'Official market') : 'Firsto' });
  let description = d.description[en ? 1 : 0];
  if (rawEvent === 'Failed' && [0n, 1n].includes(uint(fields.reason))) description = uint(fields.reason) === 0n
    ? text('募集截止时未满募，进入退款阶段；成员仍需领取 BNB。', 'Funding ended below target; members can withdraw their credited BNB.')
    : text('购机期限已过仍未完成采购，进入退款阶段；成员仍需领取 BNB。', 'The purchase deadline passed without a purchase; members can withdraw their credited BNB.');
  if (rawEvent === 'Transfer') {
    if (address(fields.from)?.toLowerCase() === '0x0000000000000000000000000000000000000000') description = text('项目向账户增发份额；认购付款见对应认购记录，不重复计算。', 'The project minted shares to the account; see the subscription record for payment, without counting it twice.');
    else if (address(fields.to)?.toLowerCase() === '0x0000000000000000000000000000000000000000') description = text('账户份额被销毁；本事件未记录退款金额或是否已经提款。', 'Account shares were burned; this event does not record a refund amount or confirm withdrawal.');
  }
  return { label: d.label[en ? 1 : 0], description, rawEvent, facts };
}
