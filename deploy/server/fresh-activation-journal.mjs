import { ContractFactory, Interface, getAddress, getCreateAddress, keccak256, parseEther, parseUnits } from 'ethers';
import { isFreshActivationWrapper, verifyWrappedFreshActivation } from '../shared/fresh-activation-chain-proof.mjs';

export const FRESH_ACTIVATION_STEPS = [
  'deployAuthority', 'coreOperator', 'coreTreasury', 'budgetOperator',
  'budgetTreasury', 'coreOwner', 'budgetOwner',
];
export const FRESH_ADMIN_ONE = getAddress('0x7674fa446D42b1f7f150DC5e678cc525d275Ea53');
export const FRESH_ADMIN_TWO = getAddress('0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb');
const HASH = /^0x[\da-f]{64}$/i;
const DECIMAL = /^(0|[1-9]\d*)$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const validReceipt = receipt => isObject(receipt) && HASH.test(receipt.blockHash)
  && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber >= 0
  && [0,1].includes(receipt.status) && DECIMAL.test(receipt.feeWei)
  && DECIMAL.test(receipt.gasUsed) && DECIMAL.test(receipt.gasPrice)
  && BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice) === BigInt(receipt.feeWei);

export function validateFreshActivation(record, account, genesis, expectedGasWallet) {
  const bad = () => { throw new Error('Invalid fresh activation journal.'); };
  if (!isObject(record) || !isObject(genesis) || genesis.status !== 'complete' || genesis.kind !== 'integrated-v2'
    || record.schemaVersion !== 1 || record.kind !== 'fresh-authority' || record.chainId !== 56
    || !sameAddress(record.account, account) || !sameAddress(genesis.account, account)
    || record.deploymentId !== genesis.id || record.genesisArtifactDigest !== genesis.artifactDigest
    || !HASH.test(record.genesisArtifactDigest) || !sameAddress(genesis.input?.ownerMultisig, account)
    || !sameAddress(genesis.input?.operator, account) || !sameAddress(genesis.input?.treasury, account)
    || !isObject(record.genesis) || !sameAddress(record.genesis.factory, genesis.addresses?.factory)
    || !sameAddress(record.genesis.portfolioFactory, genesis.addresses?.portfolioFactory)
    || !sameAddress(record.genesis.timelock, genesis.addresses?.timelock)
    || !sameAddress(record.genesis.shareMarket, genesis.addresses?.shareMarket)
    || !sameAddress(record.genesis.portfolioMarket, genesis.addresses?.portfolioShareMarket)
    || !isObject(record.genesis.codehash)
    || !sameAddress(record.administratorOne, FRESH_ADMIN_ONE)
    || !sameAddress(record.administratorTwo, FRESH_ADMIN_TWO)
    || !expectedGasWallet || !sameAddress(record.gasWallet, expectedGasWallet)
    || !['ready','paused','complete','aborted'].includes(record.status)
    || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
    || !/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(record.maxGasBudgetBnb)
    || !/^(0|[1-9]\d*)(?:\.\d{1,9})?$/.test(record.gasPriceCapGwei)
    || !DECIMAL.test(record.spentWei) || !Array.isArray(record.steps)
    || record.steps.length !== FRESH_ACTIVATION_STEPS.length) bad();
  for (const [name, verifiedName] of Object.entries({
    factory: 'factory', portfolioFactory: 'portfolioFactory', shareMarket: 'shareMarket',
    portfolioMarket: 'portfolioShareMarket', timelock: 'timelock',
  })) {
    if (!HASH.test(record.genesis.codehash[name])
      || record.genesis.codehash[name] !== genesis.verification?.code?.[verifiedName]?.codehash) bad();
  }
  try {
    if (parseEther(record.maxGasBudgetBnb) <= 0n || parseUnits(record.gasPriceCapGwei, 'gwei') <= 0n) bad();
    for (const address of [record.genesis.factory, record.genesis.portfolioFactory, record.genesis.timelock,
      record.administratorOne, record.administratorTwo, record.gasWallet]) {
      if (getAddress(address) === '0x0000000000000000000000000000000000000000') bad();
    }
  } catch { bad(); }
  if (sameAddress(record.gasWallet, record.account) || sameAddress(record.gasWallet, FRESH_ADMIN_ONE)
    || sameAddress(record.gasWallet, FRESH_ADMIN_TWO)) bad();
  if (record.authorityAddress !== undefined) {
    try { if (!sameAddress(record.authorityAddress, getAddress(record.authorityAddress))) bad(); }
    catch { bad(); }
  }
  for (let i = 0; i < record.steps.length; i++) {
    const step = record.steps[i];
    if (!isObject(step) || step.id !== FRESH_ACTIVATION_STEPS[i]
      || !['waiting','signing','submitted','uncertain','confirmed','rejected','failed','cancelled','replaced'].includes(step.status)
      || step.nonce !== undefined && (!Number.isSafeInteger(step.nonce) || step.nonce < 0)
      || step.dataHash !== undefined && !HASH.test(step.dataHash)
      || step.txHash !== undefined && !HASH.test(step.txHash)
      || step.receipt !== undefined && !validReceipt(step.receipt)
      || step.previousTxHashes !== undefined && (!Array.isArray(step.previousTxHashes)
        || step.previousTxHashes.some(hash => !HASH.test(hash))
        || new Set(step.previousTxHashes.map(hash => hash.toLowerCase())).size !== step.previousTxHashes.length)
      || step.rejectionKind !== undefined && !['pre-send','wallet-rejected','nonce-witnessed'].includes(step.rejectionKind)
      || step.replacementHash !== undefined && !HASH.test(step.replacementHash)) bad();
    if (step.attempts !== undefined && (!Array.isArray(step.attempts)
      || step.attempts.some((attempt, attemptIndex) => !isObject(attempt)
        || attempt.id !== step.id || !['failed','replaced'].includes(attempt.status)
        || !Number.isSafeInteger(attempt.nonce) || attempt.nonce < 0
        || attemptIndex > 0 && attempt.nonce <= step.attempts[attemptIndex - 1].nonce
        || !HASH.test(attempt.dataHash) || !HASH.test(attempt.txHash)
        || attempt.replacementHash !== undefined && !HASH.test(attempt.replacementHash)
        || !validReceipt(attempt.receipt)
        || attempt.status === 'failed' && attempt.receipt.status !== 0
        || attempt.status === 'replaced' && (attempt.receipt.status !== 1 || !attempt.replacementHash
          || attempt.replacementHash.toLowerCase() === attempt.txHash.toLowerCase())
        || !isObject(attempt.recovery) || !HASH.test(attempt.recovery.winnerHash)
        || attempt.recovery.winnerHash.toLowerCase()
          !== (attempt.replacementHash ?? attempt.txHash).toLowerCase()
        || !Number.isSafeInteger(attempt.recovery.finalizedBlockNumber)
        || attempt.recovery.finalizedBlockNumber < attempt.receipt.blockNumber
        || !HASH.test(attempt.recovery.finalizedBlockHash)))) bad();
    if (step.attempts?.length && step.nonce !== undefined
      && step.nonce <= step.attempts.at(-1).nonce) bad();
    if (['signing','submitted','uncertain','confirmed'].includes(step.status)
      && (step.nonce === undefined || !step.dataHash || !DECIMAL.test(step.gasLimit)
        || !DECIMAL.test(step.gasPriceWei) || !DECIMAL.test(step.maxFeeWei))) bad();
    if (['submitted','confirmed'].includes(step.status) && !step.txHash) bad();
    if (step.status === 'confirmed' && (!step.receipt || step.receipt.status !== 1)) bad();
    if (step.rejectionKind === 'nonce-witnessed' && (step.status !== 'rejected' || step.txHash || step.receipt
      || step.nonce === undefined || !step.dataHash || !DECIMAL.test(step.gasLimit)
      || !DECIMAL.test(step.gasPriceWei) || BigInt(step.gasPriceWei) <= 0n
      || !DECIMAL.test(step.maxFeeWei)
      || BigInt(step.gasLimit) * BigInt(step.gasPriceWei) !== BigInt(step.maxFeeWei))) bad();
    if (i > 0 && step.status !== 'waiting' && record.steps[i - 1].status !== 'confirmed') bad();
  }
  if (record.status === 'complete' && (record.steps.some(step => step.status !== 'confirmed') || !record.authorityAddress)) bad();
  if (record.status === 'aborted' && !record.steps.some(step => ['failed','cancelled','replaced'].includes(step.status))) bad();
  if (BigInt(record.spentWei) !== record.steps.reduce((sum, step) => sum
    + BigInt(step.receipt?.feeWei ?? '0')
    + (step.attempts ?? []).reduce((fees, attempt) => fees + BigInt(attempt.receipt.feeWei), 0n), 0n)) bad();
  return record;
}

