import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Transaction, Wallet, keccak256 } from 'ethers';
import { acknowledgeFinalizedAuthorityFailure, acknowledgeFinalizedAuthorityReplacement,
  acknowledgeFinalizedExpiredCancel, cancelExpiredSignedAuthority, manuallyRebroadcastAuthorityCancel,
  authorityCommandFromCalldata, authorityGasLimit, manuallyRebroadcastSigned, parseAuthorityArguments,
  prepareAuthorityCall, requireAuthorityCliIsolation, requireAuthorityPrivatePaths, runAuthorityRelay,
  requireAuthorityRecoverySendersStopped,
  requireAuthorityRecoveryUnit, AUTHORITY_RECOVERY_SENDERS, AUTHORITY_RECOVERY_UNIT,
  V4_AUTHORITY_JOURNAL, V4_KEEPER_STATE_ROOT } from './authority-relay.mjs';
import { authorityTypedAction } from '../shared/authority-typed.mjs';
import { readJournal, reconcilePending, writeJournal } from './purchase-keeper.mjs';

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
  const cancelArgs=['--journal','/tmp/authority.json','--authority',authority,
    '--expected-codehash','0x'+'a'.repeat(64),'--send','--cancel-expired-signed',
    '--expected-hash','0x'+'b'.repeat(64)];
  assert.equal(parseAuthorityArguments(cancelArgs).cancelExpiredSigned,true);
  assert.equal(parseAuthorityArguments(cancelArgs.filter(value=>value!=='--cancel-expired-signed')
    .concat('--rebroadcast-cancel')).rebroadcastCancel,true);
  assert.throws(()=>parseAuthorityArguments([...cancelArgs,'--gas-limit','21000']),/fixed Gas limit/);
  assert.throws(()=>parseAuthorityArguments([...cancelArgs,'--rebroadcast-signed']),/one Authority recovery action/);
  assert.throws(()=>parseAuthorityArguments(cancelArgs.filter(value=>value!=='--send')),/requires --send/);
  assert.equal(parseAuthorityArguments(['--journal','/tmp/authority.json','--authority',authority,
    '--expected-codehash','0x'+'a'.repeat(64),'--acknowledge-expired-cancel','0x'+'b'.repeat(64),
    '--cancel-hash','0x'+'c'.repeat(64)]).cancelHash,'0x'+'c'.repeat(64));
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
  const cancelArchive = { send: false, acknowledgeExpiredCancel: '0x'+'a'.repeat(64),
    journal: V4_AUTHORITY_JOURNAL };
  assert.doesNotThrow(() => requireAuthorityCliIsolation(send, env, V4_KEEPER_STATE_ROOT, 1001));
  assert.doesNotThrow(() => requireAuthorityCliIsolation(acknowledge,
    { ...env, CREDENTIALS_DIRECTORY: undefined }, V4_KEEPER_STATE_ROOT, 1001));
  assert.doesNotThrow(() => requireAuthorityCliIsolation(cancelArchive,
    { ...env, CREDENTIALS_DIRECTORY: undefined }, V4_KEEPER_STATE_ROOT, 1001));
  assert.throws(() => requireAuthorityCliIsolation(send,
    { ...env, CREDENTIALS_DIRECTORY: undefined }, V4_KEEPER_STATE_ROOT, 1001),
  /systemd keeper-private-key/);
  assert.throws(() => requireAuthorityCliIsolation(cancelArchive,
    { ...env, PINKUANG_KEEPER_STATE_ROOT: '/tmp/other' }, V4_KEEPER_STATE_ROOT, 1001),
  /paired v4/);
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

