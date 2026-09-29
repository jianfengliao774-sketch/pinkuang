import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Transaction, Wallet, keccak256 } from 'ethers';
import { acknowledgeFinalizedAuthorityFailure, authorityGasLimit, manuallyRebroadcastSigned, parseAuthorityArguments,
  prepareAuthorityCall } from './authority-relay.mjs';
import { authorityTypedAction } from '../shared/authority-typed.mjs';

const authority = '0x0000000000000000000000000000000000000011';
const market = '0x0000000000000000000000000000000000000022';
const pool = '0x0000000000000000000000000000000000000033';
const admin = new Wallet('0x' + '11'.repeat(32));
const deadline = '9999999999';
const sign = async (action, args, nonce) => {
  const typed = authorityTypedAction(authority, action, args, nonce, deadline);
  return admin.signTypedData(typed.domain, typed.types, typed.message);
};

test('all Authority send paths require a fixed reviewed Gas bound and never estimate',async()=>{
  let simulated=false;
  const provider={estimateGas:async()=>{simulated=true;return 100n;}};
  assert.equal(await authorityGasLimit(provider,{to:authority},650_000n),650_000n);
  assert.equal(simulated,false);
  await assert.rejects(authorityGasLimit(provider,{to:authority}),/explicit reviewed/);
  await assert.rejects(authorityGasLimit(provider,{to:authority},0n),/1–10,000,000/);
  await assert.rejects(authorityGasLimit(provider,{to:authority},10_000_001n),/1–10,000,000/);
  assert.equal(simulated,false);
});

test('relayed sale review binds the exact pool, price, decision, chain and authority', async () => {
  const args = { market, pool, proposalId: '7', priceWei: '100', approved: true };
  const signature = await sign('reviewSale', args, 0);
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
  const signature = await sign('claimFees', args, 2);
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
  assert.throws(() => parseAuthorityArguments(['--command', '/tmp/action.json', '--send',
    '--journal', '/tmp/authority.json']), /gas-limit/);
  assert.equal(parseAuthorityArguments(['--command', '/tmp/action.json', '--send',
    '--journal', '/tmp/authority.json', '--gas-limit', '650000']).gasLimit,650_000n);
  assert.throws(() => parseAuthorityArguments(['--command', '/tmp/action.json', '--send',
    '--journal', '/tmp/authority.json', '--rebroadcast-signed']), /expected-hash/);
  assert.throws(() => parseAuthorityArguments(['--command', '/tmp/action.json',
    '--acknowledge-failure', '0x'+'a'.repeat(64)]), /private journal/);
  assert.throws(() => prepareAuthorityCall({ authority, kind: 'executeOperation', args: { target: pool, data: '0x' } }), /mine/);
});

