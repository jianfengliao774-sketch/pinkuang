import { describeActivity } from '../lib/activity-description.mjs';
import './ActivityOperation.css';

/** Readable explanation beside the original event; raw CSV remains unchanged. */
export default function ActivityOperation({ row, locale = 'zh' }) {
  const entry = describeActivity(row, locale);
  return <div className="activity-operation" data-activity-event={entry.rawEvent}>
    <strong>{entry.label}</strong>
    <p>{entry.description}</p>
    {entry.facts.length > 0 && <p>{entry.facts.map((fact, index) => <span key={fact.label} title={fact.exact}>
      {index > 0 ? ' · ' : ''}{fact.label}{locale === 'en' ? ': ' : '：'}{fact.value}
    </span>)}</p>}
    <small>{locale === 'en' ? 'Raw event: ' : '原始事件：'}<code>{entry.rawEvent || '—'}</code></small>
  </div>;
}
