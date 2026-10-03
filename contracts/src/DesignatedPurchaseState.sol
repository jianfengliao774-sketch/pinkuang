// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPoolVault} from "./interfaces/IPoolVault.sol";

/// @notice Independent opt-in namespace; upgrading the shared Beacon leaves all old pools disabled.
abstract contract DesignatedPurchaseState {
    /// @custom:storage-location erc7201:tapeout.storage.DesignatedPurchase
    struct DesignatedStorage {
        bool enabled;
        uint256 referenceCircuitId;
        uint32 taskId;
        uint128 referenceVerifiedWeight;
        IPoolVault.DesignatedPurchaseConfig config;
    }
}
