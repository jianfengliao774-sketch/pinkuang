import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AbiCoder, Interface, getAddress, keccak256 } from 'ethers';
import { buildDigest, evidenceDigest, settleReads } from '../shared/firsto-upgrade-proof.mjs';
import { validateFirstoBatchUpgradeReview } from '../shared/firsto-batch-upgrade-plan.mjs';
import { GOVERNANCE24_REVIEW_KIND, governance24Coverage, governance24Cancellations,
  validateGovernance24UpgradeReview } from '../shared/governance24-upgrade-plan.mjs';
import { validateGovernance24UpgradePreflight } from '../shared/governance24-upgrade-proof.mjs';
import {verifyFirstoBatchOperationReceipt}from '../shared/firsto-batch-upgrade-proof.mjs';
const HASH=/^0x[\da-f]{64}$/i,need=(ok,text)=>{if(!ok)throw new Error(text);},same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
const num=value=>typeof value==='string'?Number(BigInt(value)):value;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const views=new Interface(['function poolCount() view returns(uint256)','function allPools(uint256) view returns(address)',
  'function portfolioCount() view returns(uint256)','function portfolioAt(uint256) view returns(address)',
  'function OFFICIAL_FACTORY() view returns(address)','function factory() view returns(address)']);
const timelock=new Interface(['function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)','event Cancelled(bytes32 indexed id)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)']);
const BEACON_SLOT='0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

