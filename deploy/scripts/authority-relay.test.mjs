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
  assert.equal(prepareAuthorityCall({...command,expectedCodehash:'0x'+'ab'.repeat(32)}).expectedCodehash,
    '0x'+'ab'.repeat(32));
  assert.throws(()=>prepareAuthorityCall({...command,expectedCodehash:'0x1234'}),/codehash/);
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
  assert.throws(() => prepareAuthorityCall({ authority, kind: 'executeOperation', args: { target: pool, data: '0x' } }), /mine/);
});

test('project creation requires a signed exact calldata payload', async () => {
  const inner = new Interface(['function createBudgetChildPool(address,uint256)'])
    .encodeFunctionData('createBudgetChildPool',[pool,17]);
  assert.throws(() => prepareAuthorityCall({authority,kind:'executeOperation',
    args:{target:market,data:inner}}),/mine/);
  const signature=await admin.signTypedData(domain,types,{kind:kind('APPROVED_OPERATION'),
    target:market,paramsHash:keccak256(inner),nonce:0,deadline});
  const command={authority,kind:'executeApprovedOperation',args:{target:market,data:inner},
    nonce:'0',deadline,signature};
  const prepared=prepareAuthorityCall(command);
  assert.equal(prepared.signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...command,args:{...command.args,target:pool}}).signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...command,args:{...command.args,
    data:inner.slice(0,-2)+'01'}}).signer,admin.address);
});

test('budget purchase signatures bind portfolio, child, listing or Firsto bytes and cost ceiling', async () => {
  const official={portfolio:market,child:pool,listingId:'5',maxCost:'3000'};
  const officialHash=keccak256(coder.encode(['address','uint256','uint256'],
    [official.child,official.listingId,official.maxCost]));
  const officialSignature=await admin.signTypedData(domain,types,{kind:kind('BUY_BUDGET_OFFICIAL'),
    target:market,paramsHash:officialHash,nonce:3,deadline});
  const officialCommand={authority,kind:'buyBudgetOfficial',args:official,nonce:'3',deadline,
    signature:officialSignature};
  assert.equal(prepareAuthorityCall(officialCommand).signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...officialCommand,args:{...official,maxCost:'3001'}}).signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...officialCommand,args:{...official,listingId:'6'}}).signer,admin.address);
  const firsto={portfolio:market,child:pool,encodedOrder:'0x1234abcd',maxCost:'4000'};
  const firstoHash=keccak256(coder.encode(['address','bytes32','uint256'],
    [firsto.child,keccak256(firsto.encodedOrder),firsto.maxCost]));
  const firstoSignature=await admin.signTypedData(domain,types,{kind:kind('BUY_BUDGET_FIRSTO'),
    target:market,paramsHash:firstoHash,nonce:4,deadline});
  const firstoCommand={authority,kind:'buyBudgetFirsto',args:firsto,nonce:'4',deadline,
    signature:firstoSignature};
  assert.equal(prepareAuthorityCall(firstoCommand).signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...firstoCommand,args:{...firsto,
    encodedOrder:'0x1234abce'}}).signer,admin.address);
});