test('Authority recovery explicitly excludes the v4 mining sender at preflight and inside the transient unit', () => {
  const mining = 'pinkuang-v4-mining.service';
  assert(AUTHORITY_RECOVERY_SENDERS.includes(mining));
  assert.throws(() => requireAuthorityRecoverySendersStopped(unit => unit === mining ? 'active' : 'inactive'),
    /Stop and reconcile pinkuang-v4-mining/);
  for (const omitted of ['Conflicts', 'After']) {
    assert.throws(() => requireAuthorityRecoveryUnit((_unit, property) => property === 'MainPID' ? '123'
      : AUTHORITY_RECOVERY_SENDERS.filter(unit => property !== omitted || unit !== mining).join(' '), 123),
    /must conflict with and follow pinkuang-v4-mining/);
  }
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

async function expiredCancelFixture() {
  const directory=mkdtempSync(join(tmpdir(),'authority-expired-cancel-'));
  const gas=Wallet.createRandom(), args={market,pool,proposalId:'7',priceWei:'100',approved:true};
  const signature=await sign('reviewSale',args,0);
  const command={authority,kind:'reviewSale',args,nonce:'0',deadline,signature,
    expectedCodehash:keccak256('0x6000')};
  const prepared=prepareAuthorityCall(command);
  const raw=await gas.signTransaction({type:0,chainId:56,to:authority,data:prepared.data,
    nonce:0,gasLimit:650_000n,gasPrice:1_000_000_000n,value:0n});
  const originalHash=keccak256(raw).toLowerCase(),journalPath=join(directory,'authority.json');
  const journal={version:1,chainId:56,factory:authority,pool:authority,transactionTarget:authority,
    gasSpentWei:'0',gasReceipts:{},transaction:{phase:'signed',kind:'reviewSale',from:gas.address,
      nonce:0,to:authority,data:prepared.data,value:'0',createdAt:new Date().toISOString(),
      hash:originalHash,speedUps:0,attempts:[{kind:'purchase',raw,hash:originalHash,
        gasLimit:'650000',gasPrice:'1000000000',createdAt:new Date().toISOString(),broadcastCount:0}]}};
  writeJournal(journalPath,journal);
  const state={latest:0,pending:0,finalizedNonce:1,chain:56n,time:Number(deadline)+1,
    walletCode:'0x',balance:10n**18n,gasPrice:2_000_000_000n,
    transactions:new Map(),receipts:new Map(),broadcasts:[],broadcastError:false,
    blockHash:'0x'+'a'.repeat(64),canonicalHash:'0x'+'a'.repeat(64),finalized:110};
  const provider={
    getNetwork:async()=>({chainId:state.chain}),
    getTransactionCount:async(_wallet,tag)=>typeof tag==='number'?state.finalizedNonce
      :tag==='latest'?state.latest:state.pending,
    getBlock:async tag=>tag==='latest'?{number:111,timestamp:state.time,gasLimit:30_000_000n}
      :tag==='finalized'?{number:state.finalized,hash:'0x'+'b'.repeat(64)}
        :{number:tag,hash:state.canonicalHash,timestamp:state.time},
    getBlockNumber:async()=>111,
    getCode:async address=>address.toLowerCase()===gas.address.toLowerCase()?state.walletCode:'0x6000',
    call:async transaction=>{
      const iface=new Interface(['function gasWallet() view returns(address)']);
      assert.equal(transaction.to.toLowerCase(),authority.toLowerCase());
      assert.equal(transaction.data,iface.encodeFunctionData('gasWallet'));
      return iface.encodeFunctionResult('gasWallet',[gas.address]);
    },
    getBalance:async()=>state.balance,
    getFeeData:async()=>({gasPrice:state.gasPrice}),
    getTransaction:async value=>state.transactions.get(value.toLowerCase())??null,
    getTransactionReceipt:async value=>state.receipts.get(value.toLowerCase())??null,
    broadcastTransaction:async bytes=>{
      const cancelHash=keccak256(bytes).toLowerCase();state.broadcasts.push(bytes);
      const durable=JSON.parse(readFileSync(journalPath,'utf8'));
      assert.equal(durable.transaction.attempts[1].raw,bytes);
      assert.equal(durable.transaction.attempts[1].broadcastCount,state.broadcasts.length);
      if(state.broadcastError)throw Error('RPC response unknown');
      return {hash:cancelHash};
    },
  };
  const options={journal:journalPath,expectedHash:originalHash,maxGasWei:10n**18n,
    maxGasPrice:3_000_000_000n};
  return {directory,gas,command,prepared,raw,originalHash,journalPath,journal,state,provider,options,
    close(){rmSync(directory,{recursive:true,force:true});}};
}

test('the relay stays read-only on an expired signed hold until the explicit cancel flag is used',async()=>{
  const f=await expiredCancelFixture();try{
    const base={...f.options,commandObject:f.command,send:true};
    const waiting=await runAuthorityRelay(f.provider,base,f.gas);
    assert.equal(waiting.status,'signed-awaiting-manual-broadcast');
    assert.equal(f.state.broadcasts.length,0);
    const cancelled=await runAuthorityRelay(f.provider,{...base,cancelExpiredSigned:true},f.gas);
    assert.equal(cancelled.status,'cancel-broadcast');
    assert.equal(f.state.broadcasts.length,1);
  }finally{f.close();}
});

test('expired signed Authority approval creates one durable fixed-price inert cancel before broadcasting',async()=>{
  const f=await expiredCancelFixture();try{
    const result=await cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,
      {status:'pending-not-indexed'});
    assert.equal(result.status,'cancel-broadcast');
    assert.equal(result.originalHash,f.originalHash);
    assert.equal(f.state.broadcasts.length,1);
    const saved=readJournal(f.journalPath,{factory:authority,pool:authority,transactionTarget:authority});
    assert.equal(saved.transaction.phase,'broadcast');
    assert.equal(saved.transaction.attempts.length,2);
    assert.equal(saved.transaction.attempts[0].raw,f.raw);
    const cancel=Transaction.from(saved.transaction.attempts[1].raw);
    assert.equal(cancel.type,0);assert.equal(cancel.chainId,56n);
    assert.equal(cancel.from,f.gas.address);assert.equal(cancel.to,f.gas.address);
    assert.equal(cancel.nonce,0);assert.equal(cancel.data,'0x');assert.equal(cancel.value,0n);
    assert.equal(cancel.gasLimit,21_000n);assert.equal(cancel.gasPrice,2_000_000_000n);
  }finally{f.close();}
});

test('expired cancel refuses absent proof, hidden pending nonce, code, fees and prior broadcast',async()=>{
  const f=await expiredCancelFixture();try{
    const status={status:'pending-not-indexed'};
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,
      {status:'unknown-pending-replacement-manual-review'}),/unindexed/);
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,{...f.options,expectedHash:'0x'+'f'.repeat(64)},
      f.gas,f.prepared,f.journal,status),/exact sole signed/);
    f.state.time=Number(deadline);
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,status),/unproved/);
    f.state.time++;
    f.state.pending=1;
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,status),/unproved/);
    f.state.pending=0;f.state.transactions.set(f.originalHash,{hash:f.originalHash});
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,status),/unproved/);
    f.state.transactions.clear();f.state.walletCode='0x6000';
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,status),/unproved/);
    f.state.walletCode='0x';f.state.gasPrice=4_000_000_000n;
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,status),/ceiling/);
    f.state.gasPrice=2_000_000_000n;f.state.balance=1n;
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,status),/budget or wallet balance/);
    f.state.balance=10n**18n;
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,
      {...f.options,maxGasWei:1n},f.gas,f.prepared,f.journal,status),/budget or wallet balance/);
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,
      {...f.options,maxGasPrice:1_000_000_000n},f.gas,f.prepared,f.journal,status),/ceiling/);
    f.journal.transaction.attempts[0].broadcastCount=1;
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,status),/never-broadcast/);
    assert.equal(f.state.broadcasts.length,0);
    assert.equal(JSON.parse(readFileSync(f.journalPath,'utf8')).transaction.attempts.length,1);
  }finally{f.close();}
});

