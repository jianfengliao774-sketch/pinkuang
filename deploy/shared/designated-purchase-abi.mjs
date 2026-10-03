// Supplemental candidate ABI. Inclusion is not evidence that a deployed graph
// supports this opt-in policy; activation requires reviewed runtime bindings.
export const DESIGNATED_POOL_PARAMS = '(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline)';
export const DESIGNATED_CONFIG = '(address referenceSeller,uint256 referencePriceWei,uint256 referenceCostWei,uint256 referenceDailyOutputAtomic,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)';
export const DESIGNATED_CREATE = `function createDesignatedPoolChecked(${DESIGNATED_POOL_PARAMS} params,${DESIGNATED_CONFIG} config,uint32 expectedTaskId,uint128 expectedReferenceWeight)`;
export const DESIGNATED_GETTER = `function designatedPurchase() view returns(bool enabled,uint256 referenceCircuitId,uint32 taskId,uint128 referenceVerifiedWeight,${DESIGNATED_CONFIG} config)`;
export const DESIGNATED_FIRSTO_BUY = 'function buyAlternativeFromFirsto(uint8 kind,bytes encodedOrder)';
