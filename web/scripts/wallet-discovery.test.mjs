import assert from 'node:assert/strict';
import test from 'node:test';
import { createWalletDiscovery, mobileWalletLink, safeWalletIcon, walletConnectionError } from '../lib/wallet-discovery.mjs';

const icon = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
const provider = flags => ({ ...flags, request() { assert.fail('Discovery must never request permission or call RPC'); } });
const announcement = (value, overrides = {}) => new CustomEvent('eip6963:announceProvider', { detail: {
  provider: value, info: { uuid: 'dc3ed005-1463-47ed-bbce-08d74fa58456', name: 'MetaMask', rdns: 'io.metamask', icon, ...overrides },
} });

test('EIP-6963 discovers concrete providers without permissions, upgrades legacy metadata and deduplicates', () => {
  const target = new EventTarget(), metamask = provider({ isMetaMask: true }); target.ethereum = metamask;
  target.addEventListener('eip6963:requestProvider', () => target.dispatchEvent(announcement(metamask)));
  const discovery = createWalletDiscovery(target);
  const list = discovery.getWallets();
  assert.equal(list.length, 1); assert.equal(list[0].provider, metamask); assert.equal(list[0].icon, icon);
  assert.equal(list[0].source, 'eip6963'); assert.equal(list[0].brandId, 'metamask');
  discovery.refresh(); assert.equal(discovery.getWallets().length, 1); discovery.destroy();
});

test('multiple legacy wallets retain exact providers and specific flags take priority over isMetaMask', () => {
  const target = new EventTarget(), meta = provider({ isMetaMask: true }), okx = provider({ isOkxWallet: true, isMetaMask: true }),
    trust = provider({ isTrust: true, isMetaMask: true }), bitget = provider({ isBitKeep: true });
  target.ethereum = { providers: [meta, okx, trust], request() { assert.fail('Do not use aggregator'); } };
  target.okxwallet = okx; target.bitkeep = { ethereum: bitget };
  const discovery = createWalletDiscovery(target), found = discovery.getWallets();
  assert.equal(found.length, 4); assert.deepEqual(found.map(wallet => wallet.brandId), ['metamask', 'okx', 'trust', 'bitget']);
  assert.equal(found.find(wallet => wallet.brandId === 'okx').provider, okx); discovery.destroy();
});

test('OKX and Binance EIP announcements replace different legacy wrappers without permission requests', () => {
  const target = new EventTarget(), meta = provider({ isMetaMask: true }),
    oldOkx = provider({ isOkxWallet: true, isMetaMask: true }), oldBinance = provider({}),
    okx = provider({ isMetaMask: true }), binance = provider({});
  target.ethereum = meta; target.okxwallet = oldOkx; target.BinanceChain = oldBinance;
  const discovery = createWalletDiscovery(target);
  const legacyChoice = discovery.getWallets().find(wallet => wallet.provider === oldOkx);
  const announce = () => {
    target.dispatchEvent(announcement(okx, { uuid: 'e98644f7-de75-4bd5-b1d4-cc8086c10449', name: 'OKX Wallet', rdns: 'com.okex.wallet' }));
    target.dispatchEvent(announcement(binance, { uuid: 'c2c91b7f-b564-44fa-bac7-fb49eb06b9fa', name: 'Binance Wallet', rdns: 'com.binance.wallet' }));
  };
  target.addEventListener('eip6963:requestProvider', announce);
  announce();
  for (let count = 0; count < 3; count++) {
    const wallets = discovery.getWallets();
    assert.deepEqual(wallets.map(wallet => wallet.provider), [meta, okx, binance]);
    assert.deepEqual(wallets.map(wallet => wallet.brandId), ['metamask', 'okx', 'binance']);
    discovery.refresh();
  }
  // A caller already awaiting this exact legacy provider keeps its binding.
  assert.equal(legacyChoice.provider, oldOkx);
  discovery.destroy();
});

test('legacy wrappers injected after an EIP announcement stay hidden for its recognized brand', () => {
  const target = new EventTarget(), okx = provider({});
  const discovery = createWalletDiscovery(target);
  target.dispatchEvent(announcement(okx, { name: 'OKX Wallet', rdns: 'COM.OKX.WALLET' }));
  const chosen = discovery.getWallets()[0];
  target.okxwallet = provider({}); target.ethereum = provider({ isOkxWallet: true, isMetaMask: true });
  discovery.refresh();
  assert.deepEqual(discovery.getWallets(), [chosen]);
  discovery.destroy();
});

test('distinct EIP instances of one brand remain selectable', () => {
  const target = new EventTarget(), one = provider({}), two = provider({});
  target.okxwallet = provider({});
  const discovery = createWalletDiscovery(target);
  target.dispatchEvent(announcement(one, { name: 'OKX Wallet', rdns: 'com.okx.wallet' }));
  target.dispatchEvent(announcement(two, { uuid: 'e98644f7-de75-4bd5-b1d4-cc8086c10449', name: 'OKX Wallet', rdns: 'com.okex.wallet' }));
  assert.deepEqual(discovery.getWallets().map(wallet => wallet.provider), [one, two]);
  discovery.destroy();
});

