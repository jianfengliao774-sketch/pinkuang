'use client';

import { displayPreciseAmount } from '../lib/amount-display.mjs';
import './PublicDisplayPreview.css';

const short = value => `${value.slice(0, 6)}…${value.slice(-4)}`;
const count = value => BigInt(value).toLocaleString('en-US');

/** Each card carries one server-indexed, display-only section. */
export default function PublicDisplayPreview({ preview, section, route, locale }) {
  if (!preview || preview.section !== section) return null;
  const en = locale === 'en', L = (zh, english) => en ? english : zh;
  const target = route.pool?.toLowerCase();
  const rows = target ? preview.items?.filter(row => row.address?.toLowerCase() === target)
    : preview.items?.slice(0, 8);
  if (target && !rows?.length) return null;
  const verified = new Date(preview.source.checkedAt).toLocaleString(en ? 'en-GB' : 'zh-CN');
  return <section className="public-display-preview" aria-label={L('历史公共展示快照', 'Historical public display snapshot')}>
    <header>
      <div><span className="public-display-preview-tag">{L('历史展示 · 不可用于交易', 'Historical display · no transactions')}</span>
        <h2>{L('服务器保存的公共历史', 'Server-stored public history')}</h2>
        <p>{L(`区块 #${preview.source.indexedThrough} · 服务端检查于 ${verified}。当前状态、余额和权限仍需链上核验。`,
          `Block #${preview.source.indexedThrough} · server checked ${verified}. Current state, balances and permissions still require live chain verification.`)}</p></div>
    </header>
    {section === 'stats' && <div className="public-display-preview-stats">
      <div><span>{L('历史登记项目', 'Historically registered projects')}</span><strong>{count(preview.stats.topLevelProjectCount)}</strong></div>
      <div><span>{L('历史参与地址', 'Historical participant addresses')}</span><strong>{count(preview.stats.everParticipantAddressCount)}</strong></div>
      <div><span>{L('登记矿池', 'Registered pools')}</span><strong>{count(preview.stats.registeredPoolCount)}</strong></div>
      <div><span>{L('预算项目', 'Budget projects')}</span><strong>{count(preview.stats.portfolioCount)}</strong></div>
    </div>}
    {section !== 'stats' && <div className="public-display-preview-grid"><section>
      <h3>{section === 'pools' ? L(`矿池登记身份 · 共 ${count(preview.source.standalonePoolCount)}`, `Registered pool identities · ${count(preview.source.standalonePoolCount)} total`)
        : section === 'portfolios' ? L(`预算项目登记 · 共 ${count(preview.source.portfolioCount)}`, `Registered budget projects · ${count(preview.source.portfolioCount)} total`)
          : L('历史挂单候选', 'Historical order candidates')}</h3>
      {rows.length ? <ul>{rows.map(row => <li key={row.address ?? row.orderId}>
        {section === 'pools' ? <><strong>NFT #{row.circuitId} · {short(row.collection)}</strong>
          <span>{short(row.address)} · {L('登记区块', 'registered at')} #{row.createdBlock}</span></>
          : section === 'portfolios' ? <><strong>{short(row.address)}</strong>
            <span>{L('初始预算', 'Original budget')} {displayPreciseAmount(row.budgetWei)} BNB · {L('登记区块', 'registered at')} #{row.createdBlock}</span></>
            : <><strong>#{row.orderId} · {short(row.pool)}</strong>
              <span>{L('该区块剩余', 'Remaining at that block')} {row.remaining} {L('份', 'shares')} · {displayPreciseAmount(row.pricePerUnitWei)} BNB/{L('份', 'share')}</span></>}
      </li>)}</ul> : <p>{section === 'pools' ? L('该核验区块无矿池登记。', 'No pool registration at this verified block.')
        : section === 'portfolios' ? L('该核验区块无预算项目登记。', 'No budget project registration at this verified block.')
          : L('该核验区块无历史挂单候选。', 'No historical order candidates at this verified block.')}</p>}
      {!target && rows.length > 0 && (preview.items.length > rows.length || preview.nextCursor !== null)
        && <small>{L('这里只展示前八项。', 'Showing the first eight items only.')}</small>}
      {section === 'orders' && <small>{L('挂单可能已变化；此处没有成交入口。', 'Orders may have changed; this preview has no trading controls.')}</small>}
    </section></div>}
  </section>;
}
