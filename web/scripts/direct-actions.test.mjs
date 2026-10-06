import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Wallet, getAddress, ZeroAddress, toQuantity } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { prepareProductAction } from '../lib/live-actions.mjs';
import { prepareAdminAction, readOperatorStatus, OFFICIAL_COLLECTIONS } from '../lib/live-admin.mjs';
import { signAuthorityAction } from '../lib/authority-client.mjs';
import { readOfficialMinerOnchain, loadOperatorQuote, operatorQuoteDraft } from '../lib/operator-quotes.mjs';
import { dataFixture, chainFixture, apiFixture } from './operator-quotes-fixture.mjs';
import { FIRSTO_SIGNED_EXCHANGE } from '../../deploy/src/firsto-purchase.mjs';
import { preparePortfolioAction } from '../lib/live-portfolios.mjs';
import { portfolioFixture, PORTFOLIOS } from './portfolio-fixture.mjs';

const addr = value => getAddress(`0x${value.toString(16).padStart(40, '0')}`);
const administrator = new Wallet(`0x${'11'.repeat(32)}`);
const account = administrator.address, factory = addr(2), lens = addr(3), pool = addr(4), market = addr(5);
const authority = addr(6), portfolioFactory = addr(7), other = addr(8);
const config = { status: 'ready', stage: 'fresh-active', productFamily: 'fresh-v4', displayOnly: true,
  chainId: 56, factory, lens, shareMarket: market, authority, portfolioFactory,
  freshAuthority: { address: authority, administratorOne: account, administratorTwo: other, codehash: `0x${'ab'.repeat(32)}` } };
const noRpc = { request: async ({ method }) => { throw new Error(`Unexpected RPC ${method}`); } };
const base = { circuits: OFFICIAL_COLLECTIONS[0], circuitId: '7', targetRaiseWei: '11000',
  priceCapWei: '10000', fundingHours: '24', purchaseHours: '48' };
const prepare = input => prepareProductAction({ provider: noRpc, config, account, pool, ...input });

test('direct personal, market and governance calldata requires no chain proof RPC', async () => {
  const actions = [
    ...['claim', 'harvest', 'withdrawBnb', 'withdrawDeposit', 'finalizeFailure', 'cancelExpired', 'marketWithdraw'].map(kind => ({ kind })),
    { kind: 'list', quantity: '2', price: '0.00001' }, { kind: 'cancel', orderId: '3' }, { kind: 'expire', orderId: '3' },
    { kind: 'propose', price: '1.5', refPriceWei: '1000000000000000000', refAt: '1800000000' },
    { kind: 'vote', proposalId: '2', support: true }, { kind: 'executeSale', proposalId: '2' },
  ];
  for (const action of actions) {
    const result = await prepare(action);
    assert.equal(result.direct, true); assert.equal(result.displayOnly, true); assert.equal(result.checkedBlock, null);
    assert.equal(result.transaction.value, '0x0'); assert.equal(result.transaction.from, account);
    const contract = ['list', 'cancel', 'expire', 'marketWithdraw'].includes(action.kind) ? abi.ShareMarket : abi.PoolVault;
    assert.equal(contract.parseTransaction(result.transaction).name, action.kind === 'marketWithdraw' ? 'withdrawBnb' : action.kind);
  }
});

test('direct mode still rejects malformed values, addresses and changed user-selected identity locally', async () => {
  for (const action of [
    { kind: 'deposit', quantity: 1.5 }, { kind: 'list', quantity: '2', price: 0.1 },
    { kind: 'list', quantity: '0', price: '1' }, { kind: 'list', quantity: '1', price: '0.000001' },
    { kind: 'vote', proposalId: '2', support: 'true' }, { kind: 'cancel', orderId: 2 },
    { kind: 'claim', pool: ZeroAddress }, { kind: 'claim', expectedAccount: other },
    { kind: 'claim', expectedPool: other }, { kind: 'vote', proposalId: '2', support: true, expectedProposalId: '3' },
  ]) await assert.rejects(prepare(action));
});

