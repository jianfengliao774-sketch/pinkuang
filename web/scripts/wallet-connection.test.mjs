import test from 'node:test';
import assert from 'node:assert/strict';
import { connectWallet } from '../lib/live-transactions.mjs';

const account = '0x0000000000000000000000000000000000000001';
const other = '0x0000000000000000000000000000000000000002';
function wallet(options = {}) {
  const state = { chain: '0x38', account, installed: true, ...options }, calls = [];
  return { state, calls, provider: { async request(request) {
    calls.push(request);
    const { method, params } = request;
    if (method === 'wallet_requestPermissions') {
      assert.deepEqual(params, [{ eth_accounts: {} }]);
      if (state.reselectError) throw state.reselectError;
      if (state.reselectAccount) state.account = state.reselectAccount;
      return [{ parentCapability: 'eth_accounts', caveats: [] }];
    }
    if (method === 'eth_requestAccounts') {
      if (state.permissionError) throw state.permissionError;
      return state.empty ? [] : [state.account];
    }
    if (method === 'eth_accounts') return state.empty ? [] : [state.account];
    if (method === 'eth_chainId') return state.chain;
    if (method === 'wallet_switchEthereumChain') {
      assert.deepEqual(params, [{ chainId: '0x38' }]);
      if (state.switchError) throw state.switchError;
      if (!state.installed) throw state.unknownNetworkError || { code: 4902 };
      if (!state.ignoreSwitch) state.chain = '0x38';
      if (state.changeAccount) state.account = other;
      return null;
    }
    if (method === 'wallet_addEthereumChain') {
      assert.equal(params[0].chainId, '0x38');
      assert.deepEqual(params[0].nativeCurrency, { name: 'BNB', symbol: 'BNB', decimals: 18 });
      assert.deepEqual(params[0].rpcUrls, ['https://bsc-dataseed.bnbchain.org']);
      if (state.addError) throw state.addError;
      state.installed = true;
      return null;
    }
    assert.fail(`Unexpected signing or wallet request: ${method}`);
  } } };
}

test('connecting BSC only requests accounts; it does not sign, send or switch needlessly', async () => {
  const f = wallet();
  assert.equal(await connectWallet(f.provider), account);
  assert.deepEqual(f.calls.map(x => x.method), ['eth_requestAccounts', 'eth_chainId', 'eth_chainId', 'eth_accounts']);
});
test('explicit connect offers a BSC switch then revalidates selected account and chain', async () => {
  const f = wallet({ chain: '0x1' });
  assert.equal(await connectWallet(f.provider), account);
  assert.equal(f.calls.filter(x => x.method === 'wallet_switchEthereumChain').length, 1);
});
test('unknown BSC network is added with fixed official metadata then switched and checked', async () => {
  const f = wallet({ chain: '0x1', installed: false });
  assert.equal(await connectWallet(f.provider), account);
  assert.deepEqual(f.calls.map(x => x.method), ['eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain',
    'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts']);
});
test('rejected or pending account approval is never retried', async () => {
  for (const code of [4001, -32002]) {
    const f = wallet({ permissionError: { code } });
    await assert.rejects(connectWallet(f.provider), error => error.code === code);
    assert.deepEqual(f.calls.map(x => x.method), ['eth_requestAccounts']);
  }
});
test('wrapped unknown-network errors can install BSC without masking a top-level rejection', async () => {
  const wrapped = { code: -32603, data: { originalError: { code: 4902 } } };
  const f = wallet({ chain: '0x1', installed: false, unknownNetworkError: wrapped });
  assert.equal(await connectWallet(f.provider), account);
  assert.equal(f.calls.filter(x => x.method === 'wallet_addEthereumChain').length, 1);
  const g = wallet({ chain: '0x1', switchError: { ...wrapped, code: 4001 } });
  await assert.rejects(connectWallet(g.provider), error => error.code === 4001);
  assert(!g.calls.some(x => x.method === 'wallet_addEthereumChain'));
});
test('rejected/unsupported switching never falls through to network installation', async () => {
  for (const code of [4001, 4200, -32002]) {
    const f = wallet({ chain: '0x1', switchError: { code } });
    await assert.rejects(connectWallet(f.provider), error => error.code === code);
    assert.equal(f.calls.filter(x => x.method === 'wallet_switchEthereumChain').length, 1);
    assert(!f.calls.some(x => x.method === 'wallet_addEthereumChain'));
  }
});
test('rejected installation does not request another switch', async () => {
  const f = wallet({ chain: '0x1', installed: false, addError: { code: 4001 } });
  await assert.rejects(connectWallet(f.provider), error => error.code === 4001);
  assert.equal(f.calls.filter(x => x.method === 'wallet_switchEthereumChain').length, 1);
});
test('lying switch responses and changed accounts cannot become a connected wallet', async () => {
  const f = wallet({ chain: '0x1', ignoreSwitch: true });
  await assert.rejects(connectWallet(f.provider), /BSC/);
  const g = wallet({ chain: '0x1', changeAccount: true });
  await assert.rejects(connectWallet(g.provider), /账户已变化/);
});
test('missing providers and empty permissions leave the user disconnected', async () => {
  await assert.rejects(connectWallet(undefined), /未找到钱包/);
  const f = wallet({ empty: true });
  await assert.rejects(connectWallet(f.provider), /未提供账户/);
  assert.equal(f.calls.length, 1);
});