export function validateFreshActivationProgress(previous, next) {
  const conflict = () => { throw new Error('Fresh activation journal identity or progress changed.'); };
  for (const field of ['schemaVersion','kind','chainId','account','deploymentId','genesisArtifactDigest',
    'administratorOne','administratorTwo','gasWallet','createdAt']) {
    if (previous[field] !== next[field]) conflict();
  }
  if (canonical(previous.genesis) !== canonical(next.genesis)) conflict();
  if (previous.status === 'complete' && next.status !== 'complete' || previous.status === 'aborted' && next.status !== 'aborted') conflict();
  if (parseEther(next.maxGasBudgetBnb) < parseEther(previous.maxGasBudgetBnb)
    || parseUnits(next.gasPriceCapGwei, 'gwei') < parseUnits(previous.gasPriceCapGwei, 'gwei')) conflict();
  if (previous.authorityAddress && !sameAddress(previous.authorityAddress, next.authorityAddress)) conflict();
  for (let i = 0; i < FRESH_ACTIVATION_STEPS.length; i++) {
    const old = previous.steps[i], item = next.steps[i];
    if (canonical(old.attempts ?? []) !== canonical(item.attempts ?? [])) conflict();
    for (const field of ['id','nonce','dataHash','address']) {
      if (old[field] !== undefined && old[field] !== item[field]) conflict();
    }
    if (item.rejectionKind === 'nonce-witnessed' && old.rejectionKind !== 'nonce-witnessed') conflict();
    if (old.rejectionKind === 'nonce-witnessed'
      && ['gasLimit','gasPriceWei','maxFeeWei'].some(field => old[field] !== item[field])) conflict();
    if (old.txHash !== undefined && old.txHash !== item.txHash
      && !(item.finalizedRecovery === true && item.status === 'confirmed'
        && item.previousTxHashes?.some(hash => hash.toLowerCase() === old.txHash.toLowerCase()))) conflict();
    const history = old.previousTxHashes ?? [], nextHistory = item.previousTxHashes ?? [];
    if (history.some((hash, index) => hash !== nextHistory[index])) conflict();
    if (old.replacementHash !== undefined && old.replacementHash !== item.replacementHash) conflict();
    const definiteNoSend = old.status === 'signing' && item.status === 'rejected'
      && ['pre-send','wallet-rejected'].includes(item.rejectionKind)
      && !old.txHash && !item.txHash && !old.receipt && !item.receipt;
    if (old.status === 'confirmed' && item.status !== 'confirmed'
      || ['failed','cancelled','replaced'].includes(old.status) && item.status !== old.status
      || ['signing','submitted','uncertain'].includes(old.status) && ['waiting','rejected'].includes(item.status)
        && !definiteNoSend) conflict();
    if (old.receipt && canonical(old.receipt) !== canonical(item.receipt)) conflict();
  }
  if (BigInt(next.spentWei) < BigInt(previous.spentWei)) conflict();
}

