import { getAddress, parseEther, parseUnits } from 'ethers';

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
      || step.receipt !== undefined && (!isObject(step.receipt) || !HASH.test(step.receipt.blockHash)
        || !Number.isSafeInteger(step.receipt.blockNumber) || step.receipt.blockNumber < 0
        || ![0,1].includes(step.receipt.status) || !DECIMAL.test(step.receipt.feeWei)
        || !DECIMAL.test(step.receipt.gasUsed) || !DECIMAL.test(step.receipt.gasPrice)
        || BigInt(step.receipt.gasUsed) * BigInt(step.receipt.gasPrice) !== BigInt(step.receipt.feeWei))
      || step.previousTxHashes !== undefined && (!Array.isArray(step.previousTxHashes)
        || step.previousTxHashes.some(hash => !HASH.test(hash))
        || new Set(step.previousTxHashes.map(hash => hash.toLowerCase())).size !== step.previousTxHashes.length)
      || step.rejectionKind !== undefined && !['pre-send','wallet-rejected'].includes(step.rejectionKind)
      || step.replacementHash !== undefined && !HASH.test(step.replacementHash)) bad();
    if (['signing','submitted','uncertain','confirmed'].includes(step.status)
      && (step.nonce === undefined || !step.dataHash || !DECIMAL.test(step.gasLimit)
        || !DECIMAL.test(step.gasPriceWei) || !DECIMAL.test(step.maxFeeWei))) bad();
    if (['submitted','confirmed'].includes(step.status) && !step.txHash) bad();
    if (step.status === 'confirmed' && (!step.receipt || step.receipt.status !== 1)) bad();
    if (i > 0 && step.status !== 'waiting' && record.steps[i - 1].status !== 'confirmed') bad();
  }
  if (record.status === 'complete' && (record.steps.some(step => step.status !== 'confirmed') || !record.authorityAddress)) bad();
  if (record.status === 'aborted' && !record.steps.some(step => ['failed','cancelled','replaced'].includes(step.status))) bad();
  if (BigInt(record.spentWei) !== record.steps.reduce((sum, step) => sum + BigInt(step.receipt?.feeWei ?? '0'), 0n)) bad();
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
    for (const field of ['id','nonce','dataHash','address']) {
      if (old[field] !== undefined && old[field] !== item[field]) conflict();
    }
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
