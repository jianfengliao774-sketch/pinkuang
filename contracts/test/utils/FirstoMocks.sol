// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {PurchaseMockNft} from "./PurchaseMocks.sol";

/// @dev Isolated fault injection only; never production protocol provenance or a substitute for a real fork.
contract FirstoSignedAskMock is IFirstoSignedAskExchange {
    address public factory;
    bool public paused;
    uint16 public defaultTakerFeeBps;
    uint256 public feeEpoch;
    uint16 public constant SIGNED_ASK_SCHEMA_VERSION = 2;
    mapping(uint256 => uint16) public feeBpsAtEpoch;
    mapping(address => mapping(uint256 => bool)) public isSignedAskNonceInvalidated;
    uint8 public fault;
    uint256 public fills;
    bool public reentrySucceeded;
    bytes public reentryData;

    function configure(address factory_, uint16 fee, uint256 epoch) external {
        factory = factory_;
        defaultTakerFeeBps = fee;
        feeEpoch = epoch;
        feeBpsAtEpoch[epoch] = fee;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setFault(uint8 value) external {
        fault = value;
    }

    function invalidate(address maker, uint256 nonce) external {
        isSignedAskNonceInvalidated[maker][nonce] = true;
    }

    function setReentry(bytes calldata data) external {
        reentryData = data;
    }

    function hash(SignedAsk memory ask) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Firsto Circuit Signed Ask"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
        bytes32 typehash = keccak256(
            "SignedAsk(address maker,address collection,uint256 tokenId,uint256 nonce,uint128 price,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion)"
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typehash, ask))));
    }

    function fillSignedAsk(SignedAsk calldata ask, bytes calldata signature, address nftRecipient) external payable {
        require(!paused && fault != 1, "market unavailable");
        require(ask.expiry > block.timestamp && ask.schemaVersion == 2, "expired or schema");
        require(!isSignedAskNonceInvalidated[ask.maker][ask.nonce], "nonce invalidated");
        require(ask.feeBps == feeBpsAtEpoch[ask.feeEpoch], "wrong signed fee");
        require(msg.value == uint256(ask.price) + uint256(ask.price) * ask.feeBps / 10000, "wrong value");
        require(SignatureChecker.isValidSignatureNow(ask.maker, hash(ask), signature), "bad signature");
        isSignedAskNonceInvalidated[ask.maker][ask.nonce] = true;
        ++fills;
        if (fault != 2) {
            IERC721(ask.collection).safeTransferFrom(ask.maker, fault == 3 ? address(0xBAD) : nftRecipient, ask.tokenId);
        }
        if (reentryData.length > 0) (reentrySucceeded,) = msg.sender.call(reentryData);
        (bool ok,) = ask.payoutRecipient.call{value: ask.price}("");
        require(ok, "payout rejected");
        if (fault == 4) new FirstoForceBnb{value: 1}(payable(msg.sender));
        if (fault == 5) ++feeEpoch;
        if (fault == 6) PurchaseMockNft(ask.collection).forceTransfer(address(0xBAD), ask.tokenId);
    }
}

contract FirstoForceBnb {
    constructor(address payable recipient) payable {
        selfdestruct(recipient);
    }
}

contract FirstoRejectingRecipient {
    receive() external payable {
        revert("reject");
    }
}

contract Firsto1271Mock {
    function isValidSignature(bytes32, bytes calldata signature) external pure returns (bytes4) {
        return signature.length > 0 && signature[0] == 0x42 ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    receive() external payable {}
}
