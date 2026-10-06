// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IFirstoBatchAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {PurchaseMockNft} from "./PurchaseMocks.sol";
import {FirstoForceBnb} from "./FirstoMocks.sol";

/// @dev TEST ONLY. This is a controlled semantics/fault fixture, never protocol-runtime provenance.
contract FirstoBatchAskMock is IFirstoBatchAskExchange {
    address public factory;
    bool public paused;
    uint16 public defaultTakerFeeBps;
    uint256 public feeEpoch;
    uint16 public BATCH_ASK_SCHEMA_VERSION;
    mapping(uint256 => uint16) public feeBpsAtEpoch;
    mapping(address => mapping(uint256 => bool)) public batchCancelled;
    mapping(bytes32 => bool) public leafUsed;
    uint8 public fault;
    uint256 public fills;
    bytes public reentryData;
    bool public reentrySucceeded;

    function configure(address factory_, uint16 fee, uint256 epoch) external {
        BATCH_ASK_SCHEMA_VERSION = 1;
        factory = factory_;
        defaultTakerFeeBps = fee;
        feeEpoch = epoch;
        feeBpsAtEpoch[epoch] = fee;
    }

    function setSchema(uint16 value) external {
        BATCH_ASK_SCHEMA_VERSION = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setFault(uint8 value) external {
        fault = value;
    }

    function setReentry(bytes calldata data) external {
        reentryData = data;
    }

    function cancel(address maker, uint256 nonce) external {
        batchCancelled[maker][nonce] = true;
    }

    function consume(AskLeaf memory leaf) external {
        leafUsed[leafKey(leaf)] = true;
    }

    function isAskLeafInvalidated(address maker, uint256 nonce, uint256 index) external view returns (bool) {
        return batchCancelled[maker][nonce] || leafUsed[keccak256(abi.encode(maker, nonce, index))];
    }

    function leafKey(AskLeaf memory leaf) public pure returns (bytes32) {
        return keccak256(abi.encode(leaf.maker, leaf.batchNonce, leaf.leafIndex));
    }

    function hashLeaf(AskLeaf memory leaf) public pure returns (bytes32) {
        bytes32 typehash = keccak256(
            "AskLeaf(address maker,address collection,uint256 tokenId,uint128 price,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint256 batchNonce,uint256 leafIndex,uint16 schemaVersion)"
        );
        return keccak256(bytes.concat(keccak256(abi.encode(typehash, leaf))));
    }

    function hash(BatchAsk memory batch) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Firsto Circuit Batch Ask"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        bytes32 typehash = keccak256(
            "BatchAsk(address maker,bytes32 merkleRoot,uint256 batchNonce,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion)"
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typehash, batch))));
    }

    function fillAsk(
        BatchAsk calldata batch,
        AskLeaf calldata leaf,
        bytes32[] calldata proof,
        bytes calldata signature,
        address recipient
    ) external payable {
        require(!paused && fault != 1, "market unavailable");
        require(batch.maker != msg.sender && !batchCancelled[batch.maker][batch.batchNonce], "invalid batch");
        require(batch.expiry > block.timestamp && batch.schemaVersion == 1 && leaf.schemaVersion == 1, "expiry/schema");
        require(
            leaf.maker == batch.maker && leaf.batchNonce == batch.batchNonce
                && leaf.payoutRecipient == batch.payoutRecipient && leaf.feeBps == batch.feeBps
                && leaf.feeEpoch == batch.feeEpoch,
            "batch/leaf mismatch"
        );
        require(!leafUsed[leafKey(leaf)] && MerkleProof.verify(proof, batch.merkleRoot, hashLeaf(leaf)), "used/proof");
        require(leaf.feeBps == feeBpsAtEpoch[leaf.feeEpoch], "signed fee");
        require(msg.value == uint256(leaf.price) + uint256(leaf.price) * leaf.feeBps / 10000, "wrong value");
        require(SignatureChecker.isValidSignatureNow(batch.maker, hash(batch), signature), "bad signature");
        if (fault != 7) leafUsed[leafKey(leaf)] = true;
        ++fills;
        if (fault != 2) {
            IERC721(leaf.collection).safeTransferFrom(leaf.maker, fault == 3 ? address(0xBAD) : recipient, leaf.tokenId);
        }
        if (reentryData.length > 0) (reentrySucceeded,) = msg.sender.call(reentryData);
        (bool ok,) = leaf.payoutRecipient.call{value: leaf.price}("");
        require(ok, "payout rejected");
        if (fault == 4) new FirstoForceBnb{value: 1}(payable(msg.sender));
        if (fault == 5) ++feeEpoch;
        if (fault == 6) PurchaseMockNft(leaf.collection).forceTransfer(address(0xBAD), leaf.tokenId);
    }
}
