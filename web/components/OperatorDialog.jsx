'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { lockDialogScroll } from '../lib/dialog-scroll-lock.mjs';

export default function OperatorDialog({ title, onClose, children }) {
  const dialog = useRef(null), close = useRef(onClose), titleId = useId();
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement, unlock = lockDialogScroll(document);
    dialog.current?.focus();
    const keydown = event => {
      // A transaction result above this dialog owns focus and keyboard input.
      if (document.querySelector('.transaction-result-overlay')) return;
      if (event.key === 'Escape' && close.current) { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const targets = Array.from(dialog.current?.querySelectorAll('button:not(:disabled),a[href]') || [])
        .filter(element => element.getClientRects().length > 0);
      const first = targets[0], last = targets.at(-1);
      if (!first) { event.preventDefault(); return; }
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
      const next = document.querySelector('.transaction-result-dialog') || document.querySelector('.operator-confirm[role="dialog"]');
      if (next && next !== dialog.current) next.focus();
      else if (previous?.isConnected) previous.focus();
    };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(<div className="operator-preview-overlay">
    <section className="operator-confirm" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      {onClose && <button type="button" className="operator-dialog-close icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={20}/></button>}
      <h2 id={titleId}>{title}</h2>
      {children}
    </section>
  </div>, document.body);
}
