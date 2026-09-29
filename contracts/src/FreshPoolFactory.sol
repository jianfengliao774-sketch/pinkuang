// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoolFactory} from "./PoolFactory.sol";
import {IPoolMachineRegistry} from "./interfaces/IPoolMachineRegistry.sol";

interface IPreviousFactoryStatus {
    function poolCount() external view returns (uint256);
    function creationPaused() external view returns (bool);
}

/// @notice Mainnet replacement Factory. The previous Factory and its pools remain live.
/// @dev A fresh registry starts ready, so historical backfill entry points have no use here.
contract FreshPoolFactory is PoolFactory {
    address public constant FIRST_MAINNET_FACTORY = 0xcB24E7F96D81037086A268d6ea63c53f91D412A2;
    address public constant PREVIOUS_MAINNET_FACTORY = 0x2995B10d19056c8C24C57b281C22562a603C571F;
    address public constant PREVIOUS_POOL_13043 = 0x575F3D44aE9cFfF5A5584E7F1dbE056f3e63d792;

    error PreviousFactoryStillOpen();

    function _beforeReserveMachine(address circuits, uint256 circuitId) internal view override {
        // Both previous owner-controlled Factories must stay closed before any new reservation.
        if (
            !IPreviousFactoryStatus(FIRST_MAINNET_FACTORY).creationPaused()
                || IPreviousFactoryStatus(FIRST_MAINNET_FACTORY).poolCount() != 0
                || !IPreviousFactoryStatus(PREVIOUS_MAINNET_FACTORY).creationPaused()
        ) revert PreviousFactoryStillOpen();
        // The old graph owns a real NFT and can retain reservations after the new graph launches.
        // Reject old reservations for both original pools and flexible-purchase alternatives.
        if (circuits == TAPEOUT_CIRCUITS && circuitId == 13043) {
            revert MachineAlreadyReserved(circuits, circuitId, PREVIOUS_POOL_13043);
        }
        address previousPool = IPoolMachineRegistry(PREVIOUS_MAINNET_FACTORY).machinePool(circuits, circuitId);
        if (previousPool != address(0)) revert MachineAlreadyReserved(circuits, circuitId, previousPool);
    }

    function beginMachineRegistryMigration() external pure override {
        revert MachineRegistryAlreadyInitialized();
    }

    function migrateMachineRegistry(uint256) external pure override {
        revert MachineRegistryAlreadyInitialized();
    }
}
