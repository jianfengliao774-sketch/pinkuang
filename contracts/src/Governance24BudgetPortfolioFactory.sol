// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BudgetPortfolioFactory} from "./BudgetPortfolioFactory.sol";
import {Governance24Validation} from "./libraries/Governance24Validation.sol";

/// @notice In-place portfolio factory governance migration; preserves its complete existing layout.
/// @custom:oz-upgrades-unsafe-allow missing-initializer external-library-linking
contract Governance24BudgetPortfolioFactory is BudgetPortfolioFactory {
    uint256 public constant GOVERNANCE_DELAY = 24 hours;

    event GovernanceMigrated24(address indexed previousTimelock, address indexed nextTimelock);

    function migrateGovernance24(address expectedPreviousTimelock, address nextTimelock) external onlyProxy {
        Governance24Validation.requireMigration(timelock, expectedPreviousTimelock, nextTimelock);
        timelock = nextTimelock;
        _transferOwnership(nextTimelock);
        emit GovernanceMigrated24(expectedPreviousTimelock, nextTimelock);
    }
}
