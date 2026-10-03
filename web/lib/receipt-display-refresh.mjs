// A mined receipt can precede the shared index/cache. Poll only display data
// for a short interval; receipt checks and wallet submission remain separate.
export const RECEIPT_DISPLAY_MAX_AGE_MS = 120_000;
export const RECEIPT_DISPLAY_INTERVAL_MS = 3_000;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function block(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'string' && /^(?:0x[\da-f]+|0|[1-9]\d*)$/i.test(value)) {
    try { return BigInt(value); } catch { /* Invalid numbers never keep polling alive. */ }
  }
  return null;
}

export function receiptDisplayTarget(records, account, now) {
  let target = null;
  for (const record of records ?? []) {
    if (record?.status !== 'confirmed' || !same(record.account, account)
      || !Number.isFinite(record.confirmedAt) || now < record.confirmedAt
      || now - record.confirmedAt >= RECEIPT_DISPLAY_MAX_AGE_MS) continue;
    const height = block(record.blockNumber);
    if (height !== null && (target === null || height > target)) target = height;
  }
  return target;
}

/** Use the sections actually mounted on this route, rather than an unrelated
 * header/source left over from the previous page. */
export function receiptDisplaySources({ route, marketTab, source, statsSource, positionsSource,
  ordersSource, activitySource, portfolioSource } = {}) {
  if (route === 'detail') return [source];
  if (route === 'portfolio') return [portfolioSource];
  if (route === 'home') return [source, statsSource];
  if (route === 'pools') return [source, portfolioSource];
  if (['overview', 'rewards'].includes(route)) return [positionsSource, portfolioSource, activitySource];
  if (route === 'governance') return [positionsSource, portfolioSource];
  if (route === 'records') return [activitySource];
  if (route === 'market') return [marketTab === 'whole' ? source : ordersSource, positionsSource, portfolioSource];
  return [];
}

export function receiptDisplayBehind(records, { account, factory, now, ...state } = {}) {
  const target = receiptDisplayTarget(records, account, now), sources = receiptDisplaySources(state);
  return target !== null && sources.length > 0 && sources.some(source => {
    const height = block(source?.indexedThrough);
    return !same(source?.factory, factory) || height === null || height < target;
  });
}

/** The callback only invalidates display GETs. No provider or wallet is
 * accepted here, so retries can never resend a transaction or recheck a receipt. */
export function startReceiptDisplayCatchup(records, { account, factory, getState, onRefresh,
  now = Date.now, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let stopped = false, timer;
  const check = () => {
    timer = undefined;
    if (stopped) return;
    const state = getState?.() ?? {};
    if (!receiptDisplayBehind(records, { ...state, account, factory, now: now() })) return;
    if (state.visible === true && !state.busy && !state.pastFirstRecordsPage) onRefresh?.();
    timer = schedule(check, RECEIPT_DISPLAY_INTERVAL_MS);
  };
  if (receiptDisplayTarget(records, account, now()) !== null) timer = schedule(check, RECEIPT_DISPLAY_INTERVAL_MS);
  return () => { stopped = true; unschedule(timer); };
}
