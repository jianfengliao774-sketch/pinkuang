import { fundingTargetStatus, fundingTargetUnavailableText } from './live-view.mjs';

const uint = value => typeof value === 'bigint' && value >= 0n ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value)
    : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;
const address = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? value.toLowerCase() : null;

/** Cached personal display only. Action preparation re-reads state and balances before signing. */
export function fundingRefundView(row, source = {}) {
  const trusted = row?.trusted === true && row?.kind !== 'portfolio';
  const unavailable = trusted && fundingTargetStatus(row) === 'unavailable';
  const shares = trusted ? uint(row.shares) : null, bnb = trusted ? uint(row.bnbOwed) : null;
  const principal = trusted ? uint(row.initialContributedWei) : null;
  const refunding = trusted && row.status === 'Refunding' && uint(row.state) === 5n;
  const hasShares = shares !== null && shares > 0n, hasBnb = bnb !== null && bnb > 0n;
  const relevant = unavailable && (hasShares || hasBnb || shares === null || bnb === null)
    || refunding && (hasBnb || bnb === null);
  const deadline = unavailable && row.status === 'Funded' ? uint(row.params?.purchaseDeadline) : null;
  const timestamp = uint(source.indexedTimestamp);
  const deadlineReached = deadline !== null && timestamp !== null ? timestamp >= deadline : null;
  const actions = [];
  if (relevant && unavailable && row.status === 'Funding' && hasShares) actions.push({ kind: 'withdrawDeposit', ready: true,
    labelZh: '撤回认购', labelEn: 'Withdraw subscription' });
  if (relevant && unavailable && row.status === 'Funded' && hasShares) actions.push({ kind: 'finalizeFailure', ready: deadlineReached === true,
    labelZh: '开启到期退款', labelEn: 'Enable expired-purchase refunds' });
  if (relevant && hasBnb) actions.push({ kind: 'withdrawBnb', ready: true,
    labelZh: '领取退款 / 待领取 BNB', labelEn: 'Claim refund / booked BNB' });
  const title = unavailable ? fundingTargetUnavailableText(row)
    : ['项目已开启退款', 'Refunds are open for this project'];
  const explanation = unavailable && row.status === 'Funding' && hasShares
    ? ['先撤回认购，将本金记入待领取 BNB；确认后再点击领取 BNB，款项才会转入钱包。',
      'Withdraw the subscription to book the principal as claimable BNB. After confirmation, claim BNB to receive it in your wallet.']
    : unavailable && row.status === 'Funded' && hasShares
      ? ['项目已募满，现行合约需等购机期限到期才能开启退款。开启后本金记入待领取 BNB，再由本人领取；目前不会自动或即时退款。',
        'This project is fully funded. The current contract opens refunds only after the purchase deadline. Then claim the booked BNB yourself; refunds are not automatic or immediate.']
      : hasBnb ? ['你的待领取 BNB 仍保留，项目下架或份额归零不会影响领取。',
        'Your booked BNB remains claimable even after delisting or after your shares reach zero.']
        : ['请刷新核对最新的退款状态和待领取 BNB；未知余额不代表已退款。',
          'Refresh to check refund state and booked BNB. An unknown balance does not mean a refund was paid.'];
  return { relevant, unavailable, refunding, shares, bnb, principal, deadline, deadlineReached, actions, title, explanation };
}

/** In-app reminders derive only from the already-loaded, account-bound position rows. */
export function participantFundingNotices(rows, { account, positionsAccount, source } = {}) {
  if (!address(account) || address(account) !== address(positionsAccount)) return [];
  const result = [], seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = address(row?.pool), view = fundingRefundView(row, source);
    if (!key || seen.has(key) || !row?.trusted || !view.relevant) continue;
    seen.add(key); result.push({ id: `funding-target:${key}`, pool: row.pool,
      name: row.name, tokenId: row.tokenId, view, observedBlock: view.unavailable ? row.targetAvailability.observedBlock : source?.indexedThrough });
  }
  return result;
}