const FACTORY_READ = new Interface(['function owner() view returns(address)',
  'function operator() view returns(address)', 'function treasury() view returns(address)',
  'function timelock() view returns(address)', 'function shareMarket() view returns(address)',
  'function poolCount() view returns(uint256)', 'function portfolioCount() view returns(uint256)',
  'function creationPaused() view returns(bool)']);
const FACTORY_WRITE = new Interface(['function setOperator(address)',
  'function setTreasury(address)', 'function transferOwnership(address)']);
const TIMELOCK_READ = new Interface(['function getMinDelay() view returns(uint256)',
  'function PROPOSER_ROLE() view returns(bytes32)', 'function CANCELLER_ROLE() view returns(bytes32)',
  'function hasRole(bytes32,address) view returns(bool)']);
const AUTHORITY_READ = new Interface(['function owner() view returns(address)',
  'function coreFactory() view returns(address)', 'function budgetFactory() view returns(address)',
  'function administratorOne() view returns(address)', 'function administratorTwo() view returns(address)',
  'function gasWallet() view returns(address)']);

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ANCESTRY_SEGMENT_BLOCKS = 4096;
const ANCESTRY_READ_BATCH = 128;
const MAX_ANCESTRY_BLOCKS = 1_000_000;
function authorityRuntimeMatches(artifact,actual) {
  if (!artifact || !/^0x[\da-f]+$/i.test(artifact.deployedBytecode ?? '')
    || artifact.deployedBytecode==='0x'
    || Object.keys(artifact.deployedLinkReferences??{}).length
    || !/^0x[\da-f]+$/i.test(actual) || actual==='0x') return false;
  let expected=artifact.deployedBytecode.slice(2).toLowerCase();
  let observed=actual.slice(2).toLowerCase();
  if (expected.length!==observed.length) return false;
  for (const ranges of Object.values(artifact.immutableReferences??{})) for (const range of ranges) {
    const {start,length}=range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)
      || start<0 || length<=0 || (start+length)*2>expected.length) return false;
    expected=expected.slice(0,start*2)+'0'.repeat(length*2)+expected.slice((start+length)*2);
    observed=observed.slice(0,start*2)+'0'.repeat(length*2)+observed.slice((start+length)*2);
  }
  return expected===observed;
}
const EXPECTED_ACTIONS = g => [null,
  [g.factory,'setOperator'], [g.factory,'setTreasury'],
  [g.portfolioFactory,'setOperator'],[g.portfolioFactory,'setTreasury'],
  [g.factory,'transferOwnership'],[g.portfolioFactory,'transferOwnership']];

