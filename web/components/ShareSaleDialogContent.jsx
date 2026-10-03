import { displayAmount, displayDecimal } from '../lib/amount-display.mjs';
import { explorerAddress, shortAddress } from '../lib/live-view.mjs';

export default function ShareSaleDialogContent({ pool, account, quantity, price, prepared, busy,
  blocked, error, progress, locale, onQuantity, onPrice, onPrepare, onSubmit, onEdit, onConnect }) {
  const L = (zh, en) => locale === 'en' ? en : zh;
  return <>
    <header className="share-sale-header">
      <h2 id="live-dialog-title">{L('出售份额', 'Sell shares')}</h2>
      <p>{pool.name} #{pool.tokenId}</p>
    </header>
    <div className="share-sale-body">
      {!account ? <p>{L('连接钱包后出售你的份额。', 'Connect your wallet to sell your shares.')}</p>
        : prepared ? <>
          <div className="confirm-lines share-sale-summary">
            <div><span>{L('出售数量', 'Shares to sell')}</span><strong>{quantity} {L('份', 'shares')}</strong></div>
            <div><span>{L('每份价格', 'Price per share')}</span><strong title={`${price} BNB`}>{displayDecimal(price)} BNB</strong></div>
            <div className="share-sale-total"><span>{L('总挂牌金额', 'Total asking price')}</span><strong>{displayAmount(prepared.listingGrossWei)} BNB</strong></div>
          </div>
          <p className="subtle-note share-sale-fees">{L('挂牌只支付 Gas；成交时卖方扣除 1% 手续费。挂单 7 天到期。', 'Listing costs only Gas. A 1% seller fee is deducted on fills. The order expires in 7 days.')}</p>
          <details className="share-sale-details">
            <summary>{L('交易详情', 'Transaction details')}</summary>
            <dl>
              <div><dt>{L('接收合约', 'Target contract')}</dt><dd><a href={explorerAddress(prepared.transaction.to)} target="_blank" rel="noopener noreferrer">{shortAddress(prepared.transaction.to)} ↗</a></dd></div>
              <div><dt>{L('出售钱包', 'Your wallet')}</dt><dd>{shortAddress(account)}</dd></div>
              <div><dt>{L('精确单价', 'Exact price per share')}</dt><dd>{price} BNB</dd></div>
            </dl>
            <p>{L('金额显示五位小数，交易使用原始精确值。网络 Gas 以钱包显示为准。', 'Amounts display five decimals. Transactions use the exact values. Review network Gas in your wallet.')}</p>
          </details>
        </> : <>
          <div className="share-sale-available"><span>{L('可售份额', 'Available shares')}</span><strong>{pool.availableShares.toString()} {L('份', 'shares')}</strong>
            {pool.lockedShares > 0n && <small>{L('另有', 'Another')} {pool.lockedShares.toString()} {L('份已锁定', 'shares locked')}</small>}
          </div>
          <label className="field-label">{L('份额数量', 'Number of shares')}
            <input inputMode="numeric" value={quantity} disabled={busy} onChange={e => onQuantity(e.target.value)} placeholder="1–100" />
          </label>
          <button className="text-button share-sale-max" disabled={busy} onClick={() => onQuantity(pool.availableShares.toString())}>{L('全部出售', 'Sell all available')}</button>
          <label className="field-label">{L('每份价格 · BNB', 'Price per share · BNB')}
            <input inputMode="decimal" value={price} disabled={busy} onChange={e => onPrice(e.target.value)} placeholder="0.005" />
          </label>
          <p className="subtle-note">{L('每份最低 0.00001 BNB。', 'Minimum 0.00001 BNB per share.')}</p>
        </>}
      {error && <p className="live-dialog-error" role="alert">{error}</p>}
    </div>
    <footer className="share-sale-footer">
      {busy && progress && <p className="wallet-connect-status" role="status" aria-live="polite">{progress}</p>}
      <div className="live-actions">
        {!account ? <button className="btn" disabled={busy} onClick={onConnect}>{L('连接钱包', 'Connect wallet')}</button>
          : prepared ? <>
            <button className="btn" disabled={busy || blocked} onClick={onSubmit}>{busy ? L('等待确认…', 'Awaiting confirmation…') : L('确认并前往钱包', 'Confirm in wallet')}</button>
            <button className="btn secondary" disabled={busy} onClick={onEdit}>{L('返回修改', 'Edit')}</button>
          </> : <button className="btn" disabled={busy || blocked} onClick={onPrepare}>{busy ? L('正在准备…', 'Preparing…') : L('预览出售', 'Preview listing')}</button>}
      </div>
    </footer>
  </>;
}
