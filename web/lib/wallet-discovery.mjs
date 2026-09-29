/** Discovery only: no account permission, chain switch, signature or transaction requests. */
export const WALLET_BRANDS = Object.freeze([
  { id: 'metamask', name: 'MetaMask', rdns: ['io.metamask'], download: 'https://metamask.io/download/' },
  { id: 'okx', name: 'OKX Wallet', rdns: ['com.okex.wallet', 'com.okx.wallet'], download: 'https://web3.okx.com/download' },
  { id: 'trust', name: 'Trust Wallet', rdns: ['com.trustwallet.app'], download: 'https://trustwallet.com/download' },
  { id: 'coinbase', name: 'Coinbase Wallet', rdns: ['com.coinbase.wallet', 'com.coinbase'], download: 'https://www.coinbase.com/wallet/downloads' },
  { id: 'binance', name: 'Binance Wallet', rdns: ['com.binance.wallet', 'com.binance'], download: 'https://www.binance.com/en/web3wallet' },
  { id: 'bitget', name: 'Bitget Wallet', rdns: ['com.bitget.web3', 'com.bitget.wallet'], download: 'https://web3.bitget.com/en/wallet-download' },
  { id: 'tokenpocket', name: 'TokenPocket', rdns: ['pro.tokenpocket', 'com.tokenpocket'], download: 'https://www.tokenpocket.pro/en/download/app' },
]);
const brand = id => WALLET_BRANDS.find(item => item.id === id);
const read = (object, key) => { try { return object?.[key]; } catch { return undefined; } };
const isProvider = value => typeof read(value, 'request') === 'function';
const flag = (provider, name) => read(provider, name) === true;
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value);

export function safeWalletIcon(value) {
  return typeof value === 'string' && value.length <= 262144
    && /^data:image\/(?:png|webp|jpeg|gif|svg\+xml)(?:;base64)?,/i.test(value) ? value : null;
}

function legacyBrand(provider) {
  // Several wallets also expose isMetaMask for compatibility: specific identities win.
  if (flag(provider, 'isOkxWallet') || flag(provider, 'isOKExWallet')) return brand('okx');
  if (flag(provider, 'isTrust') || flag(provider, 'isTrustWallet')) return brand('trust');
  if (flag(provider, 'isCoinbaseWallet')) return brand('coinbase');
  if (flag(provider, 'isBinance') || flag(provider, 'isBinanceWallet')) return brand('binance');
  if (flag(provider, 'isBitKeep') || flag(provider, 'isBitgetWallet')) return brand('bitget');
  if (flag(provider, 'isTokenPocket')) return brand('tokenpocket');
  if (flag(provider, 'isMetaMask')) return brand('metamask');
  return null;
}

