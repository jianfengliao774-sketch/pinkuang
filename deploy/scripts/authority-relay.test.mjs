import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Transaction, Wallet, keccak256 } from 'ethers';
import { acknowledgeFinalizedAuthorityFailure, acknowledgeFinalizedAuthorityReplacement,
  authorityCommandFromCalldata, authorityGasLimit, manuallyRebroadcastSigned, parseAuthorityArguments,
  prepareAuthorityCall, requireAuthorityCliIsolation, requireAuthorityPrivatePaths,
  requireAuthorityRecoverySendersStopped,
  requireAuthorityRecoveryUnit, AUTHORITY_RECOVERY_SENDERS, AUTHORITY_RECOVERY_UNIT,
  V4_AUTHORITY_JOURNAL, V4_KEEPER_STATE_ROOT } from './authority-relay.mjs';
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
  assert.equal(prepareAuthorityCall(authorityCommandFromCalldata(authority, prepared.data)).data, prepared.data);
  assert.equal(prepareAuthorityCall({...command,expectedCodehash:'0x'+'ab'.repeat(32)}).expectedCodehash,
    '0x'+'ab'.repeat(32));
  assert.throws(()=>prepareAuthorityCall({...command,expectedCodehash:'0x1234'}),/codehash/);
  const changed = prepareAuthorityCall({ ...command, args: { ...args, priceWei: '1' } });
  assert.notEqual(changed.signer, admin.address);
  assert.notEqual(prepareAuthorityCall({ ...command, authority: market }).signer, admin.address);
  for (const approved of ['true', 'false', 1, 0, null]) {
    assert.throws(() => prepareAuthorityCall({ ...command, args: { ...args, approved } }), /boolean/);
  }
  const childArgs = { portfolio: pool, proposalId: '7', approved: true };
  const childSignature = await sign('reviewChildSale', childArgs, 0);
  const child = { authority, kind: 'reviewChildSale', args: childArgs, nonce: '0', deadline,
    signature: childSignature };
  assert.equal(prepareAuthorityCall(child).signer, admin.address);
  assert.throws(() => prepareAuthorityCall({ ...child,
    args: { ...childArgs, approved: 'true' } }), /boolean/);
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
  const recovery = parseAuthorityArguments(['--journal', '/tmp/authority.json', '--authority', authority,
    '--expected-codehash', '0x'+'a'.repeat(64), '--send', '--rebroadcast-signed',
    '--expected-hash', '0x'+'b'.repeat(64)]);
  assert.equal(recovery.command, undefined);
  assert.equal(recovery.recoveryAuthority, authority);
  assert.throws(() => parseAuthorityArguments(['--journal', '/tmp/authority.json', '--send',
    '--rebroadcast-signed', '--expected-hash', '0x'+'b'.repeat(64)]), /--authority and --expected-codehash/);
  assert.throws(() => parseAuthorityArguments(['--journal', '/tmp/authority.json', '--authority', authority,
    '--expected-codehash', '0x'+'a'.repeat(64), '--acknowledge-replacement', '0x'+'b'.repeat(64)]),
  /replacement hashes/);
  assert.throws(() => prepareAuthorityCall({ authority, kind: 'executeOperation', args: { target: pool, data: '0x' } }), /mine/);
});