test('an original transaction appearing after cancel signing blocks broadcast and preserves both bytes',async()=>{
  const f=await expiredCancelFixture();try{
    const signer={address:f.gas.address,signTransaction:async envelope=>{
      const bytes=await f.gas.signTransaction(envelope);
      f.state.transactions.set(f.originalHash,{hash:f.originalHash});
      return bytes;
    }};
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,signer,f.prepared,f.journal,
      {status:'pending-not-indexed'}),/unproved/);
    assert.equal(f.state.broadcasts.length,0);
    const saved=readJournal(f.journalPath,{factory:authority,pool:authority,transactionTarget:authority});
    assert.equal(saved.transaction.phase,'signed');
    assert.equal(saved.transaction.attempts.length,2);
    assert.equal(saved.transaction.attempts[1].broadcastCount,0);
    assert.equal(saved.transaction.attempts[0].raw,f.raw);
  }finally{f.close();}
});

test('post-sign nonce change leaves durable cancel bytes; explicit replay never re-signs',async()=>{
  const f=await expiredCancelFixture();try{
    let signatures=0;
    const signer={address:f.gas.address,signTransaction:async envelope=>{
      signatures++;const bytes=await f.gas.signTransaction(envelope);f.state.pending=1;return bytes;
    }};
    await assert.rejects(cancelExpiredSignedAuthority(f.provider,f.options,signer,f.prepared,f.journal,
      {status:'pending-not-indexed'}),/unproved/);
    assert.equal(signatures,1);assert.equal(f.state.broadcasts.length,0);
    const saved=readJournal(f.journalPath,{factory:authority,pool:authority,transactionTarget:authority});
    assert.equal(saved.transaction.phase,'signed');assert.equal(saved.transaction.attempts[1].broadcastCount,0);
    f.state.pending=0;
    const replay={...f.options,expectedHash:saved.transaction.attempts[1].hash};
    f.state.broadcastError=true;
    assert.equal((await manuallyRebroadcastAuthorityCancel(f.provider,replay,signer,f.prepared,saved,
      {status:'pending-not-indexed'})).status,'cancel-broadcast-result-unknown');
    assert.equal(signatures,1);assert.equal(saved.transaction.attempts[1].broadcastCount,1);
    f.state.broadcastError=false;
    assert.equal((await manuallyRebroadcastAuthorityCancel(f.provider,replay,signer,f.prepared,saved,
      {status:'pending-not-indexed'})).status,'cancel-broadcast');
    assert.equal(signatures,1);assert.equal(f.state.broadcasts.length,2);
    assert.equal(f.state.broadcasts[0],f.state.broadcasts[1]);
  }finally{f.close();}
});

