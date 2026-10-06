/** Read-only mainnet/drain verification. Run on the host after retiring old senders. */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const runtime=process.argv[2];
if(!/^\/srv\/pinkuang-v5\/releases\/v5-[a-z0-9-]+$/.test(runtime??''))throw Error('Explicit v5 runtime required.');
const {JsonRpcProvider,FetchRequest}=await import(pathToFileURL(runtime+'/node_modules/ethers/lib.esm/index.js'));
const {productGraphConfiguration,verifyProductGraph}=await import(pathToFileURL(runtime+'/server/product-graph.mjs'));
const env=Object.fromEntries(readFileSync('/etc/pinkuang-v5/rpc.env','utf8').split('\n').filter(s=>s.includes('=')&&!s.startsWith('#')).map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
const rpc=env.DEPLOYMENT_JOURNAL_RPC_URL;
class SerialProvider extends JsonRpcProvider { queue=Promise.resolve();_send(p){const next=this.queue.then(()=>super._send(p));this.queue=next.catch(()=>{});return next;} }
const request=new FetchRequest(rpc);request.timeout=15000;
const provider=new SerialProvider(request,56,{staticNetwork:true,batchMaxCount:1});
const gas='0xA285d1933e32b5990625aC1F5BEa205Cf2606619';
const units=['pinkuang-purchase-v2.service','pinkuang-v4-purchase.service','pinkuang-v4-mining.service','pinkuang-v4-signer.service'];
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const need=(ok,message)=>{if(!ok)throw Error(message);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try {
 for(const unit of units){
  const state=Object.fromEntries(execFileSync('systemctl',['show',unit,'-p','LoadState,ActiveState,MainPID,UnitFileState'],{encoding:'utf8'}).trim().split('\n').map(s=>s.split('=')));
  need(state.ActiveState==='inactive'&&state.MainPID==='0'&&(state.LoadState==='not-found'||['disabled','masked'].includes(state.UnitFileState)),'An old sender remains enabled: '+unit);
 }
 const latest=await provider.getTransactionCount(gas,'latest'),pending=await provider.getTransactionCount(gas,'pending');
 need(latest===pending,'Gas wallet still has a pending transaction.');
 const block=await provider.getBlock('finalized');
 const trusted=productGraphConfiguration({recordPath:'/etc/pinkuang-v5/trusted-product-deployment.json',bundlePath:runtime+'/public/deployment-artifacts.json',productActivationPath:'/etc/pinkuang-v5/fresh-activation.json',expectedGasWallet:gas});
 const graph=await verifyProductGraph(provider,trusted.record.addresses.factory,trusted,block);
 const old=JSON.parse(readFileSync('/etc/pinkuang-v4/legacy-drain.json','utf8'));
 const candidates=new Map(old.journals.map(row=>[row.txHash.toLowerCase(),{...row}]));
 function inspect(x,digest){
  if(!x||typeof x!=='object')return;
  if(!Array.isArray(x)){
   const nonce=Number(x.nonce);
   if(Number.isSafeInteger(nonce)&&nonce>=0&&nonce<latest){
    const hash=x.txHash??x.transactionHash??x.hash;
    if(/^0x[0-9a-f]{64}$/i.test(hash??''))candidates.set(hash.toLowerCase(),{nonce,txHash:hash,journalSha256:digest});
   }
  }
  for(const child of Object.values(x))if(child&&typeof child==='object')inspect(child,digest);
 }
 function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
  const path=dir+'/'+entry.name;
  if(entry.isDirectory())walk(path);
  else if(entry.isFile()&&entry.name.endsWith('.json')&&statSync(path).size<8*1024*1024){
   const bytes=readFileSync(path);try{inspect(JSON.parse(bytes),sha(bytes));}catch{}
  }
 }}
 walk('/var/lib/pinkuang-v4-signer');
 const verified=new Map();
 for(const row of candidates.values()){
  const tx=await provider.getTransaction(row.txHash);
  if(!tx||!same(tx.from,gas)||tx.nonce>=latest)continue;
  const receipt=await provider.getTransactionReceipt(row.txHash);
  need(receipt&&receipt.blockNumber<=block.number,'Old Gas transaction is not finalized.');
  need(same((await provider.getBlock(receipt.blockNumber))?.hash,receipt.blockHash),'Old Gas transaction is not canonical.');
  verified.set(tx.nonce,{nonce:tx.nonce,txHash:tx.hash,phase:receipt.status===1?'confirmed':'reverted',blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,journalSha256:row.journalSha256});
 }
 need(verified.size===latest&&Array.from({length:latest},(_,i)=>i).every(i=>verified.has(i)),'Old terminal nonce evidence is incomplete.');
 need(await provider.getTransactionCount(gas,'latest')===latest&&await provider.getTransactionCount(gas,'pending')===latest,'Nonce changed during cutover verification.');
 const proof={schemaVersion:1,kind:'bemine-v5-legacy-gas-drain',chainId:56,gasWallet:gas,cutoverNonce:latest,latestNonce:latest,pendingNonce:latest,units,journals:[...verified.values()].sort((a,b)=>a.nonce-b.nonce),checkedAt:new Date().toISOString(),finalizedBlockNumber:block.number,finalizedBlockHash:block.hash};
 writeFileSync('/etc/pinkuang-v5/legacy-drain.json',JSON.stringify(proof,null,2)+'\n',{mode:0o644});
 writeFileSync('/root/bemine-v5-upload/live-activation-proof.json',JSON.stringify({graph,drain:proof},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({verified:true,factory:graph.factory,authority:graph.freshAuthority.address,block:block.number,nonce:latest,oldSendersDisabled:true}));
}catch(error){console.error(String(error.message).split(rpc).join('[RPC]'));process.exitCode=1;}finally{provider.destroy();}