/** The complete inventory is an independently pinned file, never an unverified list of remembered operations. */
export function validateGovernance24PendingInventory(bytes,{trustedFileSha256,trustedFileKeccak256,timelockAddress}) {
  need(sha(bytes)===trustedFileSha256&&same(keccak256(bytes),trustedFileKeccak256),'Complete pending inventory differs from its independent file pins.');
  const inventory=JSON.parse(Buffer.from(bytes).toString('utf8'));
  need(inventory.schemaVersion===2&&inventory.readOnly===true&&inventory.chainId===56&&same(inventory.timelock,timelockAddress)
    &&Number.isSafeInteger(inventory.anchor?.blockNumber)&&HASH.test(inventory.anchor?.blockHash ?? '')
    &&Number.isSafeInteger(inventory.anchor.timestamp)&&Number.isSafeInteger(inventory.scannedFromBlock)
    &&Array.isArray(inventory.ranges)&&inventory.ranges.length>0&&Array.isArray(inventory.logs)&&Array.isArray(inventory.operations),
  'Unsupported complete pending inventory.');
  let next=inventory.scannedFromBlock,count=0;
  for(const range of inventory.ranges){need(range.fromBlock===next&&Number.isSafeInteger(range.toBlock)&&range.toBlock>=range.fromBlock
    &&Number.isSafeInteger(range.eventCount)&&range.eventCount>=0,'Full original Timelock inventory has a gap or overlapping range.');next=range.toBlock+1;count+=range.eventCount;}
  need(next===inventory.anchor.blockNumber+1&&count===inventory.logs.length,'Full original Timelock inventory is truncated.');
  for(const range of inventory.ranges)need(inventory.logs.filter(log=>num(log.blockNumber)>=range.fromBlock&&num(log.blockNumber)<=range.toBlock).length===range.eventCount,
    'Original event count differs from its independently scanned range.');
  need(num(inventory.genesisAnchor?.number)===inventory.scannedFromBlock&&HASH.test(inventory.genesisAnchor?.hash ?? ''),'Original Timelock birth anchor is missing.');
  const seen=new Set(),scheduled=new Set(),operationIds=new Set(),pending=[];
  for(const log of inventory.logs){
    need(same(log.address,timelockAddress)&&log.removed!==true&&num(log.blockNumber)>=inventory.scannedFromBlock
      &&num(log.blockNumber)<=inventory.anchor.blockNumber,'Event lies outside the full original Timelock inventory.');
    const id=`${log.transactionHash}:${log.logIndex ?? log.index}`;need(!seen.has(id),'Complete inventory repeats a log.');seen.add(id);
    const tx=inventory.transactions[log.transactionHash],receipt=inventory.receipts[log.transactionHash];
    const block=inventory.blocks[log.blockNumber] ?? Object.values(inventory.blocks).find(b=>same(b.hash,log.blockHash));
    need(tx&&receipt&&block&&same(tx.hash,log.transactionHash)&&same(receipt.transactionHash ?? receipt.hash,log.transactionHash)
      &&num(receipt.status)===1&&same(tx.from,receipt.from)&&same(tx.to,receipt.to)&&num(tx.chainId)===56
      &&same(tx.blockHash,receipt.blockHash)&&same(log.blockHash,receipt.blockHash)&&same(block.hash,receipt.blockHash)
      &&num(tx.blockNumber)===num(receipt.blockNumber)&&num(tx.transactionIndex)===num(receipt.transactionIndex)
      &&num(log.blockNumber)===num(receipt.blockNumber)&&num(block.number)===num(receipt.blockNumber)
      &&same(block.transactions[num(receipt.transactionIndex)],log.transactionHash),'Original inventory receipt lacks canonical successful inclusion.');
    need(receipt.logs.some(item=>same(item.address,log.address)&&same(item.data,log.data)
      &&evidenceDigest(item.topics)===evidenceDigest(log.topics)&&num(item.logIndex ?? item.index)===num(log.logIndex ?? log.index)),
    'Original inventory event differs from its original receipt.');
    const parsed=timelock.parseLog(log);if(parsed?.name==='CallScheduled')scheduled.add(parsed.args.id.toLowerCase());
  }
  for(const operation of inventory.operations){
    need(HASH.test(operation.operationId ?? '')&&/^(0|[1-9]\d*)$/.test(operation.timestamp ?? '')
      &&operation.pending===(BigInt(operation.timestamp)>1n),'Invalid original operation state.');
    const lowerId=operation.operationId.toLowerCase();need(!operationIds.has(lowerId),'Original inventory repeats an operation.');operationIds.add(lowerId);
    if(!operation.pending)continue;
    const s=operation.currentSchedule;
    need(s&&['schedule','scheduleBatch'].includes(s.method)&&s.targets?.length>0&&s.targets.length===s.values.length
      &&s.values.length===s.payloads.length&&HASH.test(s.salt ?? '')&&HASH.test(s.predecessor ?? '')
      &&s.operationId===operation.operationId&&BigInt(s.delaySeconds)>=172800n&&BigInt(s.originalEta)===BigInt(operation.timestamp),
    'Complete pending original schedule is missing.');
    const mode=s.method==='schedule'?'single':'batch',op={mode,timelock:timelockAddress,operationId:operation.operationId,timestamp:operation.timestamp,
      predecessor:s.predecessor,salt:s.salt,scheduleTxHash:s.transactionHash,delaySeconds:s.delaySeconds};
    if(mode==='single'){need(s.targets.length===1,'Single original schedule has extra targets.');Object.assign(op,{target:getAddress(s.targets[0]),value:s.values[0],data:s.payloads[0]});}
    else Object.assign(op,{targets:s.targets.map(getAddress),values:s.values,payloads:s.payloads});
    const types=mode==='single'?['address','uint256','bytes','bytes32','bytes32']:['address[]','uint256[]','bytes[]','bytes32','bytes32'];
    const args=mode==='single'?[op.target,op.value,op.data,op.predecessor,op.salt]:[op.targets,op.values,op.payloads,op.predecessor,op.salt];
    need(same(keccak256(AbiCoder.defaultAbiCoder().encode(types,args)),op.operationId),'Reconstructed pending original operation ID differs.');pending.push(op);
  }
  need(operationIds.size===scheduled.size&&[...scheduled].every(id=>operationIds.has(id)),
    'Original operation inventory omits or adds an observed schedule.');
  return {inventory,pending,evidence:{fileSha256:trustedFileSha256,fileKeccak256:trustedFileKeccak256,inventoryDigest:evidenceDigest(inventory),
    scannedFromBlock:inventory.scannedFromBlock,throughBlock:inventory.anchor.blockNumber,anchorBlockHash:inventory.anchor.blockHash,
    birthBlockHash:inventory.genesisAnchor.hash,rangeCount:inventory.ranges.length,eventCount:inventory.logs.length,
    operationCount:inventory.operations.length,pendingOperationIds:pending.map(op=>op.operationId)}};
}
async function read(provider,to,method,args,block){return views.decodeFunctionResult(method,
  await provider.send('eth_call',[{to,data:views.encodeFunctionData(method,args ?? [])},`0x${block.toString(16)}`]))[0];}
