import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startWalletSession } from '../lib/wallet-session.mjs';

const account = '0x7674fa446D42b1f7f150DC5e678cc525d275Ea53';
const other = '0x0000000000000000000000000000000000000002';
const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function fixture({ request, isCurrent = () => true, followAccountChanges = false } = {}) {
  let now = 0, serial = 0;
  const provider = new EventEmitter(), calls = [], events = [], timers = new Map();
  provider.request = args => {
    calls.push(args);
    assert(['eth_accounts', 'eth_chainId'].includes(args.method), `Unexpected permission, switch or signing request: ${args.method}`);
    return request ? request(args) : args.method === 'eth_accounts' ? [account] : '0x38';
  };
  const stop = startWalletSession({ provider, account, isCurrent, followAccountChanges,
    onInvalidate: value => events.push({ type: 'invalidate', ...value }),
    onChecking: () => events.push({ type: 'checking' }),
    onRecovered: value => events.push({ type: 'recovered', ...value }),
    onDisconnected: value => events.push({ type: 'disconnected', ...value }),
    schedule: (fn, delay) => { timers.set(++serial, { at: now + delay, fn }); return serial; },
    unschedule: id => timers.delete(id),
  });
  const advance = async ms => {
    await drain(); const target = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await drain();
    }
    now = target; await drain();
  };
  return { provider, calls, events, stop, advance, timers };
}

test('unchanged selected-account, network and connect announcements do not lose authorization', async () => {
  const f = fixture();
  f.provider.emit('accountsChanged', [account.toUpperCase(), other]);
  f.provider.emit('chainChanged', '0x0038');
  f.provider.emit('chainChanged', '56');
  f.provider.emit('connect', { chainId: '0x38' });
  await f.advance(60_000);
  assert.deepEqual(f.events, []); assert.deepEqual(f.calls, []); f.stop();
});

test('transport interruption invalidates pending work immediately and silently recovers the same identity', async () => {
  const f = fixture(); f.provider.emit('disconnect', { code: 4900 });
  assert.deepEqual(f.events.map(x => x.type), ['invalidate', 'checking']);
  await drain();
  assert.deepEqual(f.events, [{ type: 'invalidate', reason: 'transport' }, { type: 'checking' },
    { type: 'recovered', account, chainId: 56 }]);
  assert.deepEqual(f.calls, [{ method: 'eth_accounts' }, { method: 'eth_chainId' }]);
  assert.equal(f.timers.size, 0); f.stop();
});

test('transient read failures retry read-only queries with a fixed budget', async () => {
  let failing = true;
  const f = fixture({ request: ({ method }) => {
    if (failing) throw new Error('temporary transport error');
    return method === 'eth_accounts' ? [account] : '0x38';
  } });
  f.provider.emit('disconnect'); await drain();
  failing = false; await f.advance(500);
  assert.equal(f.calls.length, 4);
  assert.equal(f.events.at(-1).type, 'recovered');
  assert.equal(f.events.filter(x => x.type === 'invalidate').length, 1); f.stop();
});

test('hanging reads and repeated reconnect announcements cannot reset the bounded timeout', async () => {
  const f = fixture({ request: () => new Promise(() => {}) });
  f.provider.emit('disconnect'); await f.advance(2_000);
  for (let i = 0; i < 50; i++) {
    f.provider.emit('disconnect'); f.provider.emit('connect', { chainId: '0x38' });
  }
  await f.advance(7_500);
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.events.map(x => x.type), ['invalidate', 'checking', 'disconnected']);
  assert.equal(f.events.at(-1).reason, 'transport'); assert.equal(f.timers.size, 0);
  f.provider.emit('disconnect'); await f.advance(60_000); assert.equal(f.calls.length, 6); f.stop();
});

test('revoked authorization, real account switches and real chain switches disconnect synchronously', () => {
  for (const [event, payload, reason] of [['accountsChanged', [], 'account'],
    ['accountsChanged', [other], 'account'], ['chainChanged', '0x1', 'network']]) {
    const f = fixture(); f.provider.emit(event, payload);
    assert.deepEqual(f.events, [{ type: 'invalidate', reason }, { type: 'disconnected', reason }]);
    assert.equal(f.calls.length, 0); f.stop();
  }
});

