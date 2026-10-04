import { WALLET_BRANDS } from './wallet-discovery.mjs';

export const WALLET_PREFERENCE_KEY = 'bemine:wallet-preference:v1';
export const WALLET_RESTORE_DISCOVERY_WINDOW_MS = 5_000;
export const WALLET_RESTORE_READ_TIMEOUT_MS = 2_500;
export const WALLET_RESTORE_RETRY_DELAYS = Object.freeze([0, 500, 1_500]);

const ACCOUNT = /^0x[0-9a-f]{40}$/i;
const RDNS = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i;
const brands = new Set(WALLET_BRANDS.map(item => item.id));
const read = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
const notify = (callback, value) => { try { callback?.(value); } catch { /* A UI callback cannot restart recovery. */ } };

function selector(value) {
  const source = read(value, 'source'), brandId = read(value, 'brandId') ?? null;
  if (brandId !== null && !brands.has(brandId)) return null;
  if (source === 'eip6963') {
    const rdns = read(value, 'rdns');
    if (typeof rdns !== 'string' || rdns.length > 253 || !RDNS.test(rdns)) return null;
    return { version: 1, source, rdns: rdns.toLowerCase(), brandId };
  }
  if (source === 'legacy' && brandId) return { version: 1, source, rdns: '', brandId };
  return null;
}

const samePreference = (left, right) => !!left && !!right && left.source === right.source
  && left.rdns === right.rdns && left.brandId === right.brandId;

/** A remembered wallet is selection intent, never proof of authorization. */
export function readWalletPreference(storage) {
  try {
    const raw = storage?.getItem(WALLET_PREFERENCE_KEY);
    if (typeof raw !== 'string' || raw.length > 1_024) return null;
    const value = JSON.parse(raw);
    return value?.version === 1 ? selector(value) : null;
  } catch { return null; }
}

/** Unsupported/generic/WalletConnect selections retire any prior injected hint. */
export function saveWalletPreference(storage, entry) {
  const value = read(read(entry, 'provider'), 'isWalletConnect') === true ? null : selector(entry);
  if (!value) { clearWalletPreference(storage); return false; }
  try { storage.setItem(WALLET_PREFERENCE_KEY, JSON.stringify(value)); return true; }
  catch { clearWalletPreference(storage); return false; }
}

/** A late announcement may rename the exact provider already selected by the
 * user. Migrate only that object and the same reviewed brand, never brand-only
 * candidates or another extension wrapper. */
export function migrateWalletPreference(storage, provider, entries) {
  const preference = readWalletPreference(storage);
  if (preference?.source !== 'legacy' || !provider || !Array.isArray(entries)) return false;
  const matches = entries.filter(entry => entry?.provider === provider && entry.source === 'eip6963'
    && entry.brandId === preference.brandId && WALLET_BRANDS.find(item => item.id === entry.brandId)
      ?.rdns.includes(String(entry.rdns).toLowerCase()));
  return matches.length === 1 && saveWalletPreference(storage, matches[0]);
}

export function clearWalletPreference(storage) {
  try { storage.removeItem(WALLET_PREFERENCE_KEY); return true; }
  catch { return false; }
}

function chainId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return null;
  try { const chain = BigInt(value); return chain > 0n ? chain : null; } catch { return null; }
}

/** Refresh an explicitly selected injected wallet without permissions, switching,
 * signing, transactions, or WalletConnect initialization. Discovery stays owned
 * by the caller: call refresh on each announcement, and cancel before manual
 * connection/disconnection or unmount. Repeated announcements cannot reset the
 * timeout/retry budget. onSettled is called once, except after silent cancel or
 * loss of isCurrent ownership. Injectable timers are for deterministic tests. */
