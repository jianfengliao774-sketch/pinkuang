import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash}from 'node:crypto';
import {AbiCoder,Interface,ZeroHash,keccak256}from 'ethers';
import {validateGovernance24PendingInventory}from './capture-governance24-review.mjs';
const hash=`0x${'11'.repeat(32)}`,timelockAddress='0x0000000000000000000000000000000000001122';
const fixture=()=>({schemaVersion:2,readOnly:true,chainId:56,timelock:timelockAddress,scannedFromBlock:100,
  anchor:{blockNumber:200,blockHash:hash,timestamp:500000},genesisAnchor:{number:'0x64',hash},
  ranges:[{fromBlock:100,toBlock:150,eventCount:0},{fromBlock:151,toBlock:200,eventCount:0}],logs:[],operations:[],blocks:{},transactions:{},receipts:{}});
const check=value=>{const bytes=Buffer.from(JSON.stringify(value));return validateGovernance24PendingInventory(bytes,
  {trustedFileSha256:createHash('sha256').update(bytes).digest('hex'),trustedFileKeccak256:keccak256(bytes),timelockAddress});};
test('complete original inventory requires independent file pins and continuous birth-to-anchor ranges',()=>{
  const value=fixture(),result=check(value);assert.equal(result.evidence.scannedFromBlock,100);assert.equal(result.evidence.throughBlock,200);
  assert.equal(result.pending.length,0);
  assert.throws(()=>validateGovernance24PendingInventory(Buffer.from(JSON.stringify(value)),{trustedFileSha256:'00'.repeat(32),trustedFileKeccak256:hash,timelockAddress}),/file pins/);
});
const withSchedule=()=>{
  const x=fixture(),target='0x0000000000000000000000000000000000003344',salt=`0x${'44'.repeat(32)}`,transactionHash=`0x${'22'.repeat(32)}`;
  const operationId=keccak256(AbiCoder.defaultAbiCoder().encode(['address','uint256','bytes','bytes32','bytes32'],[target,'0','0x1234',ZeroHash,salt]));
  const abi=new Interface(['event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)']);
  const encoded=abi.encodeEventLog(abi.getEvent('CallScheduled'),[operationId,0,target,0,'0x1234',ZeroHash,172800]);
  const log={address:timelockAddress,transactionHash,blockHash:hash,blockNumber:'0x78',logIndex:'0x0',...encoded};
  x.logs=[log];x.ranges[0].eventCount=1;x.blocks['0x78']={number:'0x78',hash,transactions:[transactionHash]};
  x.transactions[transactionHash]={hash:transactionHash,from:target,to:timelockAddress,chainId:'0x38',blockHash:hash,blockNumber:'0x78',transactionIndex:'0x0'};
  x.receipts[transactionHash]={transactionHash,from:target,to:timelockAddress,status:'0x1',blockHash:hash,blockNumber:'0x78',transactionIndex:'0x0',logs:[structuredClone(log)]};
  x.operations=[{operationId,timestamp:'173000',pending:true,currentSchedule:{method:'schedule',targets:[target],values:['0'],payloads:['0x1234'],
    salt,predecessor:ZeroHash,transactionHash,delaySeconds:'172800',originalEta:'173000',operationId}}];return x;
};
test('original pending schedule is reconstructed from exact args and observed canonical receipt',()=>{
  const x=withSchedule(),r=check(x);assert.equal(r.pending[0].operationId,x.operations[0].operationId);assert.equal(r.pending[0].target,x.operations[0].currentSchedule.targets[0]);
});
for(const[name,mutate]of[['missing observed operation',x=>{x.operations=[];}],['duplicate operation',x=>{x.operations.push(structuredClone(x.operations[0]));}],
  ['falsely nonpending timestamp',x=>{x.operations[0].pending=false;}],['different original arguments',x=>{x.operations[0].currentSchedule.payloads=['0xabcd'];}],
  ['removed event',x=>{x.logs[0].removed=true;}],['different receipt event',x=>{Object.values(x.receipts)[0].logs[0].data='0x';}],
  ['noncanonical transaction index',x=>{Object.values(x.receipts)[0].transactionIndex='0x1';}],
  ['different event block',x=>{x.logs[0].blockNumber='0x79';}],['different scanned range count',x=>{x.logs[0].blockNumber='0xb4';}]
])test(`formal capture rejects ${name}`,()=>{const x=withSchedule();mutate(x);assert.throws(()=>check(x));});
for(const [name,mutate]of[['gap',x=>{x.ranges[1].fromBlock=152;}],['overlap',x=>{x.ranges[1].fromBlock=150;}],
  ['truncated final range',x=>{x.ranges[1].toBlock=199;}],['missing birth',x=>{x.genesisAnchor.number='0x65';}],
  ['event-count mismatch',x=>{x.ranges[1].eventCount=1;}],['wrong chain',x=>{x.chainId=1;}]])test(`formal capture rejects ${name}`,()=>{
  const value=fixture();mutate(value);assert.throws(()=>check(value));
});