function calls(values) {
  const seen = [];
  return { seen, provider: { request: async ({ method, params }) => {
    assert.equal(method, 'eth_call'); assert.equal(params[1], 'latest');
    const target = getAddress(params[0].to);
    const feeAbi = new Interface(['function defaultTakerFeeBps() view returns(uint16)', 'function feeEpoch() view returns(uint256)']);
    const contract = target === pool ? abi.PoolVault : target === market ? abi.ShareMarket
      : target === getAddress(FIRSTO_SIGNED_EXCHANGE) ? feeAbi : null;
    assert(contract, `Unexpected target ${target}`);
    const parsed = contract.parseTransaction(params[0]); seen.push(parsed.name);
    assert(Object.hasOwn(values, parsed.name), `Unexpected getter ${parsed.name}`);
    return contract.encodeFunctionResult(parsed.fragment, [values[parsed.name]]);
  } } };
}

test('direct deposit reads only the exact payable unit price', async () => {
  const rpc = calls({ unitPriceWei: 123456789012345n });
  const result = await prepareProductAction({ provider: rpc.provider, config, account, pool, kind: 'deposit', quantity: '3' });
  assert.deepEqual(rpc.seen, ['unitPriceWei']); assert.equal(result.transaction.value, toQuantity(370370367037035n));
  assert.equal(abi.PoolVault.parseTransaction(result.transaction).args[0], 3n);
});

test('direct fill reads the selected order and real buyer fee without a pool proof', async () => {
  const rpc = calls({ orders: { pool, seller: other, remaining: 10n, pricePerUnit: 123456789012345n, active: true }, buyerFeeBps: 100n, feeBps: 100n });
  const result = await prepareProductAction({ provider: rpc.provider, config, account, pool, kind: 'fill',
    quantity: '3', orderId: '2', expectedSeller: other, expectedPricePerUnitWei: '123456789012345' });
  assert.deepEqual(rpc.seen.sort(), ['buyerFeeBps', 'feeBps', 'orders']);
  assert.equal(BigInt(result.transaction.value), 370370367037035n + 370370367037035n / 100n);
  assert.equal(result.marketTrade.sellerNetWei, 370370367037035n - 370370367037035n / 100n);
  await assert.rejects(prepareProductAction({ provider: rpc.provider, config, account, pool, kind: 'fill', quantity: '3',
    orderId: '2', expectedPricePerUnitWei: '1' }), /价格/);
  for (const [overrides, expected, message] of [
    [{ orders: { pool: other, seller: other, remaining: 10n, pricePerUnit: 123456789012345n, active: true } }, {}, /Order pool/],
    [{}, { expectedSeller: account }, /Seller changed/],
    [{ buyerFeeBps: 10001n }, {}, /fee/], [{ feeBps: 10001n }, {}, /fee/],
  ]) {
    const changed = calls({ orders: { pool, seller: other, remaining: 10n, pricePerUnit: 123456789012345n, active: true },
      buyerFeeBps: 100n, feeBps: 100n, ...overrides });
    await assert.rejects(prepareProductAction({ provider: changed.provider, config, account, pool, kind: 'fill',
      quantity: '3', orderId: '2', ...expected }), message);
    assert.equal(changed.seen.length, 3);
  }
});

test('direct budget fill preserves selected order and exact fees using only three business getters', async () => {
  const fixture = portfolioFixture(), selected = PORTFOLIOS[0];
  const displayConfig = { ...fixture.config, displayOnly: true, transactionReady: false, operationalReady: false };
  const terms = { orders: { pool: selected, seller: other, remaining: 5n, pricePerUnit: 100n, active: true },
    buyerFeeBps: 100n, feeBps: 100n };
  const prepareFill = async (overrides = {}, expected = {}) => {
    const seen = [], values = { ...terms, ...overrides };
    const provider = { request: async ({ method, params }) => {
      assert.equal(method, 'eth_call'); assert.equal(params[1], 'latest');
      assert.equal(getAddress(params[0].to), fixture.manifest.portfolioMarket);
      const call = abi.ShareMarket.parseTransaction(params[0]); seen.push(call.name);
      assert(Object.hasOwn(values, call.name));
      return abi.ShareMarket.encodeFunctionResult(call.fragment, [values[call.name]]);
    } };
    try {
      return await preparePortfolioAction({ config: displayConfig, provider, account: fixture.account, pool: selected,
        action: { kind: 'marketFill', orderId: '2', quantity: '3', expectedSeller: other,
          expectedPricePerUnitWei: '100', ...expected } });
    } finally { assert.deepEqual(seen.sort(), ['buyerFeeBps', 'feeBps', 'orders']); }
  };
  const result = await prepareFill();
  assert.equal(BigInt(result.transaction.value), 303n); assert.equal(result.marketTrade.sellerFeeWei, 3n);
  assert.equal(result.blockNumber, null);
  await assert.rejects(prepareFill({ orders: { ...terms.orders, pool: PORTFOLIOS[1] } }), /当前预算项目/);
  await assert.rejects(prepareFill({}, { expectedSeller: account }), /卖方/);
  await assert.rejects(prepareFill({}, { expectedPricePerUnitWei: '99' }), /每份价格/);
  await assert.rejects(prepareFill({ buyerFeeBps: 10001n }), /手续费/);
  await assert.rejects(prepareFill({ feeBps: 10001n }), /手续费/);
});

