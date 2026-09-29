import { Interface, getAddress, keccak256, parseEther, parseUnits } from 'ethers';

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

/** Independent RPC proof required before archiving a failed Stage 2 attempt. */
export async function verifyFinalizedFreshAttempt(provider, record, account, stepId, nonce, winnerHash) {
  const deny = () => { throw new Error('Finalized fresh activation recovery proof failed.'); };
  const index=record?.steps?.findIndex(step=>step.status!=='confirmed') ?? -1;
  const step=record?.steps?.[index];
  if (record?.status!=='aborted' || index<1 || step?.id!==stepId
    || !['failed','replaced'].includes(step.status) || step.nonce!==nonce
    || !HASH.test(winnerHash) || (step.replacementHash??step.txHash)?.toLowerCase()!==winnerHash.toLowerCase()
    || !validReceipt(step.receipt) || !record.steps.slice(0,index).every(item=>item.status==='confirmed')
    || !record.steps.slice(index+1).every(item=>item.status==='waiting')) deny();
  const [tx,receipt,finalized,network]=await Promise.all([
    provider.getTransaction(winnerHash),provider.getTransactionReceipt(winnerHash),
    provider.getBlock('finalized'),provider.getNetwork(),
  ]);
  if (network?.chainId!==56n || !tx || !receipt || !finalized?.hash
    || tx.chainId!==56n || !sameAddress(tx.from,account) || tx.nonce!==nonce
    || !sameAddress(receipt.from,account) || !sameAddress(tx.hash,winnerHash)
    || !sameAddress(receipt.hash,winnerHash) || tx.blockNumber!==receipt.blockNumber
    || tx.blockHash!==receipt.blockHash || receipt.blockNumber!==step.receipt.blockNumber
    || receipt.blockHash!==step.receipt.blockHash || receipt.status!==step.receipt.status
    || receipt.gasUsed.toString()!==step.receipt.gasUsed
    || receipt.gasPrice.toString()!==step.receipt.gasPrice
    || receipt.fee.toString()!==step.receipt.feeWei
    || finalized.number<receipt.blockNumber
    || step.status==='failed' && receipt.status!==0
    || step.status==='replaced' && (receipt.status!==1 || !step.replacementHash
      || step.replacementHash.toLowerCase()===step.txHash?.toLowerCase())) deny();
  const g=record.genesis;
  const actions=[null,
    [g.factory,'setOperator',record.authorityAddress],
    [g.factory,'setTreasury',record.authorityAddress],
    [g.portfolioFactory,'setOperator',record.authorityAddress],
    [g.portfolioFactory,'setTreasury',record.authorityAddress],
    [g.factory,'transferOwnership',g.timelock],
    [g.portfolioFactory,'transferOwnership',g.timelock]];
  const [target,method,destination]=actions[index];
  if (!destination || keccak256(FACTORY_WRITE.encodeFunctionData(method,[destination]))!==step.dataHash
    || !step.replacementHash && (!sameAddress(tx.to,target) || tx.value!==0n
      || keccak256(tx.data)!==step.dataHash)) deny();
  const receiptBlock=await provider.getBlock(receipt.blockNumber);
  if (receiptBlock?.hash!==receipt.blockHash) deny();
  const block=finalized.number;
  const read=async(to,iface,name,args=[])=>iface.decodeFunctionResult(name,
    await provider.call({to,data:iface.encodeFunctionData(name,args)},block))[0];
  for (const [name,address] of Object.entries({factory:g.factory,portfolioFactory:g.portfolioFactory,
    shareMarket:g.shareMarket,portfolioMarket:g.portfolioMarket,timelock:g.timelock})) {
    const code=await provider.getCode(address,block);
    if (code==='0x' || keccak256(code)!==g.codehash[name]) deny();
  }
  for (const [target,market,isBudget] of [[g.factory,g.shareMarket,false],
    [g.portfolioFactory,g.portfolioMarket,true]]) {
    const owner=await read(target,FACTORY_READ,'owner');
    const operator=await read(target,FACTORY_READ,'operator');
    const treasury=await read(target,FACTORY_READ,'treasury');
    const expectedOwner=isBudget ? index>=7?g.timelock:account : index>=6?g.timelock:account;
    const expectedOperator=isBudget ? index>=4?record.authorityAddress:account
      : index>=2?record.authorityAddress:account;
    const expectedTreasury=isBudget ? index>=5?record.authorityAddress:account
      : index>=3?record.authorityAddress:account;
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
  if (!record.authorityAddress || await provider.getCode(record.authorityAddress,block)==='0x') deny();
  for (const [name,expected] of Object.entries({owner:g.timelock,coreFactory:g.factory,
    budgetFactory:g.portfolioFactory,administratorOne:record.administratorOne,
    administratorTwo:record.administratorTwo,gasWallet:record.gasWallet})) {
    if (!sameAddress(await read(record.authorityAddress,AUTHORITY_READ,name),expected)) deny();
  }
  const [again,finalizedAgain,latestNonce,pendingNonce]=await Promise.all([
    provider.getBlock(receipt.blockNumber),provider.getBlock(block),
    provider.getTransactionCount(account,'latest'),provider.getTransactionCount(account,'pending'),
  ]);
  if (again?.hash!==receipt.blockHash || finalizedAgain?.hash!==finalized.hash
    || latestNonce!==pendingNonce || latestNonce<=nonce) deny();
  return {stepId,nonce,winnerHash,receiptBlockNumber:receipt.blockNumber,
    receiptBlockHash:receipt.blockHash,finalizedBlockNumber:block,
    finalizedBlockHash:finalized.hash};
}
