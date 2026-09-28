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
  assert.equal(prepared.value.kind, signing.message.kind);
  assert.equal(prepared.value.target, signing.message.target);
  assert.equal(prepared.value.paramsHash, signing.message.paramsHash);
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
