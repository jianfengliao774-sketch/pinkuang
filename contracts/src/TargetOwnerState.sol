// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Append-only, independent storage for the fixed target's original owner.
abstract contract TargetOwnerState {
    /// @custom:storage-location erc7201:tapeout.storage.TargetOwner
    struct TargetOwnerStorage {
        address originalOwner;
        bool configured;
        uint256 nonce;
    }
}
