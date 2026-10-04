import { readFileSync, writeFileSync } from 'node:fs';
import { JsonRpcProvider, FetchRequest } from '/private/tmp/bemine-upgrade-null-id-throttle-20261004/deploy/node_modules/ethers/lib.esm/ethers.js';
import { validateTargetOwnerUpgradePreflight } from '/private/tmp/bemine-upgrade-null-id-throttle-20261004/deploy/shared/target-owner-upgrade-proof.mjs';
const root='/private/tmp/bemine-upgrade-null-id-throttle-20261004/deploy/.target-owner-release';
const config=JSON.parse(readFileSync(root+'/config.json'));
const common={...config.pins};
for (const name of ['genesisRecord','genesisBundle','trustedGenesisManifest','upgradeBundle','reviewCatalog']) common[name]=JSON.parse(readFileSync(root+'/public/'+config.files[name].path));
const request = new FetchRequest(process.argv[2]);request.timeout=15000;
const provider=new JsonRpcProvider(request,56,{batchMaxCount:1,cacheTimeout:-1});
const methods={}, failures=[], send=provider.send.bind(provider), start=Date.now();
provider.send=async(method,params)=>{ if(!['eth_chainId','eth_getBlockByNumber','eth_blockNumber','eth_call','eth_getCode','eth_getStorageAt','eth_getTransactionByHash','eth_getTransactionReceipt'].includes(method))throw Error('unexpected method');
 methods[method]=(methods[method]??0)+1;
 try{return await send(method,params);}catch(e){failures.push({method,address:params?.[0]?.to??(method==='eth_getCode'?params[0]:undefined),blockTag:params?.[1],code:e.code,status:e.info?.responseStatus,errorType:e.name});throw e;}};
let result;
try{const checked=await validateTargetOwnerUpgradePreflight(provider,common,{phase:'prepared'});result={ok:true,phase:checked.phase,blockNumber:checked.blockNumber,baselineVerified:checked.baselineVerified};}
catch(e){result={ok:false,errorCode:e.code??null,errorType:e.name,errorMessage:(e.shortMessage??e.message).split('(')[0].slice(0,220)};}
finally {provider.destroy();}
result={...result,elapsedMs:Date.now()-start,methods,failures,chainActionsPerformed:false,sourceCommit:process.argv[4]??null,readEndpoint:process.argv[5]??null,generatedAt:new Date().toISOString()};
writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
