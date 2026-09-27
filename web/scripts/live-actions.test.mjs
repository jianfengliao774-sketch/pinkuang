import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, ZeroAddress, toQuantity, formatEther } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { shareQuantity, exactPrice, prepareProductAction } from '../lib/live-actions.mjs';

const addr = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const factory = addr(1), lens = addr(2), market = addr(3), pool = addr(4), account = addr(5), seller = addr(6), collection = addr(7);
const now = 2_000_000n, day = 86400n, week = day * 7n, blockHash = `0x${'ab'.repeat(32)}`;
const config = { status: 'ready', chainId: 56, factory, lens, shareMarket: market };
const allPool = (1n << 17n) - 1n, allGov = (1n << 14n) - 1n;
const status = (validMask, errorMask = 0n) => ({ validMask, errorMask, trustError: 0n });
const params = { circuits: collection, circuitId: 900719925474099312345n, targetRaise: 100000000000000000100n,
  priceCap: 100000000000000000000n, directSeller: ZeroAddress, directPrice: 0n,
  fundingDeadline: now + 100n, purchaseDeadline: now + 200n };
const proposal = { proposer: account, snapshotTs: now - 100n, endsAt: now - 100n + day, refAt: 0n,
  price: 1000n, refPrice: 0n, snapshotMemberCount: 3n, snapshotTotalShares: 100n, yesCount: 2n, yesShares: 60n, executed: false };
function row(change = {}) { return { pool, status: status(allPool), params, state: 2n,
  unitPriceWei: 1000000000000000001n, totalRaised: params.targetRaise, totalSupply: 100n, memberCount: 3n,
  depositPaused: false, purchaseCost: 1000n, activatedAt: now - week, shareTradingAllowed: true,
  shares: 10n, lockedShares: 0n, availableShares: 10n, claimableBEM: 123456789n, bnbOwed: 2n,
  initialContributedWei: 10000000000000000010n, ...change }; }
function gov(change = {}, state = 2n) { return { status: status(allGov), state, activeProposalId: 1n,
  purchaseCost: 1000n, hasVoted: false, snapshotShares: 10n, listedProposalId: 0n, expiresAt: now + week,
  salePrice: 1000n, requiredYesCount: 2n, requiredYesShares: 51n, discounted: false, passed: true,
  canVote: true, canExecute: true, canCancelExpired: false, ...change,
  proposal: { ...proposal, ...change.proposal } }; }