export async function verifyGovernance24OriginalPendingWallets(provider,pending,inventory,proposer,finalized){
  const result=[];
  for(const operation of pending){
    need(operation.mode==='single','Original batch intent requires additional independent wallet review.');
    const data=timelock.encodeFunctionData('schedule',[operation.target,operation.value,operation.data,operation.predecessor,operation.salt,operation.delaySeconds]);
    const [tx,receipt]=await settleReads([provider.getTransaction(operation.scheduleTxHash),provider.getTransactionReceipt(operation.scheduleTxHash)]);
    const sourceTx=inventory.transactions[operation.scheduleTxHash],block=await provider.getBlock(receipt.blockNumber);
    need(sourceTx&&same(tx.data,sourceTx.input ?? sourceTx.data)&&tx.nonce===num(sourceTx.nonce)
      &&same(block.hash,receipt.blockHash)&&same(block.transactions[receipt.index],operation.scheduleTxHash)
      &&tx.index===receipt.index,'Original pending transaction body or canonical inclusion changed.');
    const proof=await verifyFirstoBatchOperationReceipt(provider,{tx,receipt,finalized,expected:{operation:'schedule',to:operation.timelock,
      from:proposer,data,dataHash:keccak256(data)}});
    need(same(proof.operationId,operation.operationId),'Original pending wallet signs a different operation.');
    result.push({operationId:proof.operationId,transactionHash:proof.transactionHash,kind:proof.kind,nonce:proof.nonce,
      blockNumber:proof.blockNumber,blockHash:proof.blockHash,status:proof.status,innerDataHash:proof.innerDataHash});
  }
  return result;
}

