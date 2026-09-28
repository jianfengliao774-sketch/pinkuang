// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Append-only governance timing, independent from the portfolio's historical linear layout.
abstract contract BudgetGovernanceState {
    /// @custom:storage-location erc7201:tapeout.storage.BudgetGovernance
    struct BudgetGovernanceStorage {
        uint64 nextRoundAt;
        mapping(uint256 => uint8) saleReviews;
        mapping(address => uint64) lastProposed;
    }

    function _budgetGovernanceStorage() internal pure returns (BudgetGovernanceStorage storage s) {
        bytes32 location =
            keccak256(abi.encode(uint256(keccak256("tapeout.storage.BudgetGovernance")) - 1)) & ~bytes32(uint256(0xff));
        assembly { s.slot := location }
    }
}
