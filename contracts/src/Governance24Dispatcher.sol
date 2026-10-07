// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governance24Beacon} from "./Governance24Beacon.sol";
import {Governance24Validation} from "./libraries/Governance24Validation.sol";

/// @notice Storage-free routing installed in a legacy immutable BeaconProxy's original beacon.
/// @dev Both delegatecalls preserve the pool address, caller, value and all existing storage namespaces.
contract Governance24Dispatcher {
    address public immutable OFFICIAL_FACTORY;
    address public immutable SECONDARY_BEACON;
    address private immutable SELF;

    error InvalidFactoryBinding();
    error DirectCall();

    constructor(address officialFactory_, address secondaryBeacon_) {
        if (officialFactory_ == address(0) || secondaryBeacon_.code.length == 0) revert InvalidFactoryBinding();
        Governance24Beacon secondary = Governance24Beacon(secondaryBeacon_);
        if (secondary.OFFICIAL_FACTORY() != officialFactory_) revert InvalidFactoryBinding();
        Governance24Validation.requireTimelock24(secondary.owner());
        OFFICIAL_FACTORY = officialFactory_;
        SECONDARY_BEACON = secondaryBeacon_;
        SELF = address(this);
    }

    /// @dev The dispatcher itself cannot be initialized or used as a stateful pool.
    fallback() external payable {
        if (address(this) == SELF) revert DirectCall();
        address implementation_ = Governance24Beacon(SECONDARY_BEACON).implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), implementation_, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch success
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
