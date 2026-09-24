// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

interface IBeaconVaultImplementation {
    function OFFICIAL_FACTORY() external view returns (address);
}

/// @notice Shared implementation beacon whose upgrade authority stays with its original timelock.
contract PoolBeacon is UpgradeableBeacon {
    error InvalidTimelock();
    error BeaconOwnershipFixed();
    error InvalidFactoryBinding();

    address public immutable OFFICIAL_FACTORY;

    constructor(address implementation_, address timelock_) UpgradeableBeacon(implementation_, timelock_) {
        if (timelock_.code.length == 0 || TimelockController(payable(timelock_)).getMinDelay() < 48 hours) {
            revert InvalidTimelock();
        }
        OFFICIAL_FACTORY = _boundFactory(implementation_);
    }

    /// @notice Every future implementation must retain this deployment's official factory binding.
    /// @dev This is an identity/configuration guard, not a substitute for reviewing the full new implementation.
    function upgradeTo(address implementation_) public override onlyOwner {
        if (_boundFactory(implementation_) != OFFICIAL_FACTORY) revert InvalidFactoryBinding();
        super.upgradeTo(implementation_);
    }

    function transferOwnership(address) public pure override {
        revert BeaconOwnershipFixed();
    }

    function renounceOwnership() public pure override {
        revert BeaconOwnershipFixed();
    }

    function _boundFactory(address implementation_) private view returns (address factory_) {
        try IBeaconVaultImplementation(implementation_).OFFICIAL_FACTORY() returns (address bound) {
            if (bound == address(0)) revert InvalidFactoryBinding();
            return bound;
        } catch {
            revert InvalidFactoryBinding();
        }
    }
}