function mock(options = {}) {
  const requests = [], invocations = [], raw = row(options.row), governance = gov(options.gov, raw.state);
  let headerCount = 0, chainCount = 0;
  return { requests, invocations, async request(input) {
    requests.push(input); const { method, params: args = [] } = input;
    if (method === 'eth_chainId') return options.wrongChain || options.flipChain && ++chainCount >= 4 ? '0x1' : '0x38';
    if (method === 'eth_getBlockByNumber') {
      headerCount++;
      return { number: '0xa', timestamp: toQuantity(options.now ?? now),
        hash: options.reorg && headerCount >= 4 ? `0x${'cd'.repeat(32)}` : blockHash };
    }
    if (method === 'eth_getCode') return '0x1234';
    assert.equal(method, 'eth_call', 'preparation may only read'); assert.equal(args[1], '0xa', 'every call is pinned');
    const inputTx = args[0], iface = inputTx.to === factory ? abi.PoolFactory : inputTx.to === lens ? abi.PoolLens
      : inputTx.to === market ? abi.ShareMarket : abi.PoolVault;
    const decoded = iface.parseTransaction(inputTx); assert.ok(decoded, 'known ABI');
    const name = decoded.name, simulated = Object.hasOwn(inputTx, 'from');
    invocations.push({ name, simulated, args: decoded.args, transaction: inputTx });
    if (simulated) {
      assert.equal(inputTx.from, account);
      if (options.simulationFails) throw new Error('simulation reverted');
      if (options.badSimulationReturn) return '0x';
      return iface.encodeFunctionResult(decoded.fragment, decoded.fragment.outputs.map(() => 1n));
    }
    let value;
    if (name === 'lens') value = options.wrongLens ? addr(99) : lens;
    else if (name === 'factory') value = options.wrongFactory ? addr(99) : factory;
    else if (name === 'VERSION') value = 1n;
    else if (name === 'shareMarket') value = options.wrongMarket ? addr(99) : market;
    else if (name === 'feeBps') value = options.sellerFeeBps ?? 100n;
    else if (name === 'buyerFeeBps') {
      if (options.oldMarket) throw new Error('old Market has no buyerFeeBps getter');
      value = options.buyerFeeBps ?? 100n;
    }
    else if (name === 'positions') value = { blockNumber: 10n, timestamp: options.now ?? now, totalPools: 1n,
      nextCursor: 1n, registryCountValid: true, pools: [raw] };
    else if (name === 'governance') value = governance;
    else if (name === 'OFFICIAL_FACTORY') value = factory;
    else if (name === 'isPool') value = true;
    else if (['state','purchaseCost','activatedAt'].includes(name)) value = raw[name];
    else if (name === 'balanceOf') value = raw.shares;
    else if (name === 'getPastShares') value = governance.snapshotShares;
    else if (['activeProposalId','listedProposalId','expiresAt','salePrice','hasVoted'].includes(name)) value = governance[name];
    else if (name === 'nextProposalId') value = governance.activeProposalId === 0n ? 1n : governance.activeProposalId + BigInt(options.proposals?.length ?? 1);
    else if (name === 'getProposal') value = options.proposals?.[Number(decoded.args[0]-1n)] ?? governance.proposal;
    else if (name === 'proposalPassed') { const p = options.proposals?.[Number(decoded.args[0]-1n)] ?? governance.proposal;
      value = p.yesCount*2n>p.snapshotMemberCount && (p.price<raw.purchaseCost ? p.yesShares>=60n : p.yesShares>50n); }

    else if (name === 'lastProposed') value = options.lastProposed ?? 0n;
    else if (name === 'bnbOwed') value = options.marketOwed ?? 123n;
    else if (name === 'orders') value = { seller, pool, remaining: 5n, pricePerUnit: 900719925474099312345n,
      active: true, ...options.order };
    else if (name === 'orderExpiresAt') value = options.expiry ?? now + 1n;
    else throw new Error(`unexpected read: ${name}`);
    return iface.encodeFunctionResult(name, [value]);
  } };
}
const prepare = (rpc = mock(), input = {}) => prepareProductAction({ provider: rpc, config, account, pool, kind: 'claim', ...input });
const simulations = rpc => rpc.invocations.filter(c => c.simulated);

test('whole shares reject coercible objects, fractions, zero and out-of-range amounts', () => {
  for (const [value, expected] of [['1', 1n], [100, 100n], [49n, 49n]]) assert.equal(shareQuantity(value), expected);
  for (const value of [undefined, null, true, '', '01', ' 1', '1\n', '1e1', '1.0', 1.1, 0, -1n, 101, Infinity, NaN,
    Number.MAX_SAFE_INTEGER + 1, { toString: () => '1' }]) assert.throws(() => shareQuantity(value));
});

test('BNB prices preserve every wei and reject floating-point rounding or uint overflow', () => {
  assert.equal(exactPrice('0.000000000000000001'), 1n);
  assert.equal(exactPrice('9007199254740993.123456789012345678'), 9007199254740993123456789012345678n);
  assert.equal(exactPrice(formatEther((1n << 256n) - 1n)), (1n << 256n) - 1n);
  for (const value of [0.1, 1, NaN, Infinity, null, undefined, '01', '1.', '.1', ' 1', '1e3', '-1',
    '0', '1.0000000000000000001', formatEther(1n << 256n), '1'.repeat(1000), { toString: () => '1' }])
    assert.throws(() => exactPrice(value));
  assert.equal(exactPrice('0', { allowZero: true }), 0n);
});

