// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoolFactory} from "./PoolFactory.sol";

/// @notice Independent Factory for a fresh deployment.
/// @dev Its registry starts ready and never reads a previous deployment.
contract FreshPoolFactory is PoolFactory {
    function beginMachineRegistryMigration() external pure override {
        revert MachineRegistryAlreadyInitialized();
    }

    function migrateMachineRegistry(uint256) external pure override {
        revert MachineRegistryAlreadyInitialized();
    }
}
