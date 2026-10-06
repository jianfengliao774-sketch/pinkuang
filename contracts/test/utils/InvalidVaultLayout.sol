// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @notice NEGATIVE validation fixture. Never deploy as a project implementation.
/// @dev Swaps two existing fields in PoolVault's ERC-7201 namespace. The CLI MUST reject this layout.
contract InvalidVaultLayout is ERC20Upgradeable, ReentrancyGuardUpgradeable {
    /// @custom:storage-location erc7201:tapeout.storage.PoolVault
    struct VaultStorage {
        address factory;
        address treasury;
        IPoolVault.PoolParams params;
        IPoolVault.State state;
        bool depositPaused;
        bool refundsRecorded;
        uint256 totalRaised; // Deliberate incompatible reorder.
        uint256 unitPriceWei;
        uint256 totalBnbOwed;
        mapping(address => uint256) contributedWei;
        mapping(address => uint256) bnbOwed;
        address[] activeMembers;
        mapping(address => uint256) memberIndexPlusOne;
        mapping(address => Checkpoints.Trace208) shareHistory;
        Checkpoints.Trace208 memberHistory;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() external initializer {
        __ERC20_init("Incompatible fixture", "BAD");
        __ReentrancyGuard_init();
    }

    function badLayout() internal pure returns (VaultStorage storage s) {
        assembly { s.slot := 0x91bfb6bda130bea719738fb057a72863be36ca25095a844c93b1e775e47e6d00 }
    }

    function totalRaised() external view returns (uint256) {
        return badLayout().totalRaised;
    }
}
