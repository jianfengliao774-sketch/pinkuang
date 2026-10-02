// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Fixed Firsto protocol ABIs, independently checked against its deployed front-end and read-only calls.
/// @dev Batch execution remains disabled until its deployed runtime provenance is resolved.
interface IFirstoSignedAskExchange {
    struct SignedAsk {
        address maker;
        address collection;
        uint256 tokenId;
        uint256 nonce;
        uint128 price;
        uint64 expiry;
        address payoutRecipient;
        uint16 feeBps;
        uint256 feeEpoch;
        uint16 schemaVersion;
    }

    function factory() external view returns (address);
    function paused() external view returns (bool);
    function defaultTakerFeeBps() external view returns (uint16);
    function feeEpoch() external view returns (uint256);
    function feeBpsAtEpoch(uint256 epoch) external view returns (uint16);
    function SIGNED_ASK_SCHEMA_VERSION() external view returns (uint16);
    function isSignedAskNonceInvalidated(address maker, uint256 nonce) external view returns (bool);
    function cancelSignedAskNonce(uint256 nonce) external;
    function fillSignedAsk(SignedAsk calldata ask, bytes calldata signature, address nftRecipient) external payable;
}

interface IFirstoBatchAskExchange {
    struct BatchAsk {
        address maker;
        bytes32 merkleRoot;
        uint256 batchNonce;
        uint64 expiry;
        address payoutRecipient;
        uint16 feeBps;
        uint256 feeEpoch;
        uint16 schemaVersion;
    }

    struct AskLeaf {
        address maker;
        address collection;
        uint256 tokenId;
        uint128 price;
        address payoutRecipient;
        uint16 feeBps;
        uint256 feeEpoch;
        uint256 batchNonce;
        uint256 leafIndex;
        uint16 schemaVersion;
    }

    function fillAsk(
        BatchAsk calldata batch,
        AskLeaf calldata leaf,
        bytes32[] calldata merkleProof,
        bytes calldata signature,
        address nftRecipient
    ) external payable;
}
