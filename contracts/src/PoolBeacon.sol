// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Shared implementation beacon whose upgrade authority stays with its original timelock.
contract PoolBeacon is UpgradeableBeacon {
    error InvalidTimelock();
    error BeaconOwnershipFixed();

    constructor(address implementation_, address timelock_) UpgradeableBeacon(implementation_, timelock_) {
        if (timelock_.code.length == 0 || TimelockController(payable(timelock_)).getMinDelay() < 48 hours) {
            revert InvalidTimelock();
        }
    }

    function transferOwnership(address) public pure override {
        revert BeaconOwnershipFixed();
    }

    function renounceOwnership() public pure override {
        revert BeaconOwnershipFixed();
    }
}