/** Capture only code/bindings and a complete immutable pool prefix, leaving live asset balances unfrozen. */
export async function captureGovernance24Review({provider,predecessorInput,upgradeBundle,inventoryBytes,inventoryPins,candidateArtifactDigest,
  candidateSourceCommit,outputDirectory}) {
  const prior=validateFirstoBatchUpgradeReview(predecessorInput),a=prior.addresses;
  need(same(buildDigest(upgradeBundle),candidateArtifactDigest)&&upgradeBundle.sourceCommit===candidateSourceCommit,
    'Finished source/artifact bundle differs from its independently reviewed pins.');
  const {inventory,pending,evidence}=validateGovernance24PendingInventory(inventoryBytes,{...inventoryPins,timelockAddress:a.timelock}),anchor=inventory.anchor;
  const [chain,canonical,finalized]=await settleReads([provider.send('eth_chainId',[]),provider.getBlock(anchor.blockNumber),provider.getBlock('finalized')]);
  need(BigInt(chain)===56n&&canonical?.number===anchor.blockNumber&&same(canonical.hash,anchor.blockHash)&&canonical.timestamp===anchor.timestamp
    &&finalized?.number>=anchor.blockNumber,'Complete inventory snapshot is not canonical and finalized.');
  need(await provider.getCode(a.timelock,inventory.scannedFromBlock-1)==='0x'&&await provider.getCode(a.timelock,inventory.scannedFromBlock)!=='0x',
    'Inventory begins after the original Timelock deployment birth.');
  const originalPendingWalletProofs=await verifyGovernance24OriginalPendingWallets(provider,pending,inventory,prior.catalog.bindings.proposer,finalized);
  const preservation={corePools:[],portfolioPools:[],storage:{}};
  for(const [name,factory,beacon,countMethod,atMethod]of[['corePools',a.factory,a.beacon,'poolCount','allPools'],['portfolioPools',a.portfolioFactory,a.portfolioBeacon,'portfolioCount','portfolioAt']]){
    const raw=await read(provider,factory,countMethod,[],anchor.blockNumber);need(raw<=BigInt(Number.MAX_SAFE_INTEGER),'Pool count exceeds safe enumeration.');
    const count=Number(raw),seen=new Set();
    for(let index=0;index<count;index++){
      const at=getAddress(await read(provider,factory,atMethod,[index],anchor.blockNumber));need(!seen.has(at),'Pool inventory repeats an address.');seen.add(at);
      const [code,word,official]=await settleReads([provider.getCode(at,anchor.blockNumber),provider.getStorage(at,BEACON_SLOT,anchor.blockNumber),read(provider,at,'OFFICIAL_FACTORY',[],anchor.blockNumber)]);
      need(code!=='0x'&&same(`0x${word.slice(-40)}`,beacon)&&same(official,factory),'Current pool factory or original beacon binding differs.');
      preservation[name].push({address:at,codehash:keccak256(code)});
    }
  }
  const input={predecessorInput,trustedPredecessorInputDigest:evidenceDigest(predecessorInput),upgradeBundle,
    trustedUpgradeArtifactDigest:candidateArtifactDigest,reviewCatalog:{schemaVersion:1,kind:GOVERNANCE24_REVIEW_KIND,chainId:56,profile:'formal',
      deployer:prior.catalog.deployer,predecessorInputDigest:evidenceDigest(predecessorInput),candidateArtifactDigest,
      anchor:{blockNumber:anchor.blockNumber,blockHash:anchor.blockHash},bindings:prior.catalog.bindings,
      coverage:governance24Coverage(prior,predecessorInput),pendingOperations:pending,pendingInventoryEvidence:evidence,preservation}};
  input.trustedReviewCatalogDigest=evidenceDigest(input.reviewCatalog);
  const reviewed=validateGovernance24UpgradeReview(input),cancellations=governance24Cancellations(input);
  need(cancellations.length===pending.length,'Unexpected original governance intent is not covered by this complete business release.');
  const proof=await validateGovernance24UpgradePreflight(provider,input,{phase:'prepared',deployments:{},snapshot:canonical});
  const liveReview={...proof,readOnly:true,chainActionsPerformed:false,pendingInventoryEvidence:evidence,
    originalPendingWalletProofs,
    cancellationPrerequisites:cancellations.map(({id,operationId,name,to,data,originalOperation})=>({id,operationId,name,to,data,originalOperation}))};
  const summary={schemaVersion:1,kind:'governance24-formal-current-review-summary-v1',readOnly:true,chainActionsPerformed:false,
    anchor,checkedAt:liveReview.checkedAt,candidateSourceCommit,candidateArtifactDigest,pins:{trustedPredecessorInputDigest:input.trustedPredecessorInputDigest,
      trustedUpgradeArtifactDigest:input.trustedUpgradeArtifactDigest,trustedReviewCatalogDigest:input.trustedReviewCatalogDigest},
    liveReviewEvidenceDigest:evidenceDigest(liveReview),corePoolCount:preservation.corePools.length,portfolioPoolCount:preservation.portfolioPools.length,
    linkedAddressClosureCount:reviewed.linkedAddressClosure.length,pendingInventoryEvidence:evidence,
    cancellationIds:cancellations.map(op=>op.id),scope:input.reviewCatalog.coverage.scope,baselineVerified:proof.baselineVerified,
    originalPendingWalletProofCount:originalPendingWalletProofs.length};
  if(outputDirectory){await mkdir(resolve(outputDirectory),{recursive:true,mode:0o700});
    for(const [name,value]of Object.entries({'governance24-input.json':input,'governance24-review-catalog.json':input.reviewCatalog,'governance24-live-review.json':liveReview,'governance24-review-summary.json':summary})){
      const path=resolve(outputDirectory,name);await writeFile(path,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});await chmod(path,0o600);}}
  return {input,liveReview,summary};
}
