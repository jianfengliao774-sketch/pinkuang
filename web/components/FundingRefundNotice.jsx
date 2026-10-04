'use client';
import { fundingRefundView } from '../lib/funding-refund.mjs';
import { displayPreciseAmount } from '../lib/amount-display.mjs';

/** One exit path on desktop and mobile; supplied handlers keep the existing transaction gates. */
export default function FundingRefundNotice({ row, source, L, readyFor, blocked = false, onAction, compact = false }) {
  const view = fundingRefundView(row, source);
  if (!view.relevant) return null;
  const deadline = view.deadline !== null && view.deadline <= 8640000000000n
    ? new Date(Number(view.deadline) * 1000).toLocaleString(L('zh-CN', 'en-GB')) : null;
  return <section className={`funding-refund-notice${compact ? ' compact' : ''}`} role="status" data-refund-pool={row.pool}>
    <strong>{L(...view.title)}</strong>
    <p>{L(...view.explanation)}</p>
    {source?.stale && <p>{L('当前显示缓存记录，操作前会核对最新余额与退款资格。', 'This is a cached record. Current balances and refund eligibility are checked before an action.')}</p>}
    {view.deadline !== null && <p>{L('最晚购机时间', 'Purchase deadline')}：{deadline || '—'}
      {view.deadlineReached === false && <> · {L('尚未到退款时间', 'Refund deadline not reached')}</>}
      {view.deadlineReached === null && <> · {L('到期条件待核对', 'Deadline eligibility is unconfirmed')}</>}</p>}
    {view.unavailable && view.shares !== null && view.shares > 0n && <p>{L('当前认购本金', 'Current subscription principal')}：<b title={view.principal === null ? undefined : `${displayPreciseAmount(view.principal, 18, 18)} BNB`}>{view.principal === null ? '—' : `${displayPreciseAmount(view.principal)} BNB`}</b></p>}
    {view.bnb !== null && view.bnb > 0n && <p>{L('待领取 BNB', 'Claimable BNB')}：<b>{displayPreciseAmount(view.bnb)} BNB</b></p>}
    <div className="live-actions">{view.actions.map(action => <button key={action.kind} className="btn"
      disabled={blocked || !action.ready || !readyFor?.(action.kind)} onClick={() => onAction(action.kind, row)}>
      {L(action.labelZh, action.labelEn)}</button>)}</div>
  </section>;
}
