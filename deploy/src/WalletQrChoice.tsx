import { useEffect, useRef, useState } from 'react';
import { QrCode } from 'lucide-react';
import { createWalletConnectConnector, validWalletConnectProjectId, type WalletConnectConnector } from '../shared/walletconnect.mjs';
import type { WalletOption } from './wallet';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';
export default function WalletQrChoice({ onConnect, onPending }: {
  onConnect: (option: WalletOption) => Promise<void>; onPending: (pending: boolean) => void;
}) {
  const connector = useRef<WalletConnectConnector | null>(null), mounted = useRef(true), running = useRef(false);
  const [pending, setPending] = useState(false), [image, setImage] = useState(''), [error, setError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; connector.current?.cancel(); onPending(false); }; }, [onPending]);
  if (!validWalletConnectProjectId(projectId)) return null;
  async function connect() {
    if (running.current) return;
    running.current = true; setPending(true); onPending(true); setError(''); setImage('');
    try {
      connector.current ||= createWalletConnectConnector({ projectId, origin: location.href,
        loadProvider: async () => (await import('@walletconnect/ethereum-provider')).EthereumProvider,
        renderQr: async uri => (await import('qrcode')).toDataURL(uri, { width: 288, margin: 3 }) });
      const provider = await connector.current.connect({ onQr: value => { if (mounted.current) setImage(value); } });
      if (mounted.current) await onConnect({ id: 'walletconnect', name: 'WalletConnect', provider });
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (mounted.current && code !== 'WC_CANCELLED') setError(code === 'WC_TIMEOUT' ? '扫码连接已超时，请重试。' : '扫码连接未完成，请重试或使用钱包浏览器。');
    } finally {
      running.current = false;
      if (mounted.current) { setPending(false); setImage(''); onPending(false); }
    }
  }
  return <div className="wallet-qr-choice">
    {!pending && <button className="secondary-button" onClick={() => void connect()}><QrCode size={20}/>WalletConnect · 手机钱包扫码</button>}
    {pending && <div style={{display:'grid',justifyItems:'center',gap:12,marginTop:16}}>
      {image ? <img src={image} alt="WalletConnect 连接二维码" width="288" height="288" style={{maxWidth:'100%',height:'auto',borderRadius:12}}/> : <p role="status">正在准备连接二维码…</p>}
      <p>用手机钱包扫描，在钱包中确认连接。</p>
      <button className="text-button" onClick={() => connector.current?.cancel()}>取消扫码</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