test('explicit injected-wallet account re-selection opens permissions once and adopts the approved account', async () => {
  const f = wallet({ reselectAccount: other });
  assert.equal(await connectWallet(f.provider, { reselectAccount: true }), other);
  assert.deepEqual(f.calls.map(call => call.method), ['wallet_requestPermissions', 'eth_accounts',
    'eth_chainId', 'eth_chainId', 'eth_accounts']);
  assert.equal(f.calls.filter(call => call.method === 'eth_requestAccounts').length, 0);
});

test('rejected, unauthorized, disconnected or pending re-selection never falls back to another approval prompt', async () => {
  for (const error of [{ code: 4001 }, { code: 4100 }, { code: -32002 }, { code: 4900 },
    { code: -32603, data: { originalError: { code: 4001 } } },
    { code: 4001, data: { originalError: { code: -32601 } } }]) {
    const f = wallet({ reselectError: error });
    await assert.rejects(connectWallet(f.provider, { reselectAccount: true }), value => value === error);
    assert.deepEqual(f.calls.map(call => call.method), ['wallet_requestPermissions']);
  }
});

test('wallets without permission-picker support fall back to one standard account request', async () => {
  for (const reselectError of [{ code: 4200 }, { code: -32601 },
    { code: -32603, data: { originalError: { code: -32601 } } }]) {
    const f = wallet({ reselectError });
    assert.equal(await connectWallet(f.provider, { reselectAccount: true }), account);
    assert.deepEqual(f.calls.map(call => call.method), ['wallet_requestPermissions', 'eth_requestAccounts',
      'eth_chainId', 'eth_chainId', 'eth_accounts']);
  }
});

test('approved re-selection with no exposed accounts does not reuse the former identity', async () => {
  const f = wallet({ empty: true });
  await assert.rejects(connectWallet(f.provider, { reselectAccount: true }), /未提供账户/);
  assert.deepEqual(f.calls.map(call => call.method), ['wallet_requestPermissions', 'eth_accounts']);
});

test('re-selected account still requires the expected BSC network and unchanged final wallet identity', async () => {
  const f = wallet({ reselectAccount: other, chain: '0x1', ignoreSwitch: true });
  await assert.rejects(connectWallet(f.provider, { reselectAccount: true }), /BSC/);
  const g = wallet({ reselectAccount: account, chain: '0x1', changeAccount: true });
  await assert.rejects(connectWallet(g.provider, { reselectAccount: true }), /账户已变化/);
});