test('mutating Authority CLI is confined to the v4 journal and credential domain', () => {
  const env = { PINKUANG_KEEPER_STATE_ROOT: V4_KEEPER_STATE_ROOT,
    AUTHORITY_RELAY_JOURNAL: V4_AUTHORITY_JOURNAL,
    BEMINE_V2_GAS_SENDER_DRAINED: '1', CREDENTIALS_DIRECTORY: '/run/credentials/recovery.service',
    BEMINE_V4_AUTHORITY_PREFLIGHT_AT: '1000' };
  const send = { send: true, journal: V4_AUTHORITY_JOURNAL };
  const acknowledge = { send: false, acknowledgeFailure: '0x' + 'a'.repeat(64),
    journal: V4_AUTHORITY_JOURNAL };
  assert.doesNotThrow(() => requireAuthorityCliIsolation(send, env, V4_KEEPER_STATE_ROOT, 1001));
  assert.doesNotThrow(() => requireAuthorityCliIsolation(acknowledge,
    { ...env, CREDENTIALS_DIRECTORY: undefined }, V4_KEEPER_STATE_ROOT, 1001));
  assert.doesNotThrow(() => requireAuthorityCliIsolation({ send: false, journal: '/tmp/read-only.json' }, {}, '/tmp'));
  assert.throws(() => requireAuthorityCliIsolation(send,
    { ...env, PINKUANG_KEEPER_STATE_ROOT: undefined }, V4_KEEPER_STATE_ROOT), /paired v4/);
  assert.throws(() => requireAuthorityCliIsolation(send, env, '/tmp/legacy-keeper'), /paired v4/);
  assert.throws(() => requireAuthorityCliIsolation({ ...send, journal: '/tmp/v2/authority.json' },
    env, V4_KEEPER_STATE_ROOT), /paired v4/);
  assert.throws(() => requireAuthorityCliIsolation(send,
    { ...env, AUTHORITY_RELAY_JOURNAL: '/tmp/legacy.json' }, V4_KEEPER_STATE_ROOT), /paired v4/);
  assert.throws(() => requireAuthorityCliIsolation(send,
    { ...env, BEMINE_V2_GAS_SENDER_DRAINED: '0' }, V4_KEEPER_STATE_ROOT), /drained and disabled v2/);
  assert.throws(() => requireAuthorityCliIsolation(send,
    { ...env, CREDENTIALS_DIRECTORY: undefined }, V4_KEEPER_STATE_ROOT), /systemd keeper-private-key/);
  assert.throws(() => requireAuthorityCliIsolation(send,
    { ...env, KEEPER_PRIVATE_KEY: '0x' + '11'.repeat(32) }, V4_KEEPER_STATE_ROOT), /forbids private keys/);
  assert.throws(() => requireAuthorityCliIsolation(acknowledge,
    { ...env, KEEPER_PRIVATE_KEY_FILE: '/tmp/key' }, V4_KEEPER_STATE_ROOT), /forbids private keys/);
  assert.throws(() => requireAuthorityCliIsolation(send,
    { ...env, BEMINE_V4_AUTHORITY_PREFLIGHT_AT: undefined }, V4_KEEPER_STATE_ROOT, 1001), /pre-launch/);
  assert.throws(() => requireAuthorityCliIsolation(send, env, V4_KEEPER_STATE_ROOT, 31_001), /pre-launch/);
});

test('Authority recovery fails closed if any v2 or v4 sender is active or unverified', () => {
  const observed = [];
  requireAuthorityRecoverySendersStopped(unit => { observed.push(unit); return 'inactive'; });
  assert.deepEqual(observed, AUTHORITY_RECOVERY_SENDERS);
  for (const blocked of AUTHORITY_RECOVERY_SENDERS) {
    assert.throws(() => requireAuthorityRecoverySendersStopped(unit =>
      unit === blocked ? 'active' : 'inactive'), new RegExp(`Stop and reconcile ${blocked.replaceAll('.', '\\.')} `));
  }
  assert.throws(() => requireAuthorityRecoverySendersStopped(() => 'activating'), /Stop and reconcile/);
  assert.throws(() => requireAuthorityRecoverySendersStopped(() => { throw new Error('systemctl unavailable'); }),
    /systemctl unavailable/);
});

test('mutating CLI requires its own systemd unit with reciprocal sender exclusion', () => {
  const values = { MainPID: '123', Conflicts: AUTHORITY_RECOVERY_SENDERS.join(' '),
    After: AUTHORITY_RECOVERY_SENDERS.join(' ') };
  const query = (unit, property) => {
    assert.equal(unit, AUTHORITY_RECOVERY_UNIT);
    return values[property];
  };
  assert.doesNotThrow(() => requireAuthorityRecoveryUnit(query, 123));
  assert.throws(() => requireAuthorityRecoveryUnit(query, 124), /dedicated systemd transient unit/);
  assert.throws(() => requireAuthorityRecoveryUnit((unit, property) =>
    property === 'Conflicts' ? '' : query(unit, property), 123), /must conflict/);
  assert.throws(() => requireAuthorityRecoveryUnit((unit, property) =>
    property === 'After' ? '' : query(unit, property), 123), /must conflict/);
});

