import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWalletConnectConnector, validWalletConnectProjectId } from '../shared/walletconnect.mjs';
const projectId = 'a'.repeat(32), uri = `wc:${'b'.repeat(64)}@2?relay-protocol=irn&symKey=${'c'.repeat(64)}`;
const png = 'data:image/png;base64,aGVsbG8=';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(extra = {}) {
  const approval = deferred(), wallet = new EventEmitter();
  let loads = 0, options, disconnects = 0, aborts = 0;
  wallet.connect = async () => { await approval.promise; wallet.session = {}; };
  wallet.disconnect = async () => { disconnects++; wallet.session = null; };
  wallet.signer = { client: { core: { pairing: { disconnect() { aborts++; return Promise.resolve(); } } } } };
  const connector = createWalletConnectConnector({ projectId, origin: 'https://tapeout.cc.cd/bemine-v2/',
    loadProvider: async () => { loads++; return { init: async input => { options = input; return wallet; } }; },
    renderQr: async () => png, ...extra });
  return { connector, wallet, approval, get loads() { return loads; }, get options() { return options; }, get disconnects() { return disconnects; }, get aborts() { return aborts; } };
}
test('no SDK loading or relay connection before an explicit action; no fake project ID', async () => {
  const f = fixture(); assert.equal(f.loads, 0); assert.equal(f.connector.enabled, true);
  assert.equal(validWalletConnectProjectId('wallet-address'), false);
  const absent = fixture({ projectId: '' }); assert.equal(absent.connector.enabled, false);
  await assert.rejects(absent.connector.connect(), /not configured/); assert.equal(absent.loads, 0);
});
test('requires HTTPS outside localhost', () => assert.throws(() => fixture({ origin: 'http://example.com/' }), /HTTPS/));
test('only asks BSC capabilities and renders locally; no transaction/signature issued during connection', async () => {
  const f = fixture(), images = []; const result = f.connector.connect({ onQr: image => images.push(image) });
  await tick(); f.wallet.emit('display_uri', uri); await tick(); f.approval.resolve();
  assert.equal((await result).session, f.wallet.session); assert.deepEqual(images, [png]);
  assert.equal(f.options.showQrModal, false); assert.equal(f.options.telemetryEnabled, false);
  assert.deepEqual(f.options.optionalChains, [56]); assert.equal(f.options.metadata.url, 'https://tapeout.cc.cd');
  assert.equal(f.wallet.listenerCount('display_uri'), 0);
});
test('malformed URI and remote image are never shown', async () => {
  const f = fixture({ renderQr: async () => 'https://remote/qr.png' }), images = [];
  const result = f.connector.connect({ onQr: image => images.push(image) }); await tick();
  f.wallet.emit('display_uri', 'https://phishing.example'); f.wallet.emit('display_uri', uri); await tick();
  f.approval.resolve(); await result; assert.deepEqual(images, []);
});
test('a double click cannot open a second pairing request', async () => {
  const f = fixture(), result = f.connector.connect();
  await assert.rejects(f.connector.connect(), /already pending/); await tick(); f.approval.resolve(); await result; assert.equal(f.loads, 1);
});
test('cancel rejects immediately, removes QR, and disconnects a late approval', async () => {
  const f = fixture(), images = [], result = f.connector.connect({ onQr: image => images.push(image) }); await tick();
  f.wallet.emit('display_uri', uri);
  f.connector.cancel(); await assert.rejects(result, { code: 'WC_CANCELLED' });
  assert.equal(f.aborts, 1); assert.equal(f.wallet.listenerCount('display_uri'), 0);
  f.wallet.emit('display_uri', uri); f.approval.resolve(); await tick();
  assert.equal(f.disconnects, 1); assert.deepEqual(images, []);
});
test('cancelled approval cannot disconnect or replace a subsequent successful connection', async () => {
  const first = fixture(), second = fixture(); let loads = 0;
  const f = fixture({ loadProvider: async () => ({ init: async () => ++loads === 1 ? first.wallet : second.wallet }) });
  const pending = f.connector.connect(); await tick(); f.connector.cancel(); await assert.rejects(pending, { code: 'WC_CANCELLED' });
  const retry = f.connector.connect(); await tick(); second.approval.resolve(); const connected = await retry;
  assert.equal(connected.session, second.wallet.session);
  first.approval.resolve(); await tick(); assert.equal(first.disconnects, 1); assert.equal(second.disconnects, 0);
  assert.equal(await f.connector.connect(), connected);
});
test('cancel while SDK loads never opens a pairing after import finishes', async () => {
  const load = deferred(), f = fixture({ loadProvider: () => load.promise });
  const result = f.connector.connect(); f.connector.cancel(); await assert.rejects(result, { code: 'WC_CANCELLED' });
  let connects = 0; load.resolve({ init: async () => ({ connect() { connects++; } }) }); await tick(); assert.equal(connects, 0);
});
test('timeout settles UI and late QR generation cannot revive it', async () => {
  const qr = deferred(), f = fixture({ timeoutMs: 20, renderQr: () => qr.promise }), images = [];
  const result = f.connector.connect({ onQr: image => images.push(image) }); await tick(); f.wallet.emit('display_uri', uri);
  await assert.rejects(result, { code: 'WC_TIMEOUT' }); qr.resolve(png); await tick(); assert.deepEqual(images, []);
});
test('most recent QR wins over slow previous QR generation', async () => {
  const first = deferred(); let calls = 0; const images = [];
  const f = fixture({ renderQr: () => ++calls === 1 ? first.promise : Promise.resolve(png) });
  const result = f.connector.connect({ onQr: image => images.push(image) }); await tick();
  f.wallet.emit('display_uri', uri); f.wallet.emit('display_uri', uri); await tick(); first.resolve(png); await tick();
  f.approval.resolve(); await result; assert.deepEqual(images, [png]);
});
