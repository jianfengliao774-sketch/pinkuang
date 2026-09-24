// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Sale governance state shared by PoolVault and its linked library.
/// @dev Existing Vault and reward namespaces remain unchanged.
abstract contract PoolSaleState {
    struct Proposal {
        address proposer;
        uint48 snapshotTs;
        uint64 endsAt;
        uint64 refAt;
        uint256 price;
        uint256 refPrice;
        uint256 snapshotMemberCount;
        uint256 snapshotTotalShares;
        uint256 yesCount;
        uint256 yesShares;
        bool executed;
    }

    /// @custom:storage-location erc7201:tapeout.storage.PoolSales
    struct SaleStorage {
        // Zero-initialized upgraded proxies also begin at proposal 1.
        uint256 nextProposalId;
        uint256 activeProposalId;
        mapping(address => uint64) lastProposed;
        mapping(uint256 => Proposal) proposals;
        mapping(uint256 => mapping(address => bool)) hasVoted;
    }

    // keccak256(abi.encode(uint256(keccak256("tapeout.storage.PoolSales")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SALE_STORAGE_LOCATION = 0x2f6815c6ef0fa51be4582ec22c24e8543902265d5f78fd79c749f4419f2ad600;

    function _saleStorage() internal pure returns (SaleStorage storage s) {
        assembly {
            s.slot := SALE_STORAGE_LOCATION
        }
    }
}
