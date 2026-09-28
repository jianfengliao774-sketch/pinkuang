// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

/// @notice The delivered Vault namespace, shared with its fixed accounting library.
/// @dev Field order, types and ERC-7201 location are unchanged from T1d/T1e voting.
abstract contract PoolVaultState {
    /// @custom:storage-location erc7201:tapeout.storage.PoolVault
    struct VaultStorage {
        address factory;
        address treasury;
        IPoolVault.PoolParams params;
        IPoolVault.State state;
        bool depositPaused;
        bool refundsRecorded;
        uint256 unitPriceWei;
        uint256 totalRaised;
        uint256 totalBnbOwed;
        mapping(address => uint256) contributedWei;
        mapping(address => uint256) bnbOwed;
        address[] activeMembers;
        mapping(address => uint256) memberIndexPlusOne;
        mapping(address => Checkpoints.Trace208) shareHistory;
        Checkpoints.Trace208 memberHistory;
        uint256 purchaseCost;
        uint64 activatedAt;
        uint256 surplusPerShareWei;
        uint256 surplusRemainder;
        uint256 surplusOutstandingWei;
        mapping(address => bool) surplusSettled;
        address expectedNftSeller;
        address expectedNftOperator;
        bool nftReceived;
        mapping(address => uint256) lockedShares;
    }

    bytes32 private constant VAULT_STORAGE_LOCATION =
        0x91bfb6bda130bea719738fb057a72863be36ca25095a844c93b1e775e47e6d00;

    function _vaultStorage() internal pure returns (VaultStorage storage s) {
        assembly {
            s.slot := VAULT_STORAGE_LOCATION
        }
    }
}
