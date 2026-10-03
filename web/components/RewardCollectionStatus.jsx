'use client';

import './RewardCollectionStatus.css';

const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const validHash = value => typeof value === 'string' && HASH.test(value);
const short = value => ADDRESS.test(value ?? '') ? `${value.slice(0, 6)}…${value.slice(-4)}` : '';
const actions = {
  harvest: ['归集', 'Collect'],
  claim: ['领取 BEM', 'Claim BEM'],
  withdrawBnb: ['领取 BNB', 'Claim BNB'],
};
const modes = {
  'collect-only': ['已加载单矿机归集', 'Collect from loaded single-miner pools'],
  'claim-only': ['已加载单矿机领取', 'Claim from loaded single-miner pools'],
  'collect-and-claim': ['已加载单矿机归集并领取', 'Collect and claim from loaded single-miner pools'],
};
const unresolvedReasons = new Set(['pending', 'unknown', 'send_unknown', 'receipt_unknown', 'receipt_pending']);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Display only. Counts describe calls and booked balances, never harvested output. */
export default function RewardCollectionStatus({ run, locale = 'zh', onStop, onVerify, onDismiss }) {
  if (!run || !['running', 'completed', 'stopped'].includes(run.status)) return null;
  const L = (zh, en) => locale === 'en' ? en : zh;
  const running = run.status === 'running', result = run.result ?? {}, progress = run.progress ?? {};
  const steps = Array.isArray(result.steps) ? result.steps : Array.isArray(result.records) ? result.records : [];
  const submitted = Array.isArray(result.records) ? result.records : [];
  // A record list can contain a pending and a later settled update for one hash.
  const records = [...new Map([...submitted, ...steps].filter(step => step && validHash(step.hash))
    .map(step => [step.hash.toLowerCase(), step])).values()];
  const stats = result.stats ?? progress.stats ?? {};
  const confirmed = number(stats.confirmed) ?? records.filter(step => step.status === 'confirmed').length;
  const reverted = number(stats.reverted) ?? records.filter(step => ['failed', 'reverted'].includes(step.status)).length;
  const skippedZero = number(stats.skippedZero) ?? steps.filter(step => step.status === 'skipped'
    && step.reason === 'zero_balance').length;
  const recovery = run.recovery ?? {};
  const unresolved = !running && (unresolvedReasons.has(result.reason)
    || ['submitting', 'pending', 'unknown'].includes(recovery.status) || records.some(step => step.status === 'pending'));
  const hash = [recovery.hash, progress.hash, ...records.filter(step => step.status === 'pending').map(step => step.hash)]
    .find(validHash);
  const kind = progress.action ?? progress.kind ?? recovery.action ?? recovery.kind;
  const action = actions[kind];
  const pool = typeof progress.pool === 'string' ? progress.pool : recovery.pool;
  const title = modes[run.mode] ?? modes['collect-and-claim'];
  const index = number(progress.index), total = number(progress.total);
  const reason = result.reason;
  const error = typeof result.error === 'string' ? result.error : result.error?.message;
  const walletAwaiting = ['submitting', 'signing', 'awaiting-signature'].includes(progress.phase ?? progress.status);

  return <section className="reward-collection-status" aria-label={L(...title)}>
    <div className="reward-collection-status-heading">
      <strong>{L(...title)}</strong>
      <span role="status" aria-live="polite">{running ? L('进行中', 'In progress')
        : run.status === 'completed' ? L('本轮处理结束', 'Run finished')
          : unresolved ? L('本轮已暂停', 'Run paused') : L('后续操作已停止', 'Further actions stopped')}</span>
    </div>
    {running && action && <p role="status" aria-live="polite">
      {L('当前步骤', 'Current step')}：{L(...action)}
      {short(pool) && <> · <span title={pool}>{short(pool)}</span></>}
      {index !== null && total !== null && total > 0 && <> · {Math.min(index + 1, total)} / {total}</>}
      {walletAwaiting ? L(' · 请在钱包确认', ' · Confirm in your wallet')
        : hash ? L(' · 等待交易核对', ' · Checking the transaction') : ''}
    </p>}
    <p className="reward-collection-status-counts" role="status" aria-live="polite">
      <span>{L('已确认', 'Confirmed calls')} {confirmed} {L('笔', '')}</span>
      <span>{L('跳过余额为零', 'Zero balances skipped')} {skippedZero} {L('项', '')}</span>
      <span>{L('发生回滚', 'Reverted calls')} {reverted} {L('笔', '')}</span>
    </p>
    {unresolved && <p className="reward-collection-status-warning">{hash
      ? L('请先核对这笔交易，后续操作已暂停。', 'Check this transaction before continuing; later actions are paused.')
      : L('发送结果尚不明确，请先核对钱包交易记录，再处理后续操作。',
        'The submission outcome is unknown. Check your wallet history before handling later actions.')}</p>}
    {!unresolved && reason === 'wallet_rejected' && <p>{L('你已取消钱包请求，后续操作已停止。',
      'You cancelled the wallet request. Later actions have stopped.')}</p>}
    {!unresolved && reason === 'wallet_changed' && <p>{L('钱包或网络已改变，后续操作已停止。',
      'The wallet or network changed. Later actions have stopped.')}</p>}
    {error && !unresolved && <p className="reward-collection-status-warning" role="alert">{String(error).slice(0, 240)}</p>}
    {hash && <p><a href={`https://bscscan.com/tx/${hash}`} target="_blank" rel="noopener noreferrer">
      {L('查看链上交易', 'View transaction')} ↗
    </a></p>}
    <p className="subtle-note">{L('归集调用已确认不代表有新增收益；领取金额以矿池实际入账为准。',
      'A confirmed collection call may collect no new output. Claims use the pool’s booked balance.')}</p>
    {run.hasMore && <p className="subtle-note">{L('还有未加载的单矿机。加载更多后可另开一轮。',
      'More single-miner pools are not loaded. Load them before starting another run.')}</p>}
    {short(run.account) && <p className="subtle-note">{L('操作钱包', 'Wallet')}：<span title={run.account}>{short(run.account)}</span></p>}
    <div className="live-actions">
      {running ? <button type="button" className="btn secondary" disabled={typeof onStop !== 'function'} onClick={onStop}>
        {L('停止后续操作', 'Stop later actions')}
      </button> : <>
        {unresolved && hash && typeof onVerify === 'function' && <button type="button" className="btn secondary" onClick={onVerify}>
          {L('核对交易', 'Check transaction')}
        </button>}
        {typeof onDismiss === 'function' && <button type="button" className="btn secondary" onClick={onDismiss}>
          {L('收起进度', 'Hide progress')}
        </button>}
      </>}
    </div>
    {running && <p className="subtle-note">{L('停止只影响后续操作；已发送的钱包请求或交易仍需核对。',
      'Stopping affects later actions only. Wallet requests or transactions already sent still need checking.')}</p>}
  </section>;
}