// RPCs can return valid receipts and finalized blocks from different forks.
// Every parent edge is read and checked, including each segment boundary.
// The million-block ceiling bounds per-request work; a longer gap fails closed.
async function proveAncestor(provider, ancestorNumber, ancestorHash, descendant) {
  if (!Number.isSafeInteger(descendant?.number) || !HASH.test(descendant?.hash)
    || descendant.number < ancestorNumber || descendant.number - ancestorNumber > MAX_ANCESTRY_BLOCKS) return false;
  let expected = descendant.hash;
  for (let segmentTop=descendant.number; segmentTop>=ancestorNumber;) {
    const segmentBottom=Math.max(ancestorNumber,segmentTop-ANCESTRY_SEGMENT_BLOCKS+1);
    for (let batchTop=segmentTop; batchTop>=segmentBottom;) {
      const batchBottom=Math.max(segmentBottom,batchTop-ANCESTRY_READ_BATCH+1);
      const numbers=Array.from({length:batchTop-batchBottom+1},(_,i)=>batchTop-i);
      const blocks=await Promise.all(numbers.map(number=>provider.getBlock(number)));
      for (let i=0;i<numbers.length;i++) {
        const number=numbers[i],block=blocks[i];
        if (!block || block.number!==number || block.hash?.toLowerCase()!==expected.toLowerCase()) return false;
        if (number===ancestorNumber) return block.hash.toLowerCase()===ancestorHash.toLowerCase();
        if (!HASH.test(block.parentHash)) return false;
        expected=block.parentHash;
      }
      batchTop=batchBottom-1;
    }
    // expected is the verified parent hash at the next segment's top.
    segmentTop=segmentBottom-1;
  }
  return false;
}