test('read-only recovery never adopts a different account, different chain, or empty permission', async () => {
  for (const [accounts, chain, reason] of [[[other], '0x38', 'account'], [[], '0x38', 'account'],
    [[account], '0x1', 'network']]) {
    const f = fixture({ request: ({ method }) => method === 'eth_accounts' ? accounts : chain });
    f.provider.emit('disconnect'); await drain();
    assert.equal(f.events.at(-1).type, 'disconnected'); assert.equal(f.events.at(-1).reason, reason);
    assert(!f.events.some(x => x.type === 'recovered')); assert.equal(f.calls.length, 2); f.stop();
  }
});

test('a real identity change cancels recovery and ignores late success for the former account', async () => {
  let resolve;
  const f = fixture({ request: ({ method }) => method === 'eth_accounts'
    ? new Promise(done => { resolve = done; }) : '0x38' });
  f.provider.emit('disconnect'); await drain();
  f.provider.emit('accountsChanged', [other]);
  assert.equal(f.events.at(-1).type, 'disconnected'); assert.equal(f.events.at(-1).reason, 'account');
  resolve([account]); await f.advance(60_000);
  assert(!f.events.some(x => x.type === 'recovered')); assert.equal(f.timers.size, 0); f.stop();
});

test('cleanup and replaced wallet ownership prevent late recovery and remove listeners', async () => {
  for (const mode of ['cleanup', 'replaced']) {
    let active = true, resolve;
    const f = fixture({ isCurrent: () => active, request: ({ method }) => method === 'eth_accounts'
      ? new Promise(done => { resolve = done; }) : '0x38' });
    f.provider.emit('disconnect'); await drain();
    if (mode === 'cleanup') f.stop(); else active = false;
    resolve([account]); await f.advance(60_000);
    assert(!f.events.some(x => x.type === 'recovered' || x.type === 'disconnected'));
    f.stop(); assert.equal(f.provider.eventNames().length, 0); assert.equal(f.timers.size, 0);
  }
});

test('incomplete event payloads require revalidation; invalid responses never grant wallet readiness', async () => {
  const f = fixture({ request: ({ method }) => method === 'eth_accounts' ? ['not-an-address'] : 'invalid-chain' });
  f.provider.emit('accountsChanged', undefined); await f.advance(2_000);
  assert.equal(f.calls.length, 6); assert.equal(f.events.at(-1).type, 'disconnected');
  assert(!f.events.some(x => x.type === 'recovered')); f.stop();
});

test('a subsequent interruption starts its own bounded check after a successful recovery', async () => {
  const f = fixture();
  f.provider.emit('disconnect'); await drain();
  f.provider.emit('disconnect'); await drain();
  assert.deepEqual(f.events.map(x => x.type), ['invalidate', 'checking', 'recovered', 'invalidate', 'checking', 'recovered']);
  assert.equal(f.calls.length, 4); f.stop();
});

test('authorized account switching retires drafts and adopts the selected BSC account without permission or signing calls', async () => {
  const f = fixture({ followAccountChanges: true,
    request: ({ method }) => method === 'eth_accounts' ? [other] : '0x38' });
  f.provider.emit('accountsChanged', [other]);
  assert.deepEqual(f.events, [{ type: 'invalidate', reason: 'account' }, { type: 'checking' }]);
  await drain();
  assert.deepEqual(f.events.at(-1), { type: 'recovered', account: other, chainId: 56 });
  assert.equal(f.calls.length, 2); assert.equal(f.timers.size, 0); f.stop();
});

test('account-following cannot enable a wrong-network identity', async () => {
  const f = fixture({ followAccountChanges: true,
    request: ({ method }) => method === 'eth_accounts' ? [other] : '0x1' });
  f.provider.emit('accountsChanged', [other]); await drain();
  assert.equal(f.events.at(-1).reason, 'network');
  assert(!f.events.some(event => event.type === 'recovered')); f.stop();
});

test('rapid account changes ignore a late probe for the previous selection', async () => {
  let reads = 0, finish;
  const f = fixture({ followAccountChanges: true, request: ({ method }) => method === 'eth_chainId' ? '0x38'
    : ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : [account] });
  f.provider.emit('accountsChanged', [other]); await drain();
  f.provider.emit('accountsChanged', [account]); await drain();
  finish([other]); await drain();
  assert.deepEqual(f.events.filter(event => event.type === 'recovered'), [{ type: 'recovered', account, chainId: 56 }]);
  assert.equal(f.timers.size, 0); f.stop();
});
