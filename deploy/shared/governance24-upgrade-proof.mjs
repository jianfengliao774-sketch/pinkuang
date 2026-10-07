import { Interface, ZeroAddress, ZeroHash, getAddress, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';
import { evidenceDigest, settleReads } from './firsto-upgrade-proof.mjs';
import { validateFirstoBatchUpgradePreflight } from './firsto-batch-upgrade-proof.mjs';
import { decodeFreshSingleCallEnvelope, FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR, FRESH_BALANCE_ENFORCER } from './fresh-activation-execution.mjs';
import { governance24UpgradeDeploymentOrder, governance24BatchAbi, validateGovernance24UpgradeReview,
  prepareGovernance24UpgradeDeployment, buildGovernance24UpgradePlan, governance24ExpectedRuntime, governance24ArtifactNames } from './governance24-upgrade-plan.mjs';
import { snapshotGovernance24UpgradeInput } from './governance24-upgrade-plan.mjs';

const HASH = /^0x[\da-f]{64}$/i;
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const need = (ok, text) => { if (!ok) throw new Error(text); };
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = value => { const a = getAddress(value); need(a !== ZeroAddress, 'Zero address.'); return a; };
const slotAddress = word => { need(/^0x0{24}[\da-f]{40}$/i.test(word ?? ''), 'Invalid address storage word.'); return address(`0x${word.slice(-40)}`); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const completed = new WeakSet();
const views = new Interface([
  'function owner() view returns(address)', 'function timelock() view returns(address)', 'function beacon() view returns(address)',
  'function operator() view returns(address)', 'function treasury() view returns(address)', 'function shareMarket() view returns(address)',
  'function lens() view returns(address)', 'function factory() view returns(address)', 'function legacyFactory() view returns(address)',
  'function OFFICIAL_FACTORY() view returns(address)', 'function SECONDARY_BEACON() view returns(address)',
  'function implementation() view returns(address)', 'function governance24Version() view returns(uint16)',
  'function targetOwnerVersion() view returns(uint8)', 'function firstoBatchPurchaseVersion() view returns(uint16)',
  'function coreFactory() view returns(address)', 'function budgetFactory() view returns(address)',
  'function administratorOne() view returns(address)', 'function administratorTwo() view returns(address)', 'function gasWallet() view returns(address)',
  'function getMinDelay() view returns(uint256)', 'function MINIMUM_DELAY() view returns(uint256)',
  'function INITIAL_PROPOSER() view returns(address)',
  'function hasRole(bytes32,address) view returns(bool)', 'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns(bytes32)',
  'function isOperation(bytes32) view returns(bool)', 'function isOperationReady(bytes32) view returns(bool)',
  'function isOperationDone(bytes32) view returns(bool)', 'function getTimestamp(bytes32) view returns(uint256)',
  'function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)',
  'function portfolioCount() view returns(uint256)', 'function portfolioAt(uint256) view returns(address)',
]);
const events = new Interface([
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)', 'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  'event Upgraded(address indexed implementation)', 'event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)',
  'event Cancelled(bytes32 indexed id)',
]);
const roles = { ...Object.fromEntries(['PROPOSER_ROLE','CANCELLER_ROLE','EXECUTOR_ROLE'].map(n => [n, keccak256(toUtf8Bytes(n))])), DEFAULT_ADMIN_ROLE: ZeroHash };
async function read(p,to,method,args,block) {
  return views.decodeFunctionResult(method, await p.send('eth_call', [{to,data:views.encodeFunctionData(method,args ?? [])},`0x${block.number.toString(16)}`]))[0];
}
async function context(p,supplied) {
  const [chain, finalized] = await settleReads([p.send('eth_chainId',[]),p.getBlock('finalized')]);
  need(BigInt(chain) === 56n && Number.isSafeInteger(finalized?.number) && HASH.test(finalized.hash ?? ''), 'A finalized chain-56 snapshot is required.');
  const block = supplied ?? finalized;
  need(Number.isSafeInteger(block?.number) && block.number > 0 && block.number <= finalized.number
    && HASH.test(block.hash ?? '') && Number.isSafeInteger(block.timestamp), 'Invalid finalized snapshot.');
  const actual = await p.getBlock(block.number);
  need(actual?.number === block.number && same(actual.hash,block.hash) && actual.timestamp === block.timestamp, 'Snapshot is not canonical.');
  return {block,finalized};
}
function before(a,b) { return a.receipt.blockNumber < b.receipt.blockNumber || a.receipt.blockNumber === b.receipt.blockNumber && a.receipt.index < b.receipt.index; }
function body(proof) {
  const t=proof.tx,r=proof.receipt;
  return {tx:{hash:t.hash,chainId:String(t.chainId),from:t.from,to:t.to,value:String(t.value),data:t.data,nonce:t.nonce,
    type:t.type,authorizationList:t.authorizationList ?? [],blockNumber:t.blockNumber,blockHash:t.blockHash,index:t.index},
  receipt:{hash:r.hash ?? r.transactionHash,from:r.from,to:r.to,status:r.status,contractAddress:r.contractAddress,
    blockNumber:r.blockNumber,blockHash:r.blockHash,index:r.index,logs:(r.logs ?? []).map(l => ({address:l.address,data:l.data,
      topics:[...(l.topics ?? [])],transactionHash:l.transactionHash,blockHash:l.blockHash,blockNumber:l.blockNumber,
      index:l.index,transactionIndex:l.transactionIndex,removed:l.removed}))}};
}
async function transaction(p,hash,c) {
  need(HASH.test(hash ?? ''),'Confirmed transaction hash is required.');
  const [tx,receipt] = await settleReads([p.getTransaction(hash),p.getTransactionReceipt(hash)]);
  need(tx && receipt && same(tx.hash,hash) && same(receipt.hash ?? receipt.transactionHash,hash)
    && BigInt(tx.chainId ?? 0) === 56n && receipt.status === 1 && same(tx.from,receipt.from)
    && (tx.to === null ? receipt.to === null : same(tx.to,receipt.to)) && Number.isSafeInteger(tx.nonce) && tx.nonce >= 0
    && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber > 0 && receipt.blockNumber <= c.block.number
    && receipt.blockNumber <= c.finalized.number && tx.blockNumber === receipt.blockNumber && same(tx.blockHash,receipt.blockHash),
  'Transaction is not a matching successful finalized inclusion.');
  const block = await p.getBlock(receipt.blockNumber);
  need(block?.number === receipt.blockNumber && same(block.hash,receipt.blockHash) && Number.isSafeInteger(block.timestamp)
    && Number.isSafeInteger(receipt.index) && receipt.index >= 0 && tx.index === receipt.index
    && Array.isArray(block.transactions) && same(block.transactions[receipt.index],hash), 'Receipt is not canonically included.');
  return {tx,receipt,block};
}
async function recheck(p,c,review,proofs) {
  const [chain,block,finalized,anchor] = await settleReads([p.send('eth_chainId',[]),p.getBlock(c.block.number),
    p.getBlock(c.finalized.number),p.getBlock(review.catalog.anchor.blockNumber)]);
  need(BigInt(chain) === 56n && block?.number === c.block.number && same(block.hash,c.block.hash) && block.timestamp === c.block.timestamp
    && finalized?.number === c.finalized.number && same(finalized.hash,c.finalized.hash)
    && anchor?.number === review.catalog.anchor.blockNumber && same(anchor.hash,review.catalog.anchor.blockHash), 'Chain, snapshot, finality or independent anchor changed.');
  await settleReads(proofs.map(async proof => need(evidenceDigest(body(await transaction(p,proof.tx.hash,c))) === evidenceDigest(body(proof)), 'Canonical transaction body or receipt changed during recheck.')));
}
async function newLegacySchedules(p,review,c,plan,scheduled) {
  const topic=events.getEvent('CallScheduled').topicHash,found=[];
  const first=review.catalog.anchor.blockNumber+1,last=c.block.number;
  for(let from=first;from<=last;from+=2048){
    const to=Math.min(last,from+2047),filter={address:review.addresses.timelock,topics:[topic],fromBlock:from,toBlock:to};
    let rows;
    try {rows=typeof p.getLogs==='function'?await p.getLogs(filter):await p.send('eth_getLogs',[{...filter,fromBlock:`0x${from.toString(16)}`,toBlock:`0x${to.toString(16)}`}]);}
    catch {throw new Error('Cannot verify new original Timelock schedules since the independent review anchor; canonical archive log access is required.');}
    need(Array.isArray(rows),'Invalid original Timelock schedule log response.');
    for(const raw of rows){
      const number=value=>typeof value==='string'?Number(BigInt(value)):value;
      const log={...raw,blockNumber:number(raw.blockNumber),transactionIndex:number(raw.transactionIndex),index:number(raw.index ?? raw.logIndex)};
      need(log.removed!==true&&same(log.address,review.addresses.timelock)&&same(log.topics?.[0],topic)
        &&Number.isSafeInteger(log.blockNumber)&&log.blockNumber>=from&&log.blockNumber<=to,'Noncanonical incremental original Timelock log.');
      need(scheduled&&same(log.transactionHash,scheduled.tx.hash)&&log.blockNumber===scheduled.receipt.blockNumber
        &&same(log.blockHash,scheduled.receipt.blockHash)&&log.transactionIndex===scheduled.receipt.index,
        'A new or repeated original Timelock operation appeared after the review anchor; obtain a fresh complete pending inventory.');
      const receiptLog=(scheduled.receipt.logs ?? []).find(item=>item.index===log.index);
      need(receiptLog&&same(receiptLog.address,log.address)&&same(receiptLog.data,log.data)
        &&evidenceDigest(receiptLog.topics)===evidenceDigest(log.topics),'Incremental schedule log differs from its canonical original receipt.');
      found.push(log);
    }
  }
  if(scheduled&&scheduled.receipt.blockNumber>=first)need(found.length===plan.targets.length&&new Set(found.map(log=>log.index)).size===found.length,
    'Incremental log response omits or repeats the complete original migration schedule.');
  return {fromBlock:first,throughBlock:last,newScheduleEvents:found.length};
}
function logs(proof,to,name) {
  const found=[],indices=new Set(),topic=events.getEvent(name).topicHash;
  for (const log of proof.receipt.logs ?? []) {
    if (!same(log.address,to) || !same(log.topics?.[0],topic)) continue;
    need(log.removed !== true && same(log.transactionHash,proof.tx.hash) && same(log.blockHash,proof.receipt.blockHash)
      && log.blockNumber === proof.receipt.blockNumber && log.transactionIndex === proof.receipt.index
      && Number.isSafeInteger(log.index) && log.index >= 0 && !indices.has(log.index),'Noncanonical or duplicated receipt log.');
    indices.add(log.index); found.push(log);
  }
  return found;
}
function exactLogs(proof,to,name,values) {
  const found=logs(proof,to,name); need(found.length === values.length,`Exact ${name} event count differs.`);
  for (const [index,args] of values.entries()) {
    const encoded=events.encodeEventLog(events.getEvent(name),args),observed=found[index];
    need(same(encoded.data,observed.data) && encoded.topics.length === observed.topics.length
      && encoded.topics.every((t,i) => same(t,observed.topics[i])),`Complete ${name} event differs.`);
  }
}
function operationEvents(proof,plan,kind) {
  if (kind === 'schedule') {
    exactLogs(proof,plan.timelock,'CallScheduled',plan.targets.map((target,i) => [plan.operationId,BigInt(i),target,0n,plan.payloads[i],plan.predecessor,BigInt(plan.delaySeconds)]));
    exactLogs(proof,plan.timelock,'CallSalt',[[plan.operationId,plan.salt]]);
  } else {
    exactLogs(proof,plan.timelock,'CallExecuted',plan.targets.map((target,i) => [plan.operationId,BigInt(i),target,0n,plan.payloads[i]]));
    for (const step of plan.steps.slice(0,6)) exactLogs(proof,step.target,'Upgraded',[[step.implementation]]);
    for (const index of [2,3,6]) exactLogs(proof,plan.targets[index],'OwnershipTransferred',[[plan.timelock,plan.nextTimelock]]);
  }
  const used=new Set();
  for (const log of proof.receipt.logs ?? []) { need(!used.has(log.index),'Receipt repeats a global log index.');used.add(log.index); }
}

/** Receipt proof is tied to the independently pinned complete inventory, including the original user wallet envelope. */
export async function verifyGovernance24OperationReceipt(p,{tx,receipt,expected,finalized}) {
  need(expected?.input && expected?.plan,'Pinned input and complete migration plan are required.');
  const plan=buildGovernance24UpgradePlan({...expected.input,replacements:expected.plan.replacements,salt:expected.plan.salt,delaySeconds:expected.plan.delaySeconds});
  need(evidenceDigest(plan) === evidenceDigest(expected.plan) && ['schedule','execute','cancel'].includes(expected.operation), 'Original migration inventory differs.');
  const cancellation=expected.operation==='cancel'?plan.cancellations.find(op=>same(op.operationId,expected.operationId)||same(op.id,expected.cancellationId)):null;
  need(expected.operation!=='cancel'||cancellation,'Cancellation is outside the fixed original covered operation inventory.');
  const data=expected.operation === 'schedule' ? plan.scheduleData : expected.operation==='execute'?plan.executeData:cancellation.data;
  need(same(expected.to,plan.timelock) && same(expected.data,data) && same(expected.dataHash,keccak256(data))
    && (expected.nonce === undefined || tx.nonce === expected.nonce),'Complete original migration calldata or nonce differs.');
  if(expected.operation!=='cancel'){
    const parsed=governance24BatchAbi.decodeFunctionData(`${expected.operation}Batch`,data);
    need(same(governance24BatchAbi.encodeFunctionData(`${expected.operation}Batch`,parsed),data),'Noncanonical original migration calldata.');
  } else need(same(expected.from,validateGovernance24UpgradeReview(expected.input).proposer),'Only the reviewed proposer may sign covered cancellation.');
  let runtimeProof;
  if (!same(tx.to,plan.timelock)) {
    need(same(tx.to,FRESH_DELEGATION_MANAGER.address) && Number.isSafeInteger(finalized?.number)
      && finalized.number >= receipt.blockNumber && HASH.test(finalized.hash ?? ''),'Unreviewed wallet wrapper or runtime anchor.');
    const [managerCode,delegatorCode,enforcerCode]=await settleReads([p.getCode(FRESH_DELEGATION_MANAGER.address,finalized.number),
      p.getCode(FRESH_DELEGATOR.address,finalized.number),p.getCode(FRESH_BALANCE_ENFORCER.address,finalized.number)]);
    runtimeProof={managerCode,delegatorCode,enforcerCode};
  }
  const envelope=decodeFreshSingleCallEnvelope({account:expected.from,target:plan.timelock,data,tx,receipt,runtimeProof});
  if (runtimeProof) { const again=await p.getBlock(finalized.number);need(same(again?.hash,finalized.hash),'Wallet runtime anchor changed.'); }
  // Reverts remain evidence; they never release the journal nonce or justify automatic resending.
  if (receipt.status === 1) expected.operation==='cancel'?exactLogs({tx,receipt},plan.timelock,'Cancelled',[[cancellation.operationId]]):operationEvents({tx,receipt},plan,expected.operation);
  return {...envelope,operationId:expected.operation==='cancel'?cancellation.operationId:plan.operationId};
}
async function pending(p,review,block,cancelled=new Set()) {
  await settleReads(review.catalog.pendingOperations.map(async op => {
    const args=op.mode === 'single' ? [op.target,op.value,op.data,op.predecessor,op.salt] : [op.targets,op.values,op.payloads,op.predecessor,op.salt];
    const [timestamp,done,id]=await settleReads([read(p,op.timelock,'getTimestamp',[op.operationId],block),read(p,op.timelock,'isOperationDone',[op.operationId],block),
      read(p,op.timelock,op.mode === 'single' ? 'hashOperation' : 'hashOperationBatch',args,block)]);
    need(timestamp === (cancelled.has(op.operationId.toLowerCase())?0n:BigInt(op.timestamp)) && done === false && same(id,op.operationId),
      'Original pending operation differs from retained timestamp or confirmed user cancellation.');
  }));
}
async function pools(p,review,block) {
  const a=review.addresses, inventory={};
  for (const [kind,factory,beacon,countMethod,atMethod] of [['corePools',a.factory,a.beacon,'poolCount','allPools'],
    ['portfolioPools',a.portfolioFactory,a.portfolioBeacon,'portfolioCount','portfolioAt']]) {
    const raw=await read(p,factory,countMethod,[],block);
    need(raw <= BigInt(Number.MAX_SAFE_INTEGER),'Pool inventory exceeds safe enumeration range.');
    const count=Number(raw),prefix=review.catalog.preservation[kind],seen=new Set();
    need(count >= prefix.length,'Pinned pool inventory was truncated.');
    inventory[kind]=await settleReads(Array.from({length:count},async(_,index) => {
      const pool=address(await read(p,factory,atMethod,[index],block));need(!seen.has(pool.toLowerCase()),'Pool inventory repeats an address.');seen.add(pool.toLowerCase());
      const [code,word,official]=await settleReads([p.getCode(pool,block.number),p.getStorage(pool,BEACON_SLOT,block.number),read(p,pool,'OFFICIAL_FACTORY',[],block)]);
      need(code !== '0x' && same(slotAddress(word),beacon) && same(official,factory),'Current pool is outside the reviewed original beacon/factory binding.');
      if (prefix[index]) need(same(prefix[index].address,pool) && same(prefix[index].codehash,keccak256(code)),'Pinned immutable pool prefix changed.');
      if (kind === 'corePools') need(same(await read(p,pool,'factory',[],block),factory),'Core pool factory storage differs.');
      return {address:pool,codehash:keccak256(code),beacon,factory};
    }));
  }
  // Only invariant storage may be pinned here. Assets, orders and balances remain live during the delay.
  const allowed=new Set([a.factory,a.portfolioFactory,a.shareMarket,a.portfolioShareMarket,a.lens].map(x=>x.toLowerCase()));
  await settleReads(Object.entries(review.catalog.preservation.storage).flatMap(([to,slots]) => {
    need(allowed.has(address(to).toLowerCase()),'Preservation storage targets an unreviewed account.');
    return Object.entries(slots).map(async([slot,word]) => {
      need(HASH.test(slot) && HASH.test(word),'Invalid invariant storage evidence.');
      need(same(await p.getStorage(to,slot,block.number),word),'Pinned invariant storage differs.');
    });
  }));
  return inventory;
}
async function graph(p,review,c,plan,done,cancelled=new Set()) {
  const a=review.addresses,old=review.predecessor,block=c.block;
  need(block.number >= review.catalog.anchor.blockNumber,'Snapshot precedes the current review.');
  const anchor=await p.getBlock(review.catalog.anchor.blockNumber);
  need(same(anchor?.hash,review.catalog.anchor.blockHash),'Current review anchor is not canonical.');
  // Historical baseline proof retains every previous core/genesis/source safety check.
  await validateFirstoBatchUpgradePreflight(p,reviewInput(review),{phase:'prepared',deployments:{},snapshot:done ? anchor : block});
  await settleReads(Object.entries(old.runtimes).map(async([name,runtime]) => need(same(await p.getCode(a[name],block.number),runtime),`Preserved baseline runtime differs: ${name}.`)));
  await settleReads(review.linkedAddressClosure.map(async row=>need(same(await p.getCode(row.address,block.number),row.runtime),
    `Actual linked address closure runtime differs: ${row.name}@${row.address}.`)));
  const replacements=plan?.replacements ?? {},next=done ? plan.nextTimelock : a.timelock;
  const proxyNames={factory:'Governance24FreshPoolFactory',portfolioFactory:'Governance24BudgetPortfolioFactory',shareMarket:'CoreGovernance24ShareMarket',portfolioShareMarket:'PortfolioGovernance24ShareMarket'};
  await settleReads(Object.entries(proxyNames).map(async([proxy,candidate]) => {
    const expected=done ? replacements[candidate] : a[old.implementationNames[proxy]];
    need(same(slotAddress(await p.getStorage(a[proxy],IMPL_SLOT,block.number)),expected),`Current ${proxy} implementation differs.`);
    need(same(await read(p,a[proxy],'timelock',[],block),next),`Current ${proxy} governance storage differs.`);
  }));
  for (const [name,factory,impl,secondary] of [['beacon',a.factory,done ? replacements.CoreGovernance24Dispatcher : a.PoolVault,replacements.CoreGovernance24Beacon],
    ['portfolioBeacon',a.portfolioFactory,done ? replacements.PortfolioGovernance24Dispatcher : a.BudgetPortfolioVault,replacements.PortfolioGovernance24Beacon]]) {
    const [owner,implementation,official]=await settleReads([read(p,a[name],'owner',[],block),read(p,a[name],'implementation',[],block),read(p,a[name],'OFFICIAL_FACTORY',[],block)]);
    need(same(owner,a.timelock) && same(implementation,impl) && same(official,factory),`Original ${name} recovery binding differs.`);
    if (done) {
      const [dispatcherFactory,dispatchBeacon]=await settleReads([read(p,impl,'OFFICIAL_FACTORY',[],block),read(p,impl,'SECONDARY_BEACON',[],block)]);
      need(same(dispatcherFactory,factory) && same(dispatchBeacon,secondary),'Dispatcher immutable graph differs.');
      const [secondaryOwner,businessImpl,binding]=await settleReads([read(p,secondary,'owner',[],block),read(p,secondary,'implementation',[],block),read(p,secondary,'OFFICIAL_FACTORY',[],block)]);
      need(same(secondaryOwner,next) && same(binding,factory) && same(businessImpl,factory === a.factory ? replacements.PoolVault : replacements.BudgetPortfolioVault),'Secondary business beacon graph differs.');
    }
  }
  for (const [name,beaconName,market] of [['factory','beacon',a.shareMarket],['portfolioFactory','portfolioBeacon',a.portfolioShareMarket]]) {
    const [owner,operator,treasury,binding,registered]=await settleReads(['owner','operator','treasury','beacon','shareMarket'].map(m=>read(p,a[name],m,[],block)));
    need(same(owner,next) && same(operator,old.catalog.authority.address) && same(treasury,old.catalog.authority.address)
      && same(binding,a[beaconName]) && same(registered,market),'Factory owners or preserved roles/bindings differ.');
  }
  need(same(await read(p,a.factory,'lens',[],block),a.lens) && same(await read(p,a.lens,'factory',[],block),a.factory)
    && same(await read(p,a.portfolioFactory,'legacyFactory',[],block),a.factory)
    && same(await read(p,a.shareMarket,'factory',[],block),a.factory)
    && same(await read(p,a.portfolioShareMarket,'factory',[],block),a.portfolioFactory),'Preserved Lens, factory or market binding differs.');
  const authority=old.catalog.authority;
  need(same(keccak256(await p.getCode(authority.address,block.number)),authority.codehash),'Authority runtime differs.');
  await settleReads(Object.entries({owner:next,coreFactory:a.factory,budgetFactory:a.portfolioFactory,
    administratorOne:authority.administratorOne,administratorTwo:authority.administratorTwo,gasWallet:authority.gasWallet})
    .map(async([method,value])=>need(same(await read(p,authority.address,method,[],block),value),`Authority ${method} differs.`)));
  const oldDelay=await read(p,a.timelock,'getMinDelay',[],block);need(oldDelay >= 172800n,'Original 48-hour recovery floor differs.');
  await pending(p,review,block,cancelled);
  const inventory=await pools(p,review,block);
  return {inventory,legacyRecoveryDelaySeconds:Number(oldDelay)};
}
const reviewInputs=new WeakMap();
function reviewInput(review) { return reviewInputs.get(review); }
async function candidateGraph(p,review,c,plan) {
  const a={...review.addresses,proposer:review.proposer,...plan.replacements},block=c.block;
  await settleReads(plan.deployments.map(async d=>need(same(await p.getCode(d.address,block.number),d.expectedRuntime),`Reviewed deployed runtime differs: ${d.name}.`)));
  const [delay,floor,proposer,canceller,executor,selfAdmin,externalAdmin]=await settleReads([
    read(p,a.PoolTimelock24,'getMinDelay',[],block),read(p,a.PoolTimelock24,'MINIMUM_DELAY',[],block),
    read(p,a.PoolTimelock24,'hasRole',[roles.PROPOSER_ROLE,review.proposer],block),read(p,a.PoolTimelock24,'hasRole',[roles.CANCELLER_ROLE,review.proposer],block),
    read(p,a.PoolTimelock24,'hasRole',[roles.EXECUTOR_ROLE,ZeroAddress],block),read(p,a.PoolTimelock24,'hasRole',[ZeroHash,a.PoolTimelock24],block),
    read(p,a.PoolTimelock24,'hasRole',[ZeroHash,review.deployer],block)]);
  need(delay === 86400n && floor === 86400n && proposer === true && canceller === true && executor === true && selfAdmin === true && externalAdmin === false,'New 24-hour floor or least-privilege Timelock roles differ.');
  need(same(await read(p,a.PoolTimelock24,'INITIAL_PROPOSER',[],block),review.proposer),'New Timelock immutable proposer differs.');
  if (!same(review.proposer,review.deployer)) need(await read(p,a.PoolTimelock24,'hasRole',[ZeroHash,review.proposer],block) === false,'Proposer has an external admin role.');
  const [factory,version,batchVersion,portfolioFactory]=await settleReads([read(p,a.PoolVault,'OFFICIAL_FACTORY',[],block),
    read(p,a.PoolVault,'targetOwnerVersion',[],block),read(p,a.PoolVault,'firstoBatchPurchaseVersion',[],block),read(p,a.BudgetPortfolioVault,'OFFICIAL_FACTORY',[],block)]);
  need(same(factory,a.factory) && version === 1n && batchVersion === 1n && same(portfolioFactory,a.portfolioFactory),'Reviewed business versions or factory bindings differ.');
  for (const [secondary,dispatcher,official,implementation] of [[a.CoreGovernance24Beacon,a.CoreGovernance24Dispatcher,a.factory,a.PoolVault],
    [a.PortfolioGovernance24Beacon,a.PortfolioGovernance24Dispatcher,a.portfolioFactory,a.BudgetPortfolioVault]]) {
    const [owner,current,bound,dispatchFactory,dispatchBeacon]=await settleReads([read(p,secondary,'owner',[],block),read(p,secondary,'implementation',[],block),
      read(p,secondary,'OFFICIAL_FACTORY',[],block),read(p,dispatcher,'OFFICIAL_FACTORY',[],block),read(p,dispatcher,'SECONDARY_BEACON',[],block)]);
    need(same(owner,a.PoolTimelock24) && same(current,implementation) && same(bound,official) && same(dispatchFactory,official)
      && same(dispatchBeacon,secondary),'Deployed secondary beacon or dispatcher storage/immutables differ.');
  }
  return {businessDelaySeconds:86400};
}

/** Read-only, finalized proof. JSON flags are never approval or a completion capability. */
export async function validateGovernance24UpgradePreflight(p,suppliedInput,suppliedOptions={}) {
  const input=snapshotGovernance24UpgradeInput(suppliedInput);
  const options=freeze({phase:suppliedOptions.phase,deployments:JSON.parse(JSON.stringify(suppliedOptions.deployments ?? {})),
    plan:suppliedOptions.plan ? JSON.parse(JSON.stringify(suppliedOptions.plan)) : undefined,
    scheduleTxHash:suppliedOptions.scheduleTxHash,executeTxHash:suppliedOptions.executeTxHash,
    cancellationTxHashes:JSON.parse(JSON.stringify(suppliedOptions.cancellationTxHashes ?? {})),
    snapshot:suppliedOptions.snapshot ? {number:suppliedOptions.snapshot.number,hash:suppliedOptions.snapshot.hash,timestamp:suppliedOptions.snapshot.timestamp} : undefined});
  const phase=options.phase ?? 'prepared';need(['prepared','unscheduled','scheduled','done'].includes(phase),'Unknown governance migration phase.');
  const review=validateGovernance24UpgradeReview(input);reviewInputs.set(review,input.predecessorInput);
  const c=await context(p,options.snapshot),deployments=options.deployments ?? {},names=governance24UpgradeDeploymentOrder.slice(0,Object.keys(deployments).length);
  need(Object.keys(deployments).sort().join(',') === [...names].sort().join(',') && (phase === 'prepared' || names.length === governance24UpgradeDeploymentOrder.length),'Deployments must be the exact confirmed dependency prefix.');
  const claims={},proofs=[],hashes=new Set();
  for (const name of names) {
    const d=deployments[name],hash=d?.txHash;need(HASH.test(hash ?? '') && !hashes.has(hash.toLowerCase()),'Distinct deployment transaction hashes are required.');hashes.add(hash.toLowerCase());
    const prepared=prepareGovernance24UpgradeDeployment(name,input,{deploymentsPrefix:claims}),proof=await transaction(p,hash,c),deployed=address(d.address);
    need(proof.tx.to === null && proof.receipt.to === null && proof.tx.value === 0n && same(proof.tx.from,review.deployer)
      && same(proof.receipt.contractAddress,deployed) && same(getCreateAddress({from:proof.tx.from,nonce:proof.tx.nonce}),deployed)
      && same(proof.tx.data,prepared.data),'Deployment CREATE nonce, sender, value or exact linked initcode differs.');
    need(!proofs.length || before(proofs.at(-1),proof),'Deployment dependency inclusion order differs.');
    const addresses={...review.addresses,proposer:review.proposer,...claims,[name]:deployed},artifact=input.upgradeBundle.artifacts[governance24ArtifactNames[name]];
    need(same(await p.getCode(deployed,c.block.number),governance24ExpectedRuntime(artifact,addresses,deployed,name)),`Confirmed deployment runtime differs: ${name}.`);
    claims[name]=deployed;proofs.push(proof);
  }
  let plan=null,scheduledProof=null,op={operation:null,readyAt:null,codeUpgradeComplete:false,governanceMigrationComplete:false};
  if (names.length === governance24UpgradeDeploymentOrder.length) {
    plan=buildGovernance24UpgradePlan({...input,replacements:claims,salt:options.plan?.salt ?? input.salt,delaySeconds:options.plan?.delaySeconds ?? input.delaySeconds});
    if (options.plan) need(evidenceDigest(plan) === evidenceDigest(options.plan),'Plan differs from the complete fixed atomic migration inventory.');
    await candidateGraph(p,review,c,plan);
  }
  const cancelled=new Set(),cancellationProofs=[];
  const cancellationKeys=Object.keys(options.cancellationTxHashes).map(id=>plan?.cancellations.find(op=>same(op.operationId,id)||same(op.id,id))?.operationId.toLowerCase());
  need(cancellationKeys.every(Boolean),'Cancellation hash map contains an unreviewed operation.');
  need(new Set(cancellationKeys).size===cancellationKeys.length,'Cancellation operation IDs repeat.');
  need([...cancellationKeys].sort().join(',')===(plan?.cancellations ?? []).slice(0,cancellationKeys.length).map(op=>op.operationId.toLowerCase()).sort().join(','),
    'Cancellation receipts must be the exact confirmed prerequisite prefix.');
  for(const prerequisite of plan?.cancellations ?? []) {
    const supplied=Object.entries(options.cancellationTxHashes).find(([id])=>same(id,prerequisite.operationId)||same(id,prerequisite.id))?.[1];
    if(!supplied){need(phase==='prepared','Conflicting covered original pending operation requires the user-signed canonical cancellation receipt before migration schedule or execute.');continue;}
    const proof=await transaction(p,supplied,c);need(!hashes.has(proof.tx.hash.toLowerCase()),'Cancellation, deployment or operation hashes repeat.');hashes.add(proof.tx.hash.toLowerCase());
    need(before(proofs.at(-1),proof),'Cancellation precedes the confirmed complete dependency deployments.');
    await verifyGovernance24OperationReceipt(p,{...proof,finalized:c.finalized,expected:{input,plan,operation:'cancel',operationId:prerequisite.operationId,
      to:plan.timelock,from:review.proposer,data:prerequisite.data,dataHash:keccak256(prerequisite.data)}});
    const beforeBlock=await p.getBlock(proof.receipt.blockNumber-1),afterBlock=await p.getBlock(proof.receipt.blockNumber);
    need(beforeBlock?.number >= review.catalog.anchor.blockNumber,'Cancellation history lacks the independent baseline anchor.');
    const [role,oldTimestamp,afterTimestamp]=await settleReads([read(p,plan.timelock,'hasRole',[roles.CANCELLER_ROLE,review.proposer],beforeBlock),
      read(p,plan.timelock,'getTimestamp',[prerequisite.operationId],beforeBlock),read(p,plan.timelock,'getTimestamp',[prerequisite.operationId],afterBlock)]);
    need(role===true&&oldTimestamp===BigInt(prerequisite.originalOperation.timestamp)&&afterTimestamp===0n,'Cancellation lacks historical role or exact pending-to-zero transition.');
    cancelled.add(prerequisite.operationId.toLowerCase());cancellationProofs.push(proof);proofs.push(proof);
  }
  const graphInfo=await graph(p,review,c,plan,phase === 'done',cancelled);
  if (input.signer) need(same(input.signer,review.proposer),'Connect the reviewed governance proposer.');
  if (plan && phase !== 'prepared') {
    const id=plan.operationId,to=plan.timelock,block=c.block;
    const [chainId,exists,ready,done,timestamp]=await settleReads([read(p,to,'hashOperationBatch',[plan.targets,plan.values,plan.payloads,plan.predecessor,plan.salt],block),
      read(p,to,'isOperation',[id],block),read(p,to,'isOperationReady',[id],block),read(p,to,'isOperationDone',[id],block),read(p,to,'getTimestamp',[id],block)]);
    need(same(chainId,id),'Old Timelock computes a different complete batch identity.');
    if (phase === 'unscheduled') need(!exists && !ready && !done && timestamp === 0n,'Migration salt is already used.');
    else {
      const scheduled=await transaction(p,options.scheduleTxHash,c);need(!hashes.has(scheduled.tx.hash.toLowerCase()),'Operation and deployment hashes repeat.');hashes.add(scheduled.tx.hash.toLowerCase());
      scheduledProof=scheduled;
      need(before(proofs.at(-1),scheduled),'Schedule precedes confirmed dependency deployment.');
      await verifyGovernance24OperationReceipt(p,{...scheduled,finalized:c.finalized,expected:{input,plan,operation:'schedule',to,from:review.proposer,data:plan.scheduleData,dataHash:keccak256(plan.scheduleData)}});
      proofs.push(scheduled);const readyAt=BigInt(scheduled.block.timestamp)+BigInt(plan.delaySeconds);
      need(BigInt(plan.delaySeconds) >= BigInt(graphInfo.legacyRecoveryDelaySeconds),'Migration delay is below the actual original Timelock minimum.');
      if (phase === 'scheduled') need(exists && !done && timestamp === readyAt && ready === (BigInt(block.timestamp) >= readyAt),'Original 48-hour waiting state differs.');
      else {
        const executed=await transaction(p,options.executeTxHash,c);need(!hashes.has(executed.tx.hash.toLowerCase()),'Operation transaction hashes repeat.');
        need(before(scheduled,executed) && BigInt(executed.block.timestamp) >= readyAt,'Migration executed before the full original delay.');
        await verifyGovernance24OperationReceipt(p,{...executed,finalized:c.finalized,expected:{input,plan,operation:'execute',to,from:executed.tx.from,data:plan.executeData,dataHash:keccak256(plan.executeData)}});
        need(exists && done && !ready && timestamp === 1n,'Complete original migration is not done.');
        const beforeBlock=await p.getBlock(executed.receipt.blockNumber-1);
        need(beforeBlock?.number >= review.catalog.anchor.blockNumber,'Missing pre-execution graph anchor.');
        await graph(p,review,{...c,block:beforeBlock},plan,false,cancelled);
        proofs.push(executed);
      }
      need(readyAt <= BigInt(Number.MAX_SAFE_INTEGER),'Migration timestamp exceeds safe display range.');
    }
    op={operation:phase === 'done' ? 'done' : phase === 'unscheduled' ? 'unscheduled' : ready ? 'ready' : 'waiting',
      ready:phase === 'scheduled' && ready,readyAt:timestamp > 1n ? Number(timestamp) : null,timelockTimestamp:timestamp.toString(),
      operationId:id,codeUpgradeComplete:phase === 'done',governanceMigrationComplete:phase === 'done'};
  }
  const legacyScheduleWindow=await newLegacySchedules(p,review,c,plan,scheduledProof);
  await recheck(p,c,review,proofs);
  const result=freeze({...graphInfo,...op,phase,blockNumber:c.block.number,blockHash:c.block.hash,checkedAt:new Date().toISOString(),
    proposer:review.proposer,deployer:review.deployer,baselineVerified:true,coverageVerified:true,
    businessDelaySeconds:plan ? 86400 : null,verifiedDeploymentNames:names,replacements:claims,
    deployments:Object.fromEntries(names.map(name=>[name,{address:claims[name],txHash:deployments[name].txHash}])),
    replacementDeploymentVerified:names.length === governance24UpgradeDeploymentOrder.length,
    candidateArtifactDigest:input.trustedUpgradeArtifactDigest,reviewCatalogDigest:input.trustedReviewCatalogDigest,
    confirmedCancellationIds:[...cancelled],cancellationTxHashes:Object.fromEntries(cancellationProofs.map(proof=>{
      const op=plan.cancellations.find(item=>logs(proof,plan.timelock,'Cancelled').some(log=>same(events.parseLog(log).args.id,item.operationId)));
      return [op.operationId,proof.tx.hash];
    })),
    codehash:plan ? Object.fromEntries(plan.deployments.map(d=>[d.name,d.codehash])) : {},
    scope:review.catalog.coverage.scope,legacyScheduleWindow});
  if (phase === 'done') completed.add(result);return result;
}
export function governance24VerifiedUpgrade(proof) { need(completed.has(proof),'Unverified complete governance migration.');return proof; }