test('direct whole-miner purchase reads only the required amount, proposal and fee terms', async () => {
  const rpc = calls({ listedProposalId: 4n, salePrice: 100001n, defaultTakerFeeBps: 125n, feeEpoch: 7n });
  const result = await prepareProductAction({ provider: rpc.provider, config, account, pool, kind: 'completeFirstoSale' });
  assert.deepEqual(rpc.seen.sort(), ['defaultTakerFeeBps', 'feeEpoch', 'listedProposalId', 'salePrice']);
  assert.equal(BigInt(result.transaction.value), 101251n);
  assert.deepEqual([...abi.PoolVault.parseTransaction(result.transaction).args], [4n, 100001n, 125n, 7n]);
});

test('direct administrator display and creation use fixed configuration without claiming a live proof', async () => {
  const status = await readOperatorStatus({ provider: noRpc, config, account });
  assert.equal(status.status, 'configured'); assert.equal(status.isOperator, true);
  assert.equal(status.creationPaused, null); assert.equal(status.machineRegistry.ready, null);
  assert.equal(status.blockHash, null);
  const seen = [], registry = new Interface(['function machinePool(address,uint256) view returns(address)']);
  const provider = { request: async ({ method, params }) => {
    assert.equal(method, 'eth_call'); assert.equal(params[0].to, factory); assert.equal(params[1], 'latest');
    const parsed = registry.parseTransaction(params[0]); seen.push(parsed.name);
    assert.equal(parsed.args[0], base.circuits); assert.equal(parsed.args[1], 7n);
    return registry.encodeFunctionResult('machinePool', [ZeroAddress]);
  } };
  const result = await prepareAdminAction({ provider, config, account, kind: 'createPool', params: base });
  assert.equal(result.checkedBlock, null); assert.equal(result.direct, true);
  const parsed = abi.PoolFactory.parseTransaction(result.transaction);
  assert.equal(parsed.name, 'createPool'); assert.equal(parsed.args[0].targetRaise, 11000n);
  const repeated = await prepareAdminAction({ provider, config, account, ...result.request });
  assert.deepEqual(repeated.transaction, result.transaction);
  assert.deepEqual(seen, [], 'Direct creation no longer waits for reservation checks.');
  await assert.rejects(prepareAdminAction({ provider: noRpc, config, account: addr(10), kind: 'createPool', params: base }), /运营钱包/);
  await assert.rejects(prepareAdminAction({ provider: noRpc, config, account, kind: 'createPool', params: { ...base, targetRaiseWei: '11001' } }), /100 份/);
});

test('direct administrator reclaim reads only the exact miner parameters and reclaim key', async () => {
  const mining = new Interface(['function minerKey(address,uint256) view returns(bytes32)', 'function reclaim(bytes32)']);
  const key = `0x${'cd'.repeat(32)}`, methods = [];
  const provider = { request: async ({ method, params }) => {
    assert.equal(method, 'eth_call'); assert.equal(params[1], 'latest');
    const contract = getAddress(params[0].to) === pool ? abi.PoolVault : mining;
    const call = contract.parseTransaction(params[0]); methods.push(call.name);
    return contract.encodeFunctionResult(call.fragment, call.name === 'params'
      ? [[base.circuits, 7n, 11000n, 10000n, ZeroAddress, 0n, 1800001000n, 1800002000n]] : [key]);
  } };
  const result = await prepareAdminAction({ config, provider, account, pool, kind: 'mine', miningAction: 'reclaim' });
  assert.deepEqual(methods, ['params', 'minerKey']); assert.equal(result.checkedBlock, null);
  const inner = abi.PoolVault.parseTransaction(result.transaction).args[0];
  assert.equal(mining.parseTransaction({ data: inner }).args[0], key);
  const explicitListing = await prepareAdminAction({ config, provider: noRpc, account, pool, kind: 'buyFromMarket', listingId: '3' });
  assert.equal(abi.PoolVault.parseTransaction(explicitListing.transaction).args[0], 3n);
});

