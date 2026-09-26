// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPoolVault} from "./interfaces/IPoolVault.sol";

/// @notice New opt-in namespace, inherited by Vault so upgrade tooling extracts its real layout.
abstract contract PurchaseSelectionState {
    /// @custom:storage-location erc7201:tapeout.storage.FlexiblePurchase
    struct SelectionStorage {
        bool enabled;
        uint256 referenceCircuitId;
        IPoolVault.FlexiblePurchaseConfig config;
        // Append-only. Pre-model flexible pools remain uninitialized and cannot purchase.
        bool modelInitialized;
        uint32 taskId;
    }
}
