// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {IFirstoSignedAskExchange} from "../interfaces/IFirstoExchange.sol";
import {PoolVaultState} from "../PoolVaultState.sol";
import {PoolSaleState} from "../PoolSaleState.sol";
import {FirstoSaleState} from "../FirstoSaleState.sol";
import {FirstoSaleExecutor} from "../FirstoSaleExecutor.sol";
import {SaleSettlement} from "./SaleSettlement.sol";

/// @notice Only the site's controlled entry can temporarily authorize an exact Firsto sale.
/// @dev The Vault holds nonReentrant and strictly harvests before this library runs.
/// Native fillSignedAsk outside this call cannot obtain an ERC-1271 signature or NFT approval.
library FirstoSale {
    address private constant EXCHANGE = 0x33423244F9a5bF81b12B1a018aF6F4e079B97f29;
    address private constant PROTOCOL_FACTORY = 0x68224F668083c29e9800Be2a646d42d18cedF7e2;
    bytes32 private constant ASK_TYPEHASH = keccak256(
        "SignedAsk(address maker,address collection,uint256 tokenId,uint256 nonce,uint128 price,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion)"
    );

    struct Confirmation {
        uint256 proposalId;
        uint256 price;
        uint16 feeBps;
        uint256 feeEpoch;
    }

    event FirstoSaleCompleted(
        uint256 indexed proposalId,
        bytes32 indexed orderHash,
        address indexed buyer,
        uint256 gross,
        uint256 takerFee,
        uint256 feeEpoch
    );
    event SaleCompleted(uint256 gross, uint256 toPlatform, uint256 burnedBem, uint256 toMembers);

    function complete(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        Confirmation memory expected,
        uint256 settledBem
    ) external {
        IFirstoSignedAskExchange.SignedAsk memory ask = _ask(v, s, expected);
        _requireFees(ask);
        IFirstoSignedAskExchange exchange = IFirstoSignedAskExchange(EXCHANGE);
        if (exchange.isSignedAskNonceInvalidated(address(this), ask.nonce)) revert IPoolVault.InvalidFirstoOrder();
        uint256 takerFee = uint256(ask.price) * ask.feeBps / 10_000;
        uint256 payment = uint256(ask.price) + takerFee;
        if (msg.value != payment) revert IPoolVault.PaymentMismatch();
        uint256 balanceBefore = address(this).balance;
        bytes32 orderHash = _hash(ask);
        // Closing and booking before the receiver callback does not transfer an NFT;
        // all accounting rolls back if Firsto/payment/final ownership checks fail.
        SaleSettlement.prepareFirsto(v, s, msg.sender, ask.price, settledBem);
        FirstoSaleState.FirstoSaleStorage storage authorization = _storage();
        if (authorization.active) revert IPoolVault.UnverifiedSaleRoute();
        authorization.orderHash = orderHash;
        authorization.expectedProceeds = ask.price;
        authorization.active = true;
        authorization.received = false;
        IERC721(ask.collection).approve(EXCHANGE, ask.tokenId);
        // V2 rejects maker == caller. A one-use constructor supplies a different
        // caller without moving custody or creating any reusable trading authority.
        new FirstoSaleExecutor{value: payment}(ask, msg.sender);
        if (!authorization.received || address(this).balance != balanceBefore - payment + ask.price) {
            revert IPoolVault.PaymentMismatch();
        }
        if (IERC721(ask.collection).ownerOf(ask.tokenId) != msg.sender) revert IPoolVault.TransferFailed();
        if (!exchange.isSignedAskNonceInvalidated(address(this), ask.nonce)) revert IPoolVault.InvalidFirstoOrder();
        _requireFees(ask);
        delete authorization.orderHash;
        delete authorization.expectedProceeds;
        delete authorization.active;
        delete authorization.received;
        emit SaleCompleted(ask.price, uint256(ask.price) / 100, 0, uint256(ask.price) - uint256(ask.price) / 100);
        emit FirstoSaleCompleted(expected.proposalId, orderHash, msg.sender, ask.price, takerFee, ask.feeEpoch);
    }

    function isValidSignature(bytes32 orderHash) external view returns (bytes4) {
        FirstoSaleState.FirstoSaleStorage storage s = _storage();
        return msg.sender == EXCHANGE && s.active && !s.received && s.orderHash == orderHash
            ? bytes4(0x1626ba7e)
            : bytes4(0xffffffff);
    }

    /// @dev This is the only receive window; the reentrancy lock remains held by completeFirstoSale.
    function receivePayment() external {
        FirstoSaleState.FirstoSaleStorage storage s = _storage();
        if (!s.active || s.received || msg.sender != EXCHANGE || msg.value != s.expectedProceeds) {
            revert IPoolVault.UnsupportedSubscriptionAsset();
        }
        s.received = true;
    }

    function _ask(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        Confirmation memory expected
    ) private view returns (IFirstoSignedAskExchange.SignedAsk memory ask) {
        if (v.state != IPoolVault.State.Listed) revert IPoolVault.WrongState();
        if (expected.proposalId != s.listedProposalId) revert IPoolVault.InvalidProposal();
        if (expected.price != s.salePrice) revert IPoolVault.PaymentMismatch();
        if (expected.price == 0 || expected.price > type(uint128).max) revert IPoolVault.InvalidSalePrice();
        PoolSaleState.Proposal storage listed = s.proposals[s.listedProposalId];
        if (uint256(listed.snapshotTs) + 1 days != listed.endsAt) revert IPoolVault.InvalidProposal();
        if (block.timestamp >= s.expiresAt) revert IPoolVault.DeadlinePassed();
        if (block.chainid != 56) revert IPoolVault.InvalidFirstoOrder();
        ask = IFirstoSignedAskExchange.SignedAsk({
            maker: address(this),
            collection: v.params.circuits,
            tokenId: v.params.circuitId,
            nonce: s.listedProposalId,
            price: uint128(expected.price),
            expiry: s.expiresAt,
            payoutRecipient: address(this),
            feeBps: expected.feeBps,
            feeEpoch: expected.feeEpoch,
            schemaVersion: 2
        });
    }

    function _requireFees(IFirstoSignedAskExchange.SignedAsk memory ask) private view {
        IFirstoSignedAskExchange exchange = IFirstoSignedAskExchange(EXCHANGE);
        if (exchange.factory() != PROTOCOL_FACTORY || exchange.paused() || exchange.SIGNED_ASK_SCHEMA_VERSION() != 2) {
            revert IPoolVault.InvalidFirstoOrder();
        }
        if (
            ask.feeBps > 10_000 || ask.feeEpoch != exchange.feeEpoch() || ask.feeBps != exchange.defaultTakerFeeBps()
                || ask.feeBps != exchange.feeBpsAtEpoch(ask.feeEpoch)
        ) revert IPoolVault.FirstoFeeChanged();
    }

    function _hash(IFirstoSignedAskExchange.SignedAsk memory ask) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Firsto Circuit Signed Ask"),
                keccak256("2"),
                block.chainid,
                EXCHANGE
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(ASK_TYPEHASH, ask))));
    }

    function _storage() private pure returns (FirstoSaleState.FirstoSaleStorage storage s) {
        // ERC-7201: keccak256(abi.encode(uint256(keccak256(namespace)) - 1)) & ~0xff.
        bytes32 location =
            keccak256(abi.encode(uint256(keccak256("tapeout.storage.FirstoSale")) - 1)) & ~bytes32(uint256(0xff));
        assembly { s.slot := location }
    }
}
