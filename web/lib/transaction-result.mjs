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

/** An earlier journal transaction is evidence about that operation, never this new request. */
export function authorityRejectionResult(input, { locale = 'zh', action } = {}) {
  const relay = input?.relayResult;
  if (input?.submissionRejected !== true || relay?.accepted !== false) return null;
  const L = (zh, en) => locale === 'en' ? en : zh;
  const hash = HASH.test(relay.hash ?? '') ? relay.hash : null;
  const previousFailed = relay.status === 'failed' && relay.reason === 'transaction-reverted';
  const reason = previousFailed
    ? L('旧交易执行已回滚，原操作未完成。', 'The earlier transaction reverted; its action did not complete.')
    : L('旧操作的链上结果仍需核对。', 'The earlier operation still needs its on-chain result checked.');
  const guidance = previousFailed && relay.archived === true
    ? L('旧失败已核验并归档。本次创建请求未发送；请核对矿机是否已有项目，重新预览后再签名创建。',
      'The earlier failure is verified and archived. This creation request was not sent; check whether the miner already has a project, then preview and sign a new request.')
    : L('本次新请求未被接受。请核对旧操作状态，结果不明时不要重复创建。',
      'This new request was not accepted. Check the earlier operation; do not retry creation while its outcome is unknown.');
  return { kind: previousFailed ? 'failed' : 'pending', reason: 'publication', action, hash,
    key: `${relay.requestId}:rejected`,
    title: L(previousFailed ? '旧操作失败，本次创建未发送' : '本次请求未被接受',
      previousFailed ? 'Earlier operation failed; this creation was not sent' : 'This request was not accepted'),
    message: `${reason} ${guidance}` };
}

export function authorityPreviousFailureNotice(input, locale = 'zh') {
  const previous = input?.previousFailure;
  if (input?.accepted !== true || previous?.archived !== true || previous.status !== 'reverted'
    || !HASH.test(previous.hash ?? '') || !HASH.test(previous.operationId ?? '')) return null;
  return { hash: previous.hash, message: locale === 'en'
    ? 'The earlier transaction reverted and has been verified and archived. The new request was accepted separately; this does not confirm creation.'
    : '旧交易执行已回滚，失败已核验并归档。本次新请求已单独接受，尚不代表项目创建成功。' };
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
