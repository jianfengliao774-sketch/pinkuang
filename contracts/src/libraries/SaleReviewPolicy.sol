// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Human review is required only below 80% of the fresh Firsto reference.
/// @dev Internal functions introduce no linked deployment or storage state.
library SaleReviewPolicy {
    uint16 internal constant THRESHOLD_BPS = 8000;

    function requiresReview(uint256 price, uint256 referencePrice) internal pure returns (bool) {
        // price < ceil(4 * referencePrice / 5) is exactly 5 * price < 4 * referencePrice
        // for integer wei. Subtraction avoids overflow even for historical uint256 prices.
        return price < referencePrice - referencePrice / 5;
    }
}
