// SDK loading and QR rendering are injected so no relay is contacted on page load.
export const validWalletConnectProjectId = value => typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
const cancelled = () => Object.assign(new Error('Wallet connection cancelled.'), { code: 'WC_CANCELLED' });
// WalletConnect 2.25 returns a number for eth_chainId. Keep amount parsing strict
// by normalizing only this method at the EIP-1193 boundary.
export function standardWalletConnectProvider(wallet) {
  return {
    async request(args) {
      const result = await wallet.request(args);
      if (args.method !== 'eth_chainId' || typeof result !== 'number') return result;
      if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid wallet chain ID.');
      return `0x${result.toString(16)}`;
    },
    on: (...args) => wallet.on(...args),
    removeListener: (...args) => wallet.removeListener(...args),
    disconnect: () => wallet.disconnect(),
    get session() { return wallet.session; },
    isWalletConnect: true,
  };
}
const safeUri = uri => {
  if (typeof uri !== 'string' || uri.length > 4096 || !/^wc:[0-9a-f]{64}@2\?/i.test(uri)) return false;
  const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
  return params.get('relay-protocol') === 'irn' && /^[0-9a-f]{64}$/i.test(params.get('symKey') || '');
};

export function createWalletConnectConnector({ projectId, origin, loadProvider, renderQr, timeoutMs = 180_000 }) {
  let providerPromise, provider, attempt;
  const facades = new WeakMap();
  const enabled = validWalletConnectProjectId(projectId);
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('WalletConnect requires HTTPS.');
  function initialize() {
    if (!enabled) throw new Error('WalletConnect is not configured.');
    if (!providerPromise) {
      const loading = (async () => {
      const EthereumProvider = await loadProvider();
      const instance = await EthereumProvider.init({ projectId, optionalChains: [56], showQrModal: false,
        optionalMethods: ['eth_sendTransaction', 'personal_sign', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'],
        optionalEvents: ['accountsChanged', 'chainChanged'], telemetryEnabled: false,
        // A cancelled approval must never mutate the next pairing instance.
        customStoragePrefix: `pinkuang:${url.pathname}:${globalThis.crypto.randomUUID()}`,
        rpcMap: { 56: 'https://bsc-dataseed.bnbchain.org' },
        metadata: { name: '拼矿 BEMine', description: 'BEMine on BNB Smart Chain', url: url.origin, icons: [] } });
      return instance;
      })().catch(error => { if (providerPromise === loading) providerPromise = null; throw error; });
      providerPromise = loading;
    }
    return providerPromise;
  }
  async function disconnect() {
    const previous = provider;
    cancel();
    providerPromise = null; provider = null;
    try { if (previous?.session) await previous.disconnect(); } catch { /* Page state must still disconnect. */ }
  }
  function cancel() { attempt?.cancel(); }
  function connect({ onQr } = {}) {
    if (attempt) return Promise.reject(new Error('A wallet connection is already pending.'));
    let rejectCancelled;
    const interruption = new Promise((_, reject) => { rejectCancelled = reject; });
    const ticket = { active: true, provider: null, qrEpoch: 0, ownsPairing: false, topic: null };
    const clean = () => { clearTimeout(ticket.timer); ticket.provider?.removeListener?.('display_uri', display); if (attempt === ticket) attempt = null; };
    const display = uri => {
      const revision = ++ticket.qrEpoch;
      if (!ticket.active || !safeUri(uri)) return;
      ticket.topic = uri.slice(3, uri.indexOf('@'));
      Promise.resolve(renderQr(uri)).then(image => {
        if (ticket.active && revision === ticket.qrEpoch && typeof image === 'string' && image.startsWith('data:image/png;base64,')) onQr?.(image);
      }).catch(() => { if (ticket.active) ticket.cancel(new Error('Unable to create wallet QR code.')); });
    };
    ticket.cancel = error => {
      if (!ticket.active) return;
      ticket.active = false; clean();
      // abortPairingAttempt is a no-op in SDK 2.25.0. Remove only this pairing,
      // isolate retries, and disconnect any late session on its original instance.
      if (ticket.ownsPairing && ticket.topic) {
        Promise.resolve().then(() => ticket.provider?.signer?.client?.core?.pairing?.disconnect({ topic: ticket.topic })).catch(() => {});
      }
      if (providerPromise === ticket.promise) { providerPromise = null; provider = null; }
      rejectCancelled(error || cancelled());
    };
    attempt = ticket;
    ticket.timer = setTimeout(() => ticket.cancel(Object.assign(new Error('Wallet connection timed out. Please try again.'), { code: 'WC_TIMEOUT' })), timeoutMs);
    const work = (async () => {
      ticket.promise = initialize();
      const wallet = await ticket.promise;
      ticket.provider = wallet;
      if (!ticket.active) throw cancelled();
      provider = wallet;
      if (!wallet.session) {
        ticket.ownsPairing = true;
        wallet.on('display_uri', display);
        await wallet.connect();
      }
      if (!ticket.active) { if (ticket.ownsPairing && wallet.session) await wallet.disconnect().catch(() => {}); throw cancelled(); }
      if (!facades.has(wallet)) facades.set(wallet, standardWalletConnectProvider(wallet));
      return facades.get(wallet);
    })();
    return Promise.race([work, interruption]).finally(() => { ticket.active = false; clean(); });
  }
  return { enabled, connect, cancel, disconnect };
}