// A finalized block remains on the canonical chain. For old receipts, compare
// their height and hash directly against the current canonical block at that
// height; walking every intervening parent would make recovery time grow with
// the number of days since the attempt. Callers re-read both the receipt block
// and current finalized anchor after state proofs to catch a racing reorg.
async function matchesFinalizedBlock(provider, number, hash, finalized) {
  if (!Number.isSafeInteger(number) || number < 0 || !HASH.test(hash)
    || !Number.isSafeInteger(finalized?.number) || !HASH.test(finalized?.hash)
    || number > finalized.number) return false;
  const block = number === finalized.number ? finalized : await provider.getBlock(number);
  return block?.number === number && block.hash?.toLowerCase() === hash.toLowerCase();
}

async function currentChainAnchor(provider) {
  const [finalized,latest] = await Promise.all([provider.getBlock('finalized'),provider.getBlock('latest')]);
  if (!finalized?.hash || !latest?.hash
    || !await proveAncestor(provider,finalized.number,finalized.hash,latest))
    throw new Error('Finalized fresh activation recovery proof failed.');
  return {finalized,latest};
}

async function assertAnchorStillCanonical(provider, receipts, finalized, latest, refreshedAnchors=[]) {
  const [winnerAgain,finalizedAgain,latestAgain,refreshedAgain,finalizedTag,latestTag]=await Promise.all([
    Promise.all(receipts.map(receipt=>provider.getBlock(receipt.blockNumber))),
    provider.getBlock(finalized.number),provider.getBlock(latest.number),
    Promise.all(refreshedAnchors.map(block=>provider.getBlock(block.number))),
    provider.getBlock('finalized'),provider.getBlock('latest'),
  ]);
  if (receipts.some((receipt,index)=>winnerAgain[index]?.hash!==receipt.blockHash)
    || finalizedAgain?.hash!==finalized.hash
    || latestAgain?.hash!==latest.hash
    || refreshedAnchors.some((block,index)=>refreshedAgain[index]?.hash!==block.hash)
    || !await proveAncestor(provider,finalized.number,finalized.hash,finalizedTag)
    || !await proveAncestor(provider,latest.number,latest.hash,latestTag)
    || !await proveAncestor(provider,finalizedTag.number,finalizedTag.hash,latestTag))
    throw new Error('Finalized fresh activation recovery proof failed.');
  return {finalizedTag,latestTag};
}

