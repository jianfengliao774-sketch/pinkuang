'use client';

import { ChevronDown } from 'lucide-react';

function ProjectFields({ fields, className = 'live-mobile-project-fields' }) {
  return <dl className={className}>{fields.map(field => <div key={field.key} data-project-field={field.key}>
    <dt>{field.label}</dt><dd title={field.title}>{field.value}</dd>
  </div>)}</dl>;
}

/** Layout only: every value and action is supplied by the existing table projection. */
export default function MobileProjectViews({ rows, summary = false, empty, category, expanded, onToggle, L }) {
  return <div className="live-mobile-projects" data-mobile-project-layout={summary ? 'summary' : 'cards'} data-mobile-category={category}>
    {rows.map(row => <article key={row.key}
      className={summary ? 'live-mobile-project-summary-row' : 'live-mobile-project-card'}
      data-project-kind={row.kind} data-project-address={row.key}>
      {summary ? <details open={expanded?.has(row.key) || false}
        onToggle={event => onToggle?.(row.key, event.currentTarget.open)}>
        <summary>
          <div className="live-mobile-project-heading"><div className="live-mobile-project-identity">{row.identity}</div>{row.status}</div>
          <ProjectFields fields={row.fields.filter(field => row.quickFields.includes(field.key))} className="live-mobile-project-quick-fields" />
          <span className="live-mobile-project-expand"><span>{expanded?.has(row.key) ? L('收起指标', 'Fewer metrics') : L('更多指标', 'More metrics')}</span><ChevronDown size={15} aria-hidden="true" /></span>
        </summary>
        <ProjectFields fields={row.fields.filter(field => !row.quickFields.includes(field.key))} />
      </details> : <>
        <div className="live-mobile-project-heading"><div className="live-mobile-project-identity">{row.identity}</div>{row.status}</div>
        <ProjectFields fields={row.fields} />
      </>}
      <div className="live-mobile-project-actions">{row.actions}</div>
    </article>)}
    {!rows.length && <div className="live-mobile-project-empty">{empty}</div>}
  </div>;
}