test('finalized exact cancel is accounted once and only hash-pinned archive releases the wallet',async()=>{
  const f=await expiredCancelFixture();try{
    await cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,
      {status:'pending-not-indexed'});
    const tx=f.journal.transaction,raw=tx.attempts[1].raw,cancel=Transaction.from(raw);
    const onchain={hash:cancel.hash,from:f.gas.address,to:f.gas.address,nonce:0,chainId:56n,type:0,
      data:'0x',value:0n,gasLimit:21_000n,gasPrice:cancel.gasPrice,
      blockNumber:100,blockHash:f.state.blockHash};
    const receipt={hash:cancel.hash,from:f.gas.address,to:f.gas.address,status:1,
      gasUsed:21_000n,fee:21_000n*cancel.gasPrice,blockNumber:100,blockHash:f.state.blockHash};
    f.state.transactions.set(cancel.hash.toLowerCase(),onchain);
    f.state.receipts.set(cancel.hash.toLowerCase(),receipt);
    f.state.latest=1;f.state.pending=1;
    const journalOptions={factory:authority,pool:authority,transactionTarget:authority,journal:f.journalPath};
    assert.equal((await reconcilePending(f.provider,journalOptions,f.journal)).status,'cancelled');
    assert.equal(f.journal.gasSpentWei,receipt.fee.toString());
    assert.equal(await reconcilePending(f.provider,journalOptions,f.journal),null);
    const archive={journal:f.journalPath,acknowledgeExpiredCancel:f.originalHash,cancelHash:cancel.hash.toLowerCase()};
    await assert.rejects(acknowledgeFinalizedExpiredCancel(f.provider,
      {...archive,cancelHash:'0x'+'f'.repeat(64)},f.journal),/exact finalized/);
    f.state.canonicalHash='0x'+'c'.repeat(64);
    await assert.rejects(acknowledgeFinalizedExpiredCancel(f.provider,archive,f.journal),/canonical/);
    f.state.canonicalHash=f.state.blockHash;
    f.state.time=Number(deadline);
    await assert.rejects(acknowledgeFinalizedExpiredCancel(f.provider,archive,f.journal),/canonical/);
    f.state.time++;
    f.state.receipts.set(f.originalHash,{hash:f.originalHash});
    await assert.rejects(acknowledgeFinalizedExpiredCancel(f.provider,archive,f.journal),/canonical/);
    f.state.receipts.delete(f.originalHash);
    const result=await runAuthorityRelay(f.provider,{...archive,recoveryAuthority:authority,
      recoveryCodehash:keccak256('0x6000')});
    assert.equal(result.status,'expired-cancel-acknowledged');
    const saved=JSON.parse(readFileSync(f.journalPath,'utf8'));
    assert.equal(saved.transaction,null);
    assert.equal(saved.reviewedAuthorityCancels[0].original.attempts[0].raw,f.raw);
    assert.equal(saved.reviewedAuthorityCancels[0].original.attempts[1].raw,raw);
    assert.equal(saved.gasSpentWei,receipt.fee.toString());
  }finally{f.close();}
});

