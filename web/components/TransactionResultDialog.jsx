'use client';

import { useEffect, useId, useRef } from 'react';
import { AlertCircle, CheckCircle2, CircleMinus, ExternalLink, Repeat2, X } from 'lucide-react';
import { transactionExplorerUrl, transactionResultText } from '../lib/transaction-result.mjs';

const icons = { success: CheckCircle2, failed: AlertCircle, cancelled: CircleMinus, replaced: Repeat2 };

/** A result is supplied only for a newly completed operation in this session. */
export default function TransactionResultDialog({ result, locale = 'zh', onClose }) {
  const dialog = useRef(null), closeButton = useRef(null), close = useRef(onClose);
  const titleId = useId(), messageId = useId();
  close.current = onClose;
  const visible = Object.hasOwn(icons, result?.kind ?? '');
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current?.(); }
      if (event.key !== 'Tab') return;
      const targets = Array.from(dialog.current?.querySelectorAll('button:not(:disabled),a[href]') ?? [])
        .filter(element => element.getClientRects().length > 0);
      if (!targets.length) { event.preventDefault(); return; }
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [visible]);
  if (!visible) return null;
  const L = (zh, en) => locale === 'en' ? en : zh;
  const { title, message } = transactionResultText(result, locale), Icon = icons[result.kind];
  const explorerUrl = transactionExplorerUrl(result.hash);
  return <div className="modal-overlay transaction-result-overlay" onClick={event => {
    if (event.target === event.currentTarget) onClose?.();
  }}>
    <section className={`modal transaction-result-dialog transaction-result-${result.kind}`} role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={messageId} ref={dialog}>
      <button type="button" className="modal-close icon-button transaction-result-close" onClick={onClose}
        aria-label={L('关闭弹窗', 'Close dialog')}><X size={20}/></button>
      <span className="transaction-result-icon" aria-hidden="true"><Icon size={34}/></span>
      <h2 id={titleId}>{title}</h2>
      <p id={messageId} className="transaction-result-message">{message}</p>
      {explorerUrl && <a className="transaction-result-link" href={explorerUrl} target="_blank" rel="noopener noreferrer">
        {L('查看链上交易', 'View transaction')}<ExternalLink size={15}/>
      </a>}
      <div className="transaction-result-actions"><button type="button" className="btn btn-primary" ref={closeButton} onClick={onClose}>
        {L('知道了', 'Got it')}
      </button></div>
    </section>
  </div>;
}
