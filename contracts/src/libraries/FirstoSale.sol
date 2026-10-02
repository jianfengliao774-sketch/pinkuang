// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {IFirstoSignedAskExchange} from "../interfaces/IFirstoExchange.sol";
import {PoolVaultState} from "../PoolVaultState.sol";
import {PoolSaleState} from "../PoolSaleState.sol";
import {PoolRewardState} from "../PoolRewardState.sol";
import {FirstoSaleState} from "../FirstoSaleState.sol";
import {FirstoSaleExecutor} from "../FirstoSaleExecutor.sol";
import {SaleSettlement} from "./SaleSettlement.sol";
import {RewardAccounting} from "./RewardAccounting.sol";
import {MiningOperations} from "./MiningOperations.sol";
import {SaleGovernance} from "./SaleGovernance.sol";
import {PoolFunds} from "./PoolFunds.sol";
import {IPoolFactoryRoles} from "../interfaces/IPoolVault.sol";

interface IFirstoVaultTimelock {
    function timelock() external view returns (address);
}

/// @notice One governance-approved ask shared by Firsto's native site and the controlled site.
/// @dev Opening strictly harvests first. Native fills transfer before payout, so
/// uncollected post-listing Mining income belongs to the new NFT owner. The
/// controlled entry additionally harvests immediately before its own handover.
library FirstoSale {
    using Checkpoints for Checkpoints.Trace208;
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
    event NativeFirstoAskOpened(uint256 indexed proposalId, bytes32 indexed orderHash, uint16 feeBps, uint256 feeEpoch);
    event NativeFirstoAskRevoked(bytes32 indexed orderHash);
    event TreasuryMigrated(address indexed previousTreasury, address indexed nextTreasury);
    event SaleDelistingProposed(
        uint256 indexed cancellationId,
        uint256 indexed listedProposalId,
        address indexed proposer,
        uint48 snapshotTs,
        uint256 snapshotMemberCount
    );
    event SaleDelistingVoted(uint256 indexed cancellationId, address indexed voter, bool support, uint256 weight);
    event SaleDelisted(uint256 indexed proposalId, uint256 indexed cancellationId);
    event SaleExpired(uint256 indexed proposalId);

    function paramsEncoded(PoolVaultState.VaultStorage storage v) external view returns (bytes memory) {
        return abi.encode(v.params);
    }

    /// @dev Exact pre-transfer path previously in PoolVault._update. The Vault
    /// retains the same outer lock, ERC20 balance mutation and checkpoints.
    function beforeShareUpdate(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage sale,
        PoolRewardState.RewardStorage storage rewards,
        address from,
        address to,
        uint256 amount
    ) external {
        if (to == address(this) || to == v.factory) revert IPoolVault.InvalidShareRecipient();
        IERC20 shares = IERC20(address(this));
        if (from != address(0) && to != address(0)) {
            if (v.state != IPoolVault.State.Active) revert IPoolVault.WrongState();
            if (SaleGovernance.tradingFrozen(sale)) revert IPoolVault.ProposalActive();
            address market = IPoolFactoryRoles(v.factory).shareMarket();
            if (market == address(0)) revert IPoolVault.WrongState();
            if (to == market) revert IPoolVault.MarketCannotHoldShares();
            if (amount == 0) revert IPoolVault.InvalidShareCount();
            if (amount > 100) revert IPoolVault.ShareOutOfRange();
            if (amount > shares.balanceOf(from) - v.lockedShares[from]) revert IPoolVault.InsufficientUnlockedShares();
            _harvest(v, rewards, true);
            RewardAccounting.settle(rewards, from, shares.balanceOf(from));
            if (to != from) RewardAccounting.settle(rewards, to, shares.balanceOf(to));
        } else if (v.state != IPoolVault.State.Funding) {
            revert IPoolVault.WrongState();
        }
        if (from != address(0)) PoolFunds.materializePurchase(v, from, shares.balanceOf(from));
        if (to != address(0)) PoolFunds.materializePurchase(v, to, shares.balanceOf(to));
    }

    function nftReceipt(PoolVaultState.VaultStorage storage v, address operator, address from, uint256 id)
        external
        returns (bytes4)
    {
        if (
            v.state != IPoolVault.State.Funded || v.expectedNftOperator == address(0) || v.nftReceived
                || msg.sender != v.params.circuits || id != v.params.circuitId || from != v.expectedNftSeller
                || operator != v.expectedNftOperator
        ) revert IPoolVault.UnexpectedNft();
        v.nftReceived = true;
        v.expectedNftOperator = address(0);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev Only a successfully removed listing earns a reopening epoch. A
    /// caller consumes its old cooldown exemption once in that epoch; later
    /// candidates retain the ordinary anti-spam interval. Initial holding time
    /// is unchanged for pools that have never completed a delisting.
    function prepareProposal(PoolSaleState.SaleStorage storage s, uint64 activatedAt) external returns (uint64) {
        FirstoSaleState.FirstoSaleStorage storage a = _storage();
        if (a.reopenEpoch == 0) return activatedAt;
        if (a.reopenedForEpoch[msg.sender] != a.reopenEpoch) {
            a.reopenedForEpoch[msg.sender] = a.reopenEpoch;
            delete s.lastProposed[msg.sender];
        }
        return 0;
    }

    function lastProposed(PoolSaleState.SaleStorage storage s, address member) external view returns (uint64) {
        FirstoSaleState.FirstoSaleStorage storage a = _storage();
        return a.reopenEpoch != 0 && a.reopenedForEpoch[member] != a.reopenEpoch ? 0 : s.lastProposed[member];
    }

    function cancelExpired(PoolVaultState.VaultStorage storage v, PoolSaleState.SaleStorage storage s) external {
        if (v.state != IPoolVault.State.Listed) revert IPoolVault.WrongState();
        if (s.listedProposalId == 0) revert IPoolVault.InvalidListing();
        if (block.timestamp < s.expiresAt) revert IPoolVault.DeadlineNotReached();
        uint256 proposalId = s.listedProposalId;
        _removeListing(v, s);
        emit SaleExpired(proposalId);
    }

    function delist(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        uint8 action,
        uint256 cancellationId,
        uint256 expectedListedProposalId,
        bool support
    ) external returns (uint256 id) {
        if (v.state != IPoolVault.State.Listed) revert IPoolVault.WrongState();
        if (expectedListedProposalId == 0 || expectedListedProposalId != s.listedProposalId) {
            revert IPoolVault.InvalidProposal();
        }
        if (block.timestamp >= s.expiresAt) revert IPoolVault.DeadlinePassed();
        FirstoSaleState.FirstoSaleStorage storage a = _storage();
        if (action == 0) {
            if (
                cancellationId != 0
                    || (a.activeDelistingId != 0
                        && a.delistingProposals[a.activeDelistingId].listedProposalId == expectedListedProposalId)
            ) revert IPoolVault.InvalidProposal();
            if (IERC20(address(this)).balanceOf(msg.sender) == 0) revert IPoolVault.NotMember();
            id = ++a.nextDelistingId;
            a.activeDelistingId = id;
            FirstoSaleState.DelistingProposal storage p = a.delistingProposals[id];
            p.proposer = msg.sender;
            p.listedProposalId = expectedListedProposalId;
            p.snapshotTs = SafeCast.toUint48(block.timestamp);
            p.expiresAt = s.expiresAt;
            p.snapshotMemberCount = v.memberHistory.upperLookupRecent(p.snapshotTs);
            emit SaleDelistingProposed(id, expectedListedProposalId, msg.sender, p.snapshotTs, p.snapshotMemberCount);
            return id;
        }
        id = cancellationId;
        FirstoSaleState.DelistingProposal storage p = a.delistingProposals[id];
        if (id == 0 || id != a.activeDelistingId || p.listedProposalId != expectedListedProposalId || p.executed) {
            revert IPoolVault.InvalidProposal();
        }
        if (action == 1) {
            if (a.delistingVotes[id][msg.sender]) revert IPoolVault.AlreadyVoted();
            uint256 weight = v.shareHistory[msg.sender].upperLookupRecent(p.snapshotTs);
            if (weight == 0) revert IPoolVault.NotMember();
            a.delistingVotes[id][msg.sender] = true;
            if (support) {
                ++p.yesCount;
                p.yesShares += weight;
            } else {
                ++p.noCount;
                p.noShares += weight;
            }
            emit SaleDelistingVoted(id, msg.sender, support, weight);
        } else if (action == 2) {
            if (p.yesCount * 2 <= p.snapshotMemberCount || p.yesShares * 2 <= 100) {
                revert IPoolVault.ProposalNotPassed();
            }
            p.executed = true;
            _removeListing(v, s);
            emit SaleDelisted(expectedListedProposalId, id);
        } else {
            revert IPoolVault.InvalidParameters();
        }
    }

    function delistingEncoded(uint256 id) external view returns (bytes memory) {
        FirstoSaleState.FirstoSaleStorage storage a = _storage();
        if (id == 0) id = a.activeDelistingId;
        FirstoSaleState.DelistingProposal storage p = a.delistingProposals[id];
        return abi.encode(id, p, a.delistingVotes[id][msg.sender]);
    }

    function _removeListing(PoolVaultState.VaultStorage storage v, PoolSaleState.SaleStorage storage s) private {
        _revoke(v);
        delete s.listedProposalId;
        delete s.listedAt;
        delete s.expiresAt;
        delete s.salePrice;
        delete s.activeProposalId;
        FirstoSaleState.FirstoSaleStorage storage a = _storage();
        delete a.activeDelistingId;
        ++a.reopenEpoch;
        v.state = IPoolVault.State.Active;
    }

    /// @dev Shared guarded handover accounting stays in this linked module to
    /// leave runtime space for the native ask ABI. Callers retain the Vault lock.
    function harvest(
        PoolVaultState.VaultStorage storage v,
        PoolRewardState.RewardStorage storage rewards,
        bool finalHandover
    ) external returns (uint256 gross, uint256 fee, uint256 burned, uint256 net) {
        return _harvest(v, rewards, finalHandover);
    }

    function _harvest(
        PoolVaultState.VaultStorage storage v,
        PoolRewardState.RewardStorage storage rewards,
        bool finalHandover
    ) private returns (uint256 gross, uint256 fee, uint256 burned, uint256 net) {
        MiningOperations.claimReward(v.params.circuits, v.params.circuitId, finalHandover);
        return RewardAccounting.account(rewards, 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a, v.treasury);
    }

    function migrateTreasury(
        PoolVaultState.VaultStorage storage v,
        PoolRewardState.RewardStorage storage rewards,
        address officialFactory,
        address expectedOld,
        address next
    ) external {
        if (msg.sender != IFirstoVaultTimelock(officialFactory).timelock()) {
            revert IPoolVault.Unauthorized();
        }
        if (v.factory != officialFactory || next == address(0) || next == expectedOld || v.treasury != expectedOld) {
            revert IPoolVault.InvalidParameters();
        }
        if (v.state == IPoolVault.State.Active || v.state == IPoolVault.State.Listed) _harvest(v, rewards, true);
        v.treasury = next;
        emit TreasuryMigrated(expectedOld, next);
    }

    function open(PoolVaultState.VaultStorage storage v, PoolSaleState.SaleStorage storage s) external {
        IFirstoSignedAskExchange exchange = IFirstoSignedAskExchange(EXCHANGE);
        _open(v, s, Confirmation(s.listedProposalId, s.salePrice, exchange.defaultTakerFeeBps(), exchange.feeEpoch()));
    }

    function openExpected(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        Confirmation memory expected
    ) external {
        _open(v, s, expected);
    }

    function _open(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        Confirmation memory expected
    ) private {
        FirstoSaleState.FirstoSaleStorage storage authorization = _storage();
        if (authorization.active || authorization.nativeActive) revert IPoolVault.UnverifiedSaleRoute();
        IFirstoSignedAskExchange.SignedAsk memory ask = _ask(v, s, expected);
        _requireFees(ask);
        if (IERC721(ask.collection).ownerOf(ask.tokenId) != address(this)) revert IPoolVault.NotOwnerAfterBuy();
        if (IFirstoSignedAskExchange(EXCHANGE).isSignedAskNonceInvalidated(address(this), ask.nonce)) {
            revert IPoolVault.InvalidFirstoOrder();
        }
        authorization.nativeOrderHash = _hash(ask);
        authorization.nativeProposalId = ask.nonce;
        authorization.nativeFeeBps = ask.feeBps;
        authorization.nativeFeeEpoch = ask.feeEpoch;
        authorization.nativeActive = true;
        // Token-scoped approval only. Expiry/cancellation revokes this approval;
        // the exchange can sell only the exact hash accepted by the Vault below.
        IERC721(ask.collection).approve(EXCHANGE, ask.tokenId);
        emit NativeFirstoAskOpened(ask.nonce, authorization.nativeOrderHash, ask.feeBps, ask.feeEpoch);
    }

    function revoke(PoolVaultState.VaultStorage storage v) external {
        _revoke(v);
    }

    function _revoke(PoolVaultState.VaultStorage storage v) private {
        FirstoSaleState.FirstoSaleStorage storage authorization = _storage();
        bytes32 oldHash = authorization.nativeOrderHash;
        bool wasActive = authorization.nativeActive;
        authorization.nativeActive = false;
        delete authorization.nativeOrderHash;
        if (IERC721(v.params.circuits).ownerOf(v.params.circuitId) != address(this)) {
            revert IPoolVault.NotOwnerAfterBuy();
        }
        IERC721(v.params.circuits).approve(address(0), v.params.circuitId);
        if (
            wasActive
                && !IFirstoSignedAskExchange(EXCHANGE)
                    .isSignedAskNonceInvalidated(address(this), authorization.nativeProposalId)
        ) {
            IFirstoSignedAskExchange(EXCHANGE).cancelSignedAskNonce(authorization.nativeProposalId);
        }
        emit NativeFirstoAskRevoked(oldHash);
    }

    function nativeAskEncoded(PoolVaultState.VaultStorage storage v, PoolSaleState.SaleStorage storage s)
        external
        view
        returns (bytes memory)
    {
        FirstoSaleState.FirstoSaleStorage storage authorization = _storage();
        IFirstoSignedAskExchange.SignedAsk memory ask =
            _buildAsk(v, s, authorization.nativeFeeBps, authorization.nativeFeeEpoch);
        bytes32 orderHash = authorization.nativeOrderHash;
        return abi.encode(ask, orderHash, _nativeValid(v, s, orderHash));
    }

    function complete(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        Confirmation memory expected,
        uint256 settledBem
    ) external {
        IFirstoSignedAskExchange.SignedAsk memory ask = _ask(v, s, expected);
        _requireFees(ask);
        FirstoSaleState.FirstoSaleStorage storage authorization = _storage();
        if (
            authorization.nativeActive
                && (authorization.nativeOrderHash != _hash(ask)
                    || authorization.nativeFeeBps != ask.feeBps
                    || authorization.nativeFeeEpoch != ask.feeEpoch)
        ) revert IPoolVault.FirstoFeeChanged();
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
        authorization.nativeActive = false;
        emit SaleCompleted(ask.price, uint256(ask.price) / 100, 0, uint256(ask.price) - uint256(ask.price) / 100);
        emit FirstoSaleCompleted(expected.proposalId, orderHash, msg.sender, ask.price, takerFee, ask.feeEpoch);
    }

    function isValidSignature(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        bytes32 orderHash
    ) external view returns (bytes4) {
        FirstoSaleState.FirstoSaleStorage storage authorization = _storage();
        bool controlled = msg.sender == EXCHANGE && authorization.active && !authorization.received
            && authorization.orderHash == orderHash;
        return controlled || _nativeValid(v, s, orderHash) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function _nativeValid(PoolVaultState.VaultStorage storage v, PoolSaleState.SaleStorage storage s, bytes32 orderHash)
        private
        view
        returns (bool)
    {
        FirstoSaleState.FirstoSaleStorage storage authorization = _storage();
        if (
            !authorization.nativeActive || authorization.nativeOrderHash != orderHash
                || v.state != IPoolVault.State.Listed || block.chainid != 56 || block.timestamp >= s.expiresAt
                || authorization.nativeProposalId != s.listedProposalId || s.salePrice == 0
                || s.salePrice > type(uint128).max
        ) return false;
        IFirstoSignedAskExchange.SignedAsk memory ask =
            _buildAsk(v, s, authorization.nativeFeeBps, authorization.nativeFeeEpoch);
        return _hash(ask) == orderHash && _feesMatch(ask)
            && IERC721(ask.collection).ownerOf(ask.tokenId) == address(this)
            && !IFirstoSignedAskExchange(EXCHANGE).isSignedAskNonceInvalidated(address(this), ask.nonce);
    }

    /// @dev Vault holds its normal reentrancy guard. This callback happens after
    /// the native exchange has transferred the NFT and consumed the same nonce.
    /// A failed payout reverts the exchange's NFT transfer and nonce as well.
    function receiveNative(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        PoolRewardState.RewardStorage storage rewards
    ) external {
        FirstoSaleState.FirstoSaleStorage storage authorization = _storage();
        if (
            msg.sender != EXCHANGE || !authorization.nativeActive || authorization.active
                || v.state != IPoolVault.State.Listed || msg.value != s.salePrice
        ) revert IPoolVault.UnsupportedSubscriptionAsset();
        IFirstoSignedAskExchange.SignedAsk memory ask = _ask(
            v,
            s,
            Confirmation(s.listedProposalId, s.salePrice, authorization.nativeFeeBps, authorization.nativeFeeEpoch)
        );
        if (authorization.nativeProposalId != ask.nonce || authorization.nativeOrderHash != _hash(ask)) {
            revert IPoolVault.InvalidFirstoOrder();
        }
        _requireFees(ask);
        IFirstoSignedAskExchange exchange = IFirstoSignedAskExchange(EXCHANGE);
        address recipient = IERC721(ask.collection).ownerOf(ask.tokenId);
        if (recipient == address(0) || recipient == address(this)) revert IPoolVault.TransferFailed();
        if (!exchange.isSignedAskNonceInvalidated(address(this), ask.nonce)) revert IPoolVault.InvalidFirstoOrder();
        authorization.nativeActive = false;
        // Only BEM actually present in this Vault is booked. Never call Mining
        // now: after transfer it pays the buyer, not these original shareholders.
        SaleSettlement.completeNative(v, s, recipient, ask.price);
        RewardAccounting.account(rewards, 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a, v.treasury);
        uint256 fee = uint256(ask.price) / 100;
        emit SaleCompleted(ask.price, fee, 0, uint256(ask.price) - fee);
        emit FirstoSaleCompleted(
            ask.nonce,
            authorization.nativeOrderHash,
            recipient,
            ask.price,
            uint256(ask.price) * ask.feeBps / 10_000,
            ask.feeEpoch
        );
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
        ask = _buildAsk(v, s, expected.feeBps, expected.feeEpoch);
    }

    function _buildAsk(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        uint16 feeBps,
        uint256 feeEpoch
    ) private view returns (IFirstoSignedAskExchange.SignedAsk memory ask) {
        ask = IFirstoSignedAskExchange.SignedAsk({
            maker: address(this),
            collection: v.params.circuits,
            tokenId: v.params.circuitId,
            nonce: s.listedProposalId,
            price: uint128(s.salePrice),
            expiry: s.expiresAt,
            payoutRecipient: address(this),
            feeBps: feeBps,
            feeEpoch: feeEpoch,
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

    function _feesMatch(IFirstoSignedAskExchange.SignedAsk memory ask) private view returns (bool) {
        IFirstoSignedAskExchange exchange = IFirstoSignedAskExchange(EXCHANGE);
        return exchange.factory() == PROTOCOL_FACTORY && !exchange.paused() && exchange.SIGNED_ASK_SCHEMA_VERSION() == 2
            && ask.feeBps <= 10_000 && ask.feeEpoch == exchange.feeEpoch()
            && ask.feeBps == exchange.defaultTakerFeeBps() && ask.feeBps == exchange.feeBpsAtEpoch(ask.feeEpoch);
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
