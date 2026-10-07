// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {PoolTimelock24} from "../PoolTimelock24.sol";

interface IGovernanceDelayFloor {
    function MINIMUM_DELAY() external view returns (uint256);
}

/// @dev Stateless read-only validation. Migration checks are linked to keep the factory below EIP-170.
library Governance24Validation {
    error InvalidGovernance24();
    error UnauthorizedMigration();

    function requireTimelock24(address next) internal view {
        if (next.code.length == 0) revert InvalidGovernance24();
        PoolTimelock24 lock = PoolTimelock24(payable(next));
        if (lock.MINIMUM_DELAY() != 24 hours || lock.getMinDelay() < 24 hours) revert InvalidGovernance24();
        address proposer = lock.INITIAL_PROPOSER();
        if (
            proposer == address(0) || !lock.hasRole(lock.PROPOSER_ROLE(), proposer)
                || !lock.hasRole(lock.CANCELLER_ROLE(), proposer) || !lock.hasRole(lock.EXECUTOR_ROLE(), address(0))
                || !lock.hasRole(lock.DEFAULT_ADMIN_ROLE(), next)
        ) revert InvalidGovernance24();
    }

    function requireMigration(address current, address expectedPrevious, address next) external view {
        if (msg.sender != current) revert UnauthorizedMigration();
        if (
            current != expectedPrevious || next == current || current.code.length == 0
                || IGovernanceDelayFloor(current).MINIMUM_DELAY() != 48 hours
                || TimelockController(payable(current)).getMinDelay() < 48 hours
        ) revert InvalidGovernance24();
        requireTimelock24(next);
        PoolTimelock24 lock = PoolTimelock24(payable(next));
        // Preserve the approved proposer at the migration boundary. Later role changes remain timelocked.
        if (!TimelockController(payable(current)).hasRole(lock.PROPOSER_ROLE(), lock.INITIAL_PROPOSER())) {
            revert InvalidGovernance24();
        }
    }
}
