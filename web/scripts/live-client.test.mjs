import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress, getAddress } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { abandonPreparedIntent, cancelLiveIntent, liveConfig, sendLiveGovernanceAction, sendLiveMarketAction, sendLivePoolAction } from '../lib/live-client.mjs';

const addr = number => getAddress(`0x${number.toString(16).padStart(40, '0')}`);
const factory = addr(1), lens = addr(2), pool = addr(3), account = addr(4), collection = addr(5), market = addr(6);
const config = { chainId: 56, factory, lens, market, journal: true, artifactDigest: ARTIFACT_DIGEST };
const hash = `0x${'a'.repeat(64)}`;
function row({ totalSupply = 0n } = {}) {
  return { pool, status: { validMask: (1n << 17n) - 1n, errorMask: 0n, trustError: 0n },
    params: { circuits: collection, circuitId: 99n, targetRaise: 10000n, priceCap: 9000n,
      directSeller: ZeroAddress, directPrice: 0n, fundingDeadline: 2000n, purchaseDeadline: 3000n },
    state: 0n, unitPriceWei: 100n, totalRaised: totalSupply * 100n, totalSupply, memberCount: 0n,
    depositPaused: false, purchaseCost: 0n, activatedAt: 0n, shareTradingAllowed: false,
    shares: 0n, lockedShares: 0n, availableShares: 0n, claimableBEM: 0n, bnbOwed: 0n, initialContributedWei: 0n };
}
function scenario({ supply = 0n, failSimulation = false, rejectWallet = false, rejectJournal = false,
  switchAfterGas = false, switchAfterArm = false } = {}) {
  const events = []; let saved = false, chainChanged = false;
  const wallet = { async request({ method, params = [] }) {
    events.push(method);
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return chainChanged ? '0x1' : '0x38';
    if (method === 'eth_getBlockByNumber') return { number: '0xa', timestamp: '0x3e8', hash: '0xabcd' };
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_estimateGas') { if (switchAfterGas) chainChanged = true; return '0x5208'; }
    if (method === 'eth_sendTransaction') {
      assert(saved, 'the server must save the exact intent before wallet signing');
      if (rejectWallet) throw Object.assign(new Error('user rejected'), { code: 4001 });
      assert.equal(params[0].to, pool); assert.equal(params[0].value, '0x2710');
      return hash;
    }
    assert.equal(method, 'eth_call');
    const tx = params[0];
    if (tx.to === pool) {
      if (failSimulation) throw new Error('another wallet filled the last share');
      return '0x';
    }
    const iface = tx.to === factory ? abi.PoolFactory : abi.PoolLens;
    const parsed = iface.parseTransaction(tx);
    const answer = { lens, factory, VERSION: 1n,
      positions: { blockNumber: 10n, timestamp: 1000n, totalPools: 1n, nextCursor: 0n,
        registryCountValid: true, pools: [row({ totalSupply: supply })] } }[parsed.name];
    return iface.encodeFunctionResult(parsed.name, [answer]);
  } };
  const fetchImpl = async (url, init) => {
    events.push(`${init.method} ${url}`);
    const path = String(url).replace(/^.*\/api\/live/, '');
    const result = path === '/intent' && init.method === 'GET' ? { intent: null } :
      path === '/intent' && init.method === 'POST' ? (() => {
        if (rejectJournal) return null;
        const request = JSON.parse(init.body);
        assert.equal(request.value, '10000'); assert.equal(request.nonce, 0);
        assert.equal(request.artifactDigest, ARTIFACT_DIGEST);
        assert.equal(abi.PoolVault.parseTransaction({ data: request.data }).args[0], 100n);
        saved = true;
        return { intent: { id: 'intent-1', nonce: 0, pool, target: pool, data: request.data.toLowerCase(), value: request.value, active: true, status: 'prepared' } };
      })() : path === '/arm' ? (() => { if (switchAfterArm) chainChanged = true;
        return { intent: { id: 'intent-1', status: 'armed', active: true } }; })() :
      path === '/hash' ? { intent: { id: 'intent-1', hashes: [hash], active: true, status: 'submitted' } } : null;
    if (!result) return { ok: false, status: 503, async json() { return { error: 'journal down' }; } };
    return { ok: true, status: 200, async json() { return result; } };
  };
  return { wallet, fetchImpl, events, get saved() { return saved; } };
}

test('100-share buy writes server intent before wallet send, records returned hash', async () => {
  const current = scenario();
  const pending = await sendLivePoolAction({ wallet: current.wallet, fetchImpl: current.fetchImpl, config, account, pool,
    action: 'deposit', quantity: '100' });
  assert.equal(pending.hashes[0], hash);
  assert(current.events.indexOf('POST /api/live/intent') < current.events.indexOf('eth_sendTransaction'));
  assert(current.events.indexOf('POST /api/live/intent') < current.events.indexOf('POST /api/live/arm'));
  assert(current.events.indexOf('POST /api/live/arm') < current.events.indexOf('eth_sendTransaction'));
  assert(current.events.indexOf('eth_sendTransaction') < current.events.indexOf('POST /api/live/hash'));
});