export function startWalletRestore({ discovery, storage, isCurrent = () => true,
  onRecovered, onChecking, onSettled, discoveryWindowMs = WALLET_RESTORE_DISCOVERY_WINDOW_MS,
  schedule = setTimeout, unschedule = clearTimeout }) {
  const preference = readWalletPreference(storage);
  let stopped = false, settled = false, selection = null, attempts = 0, revision = 0;
  let discoveryTimer, retryTimer, cancelRead, removeListeners;
  const cleanupRead = () => { cancelRead?.(); cancelRead = undefined; };
  const cleanup = () => {
    revision++;
    unschedule(discoveryTimer); discoveryTimer = undefined;
    unschedule(retryTimer); retryTimer = undefined;
    cleanupRead(); removeListeners?.(); removeListeners = undefined;
  };
  const cancel = () => { if (stopped || settled) return; stopped = true; cleanup(); };
  const current = () => {
    if (stopped || settled) return false;
    let owns = false;
    try { owns = isCurrent() === true; } catch { /* Lost ownership fails closed. */ }
    if (!owns) { cancel(); return false; }
    return true;
  };
  const finish = (reason, identity) => {
    if (!current()) return;
    settled = true; cleanup();
    notify(onChecking, false);
    if (identity) notify(onRecovered, { ...identity, entry: selection, provider: selection.provider });
    notify(onSettled, { restored: !!identity, reason });
  };
  const preferenceCurrent = () => {
    if (!current()) return false;
    if (!samePreference(preference, readWalletPreference(storage))) {
      finish('preference-cleared'); return false;
    }
    return true;
  };
  const candidates = () => {
    const wallets = discovery?.getWallets();
    if (!Array.isArray(wallets)) throw new TypeError('Wallet discovery is unavailable.');
    const providers = new Map();
    for (const entry of wallets) {
      const provider = read(entry, 'provider');
      if (read(provider, 'isWalletConnect') === true || !samePreference(preference, selector(entry))) continue;
      if (provider && !providers.has(provider)) providers.set(provider, entry);
    }
    return [...providers.values()];
  };
  const verifySelection = () => {
    if (!preferenceCurrent()) return false;
    let entries;
    try { entries = candidates(); } catch { finish('discovery-unavailable'); return false; }
    if (entries.length > 1) { finish('ambiguous'); return false; }
    if (entries.length !== 1 || entries[0].provider !== selection.provider) {
      finish('wallet-changed'); return false;
    }
    return true;
  };
  const identityRead = () => new Promise(resolve => {
    let done = false, deadline;
    const finishRead = result => {
      if (done) return;
      done = true; unschedule(deadline); cancelRead = undefined; resolve(result);
    };
    cancelRead = () => finishRead(null);
    deadline = schedule(() => finishRead(null), WALLET_RESTORE_READ_TIMEOUT_MS);
    const request = method => {
      if (done || !current()) return undefined;
      return selection.provider.request({ method });
    };
    Promise.all([
      Promise.resolve().then(() => request('eth_accounts')),
      Promise.resolve().then(() => request('eth_chainId')),
    ]).then(([accounts, chain]) => finishRead({ accounts, chain }), () => finishRead(null));
  });
  const probe = async () => {
    retryTimer = undefined;
    if (!verifySelection()) return;
    attempts++;
    const version = revision;
    const result = await identityRead();
    if (!verifySelection()) return;
    const fresh = version === revision;
    if (fresh && result) {
      if (Array.isArray(result.accounts) && result.accounts.length === 0) { finish('unauthorized'); return; }
      const account = Array.isArray(result.accounts) && typeof result.accounts[0] === 'string'
        && ACCOUNT.test(result.accounts[0]) ? result.accounts[0].toLowerCase() : null;
      const chain = chainId(result.chain);
      if (chain && chain !== 56n) { finish('network'); return; }
      if (account && chain === 56n) { finish('restored', { account, chainId: 56 }); return; }
    }
    if (attempts >= WALLET_RESTORE_RETRY_DELAYS.length) { finish(fresh && result ? 'invalid-identity' : 'transport'); return; }
    retryTimer = schedule(() => { void probe(); }, WALLET_RESTORE_RETRY_DELAYS[attempts]);
  };
  const changed = () => {
    if (!current()) return;
    revision++; cleanupRead();
    // An already queued retry keeps its deadline and remaining budget.
  };
  const refresh = () => {
    if (!current()) return;
    if (!preference) { finish('no-preference'); return; }
    if (!preferenceCurrent()) return;
    let entries;
    try { entries = candidates(); } catch { finish('discovery-unavailable'); return; }
    if (entries.length > 1) { finish('ambiguous'); return; }
    if (selection) { verifySelection(); return; }
    if (!entries.length) return;
    selection = entries[0];
    const provider = selection.provider, on = read(provider, 'on');
    const remove = read(provider, 'removeListener') || read(provider, 'off');
    if (typeof read(provider, 'request') !== 'function' || typeof on !== 'function' || typeof remove !== 'function') {
      finish('unsupported-provider'); return;
    }
    unschedule(discoveryTimer); discoveryTimer = undefined;
    const attached = [];
    removeListeners = () => {
      for (const event of attached) try { remove.call(provider, event, changed); } catch { /* Best-effort cleanup. */ }
    };
    try {
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect', 'connect']) {
        attached.push(event); on.call(provider, event, changed);
      }
    } catch { finish('unsupported-provider'); return; }
    void probe();
  };
  if (preference && current()) {
    notify(onChecking, true);
    const windowMs = Number.isFinite(discoveryWindowMs) && discoveryWindowMs > 0
      ? discoveryWindowMs : WALLET_RESTORE_DISCOVERY_WINDOW_MS;
    discoveryTimer = schedule(() => finish('discovery-timeout'), windowMs);
  }
  refresh();
  return { refresh, cancel };
}
