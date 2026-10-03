/** Public invalidation messages only. Loaded data and transaction state stay separate. */
export function startDisplayUpdates(config, {
  EventSourceImpl = globalThis.EventSource, onUpdate, isPaused = () => false,
  documentObject = globalThis.document, schedule = setTimeout, unschedule = clearTimeout,
  debounceMs = 750,
} = {}) {
  if (!config?.displayOnly || typeof EventSourceImpl !== 'function') return () => {};
  const base = new URL(config.indexBaseUrl, config.origin);
  if (base.origin !== config.origin) return () => {};
  const stream = new EventSourceImpl(`${base.href.replace(/\/$/, '')}/v1/display/events`);
  let revision, pending = false, timer, stopped = false;
  const flush = () => {
    timer = undefined;
    if (stopped || !pending) return;
    if (documentObject?.visibilityState === 'hidden' || isPaused()) {
      timer = schedule(flush, 1500); return;
    }
    pending = false; onUpdate?.();
  };
  const changed = event => {
    let input;
    try { input = JSON.parse(event.data); } catch { return; }
    if (typeof input?.revision !== 'string' || !input.revision || input.revision.length > 160) return;
    if (revision === undefined) { revision = input.revision; return; }
    if (revision === input.revision) return;
    revision = input.revision; pending = true;
    if (!timer) timer = schedule(flush, debounceMs);
  };
  stream.addEventListener('update', changed);
  const visible = () => { if (pending && !timer) timer = schedule(flush, debounceMs); };
  documentObject?.addEventListener('visibilitychange', visible);
  // EventSource resumes with Last-Event-ID. Existing page refresh is the fallback.
  return () => {
    stopped = true; unschedule(timer); stream.removeEventListener('update', changed); stream.close();
    documentObject?.removeEventListener('visibilitychange', visible);
  };
}
