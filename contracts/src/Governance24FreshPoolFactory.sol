// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FreshPoolFactory} from "./FreshPoolFactory.sol";
import {Governance24Validation} from "./libraries/Governance24Validation.sol";

/// @notice In-place migration candidate for the deployed fresh factory; no new storage fields.
/// @custom:oz-upgrades-unsafe-allow missing-initializer external-library-linking
contract Governance24FreshPoolFactory is FreshPoolFactory {
    uint256 public constant GOVERNANCE_DELAY = 24 hours;

    event GovernanceMigrated24(address indexed previousTimelock, address indexed nextTimelock);

    /// @notice Include in the legacy timelock's upgradeToAndCall batch, alongside both markets and beacons.
    /// @dev Ownership joins upgrade governance; operator, treasury, registry, pools, market and lens are preserved.
    function migrateGovernance24(address expectedPreviousTimelock, address nextTimelock) external onlyProxy {
        FactoryStorage storage s = _factoryStorage();
        Governance24Validation.requireMigration(s.timelock, expectedPreviousTimelock, nextTimelock);
        s.timelock = nextTimelock;
        _transferOwnership(nextTimelock);
        emit GovernanceMigrated24(expectedPreviousTimelock, nextTimelock);
    }
}
