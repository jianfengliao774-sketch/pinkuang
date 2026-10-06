import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, keccak256, solidityPacked, toUtf8Bytes } from 'ethers';
import { targetOwnerTypedAction, encodeTargetOwnerConfiguration, prepareTargetOwnerMigration } from './target-owner-typed.mjs';
const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const context = { chainId: 56, pool: addr(1), factory: addr(2), circuits: addr(3), circuitId: '16210' };
const a = { originalOwner: addr(4), authority: addr(5), administratorOne: addr(6), administratorTwo: addr(7), nonce: '0', deadline: '1800003600' };
const signature = `0x${'11'.repeat(65)}`;
test('typed hash matches the candidate Solidity static-tuple hash exactly', () => {
  const result = targetOwnerTypedAction(context, a), coder = AbiCoder.defaultAbiCoder();
  const domain = keccak256(coder.encode(['bytes32','bytes32','bytes32','uint256','address'], [
    keccak256(toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
    keccak256(toUtf8Bytes('BEMine Target Owner')), keccak256(toUtf8Bytes('1')), 56n, context.pool]));
  const payload = keccak256(coder.encode(['bytes32','address','address','address','uint256',
    '(address originalOwner,address authority,address administratorOne,address administratorTwo,uint256 nonce,uint256 deadline)'], [
    keccak256(toUtf8Bytes('ConfigureTargetOwner(address pool,address factory,address circuits,uint256 circuitId,address originalOwner,address authority,address administratorOne,address administratorTwo,uint256 nonce,uint256 deadline)')),
    context.pool,context.factory,context.circuits,context.circuitId,a]));
  assert.equal(result.digest, keccak256(solidityPacked(['bytes2','bytes32','bytes32'], ['0x1901',domain,payload])));
});
test('each chain/pool/authority/owner/admin/nonce/deadline mutation changes the signed digest', () => {
  const digest = targetOwnerTypedAction(context, a).digest;
  for (const [field, value] of [['chainId', 57], ['pool', addr(8)], ['factory', addr(8)], ['circuits', addr(8)], ['circuitId','16211']])
    assert.notEqual(targetOwnerTypedAction({...context,[field]:value},a).digest,digest);
  for (const [field, value] of [['authority',addr(8)], ['originalOwner',addr(8)], ['administratorOne',addr(8)], ['administratorTwo',addr(8)], ['nonce','1'], ['deadline','1800003601']])
    assert.notEqual(targetOwnerTypedAction(context,{...a,[field]:value}).digest,digest);
});
test('migration envelope is canonical fixed-length calldata and rejects malformed signatures', () => {
  const out = encodeTargetOwnerConfiguration(a,signature,signature), iface = new Interface(['function configureTargetOwner(bytes)']);
  assert.equal((out.authorization.length-2)/2,512);
  assert.equal(iface.decodeFunctionData('configureTargetOwner',out.data)[0],out.authorization);
  assert.throws(()=>encodeTargetOwnerConfiguration(a,signature+'11',signature),/65-byte/);
  assert.throws(()=>encodeTargetOwnerConfiguration(a,'0x',signature),/65-byte/);
});
test('invalid roles and imprecise unsigned values are rejected before any signing data is produced', () => {
  assert.throws(()=>targetOwnerTypedAction(context,{...a,administratorTwo:a.administratorOne}),/distinct/);
  assert.throws(()=>targetOwnerTypedAction(context,{...a,originalOwner:context.pool}),/this pool/);
  assert.throws(()=>targetOwnerTypedAction(context,{...a,authority:addr(0)}),/zero/);
  assert.throws(()=>targetOwnerTypedAction({...context,circuitId:1.5},a),/exact/);
});
function evidence() {
  const hash = `0x${'12'.repeat(32)}`, tx = `0x${'34'.repeat(32)}`;
  const events = new Interface(['event PoolCreated(address indexed pool,address indexed circuits,uint256 indexed circuitId,uint256 targetRaise,uint256 priceCap,address treasury)',
    'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
  const common = { blockNumber: 99, blockHash: hash, transactionHash: tx, transactionIndex: 2, removed: false };
  const creation = { ...common, address: context.factory, logIndex: 10,
    ...events.encodeEventLog('PoolCreated', [context.pool,context.circuits,context.circuitId,1000,900,addr(9)]) };
  const transfer = { ...common, address: context.circuits, logIndex: 11,
    ...events.encodeEventLog('Transfer', [a.originalOwner,addr(8),context.circuitId]) };
  const owner = new Interface(['function ownerOf(uint256) view returns(address)']);
  return { chainId: 56, creation, blockEndOwnerRead: { to: context.circuits, blockNumber:99,blockHash:hash,
    data: owner.encodeFunctionData('ownerOf',[context.circuitId]),result:owner.encodeFunctionResult('ownerOf',[addr(8)]) },
  transfers:[transfer] };
}
test('review packet reconstructs creation-time owner before a later same-block transfer and is JSON safe', () => {
  const packet = prepareTargetOwnerMigration(context,a,evidence());
  assert.equal(packet.evidence.reconstructedOwner,a.originalOwner);
  assert.equal(packet.typedAction.digest,targetOwnerTypedAction(context,a).digest);
  assert.deepEqual(packet.signers,[a.administratorOne,a.administratorTwo]);
  assert.equal(packet.evidenceTrust,'administrator_review_required');
  assert.equal(packet.evidenceDigestIsSigned,false); assert.equal(packet.submitted,false);
  assert.doesNotThrow(()=>JSON.stringify(packet));
});
test('review packet refuses block-end lazy owner, wrong identity, incomplete chain and polluted logs', () => {
  assert.throws(()=>prepareTargetOwnerMigration(context,{...a,originalOwner:addr(8)},evidence()),/creation-time/);
  let e=evidence(); e.transfers=[];
  assert.throws(()=>prepareTargetOwnerMigration(context,a,e),/creation-time/);
  e=evidence();e.creation.address=addr(20);
  assert.throws(()=>prepareTargetOwnerMigration(context,a,e),/another pool/);
  e=evidence();e.transfers[0].blockHash=`0x${'99'.repeat(32)}`;
  assert.throws(()=>prepareTargetOwnerMigration(context,a,e),/same-block/);
  e=evidence();e.transfers.push({...e.transfers[0]});
  assert.throws(()=>prepareTargetOwnerMigration(context,a,e),/ordering/);
  e=evidence();e.blockEndOwnerRead.result+='00';
  assert.throws(()=>prepareTargetOwnerMigration(context,a,e),/canonical/);
  e=evidence();e.chainId=57;
  assert.throws(()=>prepareTargetOwnerMigration(context,a,e),/another chain/);
  e=evidence();e.transfers[0].transactionHash=`0x${'99'.repeat(32)}`;
  assert.throws(()=>prepareTargetOwnerMigration(context,a,e),/transaction identity/);
});
