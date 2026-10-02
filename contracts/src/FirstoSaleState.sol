// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Firsto authorizations, isolated from all historic Vault storage.
abstract contract FirstoSaleState {
    struct DelistingProposal {
        address proposer;
        uint256 listedProposalId;
        uint48 snapshotTs;
        uint64 expiresAt;
        uint256 snapshotMemberCount;
        uint256 yesCount;
        uint256 yesShares;
        uint256 noCount;
        uint256 noShares;
        bool executed;
    }

    /// @custom:storage-location erc7201:tapeout.storage.FirstoSale
    struct FirstoSaleStorage {
        bytes32 orderHash;
        uint256 expectedProceeds;
        bool active;
        bool received;
        // Append-only native ask. The four original controlled-sale fields retain
        // their slots and offsets, including historic completed pools.
        bytes32 nativeOrderHash;
        uint256 nativeProposalId;
        uint16 nativeFeeBps;
        bool nativeActive;
        uint256 nativeFeeEpoch;
        // Independent cancellation rounds never reuse sale-proposal storage.
        uint256 nextDelistingId;
        uint256 activeDelistingId;
        mapping(uint256 => DelistingProposal) delistingProposals;
        mapping(uint256 => mapping(address => bool)) delistingVotes;
        uint256 reopenEpoch;
        mapping(address => uint256) reopenedForEpoch;
    }
}