test('a reverted relay requires explicit hash-pinned, canonical finalized failure review to release',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'authority-failure-review-'));
  try {
    const gas=Wallet.createRandom(), args={market,pool,proposalId:'7',priceWei:'100',approved:true};
    const signature=await sign('reviewSale',args,0);
    const prepared=prepareAuthorityCall({authority,kind:'reviewSale',args,nonce:'0',deadline,signature});
    const raw=await gas.signTransaction({type:0,chainId:56,to:authority,data:prepared.data,
      nonce:0,gasLimit:650_000n,gasPrice:1_000_000_000n,value:0n});
    const transaction=Transaction.from(raw), hash=transaction.hash, blockHash='0x'+'a'.repeat(64);
    const journalPath=join(directory,'authority.json');
    const tx={phase:'reverted',kind:'reviewSale',from:gas.address,nonce:0,to:authority,
      data:prepared.data,value:'0',hash,blockNumber:100,blockHash,finality:'bsc-finalized',
      finalizedBlockNumber:110,finalizedBlockHash:'0x'+'b'.repeat(64),gasCostWei:'21000',
      attempts:[{kind:'purchase',raw,hash,gasLimit:'650000',gasPrice:'1000000000',broadcastCount:1}],
      speedUps:0};
    const journal={version:1,chainId:56,factory:authority,pool:authority,transactionTarget:authority,
      transaction:tx,gasSpentWei:'21000',gasReceipts:{[hash]:'21000'}};
    const receipt={hash,from:gas.address,to:authority,blockNumber:100,blockHash,status:0,fee:21000n};
    const provider={getNetwork:async()=>({chainId:56n}),getTransaction:async()=>transaction,
      getTransactionReceipt:async()=>receipt,getTransactionCount:async()=>1,
      getBlock:async tag=>tag==='finalized'?{number:110,hash:'0x'+'b'.repeat(64)}:{number:100,hash:blockHash}};
    const options={journal:journalPath,acknowledgeFailure:hash.toLowerCase()};
    await assert.rejects(acknowledgeFinalizedAuthorityFailure(provider,
      {...options,acknowledgeFailure:'0x'+'f'.repeat(64)},journal),/exact finalized/);
    assert.equal(journal.transaction,tx);
    assert.equal((await acknowledgeFinalizedAuthorityFailure(provider,options,journal)).status,
      'failure-acknowledged');
    assert.equal(JSON.parse(readFileSync(journalPath,'utf8')).transaction,null);
    assert.equal(journal.reviewedAuthorityFailures[0].hash,hash);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('manual recovery broadcasts only the exact persisted signed bytes once', async () => {
  const directory=mkdtempSync(join(tmpdir(),'authority-manual-recovery-'));
  try {
    const gas=Wallet.createRandom(), args={market,pool,proposalId:'7',priceWei:'100',approved:true};
    const signature=await sign('reviewSale',args,0);
    const prepared=prepareAuthorityCall({authority,kind:'reviewSale',args,nonce:'0',deadline,signature});
    const raw=await gas.signTransaction({type:0,chainId:56,to:authority,data:prepared.data,
      nonce:0,gasLimit:650_000n,gasPrice:1_000_000_000n,value:0n});
    const hash=keccak256(raw), journalPath=join(directory,'authority.json');
    const journal={version:1,chainId:56,factory:authority,pool:authority,transactionTarget:authority,
      gasSpentWei:'0',gasReceipts:{},transaction:{phase:'signed',kind:'reviewSale',from:gas.address,
        nonce:0,to:authority,data:prepared.data,value:'0',createdAt:new Date().toISOString(),
        hash,speedUps:0,attempts:[{kind:'purchase',raw,hash,gasLimit:'650000',gasPrice:'1000000000',
          createdAt:new Date().toISOString(),broadcastCount:0}]}};
    const options={journal:journalPath,expectedHash:hash,maxGasWei:10n**18n,maxGasPrice:3n*10n**9n};
    let broadcasts=0, pending=0;
    const provider={getNetwork:async()=>({chainId:56n}),getTransactionCount:async()=>pending,
      getBalance:async()=>10n**18n,broadcastTransaction:async bytes=>{
        broadcasts++;
        assert.equal(bytes,raw);
        return {hash};
      }};
    const observed={status:'pending-not-indexed'};
    await assert.rejects(manuallyRebroadcastSigned(provider,{...options,expectedHash:'0x'+'f'.repeat(64)},
      gas,prepared,journal,observed),/exact unbroadcast/);
    assert.equal(broadcasts,0);
    pending=1;
    assert.equal((await manuallyRebroadcastSigned(provider,options,gas,prepared,journal,observed)).status,
      'nonce-or-chain-changed-before-broadcast');
    assert.equal(broadcasts,0);
    pending=0;
    assert.equal((await manuallyRebroadcastSigned(provider,options,gas,prepared,journal,observed)).status,'broadcast');
    assert.equal(broadcasts,1);
    assert.equal(JSON.parse(readFileSync(journalPath,'utf8')).transaction.phase,'broadcast');
    await assert.rejects(manuallyRebroadcastSigned(provider,options,gas,prepared,journal,observed),/exact unbroadcast/);
    assert.equal(broadcasts,1);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('admin operation requires explicit typed fields and canonical calldata', async () => {
  const inner = new Interface(['function setDepositPaused(bool)'])
    .encodeFunctionData('setDepositPaused',[true]);
  assert.throws(() => prepareAuthorityCall({authority,kind:'executeOperation',
    args:{target:market,data:inner}}),/mine/);
  const signature=await sign('executeApprovedOperation',{target:market,data:inner},0);
  const command={authority,kind:'executeApprovedOperation',args:{target:market,data:inner},
    nonce:'0',deadline,signature};
  const prepared=prepareAuthorityCall(command);
  assert.equal(prepared.signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...command,args:{...command.args,target:pool}}).signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...command,args:{...command.args,
    data:inner.slice(0,-2)+'00'}}).signer,admin.address);
  assert.throws(() => prepareAuthorityCall({...command,args:{...command.args,
    data:inner+'00'}}),/Noncanonical/);
});

test('budget purchase signatures bind portfolio, child, listing or Firsto bytes and cost ceiling', async () => {
  const official={portfolio:market,child:pool,listingId:'5',maxCost:'3000'};
  const officialSignature=await sign('buyBudgetOfficial',official,3);
  const officialCommand={authority,kind:'buyBudgetOfficial',args:official,nonce:'3',deadline,
    signature:officialSignature};
  assert.equal(prepareAuthorityCall(officialCommand).signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...officialCommand,args:{...official,maxCost:'3001'}}).signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...officialCommand,args:{...official,listingId:'6'}}).signer,admin.address);
  const firsto={portfolio:market,child:pool,encodedOrder:'0x1234abcd',maxCost:'4000'};
  const firstoSignature=await sign('buyBudgetFirsto',firsto,4);
  const firstoCommand={authority,kind:'buyBudgetFirsto',args:firsto,nonce:'4',deadline,
    signature:firstoSignature};
  assert.equal(prepareAuthorityCall(firstoCommand).signer,admin.address);
  assert.notEqual(prepareAuthorityCall({...firstoCommand,args:{...firsto,
    encodedOrder:'0x1234abce'}}).signer,admin.address);
});
