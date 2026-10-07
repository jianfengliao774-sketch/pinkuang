// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareMarket} from "./ShareMarket.sol";
import {Governance24Validation} from "./libraries/Governance24Validation.sol";

/// @notice Used for both market proxies; changes only the existing timelock field.
/// @custom:oz-upgrades-unsafe-allow missing-initializer external-library-linking
contract Governance24ShareMarket is ShareMarket {
    uint256 public constant GOVERNANCE_DELAY = 24 hours;

    event GovernanceMigrated24(address indexed previousTimelock, address indexed nextTimelock);

    function migrateGovernance24(address expectedPreviousTimelock, address nextTimelock) external onlyProxy {
        MarketStorage storage s = _marketStorage();
        Governance24Validation.requireMigration(s.timelock, expectedPreviousTimelock, nextTimelock);
        s.timelock = nextTimelock;
        emit GovernanceMigrated24(expectedPreviousTimelock, nextTimelock);
    }
}
