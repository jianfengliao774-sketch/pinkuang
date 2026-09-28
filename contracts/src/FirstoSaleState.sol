// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Transaction-scoped Firsto authorization, isolated from all historic Vault storage.
abstract contract FirstoSaleState {
    /// @custom:storage-location erc7201:tapeout.storage.FirstoSale
    struct FirstoSaleStorage {
        bytes32 orderHash;
        uint256 expectedProceeds;
        bool active;
        bool received;
    }
}
