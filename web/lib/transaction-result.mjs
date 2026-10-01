const HASH = /^0x[0-9a-f]{64}$/i;
const ACTIONS = {
  deposit: ['认购份额', 'Share subscription'],
  withdrawDeposit: ['撤回认购', 'Subscription withdrawal'],
  withdrawBnb: ['领取 BNB', 'BNB withdrawal'],
  claim: ['领取 BEM', 'BEM claim'],
  harvest: ['归集收益', 'Reward collection'],
  list: ['出售份额', 'Share listing'],
  fill: ['购买份额', 'Share purchase'],
  cancel: ['撤销挂单', 'Listing cancellation'],
  expire: ['解除过期挂单', 'Expired listing release'],
  propose: ['发起出售提案', 'Sale proposal'],
  vote: ['投票', 'Vote'],
  executeSale: ['执行出售', 'Sale execution'],
  cancelExpired: ['取消过期出售', 'Expired sale cancellation'],
  completeFirstoSale: ['结算出售', 'Sale settlement'],
  finalizeFailure: ['结束募集', 'Funding closure'],
  claimBem: ['领取项目 BEM', 'Project BEM claim'],
  collectChildBem: ['归集矿机 BEM', 'Miner BEM collection'],
  finalizeFundingFailure: ['结束项目募集并开启退款', 'Project funding closure and refund opening'],
  claimFailedFunding: ['结算募集退款', 'Funding refund settlement'],
  finalizeAcquisition: ['结束项目购机并结算余款', 'Project acquisition closure and surplus settlement'],
  transfer: ['转移项目份额', 'Project share transfer'],
  proposeChildSale: ['发起矿机出售提案', 'Miner sale proposal'],
  voteChildSale: ['矿机出售投票', 'Miner sale vote'],
  executeChildSale: ['执行矿机出售', 'Miner sale execution'],
  settleChildSale: ['结算矿机卖款', 'Miner sale proceeds settlement'],
  expireChildSale: ['取消过期矿机出售', 'Expired miner sale cancellation'],
  marketList: ['挂卖项目份额', 'Project share listing'],
  marketFill: ['购买项目份额', 'Project share purchase'],
  marketCancel: ['撤销项目挂单', 'Project listing cancellation'],
  marketExpire: ['解除到期项目挂单', 'Expired project listing release'],
  marketWithdraw: ['领取市场 BNB', 'Market BNB withdrawal'],
  createPortfolio: ['创建预算项目', 'Budget project creation'],
  createPool: ['创建矿池', 'Mining pool creation'],
};

const receiptStatus = value => value === 0 || value === '0x0' || value === '0'
  ? 0 : value === 1 || value === '0x1' || value === '1' ? 1 : null;
const hasBlock = value => Number.isSafeInteger(value) && value >= 0
  || typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);

export function transactionExplorerUrl(hash) {
  return HASH.test(hash ?? '') ? `https://bscscan.com/tx/${hash}` : null;
}

function transactionHash(input) {
  return [input?.transactionHash, input?.hash, input?.record?.hash,
    input?.receipt?.transactionHash, input?.receipt?.hash]
    .find(value => typeof value === 'string' && HASH.test(value)) ?? null;
}

function errorParts(input) {
  const parts = [], seen = new Set();
  const visit = (error, depth = 0) => {
    if (!error || typeof error !== 'object' || seen.has(error) || depth > 5) return;
    seen.add(error); parts.push(error);
    for (const nested of [error.cause, error.error, error.data?.originalError, error.info?.error]) visit(nested, depth + 1);
  };
  visit(input);
  return parts;
}

function failureReason(input) {
  const errors = errorParts(input);
  const messages = errors.flatMap(error => [error.shortMessage, error.message, error.reason])
    .filter(value => typeof value === 'string').join(' ');
  if (errors.some(error => error.code === 'INSUFFICIENT_FUNDS') || /insufficient funds|余额不足/i.test(messages)) return 'funds';
  if (/out of gas|gas limit|gas 不足/i.test(messages)) return 'gas';
  return 'reverted';
}

/**
 * Only use `member-receipt` for a fresh readMemberReceipt return, never for
 * restored local history. A hash, a timeout or a wallet warning is not a result.
 */
export function normalizeTransactionResult(input, { source = 'journal', locale = 'zh', action } = {}) {
  if (!input || typeof input !== 'object') return null;
  const hash = transactionHash(input), receipt = input.receipt;
  const status = receiptStatus(receipt?.status);
  let kind = null, reason = null;

  // Pending takes precedence even when a wallet error is attached to an intent.
  if (['pending', 'idle', 'awaiting-signature', 'awaiting-login-signature'].includes(input.status)) return null;
  if (source === 'journal' && input.finalized === true && hash) {
    if (input.status === 'confirmed' && status === 1) kind = 'success';
    else if (['reverted', 'failed'].includes(input.status) && status === 0) kind = 'failed';
    else if (input.status === 'cancelled' && status === 1) { kind = 'cancelled'; reason = 'on-chain'; }
    else if (input.status === 'replaced' && (status === 0 || status === 1 && input.plainEoaReplacementVerified === true)) kind = 'replaced';
  } else if (source === 'member-receipt' && hash && hasBlock(input.blockNumber)) {
    if (input.status === 'confirmed') kind = 'success';
    else if (input.status === 'failed') kind = 'failed';
  } else if (source === 'wallet') {
    if (hash && status === 0 && hasBlock(receipt.blockNumber)) kind = 'failed';
    else if (!hash && errorParts(input).some(error => Number(error.code) === 4001 || error.code === 'ACTION_REJECTED')) {
      kind = 'cancelled'; reason = 'wallet';
    }
  }
  if (!kind) return null;
  if (kind === 'failed') reason = failureReason(input);
  const result = {
    kind, hash, action: action ?? input.action?.kind ?? input.action ?? input.record?.action?.kind ?? input.record?.action ?? null,
    reason, explorerUrl: transactionExplorerUrl(hash),
    key: hash ? `${hash.toLowerCase()}:${kind}` : null,
  };
  return { ...result, ...transactionResultText(result, locale) };
}

export function transactionResultText(result, locale = 'zh') {
  const english = locale === 'en', L = (zh, en) => english ? en : zh;
  const action = ACTIONS[result?.action]?.[english ? 1 : 0];
  switch (result?.kind) {
    case 'success': return { title: L('交易成功', 'Transaction successful'),
      message: action ? L(`${action}已在链上确认。`, `${action} confirmed on chain.`) : L('本次操作已在链上确认。', 'Your transaction is confirmed on chain.') };
    case 'failed': return { title: L('交易失败', 'Transaction failed'), message: result.reason === 'funds'
      ? L('交易未完成，钱包余额不足。', 'The transaction did not complete because the wallet has insufficient funds.')
      : result.reason === 'gas' ? L('交易执行时 Gas 不足，本次操作未完成。', 'The transaction ran out of gas. The action did not complete.')
      : L('合约执行已回滚，本次操作未完成。', 'The contract reverted the transaction. The action did not complete.') };
    case 'cancelled': return { title: L('交易已取消', 'Transaction cancelled'), message: result.reason === 'on-chain'
      ? L('取消交易已在链上确认，原操作未执行。', 'The cancellation is confirmed on chain. The original action did not execute.')
      : L('你已取消钱包请求，本次操作未发送。', 'You cancelled the wallet request. The action was not submitted.') };
    case 'replaced': return { title: L('交易已被替换', 'Transaction replaced'),
      message: L('钱包使用了替换交易，原操作未执行。', 'The wallet used a replacement transaction. The original action did not execute.') };
    default: return { title: '', message: '' };
  }
}
