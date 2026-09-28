"use client";

import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { authenticate } from '../lib/live-transactions.mjs';
import { NOTIFICATION_BOT, notificationHistoryKey, notificationMessage, notificationPromptKind, notificationRequest, notificationTarget,
  ownsPurchasedMiner, readNotificationHistory, telegramBindingUrl } from '../lib/notifications.mjs';
import styles from './Notifications.module.css';

const language = value => value === 'zh' ? 'zh' : 'en';
const displayDate = (value, locale) => {
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-GB');
};

/** Parent keys this component by deployment, wallet identity and provider revision. */
export default function Notifications({ account, wallet, config, locale, route, positions = [], detail, claim,
  blocked = false, onConnect, onOpen, isCurrent = () => true }) {
  const L = (zh, en) => locale === 'zh' ? zh : en;
  const [capabilities, setCapabilities] = useState(null);
  const [status, setStatus] = useState(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [bindingUrl, setBindingUrl] = useState(null);
  const [items, setItems] = useState([]);
  const [inboxState, setInboxState] = useState('loading');
  const [history, setHistory] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [requestLanguage, setRequestLanguage] = useState(language(locale));
  const alive = useRef(true), operation = useRef(false), dialog = useRef(null);
  const base = config?.journalBase;
  const key = notificationHistoryKey(account, config?.factory);
  const enabled = capabilities?.enabled === true && capabilities.botUsername === NOTIFICATION_BOT;
  const eligible = ownsPurchasedMiner(route === 'detail' ? (detail ? [detail] : []) : positions);
  const isPage = route === 'notifications';
  const binding = status?.binding;
  const canConfirm = binding?.status === 'paired' && binding.telegramLabel;
  const request = (path, method = 'GET', body, signal) => notificationRequest({ config, path, account, method, body, signal });
  const current = () => alive.current && isCurrent();
  const messageFor = e => e?.status === 401
    ? L('请验证当前钱包后继续。', 'Verify your current wallet to continue.')
    : e?.status === 429 ? L('操作较频繁，请稍后再试。', 'Too many requests. Please try again shortly.')
      : e?.code === 4001 || e?.code === 'ACTION_REJECTED' ? L('你已取消钱包确认，可以稍后重试。', 'Wallet confirmation was cancelled. You can try again later.')
        : L('暂时无法完成，请稍后重试。', 'Unable to complete this action. Please try again shortly.');

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let storage;
    try { storage = window.localStorage; } catch {}
    setHistory(readNotificationHistory(storage, key));
  }, [key]);
  useEffect(() => {
    if (!config) return;
    const controller = new AbortController();
    request('capabilities', 'GET', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setCapabilities(value);
    }).catch(() => { if (!controller.signal.aborted) setCapabilities({ enabled: false }); });
    return () => controller.abort();
  }, [base, !!config]);
  useEffect(() => {
    if (!account || !enabled) return;
    const controller = new AbortController();
    request('status', 'GET', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) { setStatus(value); setNeedsLogin(false); setRequestLanguage(language(value.language ?? locale)); }
    }).catch(e => { if (!controller.signal.aborted) { setNeedsLogin(e.status === 401); if (e.status !== 401) setError(messageFor(e)); } });
    return () => controller.abort();
  }, [account, base, enabled]);

  function remember(kind) {
    const next = { ...history, purchasePromptSeen: true, ...(kind === 'claim' ? { claimReminderSeen: true } : {}) };
    setHistory(next);
    try { if (key) window.localStorage.setItem(key, JSON.stringify(next)); } catch {}
  }
  useEffect(() => {
    if (!enabled || !account || blocked || busy || isPage || !history || (!status && !needsLogin)) return;
    const kind = notificationPromptKind({ eligible, route, connected: status?.connected, history, claim, account });
    if (kind && !prompt) { setPrompt(kind); remember(kind); }
  }, [enabled, account, blocked, busy, isPage, history, status, needsLogin, eligible, route, claim]);

  async function refreshStatus({ inbox = false } = {}) {
    const value = await request('status');
    if (!current()) return null;
    setStatus(value); setNeedsLogin(false);
    if (inbox) {
      setInboxState('loading');
      try {
        const result = await request('inbox');
        if (current()) { setItems(Array.isArray(result.items) ? result.items : []); setInboxState('ready'); }
      } catch (e) { if (current()) setInboxState('error'); throw e; }
    }
    return value;
  }
  // Read-only polling stops at expiry, after ten minutes, on unmount, or once the binding is settled.
  useEffect(() => {
    if (!binding?.id || !['pending', 'paired'].includes(binding.status)) return;
    const controller = new AbortController();
    let timer, count = 0;
    const poll = async () => {
      if (controller.signal.aborted || count++ >= 120) return;
      if (Date.parse(binding.expiresAt) <= Date.now() || typeof binding.expiresAt === 'number' && binding.expiresAt <= Date.now()) {
        setBindingUrl(null); setStatus(current => ({ ...current, binding: null }));
        setNotice(L('绑定链接已过期，请重新生成。', 'This connection link expired. Generate a new one.'));
        return;
      }
      try {
        const value = await request('status', 'GET', undefined, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(value);
        if (!value.binding || value.binding.id !== binding.id || !['pending', 'paired'].includes(value.binding.status)) { setBindingUrl(null); return; }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e.status === 401) { setNeedsLogin(true); return; }
      }
      timer = window.setTimeout(poll, 5000);
    };
    timer = window.setTimeout(poll, 3000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [binding?.id]);
  useEffect(() => {
    if (!isPage || !account || !enabled || !status || needsLogin) return;
    const controller = new AbortController();
    setInboxState('loading');
    request('inbox', 'GET', undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) { setItems(Array.isArray(result.items) ? result.items : []); setInboxState('ready'); }
    }).catch(() => { if (!controller.signal.aborted) setInboxState('error'); });
    return () => controller.abort();
  }, [isPage, account, enabled, needsLogin, !!status]);

  useEffect(() => {
    if (!prompt || blocked) return;
    const previous = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector('button')?.focus();
    const keydown = e => {
      if (e.key === 'Escape' && !operation.current) setPrompt(null);
      if (e.key !== 'Tab') return;
      const controls = dialog.current?.querySelectorAll('button:not(:disabled),a[href],select:not(:disabled)');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus?.(); };
  }, [prompt, blocked]);

  async function act(work) {
    if (operation.current || blocked) return;
    if (!wallet || !account) { onConnect(); return; }
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      // Every possible signing path originates from this explicit button handler.
      await authenticate({ provider: wallet, account, config });
      if (!current()) return;
      setNeedsLogin(false);
      await work();
    } catch (e) { if (current()) { setError(messageFor(e)); if (e.status === 401) setNeedsLogin(true); } }
    finally { operation.current = false; if (current()) setBusy(false); }
  }
  const begin = () => act(async () => {
    const latest = await refreshStatus();
    if (!current() || latest?.connected) return;
    const result = await request('binding', 'POST', { language: requestLanguage });
    if (!current()) return;
    const safeUrl = telegramBindingUrl(result.url);
    if (!safeUrl || typeof result.id !== 'string' || !Number.isFinite(result.expiresAt)) throw new Error('invalid_telegram_link');
    setBindingUrl(safeUrl);
    setStatus(previous => ({ ...previous, binding: { id: result.id, status: 'pending', expiresAt: result.expiresAt, telegramLabel: null } }));
  });
  const confirm = () => act(async () => {
    const latest = await request('binding/confirm', 'POST', { id: binding.id, language: requestLanguage });
    if (!current()) return;
    setStatus(latest);
    if (latest?.connected) {
      setBindingUrl(null); setPrompt(null);
      setNotice(L('Telegram 通知已开启。', 'Telegram notifications are enabled.'));
    }
  });
  const disconnect = () => act(async () => {
    const latest = await request('disconnect', 'POST', {});
    if (!current()) return;
    setStatus(latest);
    setConfirmDisconnect(false); setBindingUrl(null);
    if (current()) setNotice(L('已解除绑定，站内通知仍然保留。', 'Telegram disconnected. Your in-app notifications remain available.'));
  });
  const saveLanguage = (resume = false) => act(async () => {
    const latest = await request('preferences', 'POST', { language: requestLanguage, ...(resume ? { enabled: true } : {}) });
    if (!current()) return;
    setStatus(latest);
    if (current()) setNotice(L('通知语言已保存。', 'Notification language saved.'));
  });

  const controls = () => <>
    {!account ? <button className={styles.primary} onClick={onConnect}>{L('连接钱包', 'Connect wallet')}</button>
      : !enabled ? <p className={styles.muted}>{capabilities === null ? L('正在检查通知服务…', 'Checking notification availability…') : L('Telegram 通知暂未开放，请稍后再来。', 'Telegram notifications are not available yet. Please check back later.')}</p>
        : <>
          <div className={styles.wallet}><ShieldCheck size={17} /><span>{L('当前钱包', 'Current wallet')} · {account.slice(0, 6)}…{account.slice(-4)}</span></div>
          {status?.connected ? <>
            <div className={styles.connected}><CheckCircle2 size={20} /><div><strong>{status.blocked ? L('Telegram 接收受阻', 'Telegram delivery is blocked') : status.notificationsEnabled === false ? L('Telegram 提醒已暂停', 'Telegram alerts are paused') : L('Telegram 已绑定', 'Telegram connected')}</strong><span>{status.telegramLabel || 'Telegram'}</span></div></div>
            {status.blocked ? <div className={styles.confirmBox}><p>{L('请打开机器人，解除屏蔽并点击“开始”，然后重新检查。', 'Open the bot, unblock it and press Start, then check again.')}</p><div className={styles.actions}><a className={styles.secondary} href={`https://t.me/${NOTIFICATION_BOT}`} target="_blank" rel="noopener noreferrer">{L('打开机器人', 'Open bot')}<ExternalLink size={16}/></a><button className={styles.secondary} disabled={busy || blocked} onClick={() => act(() => refreshStatus())}>{L('重新检查', 'Check again')}</button></div></div>
              : status.notificationsEnabled === false ? <button className={styles.primary} disabled={busy || blocked} onClick={() => saveLanguage(true)}>{L('恢复通知', 'Resume alerts')}</button>
                : <p className={styles.muted}>{L('自动接收此钱包参与矿机的重要通知，无需逐台设置。', 'Important updates cover this wallet’s miners automatically. No setup per miner is needed.')}</p>}
            <div className={styles.language}><label htmlFor={prompt ? 'notification-language-dialog' : 'notification-language'}>{L('通知语言', 'Notification language')}</label>
              <select id={prompt ? 'notification-language-dialog' : 'notification-language'} value={requestLanguage} disabled={busy || blocked} onChange={e => setRequestLanguage(e.target.value)}><option value="zh">简体中文</option><option value="en">English</option></select>
              <button className={styles.secondary} disabled={busy || blocked || requestLanguage === status.language} onClick={() => saveLanguage()}>{L('保存', 'Save')}</button></div>
            {confirmDisconnect ? <div className={styles.confirmBox}><p>{L('解除后将停止 Telegram 提醒。你仍可在站内查看和投票。', 'Disconnecting stops Telegram alerts. You can still view updates and vote on this site.')}</p><div className={styles.actions}><button className={styles.secondary} disabled={busy || blocked} onClick={disconnect}>{L('确认解除绑定', 'Confirm disconnect')}</button><button className={styles.secondary} disabled={busy} onClick={() => setConfirmDisconnect(false)}>{L('取消', 'Cancel')}</button></div></div>
              : <button className={styles.textButton} disabled={busy || blocked} onClick={() => setConfirmDisconnect(true)}>{L('解除绑定 / 更换账号', 'Disconnect / change account')}</button>}
          </> : canConfirm ? <div className={styles.confirmBox}>
            <strong>{L('确认绑定这个 Telegram 账号？', 'Connect this Telegram account?')}</strong>
            <div className={styles.telegramLabel}>{binding.telegramLabel}</div>
            <p>{L('请确认这是你自己的账号。确认后才会开启通知。', 'Make sure this is your account. Notifications start only after you confirm.')}</p>
            <div className={styles.actions}><button className={styles.primary} disabled={busy || blocked} onClick={confirm}>{L('确认绑定', 'Confirm connection')}</button><button className={styles.secondary} disabled={busy || blocked} onClick={begin}>{L('重新绑定', 'Start again')}</button></div>
          </div> : bindingUrl ? <div className={styles.confirmBox}>
            <strong>{L('前往机器人，点击“开始”', 'Open the bot and press Start')}</strong>
            <p>{L('完成后返回本页，确认你的 Telegram 账号。当前还未完成绑定。', 'Return here to confirm your Telegram account. The connection is not complete yet.')}</p>
            <div className={styles.actions}><a className={styles.primary} href={bindingUrl} target="_blank" rel="noopener noreferrer">@{NOTIFICATION_BOT}<ExternalLink size={16}/></a>
              <button className={styles.secondary} disabled={busy || blocked} onClick={() => act(() => refreshStatus())}><RefreshCw size={16}/>{L('检查绑定', 'Check connection')}</button></div>
            {binding?.expiresAt && <small className={styles.muted}>{L('链接有效期至', 'Link valid until')} {displayDate(binding.expiresAt, locale)}</small>}
            <button className={styles.textButton} disabled={busy || blocked} onClick={begin}>{L('重新生成链接', 'Generate a new link')}</button>
          </div> : <>
            <button className={styles.primary} disabled={busy || blocked} onClick={begin}><Bell size={18}/>{busy ? L('请稍候…', 'Please wait…') : L('绑定 Telegram', 'Connect Telegram')}</button>
            <p className={styles.muted}>{L('验证钱包归属后打开机器人。不产生 Gas，不授权资产。', 'Verify wallet ownership, then open the bot. No Gas payment or asset approval.')}</p>
          </>}
        </>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
  </>;

  const inbox = () => <section className={styles.panel}>
    <div className={styles.sectionTitle}><h2>{L('我的通知', 'My notifications')}</h2>{account && enabled && <button className={styles.secondary} disabled={busy || blocked} onClick={() => act(() => refreshStatus({ inbox: true }))}><RefreshCw size={16}/>{needsLogin ? L('验证并查看', 'Verify and view') : L('刷新', 'Refresh')}</button>}</div>
    {needsLogin ? <p className={styles.muted}>{L('验证钱包后查看个人通知。', 'Verify your wallet to view personal notifications.')}</p>
      : !enabled ? <p className={styles.muted}>{L('通知服务暂未开放。', 'Notifications are not available yet.')}</p>
      : inboxState === 'error' || error && !status ? <p className={styles.muted}>{L('暂时无法读取通知，请刷新重试。', 'Notifications could not be loaded. Please refresh to retry.')}</p>
      : inboxState === 'loading' ? <p className={styles.muted} role="status">{L('正在读取通知…', 'Loading notifications…')}</p>
      : !items.length ? <p className={styles.muted}>{L('暂无通知。有新的矿机事项时，会显示在这里。', 'No notifications yet. New updates about your miners will appear here.')}</p>
        : <ul className={styles.inbox}>{items.map(item => <li key={item.id} className={item.readAt ? '' : styles.unread}>
          <strong>{notificationMessage(item, locale).title}</strong><p>{notificationMessage(item, locale).body}</p><small>{displayDate(item.createdAt, locale)}</small>
          <div className={styles.actions}><a className={styles.textButton} href={notificationTarget(item)}>{L('查看矿机', 'View miner')}<ExternalLink size={15}/></a>
            {!item.readAt && <button className={styles.textButton} disabled={busy || blocked} onClick={() => act(async () => { await request('inbox/read', 'POST', { id: item.id }); if (current()) await refreshStatus({ inbox: true }); })}>{L('标为已读', 'Mark as read')}</button>}</div>
        </li>)}</ul>}
  </section>;

  return <>
    {isPage ? <div className={styles.page}>
      <div className="page-heading"><div><div className="eyebrow">BEMine / NOTIFICATIONS</div><h1>{L('通知中心', 'Notifications')}</h1><p>{L('不错过与你的矿机有关的重要决定。', 'Keep up with important decisions about your miners.')}</p></div></div>
      <section className={styles.panel}><div className={styles.heading}><span className={styles.icon}><Bell size={24}/></span><div><h2>{L('我的矿机通知', 'My miner alerts')}</h2><p>{L('出售提案、投票截止提醒、投票结果与成交消息。', 'Sale proposals, voting reminders, results and completed sales.')}</p></div></div>{controls()}</section>
      {account && inbox()}
    </div> : account && enabled && eligible && ['overview', 'detail'].includes(route) && !status?.connected && <section className={styles.card}>
      <Bell size={23}/><div><strong>{L('开启矿机重要提醒', 'Stay informed about your miner')}</strong><p>{L('通过 Telegram 接收出售投票和结果通知，随时可以设置。', 'Receive sale voting and result updates on Telegram. Set up whenever you’re ready.')}</p></div>
      <button className={styles.secondary} disabled={blocked} onClick={onOpen}>{L('开启通知', 'Set up alerts')}</button>
    </section>}
    {prompt && !blocked && !isPage && <div className={styles.overlay} onMouseDown={e => { if (e.target === e.currentTarget && !busy) setPrompt(null); }}>
      <section className={styles.dialog} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="notification-prompt-title">
        <button className={styles.close} aria-label={L('稍后设置', 'Set up later')} disabled={busy} onClick={() => setPrompt(null)}><X size={22}/></button>
        <span className={styles.icon}><Bell size={27}/></span>
        <h2 id="notification-prompt-title">{prompt === 'claim' ? L('收益已领取，重要消息也别错过', 'Rewards claimed. Stay informed about what’s next.') : L('矿机已购入，开启重要提醒', 'Your miner is ready. Stay in the loop.')}</h2>
        <p>{L('出售投票、投票结果等与你有关的事项，我们会通过 Telegram 提醒你。', 'Get Telegram updates about miner sale votes, results and other important events.')}</p>
        {controls()}
        <button className={styles.later} disabled={busy} onClick={() => setPrompt(null)}>{L('稍后设置', 'Set up later')}</button>
      </section>
    </div>}
  </>;
}
