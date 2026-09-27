import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { productGraphConfiguration, verifyProductGraph } from '../server/product-graph.mjs';
import { FIRSTO_UPGRADE_KIND, buildDigest, evidenceDigest, settleReads } from '../shared/firsto-upgrade-proof.mjs';

const read = path => {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Evidence inputs cannot be symlinks.');
  return JSON.parse(readFileSync(path,'utf8'));
};
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Produces local evidence only. The provider is never given a wallet, signer or send-transaction request. */
export async function generateFirstoUpgradeEvidence(provider, { genesisRecord,genesisBundle,upgradeBundle,plan }) {
  const block = await provider.getBlock('finalized');
  if (!Number.isSafeInteger(block?.number) || !/^0x[\da-f]{64}$/i.test(block?.hash ?? '')) throw new Error('A finalized verification block is required.');
  const record = { schemaVersion:2,kind:FIRSTO_UPGRADE_KIND,chainId:56,status:'complete',
    genesisRecordDigest:evidenceDigest(genesisRecord),genesisArtifactDigest:buildDigest(genesisBundle),
    artifactDigest:buildDigest(upgradeBundle),sourceCommit:upgradeBundle.sourceCommit,
    deployments:plan.deployments,operation:plan.operation,
    verification:{blockNumber:block.number,blockHash:block.hash,checkedAt:new Date().toISOString()} };
  const trusted = productGraphConfiguration({record,bundle:upgradeBundle,genesisRecord,genesisBundle});
  const { upgrade:proof } = await verifyProductGraph(provider,genesisRecord.addresses.factory,trusted,block);
  const initial = genesisRecord.steps.find(step => step.id === 'initialize');
  if (!initial?.txHash || !Number.isSafeInteger(initial.receipt?.blockNumber)) throw new Error('Genesis creation receipt is missing.');
  const [genesisReceipt,genesisBlock] = await settleReads([provider.getTransactionReceipt(initial.txHash),provider.getBlock(initial.receipt.blockNumber)]);
  if (!genesisReceipt || genesisReceipt.status !== 1 || !same(genesisReceipt.hash ?? genesisReceipt.transactionHash,initial.txHash)
    || genesisReceipt.blockNumber !== initial.receipt.blockNumber || genesisBlock?.number !== initial.receipt.blockNumber
    || !same(genesisReceipt.blockHash,initial.receipt.blockHash) || !same(genesisBlock.hash,initial.receipt.blockHash)) throw new Error('Genesis creation receipt is not canonical.');
  const [after,chain] = await settleReads([provider.getBlock(block.number),provider.send('eth_chainId',[])]);
  if (after?.number !== block.number || !same(after.hash,block.hash) || BigInt(chain) !== 56n) throw new Error('Chain changed before evidence export.');
  const keys=['factory','shareMarket','lens','beacon','timelock'];
  const manifest={schemaVersion:1,chainId:56,...Object.fromEntries(keys.map(name=>[name,genesisRecord.addresses[name]])),
    deployment:{txHash:initial.txHash,blockNumber:initial.receipt.blockNumber,blockHash:initial.receipt.blockHash},
    artifactDigest:record.artifactDigest,sourceCommit:record.sourceCommit,verifiedAt:record.verification.checkedAt,
    verifiedBlockNumber:block.number,codehash:Object.fromEntries(keys.map(name=>[name,genesisRecord.verification.code[name].codehash])),
    upgrade:{kind:FIRSTO_UPGRADE_KIND,genesisArtifactDigest:record.genesisArtifactDigest,operationId:proof.operationId,
      executionTxHash:proof.executionTxHash,executedBlock:proof.executedBlock}};
  return {record,manifest};
}

export async function main(args=process.argv.slice(2)) {
  const accepted=new Set(['genesis-record','genesis-bundle','upgrade-bundle','plan','out-record','out-manifest','rpc']);
  const values={};
  for(let index=0;index<args.length;index++) {
    const key=args[index]?.slice(2);
    if(!args[index]?.startsWith('--') || !accepted.has(key) || values[key] || !args[index+1] || args[index+1].startsWith('--')) throw new Error('Use explicit --genesis-record --genesis-bundle --upgrade-bundle --plan --out-record --out-manifest --rpc options.');
    values[key]=args[++index];
  }
  if([...accepted].some(key=>!values[key])) throw new Error('All upgrade evidence paths and an HTTPS read-only RPC are required.');
  const rpc=new URL(values.rpc);
  if(rpc.protocol!=='https:' || rpc.username || rpc.password || rpc.hash) throw new Error('Use an HTTPS RPC without URL credentials.');
  const recordPath=resolve(values['out-record']),manifestPath=resolve(values['out-manifest']);
  if(recordPath===manifestPath) throw new Error('Record and manifest output paths must differ.');
  const request=new FetchRequest(rpc.href);request.timeout=15000;request.retryFunc=async()=>false;
  const provider=new JsonRpcProvider(request,56,{staticNetwork:true,cacheTimeout:-1,batchMaxCount:8});
  try {
    const result=await generateFirstoUpgradeEvidence(provider,{genesisRecord:read(values['genesis-record']),genesisBundle:read(values['genesis-bundle']),
      upgradeBundle:read(values['upgrade-bundle']),plan:read(values.plan)});
    // Never overwrite a genesis record, an old recovery record or a live public manifest.
    writeFileSync(recordPath,`${JSON.stringify(result.record,null,2)}\n`,{flag:'wx',mode:0o600});
    writeFileSync(manifestPath,`${JSON.stringify(result.manifest,null,2)}\n`,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({status:'verified-local-evidence',recordPath,manifestPath,artifactDigest:result.record.artifactDigest,
      verifiedBlockNumber:result.record.verification.blockNumber,productionActivated:false,transactionsSent:false}));
  } finally {provider.destroy();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});
