import { Interface, ZeroAddress, getAddress, keccak256 } from 'ethers';

const poolTuple = '(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline)';
const flexibleTuple = '(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)';
const core = new Interface([
  `function createPool(${poolTuple} params)`,
  `function createPoolWithExpiry(${poolTuple} params,bool enabled)`,
  `function createBudgetChildPool(${poolTuple} params,address subscriber)`,
  `function createFlexiblePool(${poolTuple} params,${flexibleTuple} config)`,
  `function createFlexiblePoolChecked(${poolTuple} params,${flexibleTuple} config,uint32 taskId,uint128 weight)`,
  'function setDepositPaused(bool paused)',
  'function mine(bytes inner)',
]);
const budget = new Interface(['function createPortfolio(uint256 budgetWei,uint256 absoluteCapWei,uint256 unitCapWei,uint64 fundingDeadline,uint64 purchaseDeadline)']);
const reclaim = new Interface(['function reclaim(bytes32 workId)']);

const field = (name, type) => ({ name, type });
const common = [field('nonce', 'uint256'), field('deadline', 'uint256')];
export const AUTHORITY_TYPES = Object.freeze({
  ReviewSale: [field('market','address'),field('pool','address'),field('proposalId','uint256'),field('priceWei','uint128'),field('approved','bool'),...common],
  ReviewChildSale: [field('portfolio','address'),field('proposalId','uint256'),field('approved','bool'),...common],
  SaleReference: [field('market','address'),field('pool','address'),field('priceWei','uint128'),field('observedAt','uint64'),field('digest','bytes32'),...common],
  ClaimFees: [field('markets','address[]'),field('pools','address[]'),field('recipient','address'),...common],
  BuyBudgetOfficial: [field('portfolio','address'),field('child','address'),field('listingId','uint256'),field('maxCost','uint256'),...common],
  BuyBudgetFirsto: [field('portfolio','address'),field('child','address'),field('orderHash','bytes32'),field('maxCost','uint256'),...common],
  PoolParams: [field('circuits','address'),field('circuitId','uint256'),field('targetRaise','uint256'),field('priceCap','uint256'),field('directSeller','address'),field('directPrice','uint256'),field('fundingDeadline','uint64'),field('purchaseDeadline','uint64')],
  FlexibleConfig: [field('minVerifiedWeight','uint128'),field('referencePriceWei','uint256'),field('targetDailyYieldAtomic','uint256'),field('extraBps','uint16'),field('referenceObservedAt','uint64'),field('referenceBlock','uint64'),field('referenceDigest','bytes32')],
  CreatePool: [field('factory','address'),field('operation','string'),field('params','PoolParams'),field('expiryEnabled','bool'),field('subscriber','address'),field('config','FlexibleConfig'),field('expectedTaskId','uint32'),field('expectedReferenceWeight','uint128'),...common],
  CreatePortfolio: [field('factory','address'),field('budgetWei','uint256'),field('absoluteCapWei','uint256'),field('unitCapWei','uint256'),field('fundingDeadline','uint64'),field('purchaseDeadline','uint64'),...common],
  DepositPause: [field('pool','address'),field('paused','bool'),...common],
  Reclaim: [field('pool','address'),field('workId','bytes32'),...common],
});

const pick = (result, names) => Object.fromEntries(names.map((name, index) => [name, result[index]]));
const zeroConfig = Object.freeze({ minVerifiedWeight: 0n, referencePriceWei: 0n, targetDailyYieldAtomic: 0n,
  extraBps: 0n, referenceObservedAt: 0n, referenceBlock: 0n, referenceDigest: '0x' + '00'.repeat(32) });
const poolNames = AUTHORITY_TYPES.PoolParams.map(item => item.name);
const configNames = AUTHORITY_TYPES.FlexibleConfig.map(item => item.name);
const jsonSafe = value => typeof value === 'bigint' ? value.toString()
  : Array.isArray(value) ? value.map(jsonSafe)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)])) : value;

