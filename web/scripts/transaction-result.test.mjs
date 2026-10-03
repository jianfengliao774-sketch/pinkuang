import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTransactionResult, transactionExplorerUrl, transactionResultText } from '../lib/transaction-result.mjs';

const hash = `0x${'a'.repeat(64)}`;
const confirmed = { status: 'confirmed', finalized: true, transactionHash: hash,
  action: 'cancel', receipt: { status: 1, transactionHash: hash, blockNumber: 10 } };

test('journal success requires a final successful receipt, not a broadcast or status alone', () => {
  const result = normalizeTransactionResult(confirmed);
  assert.equal(result.kind, 'success');
  assert.equal(result.message, '撤销挂单已在链上确认。');
  for (const value of [{ ...confirmed, finalized: false }, { ...confirmed, receipt: null },
    { ...confirmed, receipt: { status: 0 } }, { ...confirmed, transactionHash: '0x123', receipt: { status: 1 } },
    { ...confirmed, status: 'pending' }, { status: 'confirmed', hash }]) {
    assert.equal(normalizeTransactionResult(value), null);
  }
});

test('member completion is an explicit receipt channel, not a restored status', () => {
  const record = { status: 'confirmed', hash, blockNumber: '0x10', action: 'deposit' };
  assert.equal(normalizeTransactionResult(record), null);
  assert.equal(normalizeTransactionResult(record, { source: 'member-receipt' }).kind, 'success');
  assert.equal(normalizeTransactionResult({ ...record, blockNumber: null }, { source: 'member-receipt' }), null);
  assert.equal(normalizeTransactionResult({ ...record, status: 'failed' }, { source: 'member-receipt' }).kind, 'failed');
});

test('a failed receipt is distinct from RPC timeouts and wallet simulation warnings', () => {
  assert.equal(normalizeTransactionResult({ ...confirmed, status: 'reverted', receipt: { status: 0 } }).kind, 'failed');
  const walletReceipt = { code: 'CALL_EXCEPTION', receipt: { hash, status: 0, blockNumber: 1 } };
  assert.equal(normalizeTransactionResult(walletReceipt, { source: 'wallet' }).kind, 'failed');
  for (const error of [new Error('RPC timeout'), { code: 'NETWORK_ERROR', hash },
    { code: 'CALL_EXCEPTION', message: 'execution reverted' }, { status: 'pending', hash, receipt: { status: 0 } },
    { status: 'failed', message: 'RPC timeout' }]) {
    assert.equal(normalizeTransactionResult(error, { source: 'wallet' }), null);
    assert.equal(normalizeTransactionResult(error), null);
  }
});

test('wallet rejection is a cancellation and a known broadcast remains ambiguous', () => {
  for (const code of [4001, '4001', 'ACTION_REJECTED']) {
    const result = normalizeTransactionResult({ code }, { source: 'wallet' });
    assert.equal(result.kind, 'cancelled');
    assert.equal(result.explorerUrl, null);
    assert.equal(result.key, null);
    assert.equal(normalizeTransactionResult({ code, hash }, { source: 'wallet' }), null);
  }
  assert.equal(normalizeTransactionResult({ info: { error: { code: 4001 } } }, { source: 'wallet' }).kind, 'cancelled');
  const error = { code: 4001 }; error.cause = error;
  assert.equal(normalizeTransactionResult(error, { source: 'wallet' }).kind, 'cancelled');
  assert.equal(normalizeTransactionResult({ status: 'pending', code: 4001 }, { source: 'wallet' }), null);
});

test('canonical cancellations and verified replacements do not say the original action succeeded', () => {
  assert.equal(normalizeTransactionResult({ ...confirmed, status: 'cancelled' }).kind, 'cancelled');
  assert.equal(normalizeTransactionResult({ ...confirmed, status: 'replaced' }), null);
  assert.equal(normalizeTransactionResult({ ...confirmed, status: 'replaced', plainEoaReplacementVerified: true }).kind, 'replaced');
  assert.equal(normalizeTransactionResult({ ...confirmed, status: 'replaced', receipt: { status: 0 } }).kind, 'replaced');
});

test('the result copy stays compact, bilingual and free of raw RPC payloads', () => {
  const result = normalizeTransactionResult({ ...confirmed, status: 'reverted', receipt: { status: 0 },
    message: `transaction execution reverted (action=sendTransaction, data=0x${'f'.repeat(4000)})` });
  assert.ok(result.message.length < 60);
  assert.equal(result.title, '交易失败');
  assert.equal(transactionResultText(result, 'en').title, 'Transaction failed');
  assert.equal(transactionResultText(normalizeTransactionResult(confirmed), 'en').message, 'Listing cancellation confirmed on chain.');
});

test('project actions name the completed operation without claiming settlement is a wallet payout', () => {
  const actions = {
    claimBem: '领取项目 BEM', collectChildBem: '归集矿机 BEM',
    finalizeFundingFailure: '结束项目募集并开启退款', claimFailedFunding: '结算募集退款',
    finalizeAcquisition: '结束项目购机并结算余款', transfer: '转移项目份额',
    proposeChildSale: '发起矿机出售提案', voteChildSale: '矿机出售投票',
    executeChildSale: '执行矿机出售', settleChildSale: '结算矿机卖款', expireChildSale: '取消过期矿机出售',
    marketList: '挂卖项目份额', marketFill: '购买项目份额', marketCancel: '撤销项目挂单',
    marketExpire: '解除到期项目挂单', marketWithdraw: '领取市场 BNB', createPortfolio: '创建预算项目', createPool: '创建矿池',
  };
  for (const [action, label] of Object.entries(actions)) {
    const result = normalizeTransactionResult({ ...confirmed, action });
    assert.equal(result.message, `${label}已在链上确认。`);
    assert(!transactionResultText(result, 'en').message.startsWith('Your transaction'));
    assert.equal(transactionResultText(result, 'en').title, 'Transaction successful');
  }
});

test('transaction links accept complete hashes only and deduplication keys ignore case', () => {
  assert.equal(transactionExplorerUrl(hash), `https://bscscan.com/tx/${hash}`);
  for (const value of [null, '0x1234', 'https://example.com', `${hash}/evil`, 'javascript:alert(1)']) {
    assert.equal(transactionExplorerUrl(value), null);
  }
  assert.equal(normalizeTransactionResult({ ...confirmed, transactionHash: hash.toUpperCase() }).key,
    normalizeTransactionResult(confirmed).key);
});
