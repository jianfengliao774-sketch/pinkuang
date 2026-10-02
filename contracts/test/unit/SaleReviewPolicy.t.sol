// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SaleReviewPolicy} from "../../src/libraries/SaleReviewPolicy.sol";

contract SaleReviewPolicyTest is Test {
    function test_exactlyEightyPercentNeedsNoReview() public pure {
        assertFalse(SaleReviewPolicy.requiresReview(4 ether, 5 ether));
        assertFalse(SaleReviewPolicy.requiresReview(4 ether + 1, 5 ether));
        assertTrue(SaleReviewPolicy.requiresReview(4 ether - 1, 5 ether));
    }

    function test_fractionalWeiBoundaryIsNotRoundedDown() public pure {
        // The true 80% boundary is 80.8 wei. 80 is below it; 81 is above it.
        assertTrue(SaleReviewPolicy.requiresReview(80, 101));
        assertFalse(SaleReviewPolicy.requiresReview(81, 101));
        assertTrue(SaleReviewPolicy.requiresReview(0, 1));
        assertFalse(SaleReviewPolicy.requiresReview(1, 1));
    }

    function test_largeHistoricalValuesDoNotOverflow() public pure {
        uint256 maximum = type(uint256).max;
        assertFalse(SaleReviewPolicy.requiresReview(maximum, maximum));
        assertFalse(SaleReviewPolicy.requiresReview(maximum, type(uint128).max));
        assertTrue(SaleReviewPolicy.requiresReview(maximum - maximum / 5 - 1, maximum));
        assertFalse(SaleReviewPolicy.requiresReview(maximum - maximum / 5, maximum));
    }

    function testFuzz_matchesExactCrossMultiplication(uint128 price, uint128 referencePrice) public pure {
        assertEq(
            SaleReviewPolicy.requiresReview(price, referencePrice),
            uint256(price) * 5 < uint256(referencePrice) * 4
        );
    }
}