test('deposit binds exact total, sender, pool and one block; returns only after successful simulation', async () => {
  const rpc = mock({ row: { state: 0n, totalSupply: 90n } });
  const result = await prepare(rpc, { kind: 'deposit', quantity: '4' });
  assert.equal(BigInt(result.transaction.value), 4000000000000000004n);
  const decoded = abi.PoolVault.parseTransaction(result.transaction);
  assert.equal(decoded.name, 'deposit'); assert.equal(decoded.args[0], 4n);
  assert.equal(result.transaction.from, account); assert.equal(result.transaction.to, pool);
  assert.equal(result.checkedBlock.blockHash, blockHash); assert.equal(result.checkedBlock.blockNumber, 10n);
  assert.equal(simulations(rpc).length, 1); assert.equal(simulations(rpc)[0].name, 'deposit');
  assert.equal(simulations(rpc)[0].transaction.value, result.transaction.value);
  assert(rpc.requests.every(r => ['eth_call', 'eth_chainId', 'eth_getBlockByNumber'].includes(r.method)));
  for (const options of [{ simulationFails: true }, { wrongChain: true }, { flipChain: true }, { reorg: true }])
    await assert.rejects(prepare(mock({ ...options, row: { state: 0n, totalSupply: 90n } }), { kind: 'deposit', quantity: '4' }));
});

test('invalid deployment, swapped pool/lens and unsupported action fail closed', async () => {
  for (const input of [{ config: { ...config, status: 'unconfigured' } }, { config: { ...config, chainId: 1 } },
    { config: { ...config, manifest: { factory: addr(77) } } }, { config: { ...config, manifest: { chainId: 1 } } },
    { kind: 'executeBurn' }, { account: ZeroAddress }])
    await assert.rejects(prepare(mock(), input));
  for (const options of [{ wrongLens: true }, { wrongFactory: true }, { row: { pool: addr(99) } },
    { row: { status: { ...status(allPool), trustError: 2n } } }]) await assert.rejects(prepare(mock(options)));
});

test('funding availability requires valid fields, open deadline, unpaused state and enough shares', async () => {
  for (const change of [{ state: 1n }, { depositPaused: true }, { totalSupply: 100n }, { shares: 100n },
    { params: { ...params, fundingDeadline: now } }, { unitPriceWei: 0n }, { status: status(allPool, 1n << 3n) }]) {
    const rpc = mock({ row: { state: 0n, totalSupply: 90n, ...change } });
    await assert.rejects(prepare(rpc, { kind: 'deposit', quantity: '1' })); assert.equal(simulations(rpc).length, 0);
  }
});

test('claims and BNB withdrawals allow former holders but never fabricate unknown or zero balances', async () => {
  for (const kind of ['claim', 'withdrawBnb']) {
    const result = await prepare(mock({ row: { state: 4n, shares: 0n } }), { kind });
    assert.equal(abi.PoolVault.parseTransaction(result.transaction).name, kind);
    const field = kind === 'claim' ? 'claimableBEM' : 'bnbOwed', bit = kind === 'claim' ? 14n : 15n;
    await assert.rejects(prepare(mock({ row: { [field]: 0n } }), { kind }));
    await assert.rejects(prepare(mock({ row: { status: status(allPool, 1n << bit) } }), { kind }));
  }
  await assert.rejects(prepare(mock({ badSimulationReturn: true }), { kind: 'claim' }));
  for (const state of [2n, 3n]) assert.equal((await prepare(mock({ row: { state } }), { kind: 'harvest' })).kind, 'harvest');
  for (const state of [0n, 1n, 4n, 5n]) await assert.rejects(prepare(mock({ row: { state } }), { kind: 'harvest' }));
});

