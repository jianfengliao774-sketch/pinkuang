import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WALLET_PREFERENCE_KEY, readWalletPreference, saveWalletPreference,
  clearWalletPreference, startWalletRestore } from '../lib/wallet-reload.mjs';

const account = '0x7674fa446D42b1f7f150DC5e678cc525d275Ea53';
const other = '0x0000000000000000000000000000000000000002';
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const storage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
function wallet({ request, source = 'eip6963', rdns = 'io.metamask', brandId = 'metamask', id = 'wallet-1' } = {}) {
  const provider = new EventEmitter(), calls = [];
  provider.request = args => {
    calls.push(args);
    assert(['eth_accounts', 'eth_chainId'].includes(args.method), `Unexpected wallet prompt: ${args.method}`);
    return request ? request(args) : args.method === 'eth_accounts' ? [account] : '0x38';
  };
  return { entry: { id, provider, name: 'Wallet name', source, rdns, brandId }, provider, calls };
}
function fixture({ entries, remembered, request, isCurrent = () => true, store = storage(), discoveryWindowMs } = {}) {
  let now = 0, serial = 0;
  const w = wallet({ request }), events = [], timers = new Map();
  let wallets = entries ?? [w.entry];
  if (remembered !== false) saveWalletPreference(store, remembered ?? w.entry);
  const restore = startWalletRestore({ storage: store, discovery: { getWallets: () => wallets }, isCurrent, discoveryWindowMs,
    onChecking: checking => events.push({ type: 'checking', checking }),
    onRecovered: value => events.push({ type: 'recovered', ...value }),
    onSettled: value => events.push({ type: 'settled', ...value }),
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
  return { ...w, events, store, timers, restore, advance,
    setWallets: value => { wallets = value; restore.refresh(); } };
}

test('preferences persist only stable selection metadata, ignoring temporary ID, display name and account', () => {
  const s = storage(), { entry } = wallet();
  assert.equal(saveWalletPreference(s, { ...entry, account, secret: 'not persisted' }), true);
  assert.deepEqual(JSON.parse(s.getItem(WALLET_PREFERENCE_KEY)),
    { version: 1, source: 'eip6963', rdns: 'io.metamask', brandId: 'metamask' });
  assert.deepEqual(readWalletPreference(s), JSON.parse(s.getItem(WALLET_PREFERENCE_KEY)));
  clearWalletPreference(s); assert.equal(readWalletPreference(s), null);
});

test('malformed, unsupported, missing and inaccessible storage fail closed without crashing', () => {
  for (const value of ['{', 'null', '{"version":2}', '{"version":1,"source":"legacy","brandId":null}',
    '{"version":1,"source":"eip6963","rdns":"bad"}', 'x'.repeat(1_025)]) {
    const s = storage(); s.setItem(WALLET_PREFERENCE_KEY, value); assert.equal(readWalletPreference(s), null);
  }
  for (const s of [null, {}, { getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } }]) {
    assert.equal(readWalletPreference(s), null);
    assert.equal(saveWalletPreference(s, wallet().entry), false);
    assert.equal(clearWalletPreference(s), false);
  }
});

test('saving generic, unknown legacy or WalletConnect selections removes the prior injected hint', () => {
  for (const entry of [{ source: 'legacy', brandId: null }, { id: 'walletconnect', name: 'MetaMask' },
    { source: 'legacy', brandId: 'invented' }, { ...wallet().entry, provider: { isWalletConnect: true } }]) {
    const s = storage(); saveWalletPreference(s, wallet().entry);
    assert.equal(saveWalletPreference(s, entry), false); assert.equal(readWalletPreference(s), null);
  }
});

test('a failed preference write removes an old selection instead of restoring the wrong wallet later', () => {
  const s = storage(); saveWalletPreference(s, wallet().entry);
  s.setItem = () => { throw new Error('quota'); };
  assert.equal(saveWalletPreference(s, wallet({ brandId: 'okx', rdns: 'com.okex.wallet' }).entry), false);
  assert.equal(readWalletPreference(s), null);
});

test('no remembered choice settles immediately and never guesses even one authorized wallet', async () => {
  const f = fixture({ remembered: false }); await f.advance(60_000);
  assert.deepEqual(f.events, [{ type: 'checking', checking: false },
    { type: 'settled', restored: false, reason: 'no-preference' }]);
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
});

test('F5 restores the remembered concrete provider using exactly two read-only methods', async () => {
  const remembered = wallet().entry;
  const selected = wallet({ id: 'wallet-27' }), unrelated = wallet({ rdns: 'com.okex.wallet', brandId: 'okx' });
  selected.entry.name = 'Changed display name';
  const f = fixture({ remembered, entries: [unrelated.entry, selected.entry] }); await drain();
  const recovered = f.events.find(item => item.type === 'recovered');
  assert.equal(recovered.provider, selected.provider); assert.equal(recovered.entry, selected.entry);
  assert.equal(recovered.account, account.toLowerCase()); assert.equal(recovered.chainId, 56);
  assert.deepEqual(selected.calls, [{ method: 'eth_accounts' }, { method: 'eth_chainId' }]);
  assert.equal(unrelated.calls.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.events.map(item => item.type), ['checking', 'checking', 'recovered', 'settled']);
  assert.equal(selected.provider.eventNames().length, 0);
});

test('legacy recovery requires one exact brand; source and brand mismatches never fall back to another wallet', async () => {
  const remembered = wallet({ source: 'legacy', rdns: '' }).entry;
  const selected = wallet({ source: 'legacy', rdns: '', id: 'wallet-30' });
  const f = fixture({ remembered, entries: [selected.entry] }); await drain();
  assert.equal(f.events.find(item => item.type === 'recovered').provider, selected.provider);
  for (const entry of [wallet({ brandId: 'okx' }).entry, wallet({ source: 'legacy', rdns: '' }).entry,
    { ...wallet().entry, name: 'MetaMask', rdns: 'com.other.wallet' }]) {
    const g = fixture({ entries: [entry] }); await g.advance(5_000);
    assert.equal(g.events.at(-1).reason, 'discovery-timeout');
    assert(!g.events.some(item => item.type === 'recovered'));
  }
});

test('multiple EIP providers with identical rdns and multiple legacy providers with one brand are ambiguous', async () => {
  for (const options of [{}, { source: 'legacy', rdns: '' }]) {
    const a = wallet(options), b = wallet(options);
    const f = fixture({ remembered: a.entry, entries: [a.entry, b.entry] }); await drain();
    assert.equal(f.events.at(-1).reason, 'ambiguous');
    assert.equal(a.calls.length + b.calls.length, 0); assert.equal(f.timers.size, 0);
  }
});

test('duplicate entries for the same provider do not manufacture ambiguity', async () => {
  const a = wallet(); const f = fixture({ entries: [a.entry, { ...a.entry, id: 'different-id' }] }); await drain();
  assert.equal(f.events.at(-1).restored, true); assert.equal(a.calls.length, 2);
});

test('late EIP injection is restored within a bounded discovery window; later injection does not auto-connect', async () => {
  const f = fixture({ entries: [] }); await f.advance(4_500);
  f.setWallets([f.entry]); await drain(); assert.equal(f.events.at(-1).restored, true);
  const g = fixture({ entries: [] }); await g.advance(5_000);
  assert.equal(g.events.at(-1).reason, 'discovery-timeout');
  g.setWallets([g.entry]); await g.advance(60_000); assert.equal(g.calls.length, 0); assert.equal(g.timers.size, 0);
});

test('a late second matching provider cancels pending recovery rather than guessing the first announcement', async () => {
  let resolve;
  const f = fixture({ request: ({ method }) => method === 'eth_accounts'
    ? new Promise(done => { resolve = done; }) : '0x38' }); await drain();
  f.setWallets([f.entry, wallet().entry]); resolve([account]); await drain();
  assert.equal(f.events.at(-1).reason, 'ambiguous'); assert(!f.events.some(item => item.type === 'recovered'));
  assert.equal(f.provider.eventNames().length, 0); assert.equal(f.timers.size, 0);
});

test('empty authorization or a different network cannot restore and never prompts to authorize or switch', async () => {
  for (const [accounts, chain, reason] of [[[], '0x38', 'unauthorized'], [[account], '0x1', 'network']]) {
    const f = fixture({ request: ({ method }) => method === 'eth_accounts' ? accounts : chain }); await drain();
    assert.equal(f.events.at(-1).reason, reason); assert.equal(f.calls.length, 2);
    assert(!f.events.some(item => item.type === 'recovered')); assert.equal(f.timers.size, 0);
  }
});

test('only the valid first account is adopted, independently of old addresses or exposed extra accounts', async () => {
  const f = fixture({ request: ({ method }) => method === 'eth_accounts' ? [other, account] : 56 }); await drain();
  assert.equal(f.events.find(item => item.type === 'recovered').account, other);
  for (const accounts of [['malformed', account], {}, null]) {
    const g = fixture({ request: ({ method }) => method === 'eth_accounts' ? accounts : '0x38' });
    await g.advance(2_000); assert.equal(g.events.at(-1).reason, 'invalid-identity'); assert.equal(g.calls.length, 6);
  }
});

test('malformed chain IDs fail closed while canonical hex, decimal and SDK numeric BSC identities restore', async () => {
  for (const chain of ['0x38', '0X0038', '56', 56]) {
    const f = fixture({ request: ({ method }) => method === 'eth_accounts' ? [account] : chain }); await drain();
    assert.equal(f.events.at(-1).restored, true);
  }
  for (const chain of ['bad-chain', null, {}, 56.1, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '0x0', -56]) {
    const f = fixture({ request: ({ method }) => method === 'eth_accounts' ? [account] : chain }); await f.advance(2_000);
    assert.equal(f.events.at(-1).reason, 'invalid-identity'); assert.equal(f.calls.length, 6);
    assert(!f.events.some(item => item.type === 'recovered'));
  }
});

test('transient errors get at most three attempts; repeated refresh cannot extend the retry budget', async () => {
  let failing = true;
  const f = fixture({ request: ({ method }) => {
    if (failing) throw new Error('temporary'); return method === 'eth_accounts' ? [account] : '0x38';
  } }); await drain(); failing = false; await f.advance(500);
  assert.equal(f.calls.length, 4); assert.equal(f.events.at(-1).restored, true);
  const g = fixture({ request: () => Promise.reject(new Error('temporary')) });
  for (let i = 0; i < 50; i++) g.restore.refresh();
  await g.advance(60_000); assert.equal(g.calls.length, 6); assert.equal(g.events.at(-1).reason, 'transport');
  g.restore.refresh(); await g.advance(60_000); assert.equal(g.calls.length, 6); assert.equal(g.timers.size, 0);
});

test('hanging reads have a fixed timeout and events cannot turn them into perpetual polling', async () => {
  const f = fixture({ request: () => new Promise(() => {}) }); await f.advance(2_000);
  for (let i = 0; i < 50; i++) { f.provider.emit('disconnect'); f.restore.refresh(); }
  await f.advance(60_000); assert.equal(f.calls.length, 6); assert.equal(f.events.at(-1).reason, 'transport');
  assert.equal(f.timers.size, 0); assert.equal(f.provider.eventNames().length, 0);
});

test('account, chain, disconnect and connect events invalidate the entire in-flight identity read', async () => {
  for (const [event, payload] of [['accountsChanged', [other]], ['chainChanged', '0x38'], ['disconnect', {}], ['connect', { chainId: '0x38' }]]) {
    let reads = 0, finish;
    const f = fixture({ request: ({ method }) => method === 'eth_chainId' ? '0x38'
      : ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : [other] }); await drain();
    f.provider.emit(event, payload); finish([account]); await drain();
    assert(!f.events.some(item => item.type === 'recovered'));
    await f.advance(500); assert.equal(f.events.find(item => item.type === 'recovered').account, other);
    assert.equal(f.calls.length, 4); assert.equal(f.timers.size, 0);
  }
});

test('cancel, ownership loss and clearing preferences prevent late success or revival on discovery callbacks', async () => {
  for (const mode of ['cancel', 'ownership', 'clear']) {
    let active = true, finish;
    const f = fixture({ isCurrent: () => active, request: ({ method }) => method === 'eth_chainId' ? '0x38'
      : new Promise(resolve => { finish = resolve; }) }); await drain();
    if (mode === 'cancel') f.restore.cancel();
    if (mode === 'ownership') active = false;
    if (mode === 'clear') clearWalletPreference(f.store);
    finish([account]); await f.advance(60_000); f.restore.refresh();
    assert(!f.events.some(item => item.type === 'recovered')); assert.equal(f.calls.length, 2);
    assert.equal(f.timers.size, 0); assert.equal(f.provider.eventNames().length, 0);
    if (mode !== 'clear') assert(!f.events.some(item => item.type === 'settled'));
    const next = fixture({ store: f.store, remembered: false });
    if (mode === 'clear') { assert.equal(next.events.at(-1).reason, 'no-preference'); assert.equal(next.calls.length, 0); }
    next.restore.cancel();
  }
});

test('cancel or manual ownership loss before request microtasks prevents even read-only requests from starting', async () => {
  for (const mode of ['cancel', 'ownership']) {
    let active = true;
    const f = fixture({ isCurrent: () => active });
    if (mode === 'cancel') f.restore.cancel(); else active = false;
    await f.advance(60_000);
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.provider.eventNames().length, 0); assert(!f.events.some(item => item.type === 'settled'));
  }
});

test('changing preference or concrete provider while a read is pending cannot adopt the old provider', async () => {
  for (const mode of ['preference', 'provider']) {
    let finish;
    const f = fixture({ request: ({ method }) => method === 'eth_chainId' ? '0x38'
      : new Promise(resolve => { finish = resolve; }) }); await drain();
    if (mode === 'preference') saveWalletPreference(f.store, wallet({ brandId: 'okx', rdns: 'com.okex.wallet' }).entry);
    else f.setWallets([wallet().entry]);
    finish([account]); await drain();
    assert.equal(f.events.at(-1).reason, mode === 'preference' ? 'preference-cleared' : 'wallet-changed');
    assert(!f.events.some(item => item.type === 'recovered')); assert.equal(f.timers.size, 0);
  }
});

test('providers without removable event listeners fail closed; listener setup failure is cleaned up', async () => {
  for (const provider of [{ request() { throw new Error('must not call'); } },
    { request() { throw new Error('must not call'); }, on() { throw new Error('listener failed'); }, removeListener() {} }]) {
    const f = fixture({ entries: [{ ...wallet().entry, provider }] }); await drain();
    assert.equal(f.events.at(-1).reason, 'unsupported-provider'); assert.equal(f.timers.size, 0);
  }
});
