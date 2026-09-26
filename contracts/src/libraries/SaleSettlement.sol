// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {PoolVaultState} from "../PoolVaultState.sol";
import {PoolSaleState} from "../PoolSaleState.sol";

/// @notice Accounting and NFT handover for the Vault's approved direct sale.
/// @dev Vault must hold nonReentrant, require Listed, strictly harvest before
/// prepare, then enter Closed and credit the treasury before calling handover.
library SaleSettlement {
    uint256 private constant TOTAL_SHARES = 100;

    event RewardSettledBeforeTransfer(
        address indexed circuits, uint256 indexed circuitId, address previousOwner, uint256 bemAmount, bytes32 tradeId
    );
    event SaleBudgetRecorded(uint256 indexed proposalId, uint256 amount);
    event SaleCompleted(uint256 gross, uint256 toPlatform, uint256 burnedBem, uint256 toMembers);

    function complete(PoolVaultState.VaultStorage storage v, PoolSaleState.SaleStorage storage s, uint256 settledBem)
        external
    {
        // Revalidate legacy listings at payment time: upgrading an already Listed
        // pool cannot bypass the new zero-price and below-cost vote requirements.
        PoolSaleState.Proposal storage proposal = s.proposals[s.listedProposalId];
        if (msg.value == 0) revert IPoolVault.InvalidSalePrice();
        bool sharesPassed = msg.value < v.purchaseCost
            ? proposal.yesShares >= 60
            : proposal.yesShares * 2 > proposal.snapshotTotalShares;
        if (
            !proposal.executed || proposal.price != msg.value || proposal.snapshotTotalShares != TOTAL_SHARES
                || proposal.yesCount * 2 <= proposal.snapshotMemberCount || !sharesPassed
        ) revert IPoolVault.ProposalNotPassed();
        address roundingRecipient = _roundingRecipient(v);
        uint256 fee = _prepare(s, msg.sender, msg.value, v.params.circuits, v.params.circuitId, roundingRecipient);
        v.state = IPoolVault.State.Closed;
        v.bnbOwed[v.treasury] += fee;
        v.totalBnbOwed += fee;
        _handover(s, v.params.circuits, v.params.circuitId, settledBem);
    }

    function _prepare(
        PoolSaleState.SaleStorage storage s,
        address buyer,
        uint256 gross,
        address circuits,
        uint256 circuitId,
        address roundingRecipient
    ) private returns (uint256 fee) {
        if (s.listedProposalId == 0 || s.saleBuyer != address(0)) revert IPoolVault.InvalidListing();
        if (block.timestamp >= s.expiresAt) revert IPoolVault.DeadlinePassed();
        if (gross != s.salePrice) revert IPoolVault.PaymentMismatch();
        if (buyer == address(0) || roundingRecipient == address(0)) revert IPoolVault.InvalidParameters();

        // Only the existing 2% platform fee is deducted. All remaining wei are owed to holders.
        fee = gross / 50;
        uint256 memberNet = gross - fee;
        s.saleBuyer = buyer;
        s.completedAt = SafeCast.toUint64(block.timestamp);
        s.saleProceeds = gross;
        s.salePerShareWei = memberNet / TOTAL_SHARES;
        // Deterministic integer division remainder, not randomness.
        // slither-disable-next-line weak-prng
        s.saleRemainder = memberNet % TOTAL_SHARES;
        s.saleOutstandingWei = memberNet;
        s.saleRoundingRecipient = roundingRecipient;
        s.legacyBurnBudgetReleased = true;
        s.saleTradeId = keccak256(abi.encode(address(this), s.listedProposalId, buyer, circuits, circuitId, gross));
    }

    function _handover(PoolSaleState.SaleStorage storage s, address circuits, uint256 circuitId, uint256 settledBem)
        private
    {
        address buyer = s.saleBuyer;
        if (buyer == address(0)) revert IPoolVault.InvalidListing();
        IERC721 nft = IERC721(circuits);
        if (nft.ownerOf(circuitId) != address(this)) revert IPoolVault.NotOwnerAfterBuy();
        emit RewardSettledBeforeTransfer(circuits, circuitId, address(this), settledBem, s.saleTradeId);
        nft.safeTransferFrom(address(this), buyer, circuitId);
        if (nft.ownerOf(circuitId) != buyer) revert IPoolVault.TransferFailed();
        uint256 fee = s.saleProceeds / 50;
        emit SaleCompleted(s.saleProceeds, fee, 0, s.saleProceeds - fee);
    }

    /// @notice Closed freezes balances; rounding goes to a fixed sale-time holder address.
    function pending(
        PoolSaleState.SaleStorage storage s,
        PoolVaultState.VaultStorage storage v,
        address member,
        uint256 shares
    ) external view returns (uint256) {
        return _pending(s, member, shares, _roundingRecipient(v));
    }

    /// @dev Historical completed sales keep their original paid flags. Remaining burn
    /// budget and old integer dust form an independent entitlement, including for users
    /// who already withdrew their old sale proceeds. Previously spent BNB is never recreated.
    function materialize(
        PoolSaleState.SaleStorage storage s,
        PoolVaultState.VaultStorage storage v,
        address member,
        uint256 shares
    ) external returns (uint256 amount) {
        if (s.saleBuyer == address(0)) return 0;
        if (!s.legacyBurnBudgetReleased) {
            address fallbackRecipient = _roundingRecipient(v);
            uint256 released = s.burnBudget + s.saleRemainder;
            if (fallbackRecipient == address(0)) revert IPoolVault.AccountingDeficit();
            s.legacyBurnBudgetReleased = true;
            s.legacyBonusPerShareWei = released / TOTAL_SHARES;
            s.legacyBonusRemainder = released % TOTAL_SHARES;
            s.legacyBonusOutstandingWei = released;
            s.legacyRoundingRecipient = fallbackRecipient;
            s.burnBudget = 0;
            s.saleRemainder = 0;
            emit LegacySaleBudgetReleased(released, fallbackRecipient);
        }
        if (!s.saleSettled[member]) {
            amount = shares * s.salePerShareWei;
            if (member == s.saleRoundingRecipient) amount += s.saleRemainder;
            s.saleSettled[member] = true;
            s.saleOutstandingWei -= amount;
        }
        if (!s.legacyBonusSettled[member]) {
            uint256 bonus = shares * s.legacyBonusPerShareWei;
            if (member == s.legacyRoundingRecipient) bonus += s.legacyBonusRemainder;
            s.legacyBonusSettled[member] = true;
            s.legacyBonusOutstandingWei -= bonus;
            amount += bonus;
        }
        if (amount != 0) {
            v.bnbOwed[member] += amount;
            v.totalBnbOwed += amount;
            emit SaleProceedsSettled(member, shares, amount);
        }
    }

    event SaleProceedsSettled(address indexed user, uint256 shares, uint256 amount);

    function _roundingRecipient(PoolVaultState.VaultStorage storage v) private view returns (address) {
        uint256 count = v.activeMembers.length;
        return count == 0 ? address(0) : v.activeMembers[count - 1];
    }

    function outstanding(PoolSaleState.SaleStorage storage s) external view returns (uint256) {
        uint256 legacy = s.legacyBurnBudgetReleased ? s.legacyBonusOutstandingWei : s.burnBudget + s.saleRemainder;
        return s.saleOutstandingWei + legacy;
    }

    event LegacySaleBudgetReleased(uint256 amount, address indexed roundingRecipient);

    function _pending(PoolSaleState.SaleStorage storage s, address member, uint256 shares, address fallbackRecipient)
        private
        view
        returns (uint256 amount)
    {
        if (s.saleBuyer == address(0)) return 0;
        if (!s.saleSettled[member]) {
            amount = shares * s.salePerShareWei;
            if (member == s.saleRoundingRecipient) amount += s.saleRemainder;
        }
        if (!s.legacyBonusSettled[member]) {
            if (s.legacyBurnBudgetReleased) {
                amount += shares * s.legacyBonusPerShareWei;
                if (member == s.legacyRoundingRecipient) amount += s.legacyBonusRemainder;
            } else {
                uint256 released = s.burnBudget + s.saleRemainder;
                // Match the stored per-share floor used by materialize; the entire
                // remaining tail is assigned separately to the fixed rounding recipient.
                // slither-disable-next-line divide-before-multiply
                amount += shares * (released / TOTAL_SHARES);
                if (member == fallbackRecipient) amount += released % TOTAL_SHARES;
            }
        }
    }
}