export function authorityTypedAction(authority, kind, args, nonce, deadline) {
  const domain = { name: 'BEMine Platform Authority', version: '1', chainId: 56,
    verifyingContract: getAddress(authority) };
  const end = { nonce: BigInt(nonce).toString(), deadline: BigInt(deadline).toString() };
  let primaryType, message;
  if (kind === 'reviewSale') {
    primaryType = 'ReviewSale';
    message = { market: getAddress(args.market), pool: getAddress(args.pool), proposalId: BigInt(args.proposalId),
      priceWei: BigInt(args.priceWei), approved: args.approved === true, ...end };
  } else if (kind === 'reviewChildSale') {
    primaryType = 'ReviewChildSale';
    message = { portfolio: getAddress(args.portfolio), proposalId: BigInt(args.proposalId),
      approved: args.approved === true, ...end };
  } else if (kind === 'setSaleReference') {
    primaryType = 'SaleReference';
    message = { market: getAddress(args.market), pool: getAddress(args.pool), priceWei: BigInt(args.priceWei),
      observedAt: BigInt(args.observedAt), digest: args.digest, ...end };
  } else if (kind === 'claimFees') {
    primaryType = 'ClaimFees';
    message = { markets: args.markets.map(getAddress), pools: args.pools.map(getAddress),
      recipient: getAddress(args.recipient), ...end };
  } else if (kind === 'buyBudgetOfficial') {
    primaryType = 'BuyBudgetOfficial';
    message = { portfolio: getAddress(args.portfolio), child: getAddress(args.child),
      listingId: BigInt(args.listingId), maxCost: BigInt(args.maxCost), ...end };
  } else if (kind === 'buyBudgetFirsto') {
    primaryType = 'BuyBudgetFirsto';
    message = { portfolio: getAddress(args.portfolio), child: getAddress(args.child),
      orderHash: keccak256(args.encodedOrder), maxCost: BigInt(args.maxCost), ...end };
  } else if (kind === 'executeApprovedOperation') {
    const target = getAddress(args.target);
    const parsedCore = core.parseTransaction({ data: args.data });
    const parsed = parsedCore ?? budget.parseTransaction({ data: args.data });
    if (!parsed) throw new Error('Unsupported signed operation.');
    const canonical = (parsedCore ? core : budget).encodeFunctionData(parsed.fragment, parsed.args);
    if (canonical.toLowerCase() !== args.data.toLowerCase()) throw new Error('Noncanonical signed calldata.');
    if (parsed.name === 'createPortfolio') {
      primaryType = 'CreatePortfolio';
      message = { factory: target, budgetWei: parsed.args[0], absoluteCapWei: parsed.args[1],
        unitCapWei: parsed.args[2], fundingDeadline: parsed.args[3], purchaseDeadline: parsed.args[4], ...end };
    } else if (parsed.name === 'setDepositPaused') {
      primaryType = 'DepositPause';
      message = { pool: target, paused: parsed.args[0], ...end };
    } else if (parsed.name === 'mine') {
      const inner = reclaim.parseTransaction({ data: parsed.args[0] });
      if (inner?.name !== 'reclaim') throw new Error('Only reclaim can use an administrator mining signature.');
      if (reclaim.encodeFunctionData(inner.fragment, inner.args).toLowerCase() !== parsed.args[0].toLowerCase())
        throw new Error('Noncanonical reclaim calldata.');
      primaryType = 'Reclaim';
      message = { pool: target, workId: inner.args[0], ...end };
    } else if (parsed.name.startsWith('create')) {
      primaryType = 'CreatePool';
      const isFlexible = parsed.name === 'createFlexiblePool' || parsed.name === 'createFlexiblePoolChecked';
      message = { factory: target, operation: parsed.name,
        params: pick(parsed.args[0], poolNames),
        expiryEnabled: parsed.name === 'createPoolWithExpiry' ? parsed.args[1] : true,
        subscriber: parsed.name === 'createBudgetChildPool' ? parsed.args[1] : ZeroAddress,
        config: isFlexible ? pick(parsed.args[1], configNames) : zeroConfig,
        expectedTaskId: parsed.name === 'createFlexiblePoolChecked' ? parsed.args[2] : 0n,
        expectedReferenceWeight: parsed.name === 'createFlexiblePoolChecked' ? parsed.args[3] : 0n,
        ...end };
    } else throw new Error('Unsupported signed operation.');
  } else throw new Error('Unsupported administrator action.');
  const nested = primaryType === 'CreatePool' ? { PoolParams: AUTHORITY_TYPES.PoolParams,
    FlexibleConfig: AUTHORITY_TYPES.FlexibleConfig } : {};
  return { domain, primaryType, types: { [primaryType]: AUTHORITY_TYPES[primaryType], ...nested },
    message: jsonSafe(message) };
}
