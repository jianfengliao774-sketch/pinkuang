import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { parseAuthorityArguments, prepareAuthorityCall } from './authority-relay.mjs';

const authority = '0x0000000000000000000000000000000000000011';
const market = '0x0000000000000000000000000000000000000022';
const pool = '0x0000000000000000000000000000000000000033';
const admin = new Wallet('0x' + '11'.repeat(32));
const domain = { name: 'BEMine Platform Authority', version: '1', chainId: 56, verifyingContract: authority };
const types = { Action: [
  { name: 'kind', type: 'bytes32' }, { name: 'target', type: 'address' },
  { name: 'paramsHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] };
const coder = AbiCoder.defaultAbiCoder();
const kind = name => keccak256(toUtf8Bytes(name));
const deadline = '9999999999';

test('relayed sale review binds the exact pool, price, decision, chain and authority', async () => {
  const args = { market, pool, proposalId: '7', priceWei: '100', approved: true };
  const paramsHash = keccak256(coder.encode(['address', 'uint256', 'uint128', 'bool'],
    [pool, args.proposalId, args.priceWei, args.approved]));
  const signature = await admin.signTypedData(domain, types, {
    kind: kind('REVIEW_SALE'), target: market, paramsHash, nonce: 0, deadline,
  });
  const command = { authority, kind: 'reviewSale', args, nonce: '0', deadline, signature };
  const prepared = prepareAuthorityCall(command);
  assert.equal(prepared.signer, admin.address);
  assert.equal(prepared.kind, 'reviewSale');
  const changed = prepareAuthorityCall({ ...command, args: { ...args, priceWei: '1' } });
  assert.notEqual(changed.signer, admin.address);
  assert.notEqual(prepareAuthorityCall({ ...command, authority: market }).signer, admin.address);
});

test('fee claim can pay only its signing administrator', async () => {
  const args = { markets: [market], pools: [pool], recipient: admin.address };
  const signature = await admin.signTypedData(domain, types, {
    kind: kind('CLAIM_FEES'), target: authority,
    paramsHash: keccak256(coder.encode(['address[]', 'address[]', 'address'], [args.markets, args.pools, args.recipient])),
    nonce: 2, deadline,
  });
  const command = { authority, kind: 'claimFees', args, nonce: '2', deadline, signature };
  assert.equal(prepareAuthorityCall(command).signer, admin.address);
  assert.throws(() => prepareAuthorityCall({ ...command,
    args: { ...args, recipient: '0x0000000000000000000000000000000000000044' } }), /recipient/);
});

test('routine operation is encoded for contract whitelist and CLI defaults to read-only', () => {
  const inner = new Interface(['function mine(bytes)']).encodeFunctionData('mine', ['0x1234']);
  const prepared = prepareAuthorityCall({ authority, kind: 'executeOperation', args: { target: pool, data: inner } });
  const outer = new Interface(['function executeOperation(address,bytes)']);
  const decoded = outer.parseTransaction({ data: prepared.data });
  assert.equal(decoded.args[0], pool);
  assert.equal(decoded.args[1], inner);
  assert.equal(parseAuthorityArguments(['--command', '/tmp/action.json']).send, false);
  assert.throws(() => parseAuthorityArguments(['--command', '/tmp/action.json', '--send']), /journal/);
  assert.throws(() => prepareAuthorityCall({ authority, kind: 'executeOperation', args: { target: pool, data: '0x' } }), /calldata/);
});
