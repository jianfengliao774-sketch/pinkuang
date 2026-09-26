// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

/// @notice Reward state shared by PoolVault and its linked accounting library.
/// @dev This namespace is separate from the delivered PoolVault namespace.
abstract contract PoolRewardState {
    struct RewardSlot {
        uint32 epoch;
        uint256 amount;
        uint256 remainder;
    }

    struct RewardUser {
        uint256 debtAcc;
        uint256 owed;
        uint256 globalRemainder;
        uint64 lastClaimAt;
        RewardSlot[8] slots;
    }

    /// @custom:storage-location erc7201:tapeout.storage.PoolRewards
    struct RewardStorage {
        // Historical expiry flag; new pools always disable expiry.
        bool expiryDisabled;
        bool expiryConfigured;
        uint256 acc;
        uint256 bemAccounted;
        Checkpoints.Trace224 accEndOf;
        mapping(uint256 => uint256) epochNet;
        mapping(uint256 => uint256) epochPaid;
        mapping(uint256 => uint256) epochBurned;
        mapping(uint256 => bool) epochBurnedFlag;
        mapping(address => RewardUser) users;
        uint256 totalGross;
        uint256 totalPlatform;
        uint256 totalBaseBurned;
        uint256 totalMemberNet;
        uint256 totalMemberPaid;
        uint256 totalExpiredBurned;
        // Sum of fractions identified by lazy user settlement, in 1e36 units.
        // These are neither the final dust total nor liabilities in addition to
        // epochNet - epochPaid - epochBurned. Burned epochs retain history here.
        mapping(uint256 => uint256) epochRemainderScaled;
        // The same identified-fraction sum for the non-expiring path only.
        uint256 totalGlobalRemainderScaled;
        // Append-only cutover: the old daily ring is preserved as historical evidence.
        bool legacyMigrationStarted;
        uint32 legacyCutoverEpoch;
        uint256 legacyCutoverAcc;
        mapping(address => bool) legacyUserMigrated;
    }

    // keccak256(abi.encode(uint256(keccak256("tapeout.storage.PoolRewards")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REWARD_STORAGE_LOCATION =
        0xbe2e6742b44a407aefa2f874e2465ec804b9b29179760a8ce2b26da776718500;

    function _rewardStorage() internal pure returns (RewardStorage storage s) {
        assembly {
            s.slot := REWARD_STORAGE_LOCATION
        }
    }
}
