import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { readShareDailyCapacityPrice, shareDailyCapacityPriceWei } from '../lib/share-daily-capacity.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const factory = address(1), pool = address(2), original = '16210', replacement = '16481';
const collection = getAddress('0xb1024b89886b9a34aa4ff5f31c411d708b20a14c');
const otherCollection = getAddress('0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c');
const NFT = new Interface(['function ownerOf(uint256) view returns(address)']);
const hash = `0x${'ab'.repeat(32)}`;
const now = 1_780_000_000_000;
const sharePrice = 68_000_000_000_000_000n;

function quote(overrides = {}) {
  return { detailChecked: true, collection, tokenId: replacement, owner: pool, tokenSymbol: 'BEM',
    tokenDecimals: 8, status: 'verified', estimated24hAtomic: '95000000',
    source: { observedAt: now - 1000, timestamps: { 'official_circuit_mining:official': now - 1000 },
      url: 'https://tapeout.firsto.ai/circuits' }, ...overrides };
}

function rpc(overrides = {}) {
  const calls = [];
  let blockReads = 0, chainReads = 0;
  return { calls, async request({ method, params = [] }) {
    calls.push({ method, params });
    assert(['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(method), `Unexpected RPC ${method}`);
    if (method === 'eth_chainId') return ++chainReads > 1 && overrides.finalChain ? overrides.finalChain : overrides.chain ?? '0x38';
    if (method === 'eth_getBlockByNumber') {
      blockReads++;
      return { number: '0xa', hash: blockReads > 1 && overrides.reorg ? `0x${'cd'.repeat(32)}` : hash };
    }
    assert.equal(params[1], '0xa', 'all identity calls use the pinned block');
    const target = getAddress(params[0].to);
    const iface = target === factory ? abi.PoolFactory : target === pool ? abi.PoolVault : NFT;
    const parsed = iface.parseTransaction(params[0]);
    assert(parsed, `Unknown selector for ${target}`);
    if (parsed.name === 'isPool') return iface.encodeFunctionResult('isPool', [overrides.registered ?? true]);
    if (parsed.name === 'factory') return iface.encodeFunctionResult('factory', [overrides.backlink ?? factory]);
    if (parsed.name === 'params') {
      const value = { circuits: overrides.collection ?? collection, circuitId: overrides.tokenId ?? replacement,
        targetRaise: 1n, priceCap: 1n, directSeller: address(3), directPrice: 0n,
        fundingDeadline: 100n, purchaseDeadline: 200n };
      return iface.encodeFunctionResult('params', [value]);
    }
    assert.equal(parsed.name, 'ownerOf');
    assert.equal(parsed.args[0], BigInt(overrides.tokenId ?? replacement));
    return iface.encodeFunctionResult('ownerOf', [overrides.owner ?? pool]);
  } };
}

const input = (provider, options = {}) => readShareDailyCapacityPrice(provider, {
  factory, pool, pricePerUnitWei: sharePrice, now,
  quoteLoader: async () => quote(), ...options,
});

test('daily capacity price uses exact BigInt and rounds up at most one wei', () => {
  assert.equal(shareDailyCapacityPriceWei(sharePrice, '95000000'),
    (sharePrice * 100n * 100_000_000n + 94_999_999n) / 95_000_000n);
  const huge = (1n << 255n) + 123n;
  assert.equal(shareDailyCapacityPriceWei(huge, 3n),
    (huge * 100n * 100_000_000n + 2n) / 3n);
  assert.equal(shareDailyCapacityPriceWei(0n, 1n), 0n);
  assert.throws(() => shareDailyCapacityPriceWei(1n, 0n), /unavailable/);
  assert.throws(() => shareDailyCapacityPriceWei(1.1, 1n), /exact bigint/);
});

test('uses the actual replacement NFT in current PoolVault.params, not the original target', async () => {
  const provider = rpc();
  let requested;
  const result = await input(provider, { blockNumber: '10', quoteLoader: async (...args) => {
    requested = args; return quote({ ask: null });
  } });
  assert.equal(result.available, true);
  assert.deepEqual(requested, [collection, replacement]);
  assert.notEqual(result.tokenId, original);
  assert.equal(result.estimated24hAtomic, 95_000_000n);
  assert.equal(result.priceWeiPerDailyBem, (sharePrice * 100n * 100_000_000n + 95_000_000n - 1n) / 95_000_000n);
  assert.equal(result.basis, 'gross_estimated_output');
  assert(provider.calls.every(call => ['eth_call', 'eth_chainId', 'eth_getBlockByNumber'].includes(call.method)));
});

test('unknown/stale/wrong Firsto capacity stays unavailable without changing order price', async () => {
  const order = Object.freeze({ pricePerUnitWei: sharePrice, remaining: 7n });
  const cases = [
    [{ tokenId: original }, 'quote_identity'],
    [{ collection: otherCollection }, 'quote_identity'],
    [{ owner: address(9) }, 'quote_identity'],
    [{ detailChecked: false }, 'quote_identity'],
    [{ tokenSymbol: 'OTHER' }, 'quote_identity'],
    [{ status: 'inactive' }, 'quote_identity'],
    [{ source: { observedAt: now - 300_001,
      timestamps: { 'official_circuit_mining:official': now - 1000 } } }, 'stale_quote'],
    [{ source: { observedAt: now + 30_001,
      timestamps: { 'official_circuit_mining:official': now - 1000 } } }, 'stale_quote'],
    [{ source: { observedAt: now - 1000, timestamps: {} } }, 'stale_quote'],
    [{ source: { observedAt: now - 1000,
      timestamps: { 'official_circuit_mining:official': now - 300_001 } } }, 'stale_quote'],
    [{ estimated24hAtomic: '0' }, 'missing_output'],
  ];
  for (const [change, reason] of cases) {
    const result = await input(rpc(), { pricePerUnitWei: order.pricePerUnitWei,
      quoteLoader: async () => quote(change) });
    assert.deepEqual(result, { available: false, reason });
    assert.equal(order.pricePerUnitWei, sharePrice);
    assert.equal(order.remaining, 7n);
  }
  assert.deepEqual(await input(rpc(), { quoteLoader: async () => { throw new Error('API outage'); } }),
    { available: false, reason: 'unavailable' });
});

test('rejects invalid pool, NFT ownership, chain and reorg before exposing a price', async () => {
  for (const [change, reason] of [
    [{ chain: '0x1' }, 'wrong_chain'],
    [{ registered: false }, 'untrusted_pool'],
    [{ backlink: address(8) }, 'untrusted_pool'],
    [{ collection: address(11) }, 'unsupported_miner'],
    [{ owner: address(12) }, 'miner_not_in_pool'],
    [{ reorg: true }, 'chain_changed'],
    [{ finalChain: '0x1' }, 'chain_changed'],
  ]) {
    assert.deepEqual(await input(rpc(change)), { available: false, reason });
  }
  assert.deepEqual(await input(rpc(), { blockNumber: '11' }), { available: false, reason: 'invalid_block' });
});