test('server failure, race simulation failure and wallet rejection never cause a second send', async () => {
  const journalDown = scenario({ rejectJournal: true });
  await assert.rejects(sendLivePoolAction({ wallet: journalDown.wallet, fetchImpl: journalDown.fetchImpl, config,
    account, pool, action: 'deposit', quantity: '100' }), /journal down/);
  assert(!journalDown.events.includes('eth_sendTransaction'));
  const race = scenario({ supply: 99n, failSimulation: true });
  await assert.rejects(sendLivePoolAction({ wallet: race.wallet, fetchImpl: race.fetchImpl, config,
    account, pool, action: 'deposit', quantity: '1' }), /another wallet/);
  assert(!race.saved); assert(!race.events.includes('eth_sendTransaction'));
  const rejected = scenario({ rejectWallet: true });
  await assert.rejects(sendLivePoolAction({ wallet: rejected.wallet, fetchImpl: rejected.fetchImpl, config,
    account, pool, action: 'deposit', quantity: '100' }), /saved intent remains pending/);
  assert(rejected.saved); assert.equal(rejected.events.filter(item => item === 'eth_sendTransaction').length, 1);
});

test('chain change before journal save or wallet signing cannot broadcast', async () => {
  const beforeSave = scenario({ switchAfterGas: true });
  await assert.rejects(sendLivePoolAction({ wallet: beforeSave.wallet, fetchImpl: beforeSave.fetchImpl, config,
    account, pool, action: 'deposit', quantity: '100' }), /Wallet account or chain changed/);
  assert(!beforeSave.saved); assert(!beforeSave.events.includes('eth_sendTransaction'));
  const afterArm = scenario({ switchAfterArm: true });
  await assert.rejects(sendLivePoolAction({ wallet: afterArm.wallet, fetchImpl: afterArm.fetchImpl, config,
    account, pool, action: 'deposit', quantity: '100' }), /Wallet account or chain changed/);
  assert(afterArm.saved); assert(!afterArm.events.includes('eth_sendTransaction'));
});

test('a stale artifact digest cannot enable wallet signing', async () => {
  const stale = { ...config, artifactDigest: `0x${'0'.repeat(64)}` };
  await assert.rejects(liveConfig(async () => ({ ok: true, async json() { return stale; } })), /incomplete/);
  const current = scenario();
  await assert.rejects(sendLivePoolAction({ wallet: current.wallet, fetchImpl: current.fetchImpl, config: stale,
    account, pool, action: 'deposit', quantity: '1' }), /out of date/);
  assert(!current.events.includes('eth_sendTransaction'));
});

test('ambiguous intent can only be cancelled through a same-nonce wallet self-transfer and saved hash', async () => {
  const calls = [], intent = { id: 'pending-7', active: true, status: 'armed', account, nonce: 7, pool };
  const wallet = { async request({ method, params }) {
    calls.push(method);
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x38';
    assert.equal(method, 'eth_sendTransaction');
    assert.deepEqual(params[0], { from: account, to: account, value: '0x0', data: '0x', nonce: '0x7', gas: '0x5208', chainId: '0x38' });
    return hash;
  } };
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return { ok: true, async json() { return init.method === 'GET' ? { intent } : { intent: { ...intent, hashes: [hash] } }; } };
  };
  const result = await cancelLiveIntent({ wallet, account, intent, fetchImpl });
  assert.equal(result.hashes[0], hash);
  assert(calls.indexOf('GET /api/live/intent') < calls.indexOf('eth_sendTransaction'));
  assert(calls.indexOf('eth_sendTransaction') < calls.indexOf('POST /api/live/hash'));
});

test('lost POST response after durable insert never reaches wallet; reload can abandon unarmed intent', async () => {
  const pending = { id: 'delayed-1', account, pool, nonce: 0, active: true, status: 'prepared' };
  const current = scenario(); let saved = false;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/intent') && init.method === 'GET') return { ok: true, async json() { return { intent: saved ? pending : null }; } };
    if (url.endsWith('/intent') && init.method === 'POST') { saved = true; throw new Error('client timeout after server commit'); }
    if (url.endsWith('/abandon')) { pending.active = false; pending.status = 'abandoned'; return { ok: true, async json() { return { intent: pending }; } }; }
    throw new Error('unexpected request');
  };
  await assert.rejects(sendLivePoolAction({ wallet: current.wallet, fetchImpl, config, account, pool,
    action: 'deposit', quantity: '100' }), /client timeout/);
  assert(saved); assert(!current.events.includes('eth_sendTransaction'));
  const result = await abandonPreparedIntent(account, pending, fetchImpl);
  assert.equal(result.intent.status, 'abandoned');
});

