'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, CircleMinus, Clock3, ExternalLink, Repeat2, X } from 'lucide-react';
import { transactionExplorerUrl, transactionResultText } from '../lib/transaction-result.mjs';
import { lockDialogScroll } from '../lib/dialog-scroll-lock.mjs';

const icons = { success: CheckCircle2, failed: AlertCircle, cancelled: CircleMinus, replaced: Repeat2, pending: Clock3 };

/** A result is supplied only for a newly completed operation in this session. */
export default function TransactionResultDialog({ result, locale = 'zh', onClose, onProject, onDirectory }) {
  const dialog = useRef(null), closeButton = useRef(null), close = useRef(onClose);
  const titleId = useId(), messageId = useId();
  close.current = onClose;
  const visible = Object.hasOwn(icons, result?.kind ?? '');
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement, unlock = lockDialogScroll(document);
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
      unlock();
      const next = document.querySelector('.operator-confirm[role="dialog"]');
      if (next) next.focus();
      else if (previous?.isConnected) previous.focus();
    };
  }, [visible]);
  if (!visible || typeof document === 'undefined') return null;
  const L = (zh, en) => locale === 'en' ? en : zh;
  const text = transactionResultText(result, locale), Icon = icons[result.kind];
  const { title, message } = result.reason === 'publication' ? result : text;
  const explorerUrl = transactionExplorerUrl(result.hash);
  return createPortal(<div className="modal-overlay transaction-result-overlay" onClick={event => {
    if (event.target === event.currentTarget) onClose?.();
  }}>
    <section className={`modal transaction-result-dialog transaction-result-${result.kind}`} role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={messageId} ref={dialog} tabIndex={-1}>
      <button type="button" className="modal-close icon-button transaction-result-close" onClick={onClose}
        aria-label={L('关闭弹窗', 'Close dialog')}><X size={20}/></button>
      <span className="transaction-result-icon" aria-hidden="true"><Icon size={34}/></span>
      <h2 id={titleId}>{title}</h2>
      <p id={messageId} className="transaction-result-message">{message}</p>
      {result.kind === 'success' && /^0x[\da-f]{40}$/i.test(result.projectAddress ?? '') && <>
        <p className="transaction-result-message">{L('项目地址', 'Project address')}<br/>
          <a className="transaction-result-link" href={`https://bscscan.com/address/${result.projectAddress}`}
            target="_blank" rel="noopener noreferrer" style={{ overflowWrap: 'anywhere' }}>{result.projectAddress}<ExternalLink size={15}/></a>
        </p>
        <div className="transaction-result-actions">
          <button type="button" className="btn btn-primary" onClick={onProject}>{L('查看项目', 'View project')}</button>
          <button type="button" className="btn secondary" onClick={onDirectory}>{L('前往项目大厅', 'Open project directory')}</button>
        </div>
      </>}
      {explorerUrl && <a className="transaction-result-link" href={explorerUrl} target="_blank" rel="noopener noreferrer">
        {L('查看链上交易', 'View transaction')}<ExternalLink size={15}/>
      </a>}
      <div className="transaction-result-actions"><button type="button" className="btn btn-primary" ref={closeButton} onClick={onClose}>
        {L('知道了', 'Got it')}
      </button></div>
    </section>
  </div>, document.body);
}