test('an original transaction winning the cancellation race remains an Authority failure, not a cancel',async()=>{
  const f=await expiredCancelFixture();try{
    await cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,
      {status:'pending-not-indexed'});
    const original=Transaction.from(f.raw),fee=65_000n*original.gasPrice;
    f.state.transactions.set(f.originalHash,{hash:f.originalHash,from:f.gas.address,to:authority,
      nonce:0,chainId:56n,type:0,data:f.prepared.data,value:0n,gasLimit:original.gasLimit,
      gasPrice:original.gasPrice,blockNumber:100,blockHash:f.state.blockHash});
    f.state.receipts.set(f.originalHash,{hash:f.originalHash,from:f.gas.address,to:authority,
      status:0,gasUsed:65_000n,fee,blockNumber:100,blockHash:f.state.blockHash});
    f.state.latest=1;f.state.pending=1;
    const journalOptions={factory:authority,pool:authority,transactionTarget:authority,journal:f.journalPath};
    assert.equal((await reconcilePending(f.provider,journalOptions,f.journal)).status,'cancel-reverted');
    assert.equal(f.journal.transaction.hash,f.originalHash);
    await assert.rejects(acknowledgeFinalizedExpiredCancel(f.provider,
      {journal:f.journalPath,acknowledgeExpiredCancel:f.originalHash,
        cancelHash:f.journal.transaction.attempts[1].hash},f.journal),/exact finalized/);
    assert.equal((await acknowledgeFinalizedAuthorityFailure(f.provider,
      {journal:f.journalPath,acknowledgeFailure:f.originalHash},f.journal)).status,'failure-acknowledged');
    assert.equal(JSON.parse(readFileSync(f.journalPath,'utf8')).transaction,null);
    assert.equal(f.journal.gasSpentWei,fee.toString());
  }finally{f.close();}
});

