/** Synthetic public history pages. No wallet, network or signing state. */
import assert from 'node:assert/strict';
const hash = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const key = row => [row.blockNumber, row.transactionIndex, row.logIndex].join(':');

export function activityPaginationFixture(fresh, { count = 45 } = {}) {
  const source = fresh.f.source();
  const rows = Array.from({ length: count }, (_, i) => ({
    event: 'Deposited', fields: { member: fresh.ordinary, shares: '1', amount: String(BigInt(i + 1) * 10n ** 15n) },
    contract: fresh.manifest.factory, pool: fresh.f.base.rows[0].pool,
    blockNumber: 100 - Math.floor(i / 6), blockHash: hash(100 - Math.floor(i / 6)),
    transactionHash: hash(2000 + i), transactionIndex: 5 - i % 6, logIndex: 0,
    timestamp: source.indexedTimestamp - Math.floor(i / 6) * 3, source: 'pool',
  }));
  const state = { requests: [], mode: 'valid', hold: null };
  async function read(url) {
    const query = new URL(url).searchParams, cursor = query.get('cursor'), limit = Number(query.get('limit') || 20);
    assert(!query.has('account') && !query.has('pool'), 'Public history must not inherit a wallet or pool filter');
    assert(Number.isInteger(limit) && limit > 0 && limit <= 20);
    const start = cursor === null ? 0 : rows.findIndex(row => key(row) === cursor) + 1;
    assert(cursor === null || start > 0, 'Unknown fixture cursor');
    // Snapshot the result before holding; an old response must stay old even if
    // the test starts a new route/read epoch before releasing this request.
    const selected = structuredClone(rows.slice(start, start + limit));
    const reply = { source: fresh.f.source(), data: { items: selected,
      nextCursor: start + selected.length < rows.length ? key(selected.at(-1)) : null } };
    const mode = cursor ? state.mode : 'valid';
    const entry = { cursor, limit, mode, startedAt: Date.now(), completed: false };
    state.requests.push(entry);
    if (cursor && state.hold) { const hold = state.hold; state.hold = null; await hold.wait(); }
    if (mode === 'source-changed') reply.source.indexedBlockHash = hash(999999);
    if (mode === 'duplicate-order') reply.data.items[0] = structuredClone(rows[start - 1]);
    entry.completed = true;
    return mode === 'unavailable'
      ? { status: 503, body: { error: 'Synthetic next-page outage' } }
      : { status: 200, body: reply };
  }
  return { rows, state, read, cursorAt: index => key(rows[index]) };
}
