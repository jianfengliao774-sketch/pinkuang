import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverWallets, type WalletOption, type WalletProvider } from './wallet';

const provider = (): WalletProvider => ({ request: async () => [] }) as WalletProvider;

function inBrowser(run: (mock: Window) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const mock = new EventTarget() as Window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: mock });
  try { run(mock); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('OneKey direct provider remains selectable when another extension owns window.ethereum', () => {
  inBrowser(mock => {
    const oneKey = provider();
    const generic = provider();
    mock.$onekey = { ethereum: oneKey };
    mock.ethereum = generic;
    let options: WalletOption[] = [];
    const stop = discoverWallets(value => { options = value; });
    assert.deepEqual(options.map(option => option.id), ['onekey', 'injected']);
    assert.equal(options[0].provider, oneKey);
    assert.equal(options[0].name, 'OneKey 扩展钱包');
    assert.equal(options[1].provider, generic);
    stop();
  });
});

test('OneKey EIP-6963 announcement replaces only the matching generic provider', () => {
  inBrowser(mock => {
    const oneKey = provider();
    mock.ethereum = oneKey;
    let options: WalletOption[] = [];
    const stop = discoverWallets(value => { options = value; });
    mock.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: 'onekey-session', name: 'OneKey', rdns: 'so.onekey.app.wallet' },
      provider: oneKey,
    } }));
    assert.deepEqual(options.map(option => option.id), ['onekey']);
    assert.equal(options[0].provider, oneKey);
    stop();
  });
});

test('a conflicting EIP-6963 name cannot replace the direct OneKey provider', () => {
  inBrowser(mock => {
    const oneKey = provider();
    mock.$onekey = { ethereum: oneKey };
    let options: WalletOption[] = [];
    const stop = discoverWallets(value => { options = value; });
    mock.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: 'impostor', name: 'OneKey', rdns: 'so.onekey.app.wallet' },
      provider: provider(),
    } }));
    assert.equal(options.length, 1);
    assert.equal(options[0].provider, oneKey);
    stop();
  });
});

test('opening wallet choice again discovers a late-injected OneKey provider', () => {
  inBrowser(mock => {
    let options: WalletOption[] = [];
    discoverWallets(value => { options = value; })();
    assert.equal(options.length, 0);
    const oneKey = provider();
    mock.$onekey = { ethereum: oneKey };
    const stop = discoverWallets(value => { options = value; });
    assert.equal(options[0].provider, oneKey);
    stop();
  });
});