test('unknown RDNS, display names and compatibility flags cannot hide another wallet', () => {
  const target = new EventTarget(), legacy = provider({ isMetaMask: true }), unknown = provider({ isMetaMask: true }), named = provider({});
  target.ethereum = legacy;
  const discovery = createWalletDiscovery(target);
  target.dispatchEvent(announcement(unknown, { name: 'Other compatible wallet', rdns: 'org.example.wallet' }));
  target.dispatchEvent(announcement(named, { uuid: 'e98644f7-de75-4bd5-b1d4-cc8086c10449', name: 'MetaMask', rdns: 'org.example.other' }));
  assert.deepEqual(discovery.getWallets().map(wallet => wallet.provider), [legacy, unknown, named]);
  discovery.destroy();
});

test('late announcements stay discoverable, while UUID conflicts and malformed providers are rejected', () => {
  const target = new EventTarget(), first = provider({}), other = provider({});
  let changes = 0; const discovery = createWalletDiscovery(target, () => changes++);
  target.dispatchEvent(announcement(first)); target.dispatchEvent(announcement(other));
  target.dispatchEvent(announcement(other, { uuid: 'invalid' }));
  target.dispatchEvent(announcement(other, { uuid: 'e98644f7-de75-4bd5-b1d4-cc8086c10449', rdns: 'javascript:bad' }));
  assert.equal(discovery.getWallets().length, 1); assert.equal(changes, 1);
  target.dispatchEvent(announcement(other, { uuid: 'e98644f7-de75-4bd5-b1d4-cc8086c10449', name: 'Other wallet', rdns: 'org.example.wallet' }));
  assert.equal(discovery.getWallets().length, 2);
  discovery.destroy(); target.dispatchEvent(announcement(provider({}), { uuid: 'c2c91b7f-b564-44fa-bac7-fb49eb06b9fa' }));
  assert.equal(changes, 2);
});

test('legacy namespaced providers and delayed injection are detected safely', () => {
  const target = new EventTarget(), wallet = provider({}); target.ethereum = wallet; target.okxwallet = wallet;
  Object.defineProperty(target, 'BinanceChain', { get() { throw new Error('hostile getter'); } });
  const discovery = createWalletDiscovery(target);
  assert.equal(discovery.getWallets()[0].brandId, 'okx');
  target.trustwallet = provider({}); target.dispatchEvent(new Event('ethereum#initialized'));
  assert.equal(discovery.getWallets().length, 2); discovery.destroy();
});

test('wallet icons accept bounded image data only, never executable or remote URLs', () => {
  assert.equal(safeWalletIcon(icon), icon);
  for (const unsafe of ['javascript:alert(1)', '<svg onload="alert(1)"/>', 'https://tracker.test/icon.svg',
    'data:text/html,<script>alert(1)</script>', 'data:image/png;base64,' + 'a'.repeat(262144)]) assert.equal(safeWalletIcon(unsafe), null);
});

test('late concrete children replace only legacy aggregate providers; invalid children keep the wallet', () => {
  const target = new EventTarget(), aggregate = provider({ isMetaMask: true }), child = provider({ isOkxWallet: true });
  target.ethereum = aggregate; target.okxwallet = aggregate;
  const seen = [], discovery = createWalletDiscovery(target, wallets => seen.push(wallets));
  for (const invalid of [[aggregate], [null], [{ request: false }]]) {
    aggregate.providers = invalid; discovery.refresh();
    assert.equal(discovery.getWallets()[0].provider, aggregate);
  }
  aggregate.providers = [aggregate, null, child]; discovery.refresh();
  assert.deepEqual(discovery.getWallets().map(wallet => wallet.provider), [child]);
  assert.equal(seen.some(list => list.some(wallet => wallet.provider === aggregate)), true);
  assert.equal(seen.at(-1).some(wallet => wallet.provider === aggregate), false);
  discovery.destroy();
  const confirmed = new EventTarget(); confirmed.ethereum = aggregate;
  const eip = createWalletDiscovery(confirmed); confirmed.dispatchEvent(announcement(aggregate)); eip.refresh();
  assert.equal(eip.getWallets().find(wallet => wallet.provider === aggregate).source, 'eip6963'); eip.destroy();
});

test('official mobile links preserve the page URL without exposing a signing route or wrong BSC coin id', () => {
  const url = 'https://tapeout.cc.cd/bemine/?x=1#pools';
  assert.equal(mobileWalletLink('metamask', url), 'https://metamask.app.link/dapp/tapeout.cc.cd/bemine/?x=1#pools');
  const trust = new URL(mobileWalletLink('trust', url));
  assert.equal(trust.origin, 'https://link.trustwallet.com'); assert.equal(trust.searchParams.get('coin_id'), '20000714');
  assert.equal(trust.searchParams.get('url'), url);
  const bitget = new URL(mobileWalletLink('bitget', url)); assert.equal(bitget.searchParams.get('action'), 'dapp');
  assert.equal(bitget.searchParams.get('url'), url);
  for (const input of ['http://example.test', 'https://user:pass@example.test', 'javascript:alert(1)'])
    assert.equal(mobileWalletLink('metamask', input), null);
  assert.equal(mobileWalletLink('coinbase', url), null);
});

test('rejections and pending authorizations have actionable feedback without suggesting another send', () => {
  assert.match(walletConnectionError({ code: 4001 }), /取消/);
  assert.match(walletConnectionError({ code: -32002 }), /已有一个请求/);
  assert.match(walletConnectionError({ code: 4901 }, 'en'), /network/i);
  assert.equal(walletConnectionError(new Error('A'.repeat(1000))).length, 250);
});
