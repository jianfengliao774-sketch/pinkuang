"use client";
import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy, ExternalLink, LoaderCircle, QrCode, RefreshCw, ShieldCheck, Smartphone, Wallet } from 'lucide-react';
import { WALLET_BRANDS, mobileWalletLink } from '../lib/wallet-discovery.mjs';
import '../app/wallet-connect.css';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
export function WalletIcon({ wallet, size = 36 }) {
  const [failed, setFailed] = useState(false);
  const brandId = wallet?.brandId || (WALLET_BRANDS.some(brand => brand.id === wallet?.id) ? wallet.id : null);
  const src = wallet?.icon || (brandId ? `${basePath}/wallets/${brandId}.${brandId === 'trust' ? 'svg' : 'png'}` : null);
  useEffect(() => setFailed(false), [src]);
  return <span className="wallet-brand-icon" style={{ width: size, height: size }} aria-hidden="true">
    {wallet?.id === 'walletconnect' ? <QrCode size={Math.round(size * .75)} /> : src && !failed ? <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} /> : <Wallet size={Math.round(size * .66)} />}
  </span>;
}

export default function WalletConnectModal({ wallets, onSelect, onRefresh, pendingId, error, locale = 'zh', dappUrl, qrEnabled = false, onScan, qrImage, onCancelScan }) {
  const L = (zh, en) => locale === 'en' ? en : zh;
  const [mobile, setMobile] = useState(false), [copied, setCopied] = useState(false), [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => setMobile(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)), []);
  const known = new Set(wallets.map(wallet => wallet.brandId));
  const others = WALLET_BRANDS.filter(brand => !known.has(brand.id));
  async function copyUrl() {
    try { await navigator.clipboard.writeText(dappUrl); setCopied(true); setCopyFailed(false); }
    catch { setCopied(false); setCopyFailed(true); }
  }
  return <div className="wallet-connect">
    <div className="wallet-connect-eyebrow"><span /><span>BNB Smart Chain</span><span className="wallet-chain-label">56</span></div>
    <h2 id="live-dialog-title">{L('连接你的钱包', 'Connect your wallet')}</h2>
    <p className="wallet-connect-intro">{L('选择你要使用的钱包，在钱包中确认连接。', 'Choose a wallet, then approve the connection in your wallet.')}</p>
    {error && <div className="wallet-connect-error" role="alert">{error}</div>}
    {pendingId && <div className="wallet-connect-status" role="status"><LoaderCircle size={18} className="wallet-spin" />
      <span>{pendingId === 'walletconnect' ? L('请使用手机钱包扫描二维码，并在钱包中确认。', 'Scan with your mobile wallet and approve in the wallet.') : L('请打开所选钱包，确认连接或网络切换请求。', 'Open the selected wallet to approve connection or network switching.')}</span></div>}
    {pendingId === 'walletconnect' && <div className="wallet-qr-panel">
      {qrImage ? <img src={qrImage} width="288" height="288" alt={L('WalletConnect 连接二维码', 'WalletConnect connection QR code')} /> : <p role="status">{L('正在准备连接二维码…', 'Preparing connection QR code…')}</p>}
      <button type="button" className="wallet-copy" onClick={onCancelScan}>{L('取消扫码', 'Cancel QR connection')}</button>
    </div>}
    {qrEnabled && !pendingId && <button type="button" className="wallet-connect-option wallet-qr-choice" onClick={onScan}>
      <WalletIcon wallet={{ id: 'walletconnect' }} /><span className="wallet-connect-name"><strong>WalletConnect</strong><small>{L('用手机钱包扫码连接', 'Connect a mobile wallet by QR code')}</small></span><QrCode size={20} />
    </button>}
    <div className="wallet-connect-section"><h3>{L('此浏览器中的钱包', 'Wallets in this browser')}</h3>
      <button type="button" className="wallet-discover" disabled={!!pendingId} onClick={onRefresh}><RefreshCw size={14} />{L('重新检测', 'Detect again')}</button></div>
    {wallets.length ? <div className="wallet-connect-list">{wallets.map(wallet => <button type="button" key={wallet.id}
      className="wallet-connect-option" disabled={!!pendingId} onClick={() => onSelect(wallet)} aria-label={`${L('连接', 'Connect')} ${wallet.name}`}>
      <WalletIcon wallet={wallet} /><span className="wallet-connect-name"><strong>{wallet.name}</strong><small>{L('已检测到', 'Detected')}</small></span>
      {pendingId === wallet.id ? <LoaderCircle size={19} className="wallet-spin" /> : <ArrowUpRight size={19} />}
    </button>)}</div> : <div className="wallet-none"><Wallet size={27} /><div><strong>{L('尚未检测到钱包', 'No wallet detected yet')}</strong>
      <p>{mobile ? L('在钱包 App 的浏览器中打开本页即可连接。', 'Open this page in your wallet app’s browser to connect.')
        : L('请安装并启用钱包扩展，允许它访问本网站，然后重新检测。', 'Install and enable a wallet extension, allow it on this site, then detect again.')}</p></div></div>}
    {others.length > 0 && <><div className="wallet-connect-section"><h3>{mobile ? L('在手机钱包中打开', 'Open in a mobile wallet') : L('其他钱包', 'More wallets')}</h3></div>
      <div className="wallet-catalog">{others.map(wallet => {
        const link = mobile ? mobileWalletLink(wallet.id, dappUrl) : null;
        return <a key={wallet.id} className="wallet-catalog-option" href={link || wallet.download}
          target={link ? '_self' : '_blank'} rel="noopener noreferrer" aria-label={`${wallet.name} · ${link ? L('打开 App', 'Open app') : L('官方网站', 'Official website')}`}>
          <WalletIcon wallet={wallet} size={30} /><span><strong>{wallet.name}</strong><small>{link ? L('打开 App', 'Open app') : L('官方网站', 'Official website')}</small></span><ExternalLink size={14} />
        </a>;
      })}</div></>}
    <div className="wallet-mobile-help"><Smartphone size={19} /><div><strong>{L('使用手机钱包', 'Using a mobile wallet')}</strong>
      <p>{L('也可以复制网址，在钱包 App 内置浏览器中打开。', 'You can also copy this URL and open it in your wallet app’s browser.')}</p>
      <button type="button" className="wallet-copy" onClick={copyUrl}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? L('已复制网址', 'URL copied') : L('复制当前网址', 'Copy page URL')}</button>
      {copyFailed && <><p role="status">{L('请长按下方网址复制。', 'Select the URL below to copy it.')}</p><input className="wallet-url-copy" aria-label={L('当前网址', 'Page URL')} readOnly value={dappUrl} onFocus={event => event.target.select()} /></>}
    </div></div>
    <p className="wallet-connect-footnote"><ShieldCheck size={16} />{L('连接仅授权读取公开地址，不会发送交易。', 'Connecting shares your public address. It does not send a transaction.')}</p>
  </div>;
}
