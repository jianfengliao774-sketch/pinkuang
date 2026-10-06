// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Upgrade governance: owner multisig proposes/cancels, anyone executes after at least 48 hours.
/// @dev No external account receives DEFAULT_ADMIN_ROLE, including the deployer.
contract PoolTimelock is TimelockController {
    uint256 public constant MINIMUM_DELAY = 48 hours;

    error InvalidMultisig();

    constructor(address ownerMultisig)
        TimelockController(MINIMUM_DELAY, _proposers(ownerMultisig), _executors(), address(0))
    {}

    /// @dev The inherited updateDelay may change the configured delay, but never this scheduling floor.
    function getMinDelay() public view override returns (uint256) {
        uint256 configured = super.getMinDelay();
        return configured < MINIMUM_DELAY ? MINIMUM_DELAY : configured;
    }

    function _proposers(address ownerMultisig) private pure returns (address[] memory accounts) {
        if (ownerMultisig == address(0)) revert InvalidMultisig();
        accounts = new address[](1);
        accounts[0] = ownerMultisig;
    }

    function _executors() private pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = address(0);
    }
}
