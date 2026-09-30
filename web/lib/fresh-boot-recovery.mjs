/** A validated current graph may still await an operational worker/index.
 * Identity checks and user-paid exits are separate from that service readiness. */
export const freshIdentityReadable = config => config?.status === 'ready'
  && config.productFamily === 'fresh-v4' && config.readMode === 'current' && config.stale === false
  && config.rechecking !== true && config.walletSessionReady !== false;
export const freshOperationsReady = config => freshIdentityReadable(config)
  && config.operationalReady === true && config.transactionReady !== false;
export const FRESH_RECOVERY_DELAYS = Object.freeze([15_000, 30_000, 60_000, 60_000, 60_000]);
const sameContext = (a, b) => a.wallet === b.wallet && a.revision === b.revision && a.route === b.route;
const deploymentIdentity = value => JSON.stringify([value.stage, value.artifactDigest, value.operationId,
  value.stageActivationBlock, value.stageActivationHash, value.freshAuthority, value.manifest]);
/** Read clients carry immutable deployment bindings, not mutable worker gates. */
export const freshReadClientIdentity = value => JSON.stringify([deploymentIdentity(value), value.origin,
  value.rpcUrl, value.indexBaseUrl, value.journalBase, value.productFamily]);

/** Preserve an already validated deployment for reads while a new check runs.
 * This local display state revokes every transaction permission; it does not
 * invent a new graph or turn an unavailable deployment into a validated one. */
export function freshRecheckDisplay(config, now = Date.now()) {
  if (config?.status !== 'ready' || config.productFamily !== 'fresh-v4' || !config.manifest) return null;
  const expiresAt = config.recheckExpiresAt ?? now + 30 * 60_000 - (config.stale === true ? config.snapshotAgeMs : 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { ...config, rechecking: true, recheckExpiresAt: expiresAt, operationalReady: false,
    transactionReady: false, userExitReady: false };
}

/** One bounded boot/recovery round. Never starts a wallet request or signs.
 * Repeated waiting graphs retain the existing client; only a readiness/stage
 * change is published. No polling remains after a healthy current result. */
export function startFreshBootRecovery({ load, onConfig, onError, onExhausted, onExpired,
  getContext, isBusy, isVisible = () => true,
  initialConfig = null,
  schedule = setTimeout, unschedule = clearTimeout }) {
  let stopped = false, pending = false, attempts = 0, published = initialConfig;
  let timer, expiryTimer;
  const clear = () => { unschedule(timer); unschedule(expiryTimer); };
  const expire = () => {
    if (stopped) return;
    // Expiry revokes historical display even while a confirmation is open.
    stopped = true; clear(); onExpired();
  };
  const accept = value => {
    const changed = !published || value.status !== published.status
      || value.readMode !== published.readMode || value.stale !== published.stale
      || value.operationalReady !== published.operationalReady
      || value.transactionReady !== published.transactionReady || value.userExitReady !== published.userExitReady
      || value.rechecking !== published.rechecking
      || deploymentIdentity(value) !== deploymentIdentity(published);
    if (changed) { published = value; onConfig(value); }
    if (value.status === 'ready' && value.stale === true && !expiryTimer) {
      expiryTimer = schedule(expire, Math.max(0, 30 * 60_000 - value.snapshotAgeMs));
    } else if (value.stale !== true) { unschedule(expiryTimer); expiryTimer = undefined; }
  };
  const retry = () => {
    if (stopped) return;
    if (attempts >= FRESH_RECOVERY_DELAYS.length) { onExhausted(true); return; }
    timer = schedule(() => void run(true), FRESH_RECOVERY_DELAYS[attempts]);
  };
  const run = async recovery => {
    if (stopped || pending) return;
    // Keep an active confirmation intact; hidden tabs do not create catch-up bursts.
    if (recovery && (!isVisible() || isBusy())) { timer = schedule(() => void run(true), 5_000); return; }
    if (recovery) attempts++;
    pending = true;
    const identity = getContext();
    try {
      const value = await load();
      if (stopped) return;
      if (published && (!sameContext(identity, getContext()) || isBusy())) { retry(); return; }
      accept(value);
      if (freshOperationsReady(value)) { stopped = true; clear(); onExhausted(false); return; }
      retry();
    } catch (error) {
      if (!stopped) { onError(error, !!published); retry(); }
    } finally { pending = false; }
  };
  onExhausted(false);
  if (initialConfig?.rechecking === true) expiryTimer = schedule(expire, Math.max(0, initialConfig.recheckExpiresAt - Date.now()));
  else if (initialConfig?.stale === true) expiryTimer = schedule(expire, Math.max(0, 30 * 60_000 - initialConfig.snapshotAgeMs));
  void run(false);
  return () => { stopped = true; clear(); };
}
