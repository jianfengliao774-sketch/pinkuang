import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeploymentAccount } from '../lib/deployment-account.mjs';
import { parseProductRoute } from '../lib/live-view.mjs';
const hash=n=>'0x'+n.repeat(64),from='0x042B23288E2316DFb6503488292FD0Ad2F811Ae7';
const manifest={deployment:{txHash:hash('1'),blockHash:hash('2'),blockNumber:90}};
function fixture(change={}){
 const tx={hash:hash('1'),from,chainId:'0x38',blockNumber:'0x5a',blockHash:hash('2'),...change.tx};
 const receipt={transactionHash:hash('1'),from,status:'0x1',blockNumber:'0x5a',blockHash:hash('2'),...change.receipt};
 const block={number:'0x5a',hash:hash('2'),...change.block};let calls=0;
 return {request:async({method})=>{
  if(method==='eth_chainId')return change.chain||'0x38';
  if(method==='eth_blockNumber')return change.head||'0x66';
  if(method==='eth_getTransactionByHash')return tx;
  if(method==='eth_getTransactionReceipt')return receipt;
  if(method==='eth_getBlockByNumber')return change.reorg&&calls++?{...block,hash:hash('3')}:block;
  throw Error('Signing or unexpected RPC is forbidden');
 }};
}
test('deployment account derives from successful release-pinned transaction, independently of operator roles',async()=>{
 assert.equal(await readDeploymentAccount(fixture(),manifest),from);
});
test('missing, changed, failed, wrong-chain and unconfirmed deployment receipts do not disclose a deployer identity',async()=>{
 for(const change of [{tx:{hash:hash('3')}},{tx:{from:'0x0000000000000000000000000000000000000001'}},
  {tx:{chainId:'0x1'}},{receipt:{status:'0x0'}},{receipt:{transactionHash:hash('3')}},{receipt:{blockHash:hash('3')}},
  {block:{hash:hash('3')}},{head:'0x65'},{chain:'0x1'},{reorg:true}])
  await assert.rejects(readDeploymentAccount(fixture(change),manifest));
 await assert.rejects(readDeploymentAccount(fixture(),{deployment:{...manifest.deployment,txHash:null}}));
});
test('public hash routes do not expose a deployment form',()=>{
 for(const route of ['#deploy','#deployment','#admin'])assert.equal(parseProductRoute(route).route,'home');
});