test('a reverted cancel or unknown same-nonce replacement never clears the Authority hold',async()=>{
  for(const kind of ['cancel-reverted','unknown-replacement']){
    const f=await expiredCancelFixture();try{
      await cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,
        {status:'pending-not-indexed'});
      const cancel=Transaction.from(f.journal.transaction.attempts[1].raw);
      if(kind==='cancel-reverted'){
        f.state.transactions.set(cancel.hash.toLowerCase(),{hash:cancel.hash,from:f.gas.address,
          to:f.gas.address,nonce:0,chainId:56n,type:0,data:'0x',value:0n,
          gasLimit:21_000n,gasPrice:cancel.gasPrice,blockNumber:100,blockHash:f.state.blockHash});
        f.state.receipts.set(cancel.hash.toLowerCase(),{hash:cancel.hash,from:f.gas.address,
          to:f.gas.address,status:0,gasUsed:21_000n,fee:21_000n*cancel.gasPrice,
          blockNumber:100,blockHash:f.state.blockHash});
      }
      f.state.latest=1;f.state.pending=1;
      const journalOptions={factory:authority,pool:authority,transactionTarget:authority,journal:f.journalPath};
      const result=await reconcilePending(f.provider,journalOptions,f.journal);
      assert.equal(result.status,kind==='cancel-reverted'?'cancel-reverted':'unknown-wallet-nonce-manual-review');
      assert.equal(f.journal.transaction.phase,kind==='cancel-reverted'?'cancel-reverted':'broadcast');
      await assert.rejects(acknowledgeFinalizedExpiredCancel(f.provider,
        {journal:f.journalPath,acknowledgeExpiredCancel:f.originalHash,cancelHash:cancel.hash.toLowerCase()},
        f.journal),/exact finalized/);
      assert.notEqual(JSON.parse(readFileSync(f.journalPath,'utf8')).transaction,null);
      assert.equal(f.state.broadcasts.length,1);
    }finally{f.close();}
  }
});

test('a different finalized nonce winner needs explicit replacement review and archives both cancel bytes',async()=>{
  const f=await expiredCancelFixture();try{
    await cancelExpiredSignedAuthority(f.provider,f.options,f.gas,f.prepared,f.journal,
      {status:'pending-not-indexed'});
    const cancelHash=f.journal.transaction.attempts[1].hash;
    const replacementRaw=await f.gas.signTransaction({type:0,chainId:56,to:pool,data:'0x',
      nonce:0,gasLimit:21_000n,gasPrice:2_000_000_000n,value:0n});
    const replacementHash=keccak256(replacementRaw).toLowerCase();
    f.state.transactions.set(replacementHash,{hash:replacementHash,from:f.gas.address,to:pool,
      nonce:0,chainId:56n,data:'0x',value:0n});
    f.state.receipts.set(replacementHash,{hash:replacementHash,from:f.gas.address,to:pool,
      status:1,blockNumber:100,blockHash:f.state.blockHash});
    f.state.latest=1;f.state.pending=1;
    const journalOptions={factory:authority,pool:authority,transactionTarget:authority,journal:f.journalPath};
    assert.equal((await reconcilePending(f.provider,journalOptions,f.journal)).status,
      'unknown-wallet-nonce-manual-review');
    assert.notEqual(f.journal.transaction,null);
    assert.equal((await acknowledgeFinalizedAuthorityReplacement(f.provider,
      {journal:f.journalPath,acknowledgeReplacement:cancelHash,replacementHash},f.journal)).status,
    'replacement-acknowledged');
    const saved=JSON.parse(readFileSync(f.journalPath,'utf8'));
    assert.equal(saved.transaction,null);
    assert.equal(saved.replacedAuthorityTransactions[0].original.attempts[0].raw,f.raw);
    assert.equal(saved.replacedAuthorityTransactions[0].original.attempts[1].hash,cancelHash);
  }finally{f.close();}
});