/** Keep this alive for the page lifetime, so late EIP-6963 announcements remain selectable. */
export function createWalletDiscovery(target, onChange = () => {}) {
  const byProvider = new Map(), byUuid = new Map();
  let nextId = 0, stopped = false;
  const getWallets = () => [...byProvider.values()];
  const publish = () => { if (!stopped) onChange(getWallets()); };
  function add(provider, metadata = {}) {
    if (!isProvider(provider) || stopped || byProvider.size >= 32) return;
    const old = byProvider.get(provider);
    if (old?.source === 'eip6963' || (old && metadata.source !== 'eip6963' && (old.brandId || !metadata.brand))) return;
    const known = metadata.brand || legacyBrand(provider);
    const entry = Object.freeze({ id: old?.id || `wallet-${++nextId}`, provider,
      name: metadata.name || known?.name || 'Browser wallet', brandId: known?.id || null,
      icon: safeWalletIcon(metadata.icon), rdns: metadata.rdns || '', source: metadata.source || 'legacy' });
    byProvider.set(provider, entry);
    publish();
  }
  function announce(event) {
    try {
      const detail = event?.detail, info = detail?.info, provider = detail?.provider;
      if (!isProvider(provider) || !uuid(info?.uuid) || typeof info.name !== 'string'
        || !info.name.trim() || info.name.length > 80 || typeof info.rdns !== 'string'
        || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(info.rdns) || info.rdns.length > 253) return;
      if (byUuid.has(info.uuid) && byUuid.get(info.uuid) !== provider) return;
      byUuid.set(info.uuid, provider);
      add(provider, { name: info.name.trim(), icon: info.icon, rdns: info.rdns, source: 'eip6963',
        brand: WALLET_BRANDS.find(item => item.rdns.includes(info.rdns.toLowerCase())) });
    } catch { /* Malformed wallet announcements cannot break the page. */ }
  }
  function legacy() {
    const ethereum = read(target, 'ethereum'), providers = read(ethereum, 'providers');
    // An aggregate provider can change its selected backend; prefer its concrete children.
    const children = Array.isArray(providers) ? providers.slice(0, 32).filter(provider => provider !== ethereum && isProvider(provider)) : [];
    if (children.length) {
      if (byProvider.get(ethereum)?.source === 'legacy') { byProvider.delete(ethereum); publish(); }
      children.forEach(provider => add(provider));
    } else add(ethereum);
    const namespaces = [
      ['okxwallet', 'okx'], ['trustwallet', 'trust'], ['trustWallet', 'trust'],
      ['coinbaseWalletExtension', 'coinbase'], ['BinanceChain', 'binance'],
      ['binancew3w', 'binance'], ['bitkeep', 'bitget'], ['bitgetWallet', 'bitget'],
      ['tokenpocket', 'tokenpocket'],
    ];
    for (const [key, id] of namespaces) {
      const value = read(target, key), provider = isProvider(read(value, 'ethereum')) ? read(value, 'ethereum') : value;
      if (children.length && provider === ethereum) continue;
      add(provider, { brand: brand(id) });
    }
  }
  const refresh = () => {
    if (stopped) return;
    legacy();
    target.dispatchEvent(new (target.Event || Event)('eip6963:requestProvider'));
  };
  target.addEventListener('eip6963:announceProvider', announce);
  target.addEventListener('ethereum#initialized', refresh);
  refresh();
  return { getWallets, refresh, destroy() {
    stopped = true;
    target.removeEventListener('eip6963:announceProvider', announce);
    target.removeEventListener('ethereum#initialized', refresh);
  } };
}

export function walletConnectionError(error, locale = 'zh') {
  const zh = locale !== 'en', code = Number(error?.code ?? error?.data?.originalError?.code);
  if (code === 4001) return zh ? '你取消了钱包授权。请选择钱包重新连接。' : 'You cancelled the wallet request. Select a wallet to try again.';
  if (code === -32002) return zh ? '钱包已有一个请求等待确认。请打开钱包扩展完成或拒绝该请求，再重试。' : 'A request is already pending. Open your wallet extension and approve or reject it before retrying.';
  if (code === 4100) return zh ? '钱包尚未授权此网站，请在钱包中允许连接。' : 'This site is not authorized. Allow the connection in your wallet.';
  if (code === 4900 || code === 4901) return zh ? '钱包网络连接不可用，请打开钱包检查网络后重试。' : 'The wallet network is unavailable. Open your wallet and check its connection.';
  return String(error?.shortMessage || error?.message || (zh ? '连接失败，请打开钱包后重试。' : 'Connection failed. Open your wallet and try again.')).slice(0, 250);
}

/** Official dapp-open links, never a transfer/signature link. Keep the URL exactly on this HTTPS site. */
export function mobileWalletLink(id, value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const target = url.href;
  if (id === 'metamask') return `https://metamask.app.link/dapp/${url.host}${url.pathname}${url.search}${url.hash}`;
  if (id === 'trust') return `https://link.trustwallet.com/open_url?coin_id=20000714&url=${encodeURIComponent(target)}`;
  if (id === 'bitget') return `https://bkcode.vip?action=dapp&url=${encodeURIComponent(target)}`;
  return null;
}