test('direct fixed, flexible and budget-child previews encode locally without reservation RPC', async () => {
  for (const kind of ['createPool', 'createFlexiblePoolChecked', 'createBudgetChildPool']) {
    const flexible = { minVerifiedWeight: '1', referencePriceWei: '10000', targetDailyYieldAtomic: '1',
      extraBps: '1000', referenceObservedAt: '1800000000', referenceBlock: '1', referenceDigest: `0x${'ab'.repeat(32)}` };
    const result = await prepareAdminAction({ provider: noRpc, config, account, kind, subscriber: other,
      flexible, expectedTaskId: '1', expectedReferenceWeight: '1', params: { ...base, circuitId: '7223' } });
    assert.equal(abi.PoolFactory.parseTransaction(result.transaction).name, kind);
  }
});

test('direct administrator signing reads only the nonce and validates the signature', async () => {
  const authorityAbi = new Interface(['function nonces(address) view returns(uint256)']);
  const registryAbi = new Interface(['function machinePool(address,uint256) view returns(address)']);
  const seen = [];
  const readProvider = { request: async ({ method, params }) => {
    seen.push(method);
    assert.equal(method, 'eth_call');
      assert.equal(params[1], 'latest');
      if (params[0].to === factory) {
        const parsed = registryAbi.parseTransaction(params[0]);
        assert.equal(parsed.name, 'machinePool'); assert.equal(parsed.args[0], base.circuits);
        assert.equal(parsed.args[1], 7n);
        return registryAbi.encodeFunctionResult('machinePool', [ZeroAddress]);
      }
      assert.equal(params[0].to, authority);
      const parsed = authorityAbi.parseTransaction(params[0]); assert.equal(parsed.name, 'nonces'); assert.equal(parsed.args[0], account);
      return authorityAbi.encodeFunctionResult(parsed.fragment, [9n]);
  } };
  const provider = { request: async ({ method, params }) => {
    seen.push(method);
    assert.equal(method, 'eth_signTypedData_v4'); assert.equal(params[0], account);
    const payload = JSON.parse(params[1]); const { EIP712Domain, ...types } = payload.types;
    return administrator.signTypedData(payload.domain, types, payload.message);
  } };
  const data = abi.PoolFactory.encodeFunctionData('createPool', [{ ...base, circuitId: 7n, targetRaise: 11000n,
    priceCap: 10000n, directSeller: ZeroAddress, directPrice: 0n, fundingDeadline: 1800001000n, purchaseDeadline: 1800002000n }]);
  const command = await signAuthorityAction({ provider, readProvider, config, account, kind: 'executeApprovedOperation', args: { target: factory, data } });
  assert.deepEqual(seen, ['eth_call', 'eth_signTypedData_v4']); assert.equal(command.nonce, '9');
  assert.equal(command.expectedCodehash, config.freshAuthority.codehash);
  const wrongSignerProvider = { request: async ({ method, params }) => {
    assert.equal(method, 'eth_signTypedData_v4');
    const payload = JSON.parse(params[1]), { EIP712Domain, ...types } = payload.types;
    return administrator.signTypedData(payload.domain, types, payload.message);
  } };
  const otherReader = { request: async ({ params }) => params[0].to === factory
    ? registryAbi.encodeFunctionResult('machinePool', [ZeroAddress]) : authorityAbi.encodeFunctionResult('nonces', [9n]) };
  await assert.rejects(signAuthorityAction({ provider: wrongSignerProvider, readProvider: otherReader, config, account: other,
    kind: 'executeApprovedOperation', args: { target: factory, data } }), /钱包签名与当前管理员地址不一致/);
});

