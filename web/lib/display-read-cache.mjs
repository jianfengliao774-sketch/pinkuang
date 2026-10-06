const aborted = () => Object.assign(new Error('展示数据读取已取消。'), { name: 'AbortError' });

/** Short-lived business reads only. Callers keep signing and journal state outside this cache. */
export function createDisplayReadCache({ maxEntries = 64 } = {}) {
  const providers = new WeakMap();
  return function cachedRead(provider, key, read, {
    signal, refreshToken = 0, force = false, cacheMs = 120_000, now = Date.now, shouldCache = () => true,
  } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    let entries = providers.get(provider);
    if (!entries) { entries = new Map(); providers.set(provider, entries); }
    const old = entries.get(key), time = now();
    let entry = old && old.refreshToken === refreshToken && !old.controller.signal.aborted
      && (!old.complete || !force && time >= old.savedAt && time - old.savedAt < cacheMs) ? old : null;
    if (!entry) {
      entry = { refreshToken, savedAt: time, complete: false, controller: new AbortController(), consumers: new Set() };
      entry.promise = Promise.resolve().then(() => read(entry.controller.signal)).then(value => {
        entry.complete = true; entry.savedAt = now();
        if (!shouldCache(value) && entries.get(key) === entry) entries.delete(key);
        return value;
      }, error => { if (entries.get(key) === entry) entries.delete(key); throw error; });
      // The last caller may leave while an EIP-1193 request is still settling.
      entry.promise.catch(() => {});
      entries.delete(key); entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    }
    return new Promise((resolve, reject) => {
      const consumer = {}; let settled = false;
      const finish = (result, error) => {
        if (settled) return;
        settled = true; entry.consumers.delete(consumer); signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(result);
      };
      const onAbort = () => {
        finish(null, aborted());
        if (!entry.complete && !entry.consumers.size) {
          entry.controller.abort(); if (entries.get(key) === entry) entries.delete(key);
        }
      };
      entry.consumers.add(consumer); signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(value => finish(value), error => finish(null, error));
    });
  };
}

const identities = new WeakMap(); let nextIdentity = 0;
export function displayProviderIdentity(provider) {
  if (!identities.has(provider)) identities.set(provider, ++nextIdentity);
  return identities.get(provider);
}

export function displayConfigIdentity(config) {
  return JSON.stringify([config?.stage, config?.kind, config?.artifactDigest, config?.origin, config?.indexBaseUrl,
    ...['authority', 'gasWallet', 'factory', 'shareMarket', 'portfolioFactory', 'portfolioMarket']
      .map(key => config?.[key]?.toLowerCase()), config?.manifest]);
}