test('100-share Market listing is quoted at one block and journaled to the verified Market target', async () => {
  const events = [], timelock = addr(7);
  const wallet = { async request({ method, params = [] }) {
    events.push(method);
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') return { number: '0xa', timestamp: '0x3e8', hash: hash };
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_sendTransaction') {
      assert(events.includes('POST /api/live/arm'));
      assert.equal(params[0].to, market); assert.equal(params[0].chainId, '0x38');
      return hash;
    }
    assert.equal(method, 'eth_call');
    if (params[1] === 'latest') { assert.equal(params[0].to, market); return '0x'; }
    const tx = params[0];
    const iface = tx.to === factory ? abi.PoolFactory : tx.to === market ? abi.ShareMarket : abi.PoolVault;
    const parsed = iface.parseTransaction(tx);
    const value = { shareMarket: market, timelock, factory, feeBps: 100n, buyerFeeBps: 100n, nextOrderId: 1n,
      bnbOwed: 0n, isPool: true, OFFICIAL_FACTORY: factory, state: 2n,
      shareTradingAllowed: true, balanceOf: 100n, lockedShares: 0n, availableShares: 100n }[parsed.name];
    return iface.encodeFunctionResult(parsed.name, [value]);
  } };
  const fetchImpl = async (url, init) => {
    const path = String(url).replace(/^.*\/api\/live/, ''); events.push(`${init.method} /api/live${path}`);
    let result;
    if (path === '/intent' && init.method === 'GET') result = { intent: null };
    else if (path === '/intent' && init.method === 'POST') {
      const posted = JSON.parse(init.body);
      assert.equal(posted.target, market); assert.equal(posted.pool, pool); assert.equal(posted.value, '0');
      const parsed = abi.ShareMarket.parseTransaction({ data: posted.data });
      assert.equal(parsed.name, 'list'); assert.equal(parsed.args[1], 100n);
      result = { intent: { id: 'market-1', target: market, pool, nonce: 0, data: posted.data.toLowerCase(),
        value: '0', active: true, status: 'prepared' } };
    } else if (path === '/arm') result = { intent: { id: 'market-1', status: 'armed', active: true } };
    else if (path === '/hash') result = { intent: { id: 'market-1', hashes: [hash], status: 'submitted', active: true } };
    else throw new Error(`Unexpected ${path}`);
    return { ok: true, status: 200, async json() { return result; } };
  };
  const intent = await sendLiveMarketAction({ wallet, config, account, fetchImpl,
    action: { kind: 'list', pool, amount: '100', pricePerUnitWei: '20' } });
  assert.equal(intent.hashes[0], hash);
  assert(events.indexOf('POST /api/live/intent') < events.indexOf('eth_sendTransaction'));
});

test('governance proposal uses the same durable wallet journal and registered pool target', async () => {
  const events = [];
  const wallet = { async request({ method, params = [] }) {
    events.push(method);
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') return { number: '0xa', timestamp: '0xf4240', hash };
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_sendTransaction') {
      assert(events.includes('POST /api/live/arm'));
      assert.equal(params[0].to, pool); assert.equal(params[0].value, '0x0');
      return hash;
    }
    assert.equal(method, 'eth_call');
    if (params[1] === 'latest') { assert.equal(params[0].to, pool); return '0x'; }
    const tx = params[0], iface = tx.to === factory ? abi.PoolFactory : abi.PoolVault;
    const parsed = iface.parseTransaction(tx);
    const value = { isPool: true, factory, OFFICIAL_FACTORY: factory, state: 2n,
      purchaseCost: 10000n, activatedAt: 1n, activeProposalId: 0n, nextProposalId: 1n,
      lastProposed: 0n, balanceOf: 100n, listedProposalId: 0n, expiresAt: 0n, salePrice: 0n }[parsed.name];
    return iface.encodeFunctionResult(parsed.name, [value]);
  } };
  const fetchImpl = async (url, init) => {
    const path = String(url).replace(/^.*\/api\/live/, ''); events.push(`${init.method} /api/live${path}`);
    let result;
    if (path === '/intent' && init.method === 'GET') result = { intent: null };
    else if (path === '/intent' && init.method === 'POST') {
      const posted = JSON.parse(init.body);
      assert.equal(posted.target, pool); assert.equal(posted.pool, pool); assert.equal(posted.value, '0');
      const parsed = abi.PoolVault.parseTransaction({ data: posted.data });
      assert.equal(parsed.name, 'propose'); assert.equal(parsed.args[0], 10000n);
      result = { intent: { id: 'sale-1', target: pool, pool, nonce: 0, data: posted.data.toLowerCase(),
        value: '0', active: true, status: 'prepared' } };
    } else if (path === '/arm') result = { intent: { id: 'sale-1', status: 'armed', active: true } };
    else if (path === '/hash') result = { intent: { id: 'sale-1', hashes: [hash], status: 'submitted', active: true } };
    else throw new Error(`Unexpected ${path}`);
    return { ok: true, status: 200, async json() { return result; } };
  };
  const intent = await sendLiveGovernanceAction({ wallet, config, account, pool, fetchImpl,
    action: { kind: 'propose', priceWei: '10000', refPriceWei: '10000', refAt: '999900' } });
  assert.equal(intent.hashes[0], hash);
  assert(events.indexOf('POST /api/live/intent') < events.indexOf('eth_sendTransaction'));
});