test('direct miner quote adds only exact reservation to four business getters and skips full verification', async () => {
  const data = dataFixture(), f = chainFixture(data.quote);
  const provider = { request: input => {
    assert.equal(input.method, 'eth_call');
    if (getAddress(input.params[0].to) === factory) return abi.PoolFactory.encodeFunctionResult('machinePool', [ZeroAddress]);
    return f.provider.request({ ...input, params: [input.params[0], '0x64'] });
  } };
  const checked = await readOfficialMinerOnchain(provider, data.quote.collection, data.quote.tokenId, { config, checkReservation: true });
  assert.deepEqual(f.calls.sort(), ['getMiner', 'listingFor', 'minerKey', 'ownerOf']);
  assert.equal(checked.registry.pool, ZeroAddress); assert.equal(checked.registry.factory, factory);
  assert.equal(checked.registry.collection, getAddress(data.quote.collection)); assert.equal(checked.registry.tokenId, data.quote.tokenId);
  assert.equal(checked.registry.ready, null); assert.equal(checked.blockHash, null); assert.equal(checked.displayOnly, true);
  assert.equal(operatorQuoteDraft({ chain: checked, quote: null }, { extraBps: 1000 }).params.priceCapWei, f.listing.price.toString());
  f.calls.length = 0;
  const result = await loadOperatorQuote({ collection: data.quote.collection, tokenId: data.quote.tokenId, config, provider, forCreation: true });
  assert(result.chain.official); assert.equal(f.calls.length, 4);
  const unlisted = chainFixture(data.quote, { listing: { valid: false } }), api = apiFixture(data);
  const unlistedProvider = { request: input => {
    if (getAddress(input.params[0].to) === factory) return abi.PoolFactory.encodeFunctionResult('machinePool', [ZeroAddress]);
    assert.equal(input.method, 'eth_call'); return unlisted.provider.request({ ...input, params: [input.params[0], '0x64'] });
  } };
  await loadOperatorQuote({ collection: data.quote.collection, tokenId: data.quote.tokenId, config, provider: unlistedProvider, forCreation: true, fetcher: api.fetcher });
  assert.equal(unlisted.calls.length, 4, 'the Firsto branch reuses the already read miner');
});

test('an existing reserved project can still auto-purchase its NFT without a creation reservation read or Firsto GET', async () => {
  const data = dataFixture(), f = chainFixture(data.quote, { registryPool: pool });
  let paramsReads = 0, reservationReads = 0;
  const provider = { request: input => {
    assert.equal(input.method, 'eth_call'); assert.equal(input.params[1], 'latest');
    const target = getAddress(input.params[0].to);
    if (target === factory) {
      reservationReads++; return abi.PoolFactory.encodeFunctionResult('machinePool', [pool]);
    }
    if (target === pool) {
      paramsReads++; assert.equal(abi.PoolVault.parseTransaction(input.params[0]).name, 'params');
      return abi.PoolVault.encodeFunctionResult('params', [[data.quote.collection, BigInt(data.quote.tokenId),
        f.listing.price * 110n / 100n, f.listing.price, ZeroAddress, 0n, 1800001000n, 1800002000n]]);
    }
    return f.provider.request({ ...input, params: [input.params[0], '0x64'] });
  } };
  const general = await readOfficialMinerOnchain(provider, data.quote.collection, data.quote.tokenId, { config });
  assert.equal(general.registry, null); assert.equal(reservationReads, 0); assert.equal(f.requests.length, 4);
  const explicit = await readOfficialMinerOnchain(provider, data.quote.collection, data.quote.tokenId,
    { config, checkReservation: true });
  assert.equal(explicit.registry.pool, pool, 'A general read reports the reservation without rejecting an existing project.');
  reservationReads = 0; f.requests.length = 0;
  const result = await prepareAdminAction({ provider, config, account, kind: 'autoPurchase', pool });
  assert.equal(result.kind, 'buyFromMarket'); assert.equal(result.transaction.to, pool);
  assert.equal(abi.PoolVault.parseTransaction(result.transaction).args[0], 45n);
  assert.equal(paramsReads, 1); assert.equal(f.requests.length, 4); assert.equal(reservationReads, 0,
    'Procurement reads only params and the four exact NFT/listing/mining getters, with no creation-only lookup.');
});