export async function verifyFreshPrefixAt(provider, record, genesis, account, completed, block, bundle) {
  const deny = () => { throw new Error('Finalized fresh activation recovery proof failed.'); };
  const g=record.genesis;
  const read=async(to,iface,name,args=[])=>iface.decodeFunctionResult(name,
    await provider.call({to,data:iface.encodeFunctionData(name,args),blockTag:block.number}))[0];
  for (const [name,address] of Object.entries({factory:g.factory,portfolioFactory:g.portfolioFactory,
    shareMarket:g.shareMarket,portfolioMarket:g.portfolioMarket,timelock:g.timelock})) {
    const code=await provider.getCode(address,block.number);
    if (code==='0x' || keccak256(code)!==g.codehash[name]) deny();
  }
  for (const [proxy,label] of [[g.factory,'FreshPoolFactory'],
    [g.portfolioFactory,'BudgetPortfolioFactory']]) {
    const implementation=genesis?.addresses?.[label];
    const verified=genesis?.verification?.code?.[label];
    if (!implementation || !sameAddress(verified?.address,implementation)
      || !HASH.test(verified?.codehash)) deny();
    const slot=await provider.getStorage(proxy,IMPLEMENTATION_SLOT,block.number);
    if (!HASH.test(slot) || !sameAddress(`0x${slot.slice(-40)}`,implementation)) deny();
    const code=await provider.getCode(implementation,block.number);
    if (code==='0x' || keccak256(code)!==verified.codehash) deny();
  }
  for (const [target,market,isBudget] of [[g.factory,g.shareMarket,false],
    [g.portfolioFactory,g.portfolioMarket,true]]) {
    const owner=await read(target,FACTORY_READ,'owner');
    const operator=await read(target,FACTORY_READ,'operator');
    const treasury=await read(target,FACTORY_READ,'treasury');
    const expectedOwner=isBudget ? completed>=7?g.timelock:account : completed>=6?g.timelock:account;
    const expectedOperator=isBudget ? completed>=4?record.authorityAddress:account
      : completed>=2?record.authorityAddress:account;
    const expectedTreasury=isBudget ? completed>=5?record.authorityAddress:account
      : completed>=3?record.authorityAddress:account;
    if (!sameAddress(owner,expectedOwner) || !sameAddress(operator,expectedOperator)
      || !sameAddress(treasury,expectedTreasury)
      || !sameAddress(await read(target,FACTORY_READ,'timelock'),g.timelock)
      || !sameAddress(await read(target,FACTORY_READ,'shareMarket'),market)
      || await read(target,FACTORY_READ,isBudget?'portfolioCount':'poolCount')!==0n
      || await read(target,FACTORY_READ,'creationPaused')!==false) deny();
  }
  const proposer=await read(g.timelock,TIMELOCK_READ,'PROPOSER_ROLE');
  const canceller=await read(g.timelock,TIMELOCK_READ,'CANCELLER_ROLE');
  if (await read(g.timelock,TIMELOCK_READ,'getMinDelay')<48n*60n*60n
    || await read(g.timelock,TIMELOCK_READ,'hasRole',[proposer,account])!==true
    || await read(g.timelock,TIMELOCK_READ,'hasRole',[canceller,account])!==true) deny();
  if (completed===0) {
    if (record.authorityAddress) deny();
  } else {
    if (!record.authorityAddress || !Number.isSafeInteger(record.steps[0]?.nonce)
      || !sameAddress(record.authorityAddress,
        getCreateAddress({from:account,nonce:record.steps[0].nonce}))
      || !authorityRuntimeMatches(bundle?.artifacts?.PlatformAuthority,
        await provider.getCode(record.authorityAddress,block.number))) deny();
    for (const [name,expected] of Object.entries({owner:g.timelock,coreFactory:g.factory,
      budgetFactory:g.portfolioFactory,administratorOne:record.administratorOne,
      administratorTwo:record.administratorTwo,gasWallet:record.gasWallet})) {
      if (!sameAddress(await read(record.authorityAddress,AUTHORITY_READ,name),expected)) deny();
    }
  }
}

async function expectedDataHash(record,index,bundle) {
  if (index===0) {
    const artifact=bundle?.artifacts?.PlatformAuthority;
    if (!artifact?.abi || !/^0x[\da-f]+$/i.test(artifact.bytecode)
      || artifact.bytecode==='0x' || Object.keys(artifact.linkReferences??{}).length) return null;
    const tx=await new ContractFactory(artifact.abi,artifact.bytecode).getDeployTransaction(
      record.genesis.factory,record.genesis.portfolioFactory,record.administratorOne,
      record.administratorTwo,record.gasWallet);
    return keccak256(tx.data);
  }
  const [target,method]=EXPECTED_ACTIONS(record.genesis)[index];
  const destination=index>=5?record.genesis.timelock:record.authorityAddress;
  return target && destination ? keccak256(FACTORY_WRITE.encodeFunctionData(method,[destination])) : null;
}

