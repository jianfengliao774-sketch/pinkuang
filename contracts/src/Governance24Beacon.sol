// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {Governance24Validation} from "./libraries/Governance24Validation.sol";

interface IGovernance24VaultBinding {
    function OFFICIAL_FACTORY() external view returns (address);
}

/// @notice Secondary business implementation beacon; legacy pools reach it through Governance24Dispatcher.
contract Governance24Beacon is UpgradeableBeacon {
    address public immutable OFFICIAL_FACTORY;

    error BeaconOwnershipFixed();
    error InvalidFactoryBinding();

    constructor(address implementation_, address timelock24_) UpgradeableBeacon(implementation_, timelock24_) {
        Governance24Validation.requireTimelock24(timelock24_);
        OFFICIAL_FACTORY = _boundFactory(implementation_);
    }

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
        try IGovernance24VaultBinding(implementation_).OFFICIAL_FACTORY() returns (address bound) {
            if (bound == address(0)) revert InvalidFactoryBinding();
            return bound;
        } catch {
            revert InvalidFactoryBinding();
        }
    }
}
