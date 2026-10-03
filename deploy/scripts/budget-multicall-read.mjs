import { Interface, getAddress, keccak256, toQuantity } from 'ethers';

export const MULTICALL_ADDRESS='0xcA11bde05977b3631167028862bE2a173976CA11';
// mds1/multicall3 b667d67ecfa5361a81e8f110234ce242613b0012 canonical deployment transaction;
// BSC runtime matches its 3,808-byte deployed code exactly. This module only performs eth_call.
export const MULTICALL_RUNTIME_HASH='0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';
export const MAX_READ_BATCH=256;
export const MAX_READ_CONCURRENCY=8;
export const MAX_AGGREGATE_RETURN_BYTES=1024*1024;
const aggregate=new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] results)',
  'function getBlockNumber() view returns(uint256)']);
const need=(condition,message)=>{if(!condition)throw Error(message);};

/** Fixed, bytecode-pinned aggregation of public views, with no wallet, signer or write method. */
export async function createBudgetMulticallReader({provider,blockNumber,signal}){
  need(Number.isSafeInteger(blockNumber)&&blockNumber>0,'Invalid aggregate read block.');
  const tag=toQuantity(blockNumber),active=()=>need(!signal?.aborted,'Budget aggregate read aborted.');
  active();
  const [chain,code]=await Promise.all([provider.send('eth_chainId',[]),provider.send('eth_getCode',[MULTICALL_ADDRESS,tag])]);
  need(BigInt(chain)===56n&&keccak256(code)===MULTICALL_RUNTIME_HASH,'BSC read aggregator bytecode is not reviewed.');
  active();let pending=[],scheduled=false,running=0;const waiting=[];
  const schedule=work=>new Promise((resolve,reject)=>{
    waiting.push({work,resolve,reject});pump();
  });
  function pump(){while(running<MAX_READ_CONCURRENCY&&waiting.length){const next=waiting.shift();running++;
    Promise.resolve().then(()=>{active();return next.work();}).then(next.resolve,next.reject).finally(()=>{running--;pump();});}}
  async function batch(rows){
    active();const requests=rows.map(row=>({target:row.to,allowFailure:false,callData:row.data}));
    requests.push({target:MULTICALL_ADDRESS,allowFailure:false,callData:aggregate.encodeFunctionData('getBlockNumber')});
    const data=await provider.send('eth_call',[{to:MULTICALL_ADDRESS,data:aggregate.encodeFunctionData('aggregate3',[requests])},tag]);
    active();need(typeof data==='string'&&data.length<=2+MAX_AGGREGATE_RETURN_BYTES*2,'Aggregate response exceeds read limit.');
    const [results]=aggregate.decodeFunctionResult('aggregate3',data);
    need(results.length===requests.length&&results.every(row=>row.success),'Incomplete aggregate read.');
    need(aggregate.decodeFunctionResult('getBlockNumber',results.at(-1).returnData)[0]===BigInt(blockNumber),'Aggregate returned a different block.');
    return rows.map((row,index)=>row.iface.decodeFunctionResult(row.method,results[index].returnData));
  }
  function flush(){scheduled=false;const rows=pending;pending=[];
    for(let start=0;start<rows.length;start+=MAX_READ_BATCH){const slice=rows.slice(start,start+MAX_READ_BATCH);
      schedule(()=>batch(slice)).then(results=>slice.forEach((row,index)=>row.resolve(results[index])),error=>slice.forEach(row=>row.reject(error)));}}
  return Object.freeze({call(to,iface,method,args=[]){
    active();const data=iface.encodeFunctionData(method,args);
    need(data.length<=258&&pending.length<MAX_READ_BATCH*MAX_READ_CONCURRENCY*2,'Aggregate request exceeds read limit.');
    return new Promise((resolve,reject)=>{pending.push({to:getAddress(to),iface,method,data,resolve,reject});if(!scheduled){scheduled=true;queueMicrotask(flush);}});
  }});
}
