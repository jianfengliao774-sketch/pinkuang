import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, getAddress, keccak256 } from 'ethers';
import { authorityAction, approvedOperatorCall } from '../lib/authority-client.mjs';
import { prepareAuthorityCall } from '../../deploy/scripts/authority-relay.mjs';
import { abi } from '../lib/chain-client.mjs';

const administrator = new Wallet('0x' + '11'.repeat(32));
const authority = getAddress('0x0000000000000000000000000000000000000021');
const core = getAddress('0x0000000000000000000000000000000000000022');
const budget = getAddress('0x0000000000000000000000000000000000000023');
const market = getAddress('0x0000000000000000000000000000000000000024');
const pool = getAddress('0x0000000000000000000000000000000000000025');

async function matchesServer(kind, args) {
  const nonce = '7', deadline = '1900000000';
  const signing = authorityAction(authority, kind, args, nonce, deadline);
  const signature = await administrator.signTypedData(signing.domain, signing.types, signing.message);
  const prepared = prepareAuthorityCall({ authority, kind, args, nonce, deadline, signature });
  assert.equal(prepared.signer, administrator.address);
  assert.deepEqual(prepared.domain, signing.domain);
  assert.equal(prepared.primaryType, signing.primaryType);
  assert.deepEqual(prepared.value, signing.message);
}

test('browser and server agree on exact Authority EIP-712 hashes', async () => {
  const calldata = abi.PoolFactory.encodeFunctionData('createPool', [{
    circuits: pool, circuitId: 123n, targetRaise: 100000n, priceCap: 90000n,
    directSeller: '0x0000000000000000000000000000000000000000', directPrice: 0n,
    fundingDeadline: 1800001000n, purchaseDeadline: 1800002000n,
  }]);
  await matchesServer('executeApprovedOperation', { target: core, data: calldata });
  await matchesServer('reviewSale', { market, pool, proposalId: '2', priceWei: '12345', approved: true });
  await matchesServer('reviewChildSale', { portfolio: budget, proposalId: '3', approved: false });
  await matchesServer('setSaleReference', { market, pool, priceWei: '54321', observedAt: '1800000000', digest: keccak256('0x1234') });
  await matchesServer('claimFees', { markets: [market], pools: [pool], recipient: administrator.address });
  await matchesServer('buyBudgetOfficial', { portfolio: budget, child: pool, listingId: 8, maxCost: 1000 });
  await matchesServer('buyBudgetFirsto', { portfolio: budget, child: pool, encodedOrder: '0x1234', maxCost: 1000 });
});

test('only reviewed Factory creation calldata is eligible for admin relay', () => {
  const config = { stage: 'fresh-active', factory: core, portfolioFactory: budget };
  const data = abi.BudgetPortfolioFactory.encodeFunctionData('createPortfolio',
    [1000n, 1000n, 900n, 1800001000n, 1800002000n]);
  assert.deepEqual(approvedOperatorCall(config, { to: budget, data, value: '0x0' }), { target: budget, data });
  assert.throws(() => approvedOperatorCall(config, { to: budget, data, value: '0x1' }), /BNB/);
  assert.throws(() => approvedOperatorCall(config, { to: core,
    data: abi.PoolFactory.encodeFunctionData('setTreasury', [market]), value: '0x0' }), /建池/);
});

test('every signed factory operation exposes exact business terms as JSON-safe EIP-712 fields', async () => {
  const params = { circuits: pool, circuitId: 13043n, targetRaise: 100000n, priceCap: 90000n,
    directSeller: administrator.address, directPrice: 80000n,
    fundingDeadline: 1800001000n, purchaseDeadline: 1800002000n };
  const flexible = { minVerifiedWeight: 12n, referencePriceWei: 70000n,
    targetDailyYieldAtomic: 456n, extraBps: 800n, referenceObservedAt: 1800000000n,
    referenceBlock: 123456n, referenceDigest: keccak256('0x1234') };
  const operations = [
    ['createPool', [params]],
    ['createPoolWithExpiry', [params, false]],
    ['createBudgetChildPool', [params, budget]],
    ['createFlexiblePool', [params, flexible]],
    ['createFlexiblePoolChecked', [params, flexible, 42, 12]],
  ];
  for (const [operation, inputs] of operations) {
    const args = { target: core, data: abi.PoolFactory.encodeFunctionData(operation, inputs) };
    const typed = authorityAction(authority, 'executeApprovedOperation', args, 0, 1900000000);
    assert.equal(typed.primaryType, 'CreatePool');
    assert.equal(typed.message.operation, operation);
    assert.equal(typed.message.params.circuitId, '13043');
    assert.equal(typed.message.params.priceCap, '90000');
    assert.equal(typed.message.config.referencePriceWei, operation.includes('Flexible') ? '70000' : '0');
    assert.doesNotThrow(() => JSON.stringify(typed));
    await matchesServer('executeApprovedOperation', args);
  }
  const budgetData = abi.BudgetPortfolioFactory.encodeFunctionData('createPortfolio',
    [100000n, 90000n, 10000n, 1800001000n, 1800002000n]);
  const budgetTyped = authorityAction(authority, 'executeApprovedOperation',
    { target: budget, data: budgetData }, 0, 1900000000);
  assert.equal(budgetTyped.primaryType, 'CreatePortfolio');
  assert.equal(budgetTyped.message.budgetWei, '100000');
  await matchesServer('executeApprovedOperation', { target: budget, data: budgetData });
});
