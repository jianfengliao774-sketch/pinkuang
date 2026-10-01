const ACCOUNT = /^0x[0-9a-f]{40}$/i;
export const WALLET_SESSION_RETRY_DELAYS = Object.freeze([0, 500, 1_500]);
export const WALLET_SESSION_READ_TIMEOUT_MS = 2_500;

const normalizeAccount = value => typeof value === 'string' && ACCOUNT.test(value) ? value.toLowerCase() : null;
const normalizeChain = value => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return null;
  try { const chain = BigInt(value); return chain > 0n ? chain : null; } catch { return null; }
};

/** Watch an already authorized wallet. No account permission, chain switch or
 * signing request is made here. Consumers must revoke pending actions in
 * onInvalidate and keep transaction controls disabled until onRecovered.
 * A transport interruption retains the selected identity only while bounded
 * read-only probes establish that the same account and chain are still active. */
export function startWalletSession({ provider, account, chainId = 56,
  onInvalidate, onChecking, onRecovered, onDisconnected,
  followAccountChanges = false,
  isCurrent = () => true, schedule = setTimeout, unschedule = clearTimeout }) {
  let expectedAccount = normalizeAccount(account), selectedAccount = account, revision = 0;
  const expectedChain = normalizeChain(chainId);
  if (!expectedAccount || !expectedChain || typeof provider?.request !== 'function'
    || typeof provider?.on !== 'function') throw new TypeError('A connected wallet account and chain are required.');
  let state = 'connected', attempts = 0, retryTimer, cancelProbe;
  const current = () => state !== 'stopped' && state !== 'disconnected' && isCurrent();
  const clear = () => {
    unschedule(retryTimer); retryTimer = undefined;
    cancelProbe?.(); cancelProbe = undefined;
  };
  const disconnect = reason => {
    if (!current()) return;
    const wasChecking = state === 'checking';
    state = 'disconnected'; clear();
    if (!wasChecking) onInvalidate({ reason });
    onDisconnected({ reason });
  };
  const readIdentity = () => new Promise(resolve => {
    let settled = false, deadline;
    const finish = value => {
      if (settled) return;
      settled = true; unschedule(deadline); cancelProbe = undefined; resolve(value);
    };
    cancelProbe = () => finish(null);
    deadline = schedule(() => finish(null), WALLET_SESSION_READ_TIMEOUT_MS);
    Promise.all([
      Promise.resolve().then(() => provider.request({ method: 'eth_accounts' })),
      Promise.resolve().then(() => provider.request({ method: 'eth_chainId' })),
    ]).then(([accounts, chain]) => finish({ accounts, chain }), () => finish(null));
  });
  const probe = async () => {
    if (!current() || state !== 'checking') return;
    const version = revision;
    attempts++;
    const result = await readIdentity();
    if (!current() || state !== 'checking' || version !== revision) return;
    if (result) {
      if (Array.isArray(result.accounts) && result.accounts.length === 0) { disconnect('account'); return; }
      const selected = Array.isArray(result.accounts) ? normalizeAccount(result.accounts[0]) : null;
      const chain = normalizeChain(result.chain);
      if (selected && selected !== expectedAccount) { disconnect('account'); return; }
      if (chain && chain !== expectedChain) { disconnect('network'); return; }
      if (selected === expectedAccount && chain === expectedChain) {
        state = 'connected'; attempts = 0;
        onRecovered({ account: selectedAccount, chainId: Number(expectedChain) });
        return;
      }
    }
    if (attempts >= WALLET_SESSION_RETRY_DELAYS.length) { disconnect('transport'); return; }
    retryTimer = schedule(() => { retryTimer = undefined; void probe(); }, WALLET_SESSION_RETRY_DELAYS[attempts]);
  };
  const recheck = (reason = 'transport') => {
    if (!current() || state === 'checking') return;
    state = 'checking'; attempts = 0;
    onInvalidate({ reason });
    onChecking();
    if (current() && state === 'checking') void probe();
  };
  const accountsChanged = accounts => {
    if (!current()) return;
    if (!Array.isArray(accounts)) { recheck(); return; }
    if (!accounts.length) { disconnect('account'); return; }
    const selected = normalizeAccount(accounts[0]);
    if (!selected) recheck();
    else if (selected !== expectedAccount) {
      if (!followAccountChanges) { disconnect('account'); return; }
      // Switch only to accounts already exposed by this concrete provider.
      // Retire old drafts immediately; a read-only chain/account probe must
      // finish before controls for the new account become available.
      revision++; clear(); expectedAccount = selected; selectedAccount = accounts[0];
      state = 'connected'; recheck('account');
    }
    // Providers may re-announce the same selected account on focus/unlock.
  };
  const chainChanged = value => {
    if (!current()) return;
    const chain = normalizeChain(value);
    if (!chain) recheck();
    else if (chain !== expectedChain) disconnect('network');
  };
  const connected = value => chainChanged(value?.chainId);
  const listeners = { accountsChanged, chainChanged, disconnect: () => recheck(), connect: connected };
  for (const [event, listener] of Object.entries(listeners)) provider.on(event, listener);
  return () => {
    state = 'stopped'; clear();
    const remove = provider.removeListener || provider.off;
    for (const [event, listener] of Object.entries(listeners)) remove?.call(provider, event, listener);
  };
}