test('withdrawal and failure finalization follow exact state and deadline boundaries', async () => {
  assert.equal((await prepare(mock({ row: { state: 0n } }), { kind: 'withdrawDeposit' })).kind, 'withdrawDeposit');
  for (const change of [{ state: 1n }, { state: 0n, shares: 0n }])
    await assert.rejects(prepare(mock({ row: change }), { kind: 'withdrawDeposit' }));
  for (const [state, field] of [[0n, 'fundingDeadline'], [1n, 'purchaseDeadline']]) {
    const changed = { state, params: { ...params, [field]: now } };
    assert.equal((await prepare(mock({ row: changed }), { kind: 'finalizeFailure' })).kind, 'finalizeFailure');
    await assert.rejects(prepare(mock({ row: { ...changed, params: { ...params, [field]: now + 1n } } }), { kind: 'finalizeFailure' }));
  }
  await assert.rejects(prepare(mock({ row: { state: 5n } }), { kind: 'finalizeFailure' }));
});

test('market ABI tuple, price multiplication, gift listing and withdrawal action name match contracts', async () => {
  const fill = await prepare(mock(), { kind: 'fill', orderId: '7', quantity: '3' });
  const gross = 2702159776422297937035n;
  assert.equal(BigInt(fill.transaction.value), gross + gross / 100n);
  assert.deepEqual(fill.marketTrade, { grossWei: gross, buyerFeeWei: gross / 100n, sellerFeeWei: gross / 100n,
    buyerPaymentWei: gross + gross / 100n, sellerNetWei: gross - gross / 100n });
  assert.deepEqual([...abi.ShareMarket.parseTransaction(fill.transaction).args], [7n, 3n]);
  const listing = await prepare(mock(), { kind: 'list', quantity: '4', price: '0' });
  assert.deepEqual([...abi.ShareMarket.parseTransaction(listing.transaction).args], [pool, 4n, 0n]);
  await assert.rejects(prepare(mock({ row: { availableShares: 100n } }), { kind: 'list', quantity: '100',
    price: formatEther(((1n << 256n) - 1n) / 100n) }), /buyer fee overflows/);
  const withdrawn = await prepare(mock(), { kind: 'marketWithdraw' });
  assert.equal(withdrawn.kind, 'withdrawBnb'); assert.equal(withdrawn.requestKind, 'marketWithdraw');
  assert.equal(withdrawn.transaction.to, market); assert.equal(withdrawn.pool, null);
  await assert.rejects(prepare(mock({ marketOwed: 0n }), { kind: 'marketWithdraw' }));
});

test('old one-sided Market blocks new list/fill without stranding withdrawals', async () => {
  await assert.rejects(prepare(mock({ oldMarket: true }), { kind: 'fill', orderId: '7', quantity: '1' }));
  await assert.rejects(prepare(mock({ oldMarket: true }), { kind: 'list', quantity: '1', price: '0.1' }));
  await assert.rejects(prepare(mock({ buyerFeeBps: 0n }), { kind: 'fill', orderId: '7', quantity: '1' }), /Bilateral/);
  await assert.rejects(prepare(mock({ sellerFeeBps: 0n }), { kind: 'list', quantity: '1', price: '0.1' }), /Bilateral/);
  assert.equal((await prepare(mock({ oldMarket: true }), { kind: 'marketWithdraw' })).transaction.value, '0x0');
});