test('Authority recovery refuses links or public permissions in its private path chain', () => {
  const base = mkdtempSync(join(tmpdir(), 'authority-cli-paths-'));
  try {
    const root = join(base, 'state'), keeper = join(root, 'keeper');
    const authorityDir = join(root, 'authority'), journal = join(authorityDir, 'authority.json');
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(keeper, { mode: 0o700 });
    mkdirSync(authorityDir, { mode: 0o700 });
    writeFileSync(journal, '{}', { mode: 0o600 });
    const paths = [[root, 'directory'], [keeper, 'directory'], [authorityDir, 'directory'], [journal, 'file']];
    assert.doesNotThrow(() => requireAuthorityPrivatePaths(paths));
    chmodSync(authorityDir, 0o755);
    assert.throws(() => requireAuthorityPrivatePaths(paths), /private regular directory/);
    chmodSync(authorityDir, 0o700);
    const link = join(base, 'legacy-keeper');
    symlinkSync(keeper, link);
    assert.throws(() => requireAuthorityPrivatePaths([[link, 'directory']]), /private regular directory/);
  } finally { rmSync(base, { recursive: true, force: true }); }
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
    let broadcasts=0, pending=0, chainTime=1_000;
    const provider={getNetwork:async()=>({chainId:56n}),getTransactionCount:async()=>pending,
      getBlock:async()=>({timestamp:chainTime}),getBalance:async()=>10n**18n,broadcastTransaction:async bytes=>{
        broadcasts++;
        assert.equal(bytes,raw);
        return {hash};
      }};
    const observed={status:'pending-not-indexed'};
    await assert.rejects(manuallyRebroadcastSigned(provider,{...options,expectedHash:'0x'+'f'.repeat(64)},
      gas,prepared,journal,observed),/exact unbroadcast/);
    assert.equal(broadcasts,0);
    chainTime=Number(deadline);
    assert.equal((await manuallyRebroadcastSigned(provider,options,gas,prepared,journal,observed)).status,
      'signed-admin-authorization-expired-review-required');
    assert.equal(journal.transaction.attempts[0].broadcastCount,0);
    assert.equal(broadcasts,0);
    chainTime=1_000;
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

test('only a different canonical finalized transaction at the original wallet nonce releases a signed relay', async () => {
  const directory=mkdtempSync(join(tmpdir(),'authority-replacement-review-'));
  try {
    const gas=Wallet.createRandom(), args={market,pool,proposalId:'7',priceWei:'100',approved:true};
    const signature=await sign('reviewSale',args,0);
    const prepared=prepareAuthorityCall({authority,kind:'reviewSale',args,nonce:'0',deadline,signature});
    const raw=await gas.signTransaction({type:0,chainId:56,to:authority,data:prepared.data,
      nonce:0,gasLimit:650_000n,gasPrice:1_000_000_000n,value:0n});
    const hash=keccak256(raw), blockHash='0x'+'c'.repeat(64);
    const replacementRaw=await gas.signTransaction({type:0,chainId:56,to:pool,data:'0x',
      nonce:0,gasLimit:21_000n,gasPrice:2_000_000_000n,value:0n});
    const replacement=Transaction.from(replacementRaw), replacementHash=replacement.hash.toLowerCase();
    const journalPath=join(directory,'authority.json');
    const tx={phase:'signed',kind:'reviewSale',from:gas.address,nonce:0,to:authority,
      data:prepared.data,value:'0',hash,speedUps:0,attempts:[{kind:'purchase',raw,hash,
        gasLimit:'650000',gasPrice:'1000000000',broadcastCount:0}]};
    const journal={version:1,chainId:56,factory:authority,pool:authority,
      transactionTarget:authority,transaction:tx,gasSpentWei:'0',gasReceipts:{}};
    const receipt={hash:replacementHash,from:gas.address,to:pool,blockNumber:100,blockHash,status:1};
    let finalizedNumber=99, originalReceipt=null, finalNonce=1;
    const provider={getNetwork:async()=>({chainId:56n}),
      getTransaction:async()=>replacement,
      getTransactionReceipt:async lookup=>lookup.toLowerCase()===hash.toLowerCase()?originalReceipt:receipt,
      getBlock:async tag=>tag==='finalized'?{number:finalizedNumber,hash:'0x'+'d'.repeat(64)}
        :{number:100,hash:blockHash},
      getTransactionCount:async (_address, tag)=>{ assert.equal(tag,finalizedNumber); return finalNonce; }};
    const options={journal:journalPath,acknowledgeReplacement:hash.toLowerCase(),replacementHash};
    await assert.rejects(acknowledgeFinalizedAuthorityReplacement(provider,options,journal),/BSC-finalized/);
    assert.equal(journal.transaction,tx);
    finalizedNumber=110;
    finalNonce=0;
    await assert.rejects(acknowledgeFinalizedAuthorityReplacement(provider,options,journal),/finalized wallet nonce/);
    assert.equal(journal.transaction,tx);
    finalNonce=1;
    originalReceipt={hash,from:gas.address,to:authority,blockNumber:100,blockHash,status:1};
    await assert.rejects(acknowledgeFinalizedAuthorityReplacement(provider,options,journal),/BSC-finalized/);
    assert.equal(journal.transaction,tx);
    originalReceipt=null;
    assert.equal((await acknowledgeFinalizedAuthorityReplacement(provider,options,journal)).status,
      'replacement-acknowledged');
    const saved=JSON.parse(readFileSync(journalPath,'utf8'));
    assert.equal(saved.transaction,null);
    assert.equal(saved.replacedAuthorityTransactions[0].original.attempts[0].raw,raw);
    assert.equal(saved.replacedAuthorityTransactions[0].replacementHash,replacementHash);
  } finally { rmSync(directory,{recursive:true,force:true}); }
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