async function proveAttemptWinner(provider,record,genesis,account,index,step,bundle,commonAnchor) {
  const deny=()=>{throw new Error('Finalized fresh activation recovery proof failed.');};
  const winnerHash=step.replacementHash??step.txHash;
  if (!HASH.test(winnerHash) || !validReceipt(step.receipt)
    || step.dataHash!==await expectedDataHash(record,index,bundle)) deny();
  const [tx,receipt,network]=await Promise.all([provider.getTransaction(winnerHash),
    provider.getTransactionReceipt(winnerHash),provider.getNetwork()]);
  if (network?.chainId!==56n || !tx || !receipt || tx.chainId!==56n
    || !sameAddress(tx.hash,winnerHash) || !sameAddress(receipt.hash,winnerHash)
    || !sameAddress(tx.from,account) || !sameAddress(receipt.from,account)
    || tx.nonce!==step.nonce || tx.blockNumber!==receipt.blockNumber
    || tx.blockHash!==receipt.blockHash || receipt.blockNumber!==step.receipt.blockNumber
    || receipt.blockHash!==step.receipt.blockHash || receipt.status!==step.receipt.status
    || receipt.gasUsed.toString()!==step.receipt.gasUsed
    || receipt.gasPrice.toString()!==step.receipt.gasPrice
    || receipt.fee.toString()!==step.receipt.feeWei
    || step.status==='failed' && receipt.status!==0
    || step.status==='replaced' && (receipt.status!==1 || !step.replacementHash
      || step.replacementHash.toLowerCase()===step.txHash?.toLowerCase())) deny();
  if (!step.replacementHash) {
    const target=index===0?null:EXPECTED_ACTIONS(record.genesis)[index][0];
    if(isFreshActivationWrapper(tx)) await verifyWrappedFreshActivation(provider,record,step,tx,receipt,{
      historicalPrefix:!commonAnchor,
      verifyPrefix:(completed,block)=>verifyFreshPrefixAt(provider,record,genesis,account,completed,block,bundle),
    });
    else if (!sameAddress(tx.to,target) && !(target===null && tx.to===null)
      || tx.value!==0n || keccak256(tx.data)!==step.dataHash) deny();
  }
  const anchors=commonAnchor??await currentChainAnchor(provider);
  if (!await matchesFinalizedBlock(provider,receipt.blockNumber,receipt.blockHash,anchors.finalized)) deny();
  if (index===0) {
    const predicted=getCreateAddress({from:account,nonce:step.nonce});
    for (const block of [anchors.finalized,anchors.latest]) {
      if (await provider.getCode(predicted,block.number)!=='0x') deny();
    }
  }
  return {winnerHash,receipt,anchors};
}

/** Independent RPC proof required before archiving a failed Stage 2 attempt. */
export async function verifyFinalizedFreshAttempt(provider,record,genesis,account,stepId,nonce,winnerHash,bundle) {
  const deny=()=>{throw new Error('Finalized fresh activation recovery proof failed.');};
  const index=record?.steps?.findIndex(step=>step.status!=='confirmed')??-1;
  const step=record?.steps?.[index];
  if (record?.status!=='aborted' || index<0 || step?.id!==stepId
    || !['failed','replaced'].includes(step.status) || step.nonce!==nonce
    || !HASH.test(winnerHash) || (step.replacementHash??step.txHash)?.toLowerCase()!==winnerHash.toLowerCase()
    || !record.steps.slice(0,index).every(item=>item.status==='confirmed')
    || !record.steps.slice(index+1).every(item=>item.status==='waiting')) deny();
  const proof=await proveAttemptWinner(provider,record,genesis,account,index,step,bundle);
  const {finalized,latest}=proof.anchors;
  for (const block of finalized.hash===latest.hash?[finalized]:[finalized,latest])
    await verifyFreshPrefixAt(provider,record,genesis,account,index,block,bundle);
  const checked=await assertAnchorStillCanonical(provider,[proof.receipt],finalized,latest);
  if (checked.finalizedTag.hash!==finalized.hash)
    await verifyFreshPrefixAt(provider,record,genesis,account,index,checked.finalizedTag,bundle);
  if (checked.latestTag.hash!==latest.hash)
    await verifyFreshPrefixAt(provider,record,genesis,account,index,checked.latestTag,bundle);
  // State reads can race a reorg. Recheck every evidence block after the last
  // role/code call, including both original and refreshed anchors.
  await assertAnchorStillCanonical(provider,[proof.receipt],finalized,latest,
    [checked.finalizedTag,checked.latestTag]);
  const [latestNonce,pendingNonce]=await Promise.all([
    provider.getTransactionCount(account,'latest'),provider.getTransactionCount(account,'pending')]);
  if (latestNonce!==pendingNonce || latestNonce<=nonce) deny();
  return {stepId,nonce,winnerHash,receiptBlockNumber:proof.receipt.blockNumber,
    receiptBlockHash:proof.receipt.blockHash,finalizedBlockNumber:finalized.number,
    finalizedBlockHash:finalized.hash};
}

