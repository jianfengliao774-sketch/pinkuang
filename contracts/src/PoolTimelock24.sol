// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Business governance after a separately approved 48-hour migration.
/// @dev The proposer can cancel, execution is open, and only this timelock administers its roles.
contract PoolTimelock24 is TimelockController {
    uint256 public constant MINIMUM_DELAY = 24 hours;
    address public immutable INITIAL_PROPOSER;

    error InvalidProposer();

    constructor(address proposer) TimelockController(MINIMUM_DELAY, _proposers(proposer), _executors(), address(0)) {
        INITIAL_PROPOSER = proposer;
    }

    /// @dev updateDelay cannot lower the scheduling floor, including after migration.
    function getMinDelay() public view override returns (uint256) {
        uint256 configured = super.getMinDelay();
        return configured < MINIMUM_DELAY ? MINIMUM_DELAY : configured;
    }

    function _proposers(address proposer) private pure returns (address[] memory accounts) {
        if (proposer == address(0)) revert InvalidProposer();
        accounts = new address[](1);
        accounts[0] = proposer;
    }

    function _executors() private pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = address(0);
    }
}
