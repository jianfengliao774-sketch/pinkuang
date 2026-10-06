import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, Wallet, ZeroHash, keccak256 } from 'ethers';
import { createTargetOwnerFixture } from './target-owner-upgrade-test-fixture.mjs';
import { FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR, FRESH_BALANCE_ENFORCER } from './fresh-activation-execution.mjs';

// Public deterministic signing key, used exclusively for synthetic in-memory fixtures.
export const targetOwnerTestSigner = new Wallet(`0x${'11'.repeat(32)}`);
const abi = AbiCoder.defaultAbiCoder();
const manager = new Interface(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
const delegationsType = 'tuple(address delegate,address delegator,bytes32 authority,tuple(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]';
const types = {
  Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }],
  Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
};
const runtimes = JSON.parse(readFileSync(new URL('../src/fixtures/fresh-delegation-runtime.json', import.meta.url), 'utf8'));
export async function createWrappedTargetOwnerFixture({ phase = 'done', operation = 'schedule', wrapped = true, status = 1 } = {}) {
  const f = createTargetOwnerFixture({ phase, proposer: targetOwnerTestSigner.address });
  const txHash = f.options[`${operation}TxHash`], tx = f.transactions.get(txHash), receipt = f.receipts.get(txHash);
  const data = f.plan[`${operation}Data`];
  tx.from = receipt.from = targetOwnerTestSigner.address; tx.type = 2; tx.authorizationList = null;
  tx.nonce = operation === 'schedule' ? 23 : 24;
  const delegation = { delegate: tx.from, delegator: tx.from, authority: `0x${'ff'.repeat(32)}`,
    caveats: [{ enforcer: FRESH_BALANCE_ENFORCER.address, terms: `0x01${tx.from.slice(2)}${'00'.repeat(32)}`, args: '0x' }], salt: 123n };
  delegation.signature = await targetOwnerTestSigner.signTypedData({ name: 'DelegationManager', version: '1', chainId: 56,
    verifyingContract: FRESH_DELEGATION_MANAGER.address }, types, delegation);
  const envelope = { delegations: [delegation], modes: [ZeroHash],
    executions: [`0x${f.plan.timelock.slice(2)}${'00'.repeat(32)}${data.slice(2)}`] };
  const rebuild = () => { tx.data = manager.encodeFunctionData('redeemDelegations',
    [[abi.encode([delegationsType], [envelope.delegations])], envelope.modes, envelope.executions]); };
  for (const [pin, name] of [[FRESH_DELEGATION_MANAGER, 'manager'], [FRESH_DELEGATOR, 'delegator'], [FRESH_BALANCE_ENFORCER, 'enforcer']])
    f.codes.set(pin.address.toLowerCase(), runtimes.codes[name].code);
  if (wrapped) { tx.to = receipt.to = FRESH_DELEGATION_MANAGER.address; rebuild(); }
  receipt.status = status; if (!status) receipt.logs = [];
  return { ...f, operation, tx, receipt, envelope, rebuild,
    expected: { from: tx.from, to: f.plan.timelock, data, dataHash: keccak256(data), operation } };
}