/** Every archived winner is checked again before the next signing intent. */
export async function verifyRecoveredFreshSigning(provider,record,genesis,account,bundle) {
  const deny=()=>{throw new Error('Finalized fresh activation recovery proof failed.');};
  const index=record?.steps?.findIndex(step=>step.status!=='confirmed')??-1;
  if (index<0) deny();
  const commonAnchor=await currentChainAnchor(provider);
  const receipts=[],archivedAnchors=[];
  for (let i=0;i<=index;i++) for (const attempt of record.steps[i].attempts??[]) {
    const proof=await proveAttemptWinner(provider,record,genesis,account,i,attempt,bundle,commonAnchor);
    const archived=attempt.recovery;
    if (!archived || !Number.isSafeInteger(archived.finalizedBlockNumber)
      || archived.finalizedBlockNumber < proof.receipt.blockNumber
      || !await matchesFinalizedBlock(provider,archived.finalizedBlockNumber,
        archived.finalizedBlockHash,commonAnchor.finalized)) deny();
    receipts.push(proof.receipt);
    archivedAnchors.push({number:archived.finalizedBlockNumber,hash:archived.finalizedBlockHash});
  }
  if (!receipts.length) return;
  for (const block of commonAnchor.finalized.hash===commonAnchor.latest.hash
    ?[commonAnchor.finalized]:[commonAnchor.finalized,commonAnchor.latest])
    await verifyFreshPrefixAt(provider,record,genesis,account,index,block,bundle);
  const checked=await assertAnchorStillCanonical(provider,receipts,
    commonAnchor.finalized,commonAnchor.latest,archivedAnchors);
  if (checked.finalizedTag.hash!==commonAnchor.finalized.hash)
    await verifyFreshPrefixAt(provider,record,genesis,account,index,checked.finalizedTag,bundle);
  if (checked.latestTag.hash!==commonAnchor.latest.hash)
    await verifyFreshPrefixAt(provider,record,genesis,account,index,checked.latestTag,bundle);
  await assertAnchorStillCanonical(provider,receipts,
    commonAnchor.finalized,commonAnchor.latest,[...archivedAnchors,checked.finalizedTag,checked.latestTag]);
}

/** Newly confirmed role operations are independently read before journal acceptance. */
export async function verifyConfirmedFreshActivation(provider,record,previous,genesis,account,bundle) {
  for(let i=1;i<record.steps.length;i++){
    const step=record.steps[i];
    if(step.status!=='confirmed' || previous?.steps?.[i]?.status==='confirmed')continue;
    const [tx,receipt]=await Promise.all([provider.getTransaction(step.txHash),provider.getTransactionReceipt(step.txHash)]);
    if(!tx || !receipt)throw new Error('Confirmed activation receipt is unavailable.');
    if(!isFreshActivationWrapper(tx))continue; // Existing direct envelope validation remains unchanged.
    if(receipt.status!==1 || receipt.blockNumber!==step.receipt.blockNumber
      || receipt.blockHash!==step.receipt.blockHash || receipt.fee.toString()!==step.receipt.feeWei
      || step.dataHash!==await expectedDataHash(record,i,bundle))
      throw new Error('Confirmed wrapped activation differs from the immutable journal.');
    await verifyWrappedFreshActivation(provider,record,step,tx,receipt,{
      includeCurrent:true,
      verifyPrefix:(completed,block)=>verifyFreshPrefixAt(provider,record,genesis,account,completed,block,bundle),
    });
  }
}
