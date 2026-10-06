// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {PoolVaultState} from "../PoolVaultState.sol";
import {PoolSaleState} from "../PoolSaleState.sol";

/// @notice Books the Vault's approved sale before Firsto performs the NFT handover.
/// @dev Vault holds nonReentrant and strictly harvests first; FirstoSale must verify
/// exact source payment, final owner and nonce consumption before the transaction returns.
library SaleSettlement {
    uint256 private constant TOTAL_SHARES = 100;

    event RewardSettledBeforeTransfer(
        address indexed circuits, uint256 indexed circuitId, address previousOwner, uint256 bemAmount, bytes32 tradeId
    );
    event SaleBudgetRecorded(uint256 indexed proposalId, uint256 amount);
    event SaleCompleted(uint256 gross, uint256 toPlatform, uint256 burnedBem, uint256 toMembers);

    function proposalEncoded(PoolSaleState.SaleStorage storage s, uint256 proposalId)
        external
        view
        returns (bytes memory)
    {
        PoolSaleState.Proposal storage p = s.proposals[proposalId];
        if (p.proposer == address(0)) revert IPoolVault.InvalidProposal();
        return abi.encode(p);
    }

    function prepareFirsto(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        address buyer,
        uint256 gross,
        uint256 settledBem
    ) external {
        // Revalidate historical listings at payment time using the same dual
        // majority rule that permits a new listing; zero-price remains invalid.
        PoolSaleState.Proposal storage proposal = s.proposals[s.listedProposalId];
        if (gross == 0) revert IPoolVault.InvalidSalePrice();
        if (
            !proposal.executed || proposal.price != gross || proposal.snapshotTotalShares != TOTAL_SHARES
                || proposal.yesCount * 2 <= proposal.snapshotMemberCount
                || proposal.yesShares * 2 <= proposal.snapshotTotalShares
        ) revert IPoolVault.ProposalNotPassed();
        address roundingRecipient = _roundingRecipient(v);
        uint256 fee = _prepare(s, buyer, gross, v.params.circuits, v.params.circuitId, roundingRecipient);
        v.state = IPoolVault.State.Closed;
        v.bnbOwed[v.treasury] += fee;
        v.totalBnbOwed += fee;
        if (IERC721(v.params.circuits).ownerOf(v.params.circuitId) != address(this)) {
            revert IPoolVault.NotOwnerAfterBuy();
        }
        emit RewardSettledBeforeTransfer(
            v.params.circuits, v.params.circuitId, address(this), settledBem, s.saleTradeId
        );
    }

    /// @notice Native Firsto has already delivered the NFT before sending its exact payout.
    /// @dev The caller validates the exchange, ask, consumed nonce and new NFT owner.
    /// Shares remain frozen from Listed through Closed. This does not claim Mining
    /// after transfer, and therefore cannot assign buyer-owned emissions to old holders.
    function completeNative(
        PoolVaultState.VaultStorage storage v,
        PoolSaleState.SaleStorage storage s,
        address recipient,
        uint256 gross
    ) external {
        PoolSaleState.Proposal storage proposal = s.proposals[s.listedProposalId];
        if (
            !proposal.executed || proposal.price != gross || proposal.snapshotTotalShares != TOTAL_SHARES
                || proposal.yesCount * 2 <= proposal.snapshotMemberCount
                || proposal.yesShares * 2 <= proposal.snapshotTotalShares
        ) revert IPoolVault.ProposalNotPassed();
        address roundingRecipient = _roundingRecipient(v);
        uint256 fee = _prepare(s, recipient, gross, v.params.circuits, v.params.circuitId, roundingRecipient);
        v.state = IPoolVault.State.Closed;
        v.bnbOwed[v.treasury] += fee;
        v.totalBnbOwed += fee;
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

        // Only the 1% platform fee is deducted. All remaining wei are owed to holders.
        fee = gross / 100;
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
        return _outstanding(s);
    }

    /// @dev Same permanent liabilities, kept with settlement to leave the Vault
    /// enough runtime space for its new native sale ABI. The self-call is view-only.
    function totalOwed(PoolVaultState.VaultStorage storage v, PoolSaleState.SaleStorage storage s)
        external
        view
        returns (uint256)
    {
        uint256 pendingRemainder = 0;
        if (v.surplusRemainder != 0 && v.activeMembers.length == 1) {
            address member = v.activeMembers[0];
            if (IERC20(address(this)).balanceOf(member) == TOTAL_SHARES && !v.surplusSettled[member]) {
                pendingRemainder = v.surplusRemainder;
            }
        }
        return v.totalBnbOwed + v.surplusOutstandingWei + pendingRemainder + _outstanding(s);
    }

    function _outstanding(PoolSaleState.SaleStorage storage s) private view returns (uint256) {
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