test('market cannot fill expired, zero-expiry, frozen, changed, oversubscribed or overflowing orders', async () => {
  for (const options of [{ expiry: now }, { expiry: 0n }, { order: { active: false } }, { order: { remaining: 0n } },
    { row: { state: 3n } }, { row: { shareTradingAllowed: false } }, { row: { shares: 99n } },
    { order: { seller: account } }, { order: { pricePerUnit: (1n << 256n) - 1n } }, { wrongMarket: true },
    { row: { status: status(allPool, 1n << 10n) } }]) {
    const rpc = mock(options); await assert.rejects(prepare(rpc, { kind: 'fill', orderId: '7', quantity: '3' }));
    assert.equal(simulations(rpc).length, 0);
  }
  await assert.rejects(prepare(mock(), { kind: 'fill', orderId: '7', quantity: '6' }));
  await assert.rejects(prepare(mock(), { kind: 'fill', pool: addr(99), orderId: '7', quantity: '1' }));
  for (const orderId of ['0', '-1', '01', '7\n', 9007199254740992, (1n << 256n).toString(), { toString: () => '7' }])
    await assert.rejects(prepare(mock(), { kind: 'fill', orderId, quantity: '1' }));
  await assert.rejects(prepare(mock({ row: { availableShares: 0n } }), { kind: 'list', quantity: '1', price: '1' }));
});

test('seller cancellation and permissionless expiry remain available for frozen and legacy orders', async () => {
  for (const state of [2n, 3n, 4n]) {
    const result = await prepare(mock({ row: { state, shareTradingAllowed: false }, order: { seller: account }, expiry: 0n }),
      { kind: 'cancel', orderId: '7' });
    assert.equal(result.kind, 'cancel');
    assert.equal((await prepare(mock({ row: { state, shareTradingAllowed: false }, expiry: 0n }), { kind: 'expire', orderId: '7' })).kind, 'expire');
  }
  await assert.rejects(prepare(mock(), { kind: 'cancel', orderId: '7' }));
  await assert.rejects(prepare(mock(), { kind: 'expire', orderId: '7' }));
});

test('sale candidates use reviewed multi-candidate reads and bind the confirmed price and identity', async()=>{
  const proposals=[{...proposal,price:2000n}, {...proposal,price:900n,executed:true}];
  const options={row:{state:3n},gov:{listedProposalId:2n,salePrice:900n},proposals};
  const bought=await prepare(mock(options),{kind:'completeSale'});
  assert.equal(BigInt(bought.transaction.value),900n);assert.equal(bought.quote.proposalId,2n);
  for(const expected of [{expectedPriceWei:'1000'},{expectedProposalId:'1'},{expectedPool:addr(99)},{expectedAccount:seller}])
    await assert.rejects(prepare(mock(options),{kind:'completeSale',...expected}));
  assert.equal((await prepare(mock(options),{kind:'completeSale',expectedPriceWei:'900',expectedProposalId:'2',expectedPool:pool,expectedAccount:account})).kind,'completeSale');
});

test('additional sale candidates, votes and reference disclosure follow the audited governance module',async()=>{
  const made=await prepare(mock(),{kind:'propose',priceWei:'100',refPriceWei:'1000',refAt:(now-1n).toString()});
  assert.deepEqual([...abi.PoolVault.parseTransaction(made.transaction).args],[100n,1000n,now-1n]);
  await assert.rejects(prepare(mock(),{kind:'propose',priceWei:'100',refPriceWei:'0',refAt:'0'}));
  const proposals=[{...proposal,price:2000n},{...proposal,price:900n}];
  const vote=await prepare(mock({proposals}),{kind:'vote',proposalId:'2',support:true});
  assert.deepEqual([...abi.PoolVault.parseTransaction(vote.transaction).args],[2n,true]);
  await assert.rejects(prepare(mock({proposals}),{kind:'vote',proposalId:'3',support:true}));
  assert.equal((await prepare(mock({proposals}),{kind:'executeSale',proposalId:'2'})).kind,'executeSale');
});

test('share purchase binds the displayed seller and exact unit price',async()=>{
  const input={kind:'fill',orderId:'7',quantity:'1',expectedSeller:seller,expectedPricePerUnitWei:'900719925474099312345'};
  const ready=await prepare(mock(),input);assert.equal(ready.order.seller,seller);
  await assert.rejects(prepare(mock({order:{pricePerUnit:1n}}),input));
  await assert.rejects(prepare(mock({order:{seller:addr(100)}}),input));
});
