'use client';

/** Layout only: values, notices and actions come from the existing table projection. */
export default function MobileFinancialCards({ rows, empty, variant = 'orders', L }) {
  return <div className="live-mobile-financial-cards" data-mobile-financial-view={variant}
    role="list" aria-label={variant === 'claims' ? L('逐池领取', 'Claim from each pool') : L('份额挂单', 'Share orders')}>
    {rows.map(row => <article className="live-mobile-financial-card" data-financial-key={row.key} key={row.key} role="listitem">
      <header className="live-mobile-financial-heading">{row.identity}</header>
      <dl className="live-mobile-financial-fields">{row.fields.map(field => <div key={field.key} data-financial-field={field.key}>
        <dt>{field.label}</dt><dd>{field.value}</dd>
      </div>)}</dl>
      <div className="live-mobile-financial-actions">{row.actions}</div>
    </article>)}
    {!rows.length && <div className="live-mobile-financial-empty">{empty}</div>}
  </div>;
}
