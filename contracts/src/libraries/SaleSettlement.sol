// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
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

    function prepare(
        PoolSaleState.SaleStorage storage s,
        address buyer,
        uint256 gross,
        address circuits,
        uint256 circuitId
    ) external returns (uint256 fee) {
        if (s.listedProposalId == 0 || s.saleBuyer != address(0)) revert IPoolVault.InvalidListing();
        if (block.timestamp >= s.expiresAt) revert IPoolVault.DeadlinePassed();
        if (gross != s.salePrice) revert IPoolVault.PaymentMismatch();
        if (buyer == address(0)) revert IPoolVault.InvalidParameters();

        // Divide first: each 2% component is exact floor(gross * 200 / 10_000)
        // without a needless multiplication overflow at very large approved prices.
        fee = gross / 50;
        uint256 budget = gross / 50;
        uint256 memberNet = gross - fee - budget;
        s.saleBuyer = buyer;
        s.completedAt = SafeCast.toUint64(block.timestamp);
        s.saleProceeds = gross;
        s.salePerShareWei = memberNet / TOTAL_SHARES;
        // Deterministic integer division remainder, not randomness.
        // slither-disable-next-line weak-prng
        s.saleRemainder = memberNet % TOTAL_SHARES;
        s.saleOutstandingWei = s.salePerShareWei * TOTAL_SHARES;
        s.burnBudget = budget;
        s.saleTradeId = keccak256(abi.encode(address(this), s.listedProposalId, buyer, circuits, circuitId, gross));
        emit SaleBudgetRecorded(s.listedProposalId, budget);
    }

    function handover(PoolSaleState.SaleStorage storage s, address circuits, uint256 circuitId, uint256 settledBem)
        external
    {
        address buyer = s.saleBuyer;
        if (buyer == address(0)) revert IPoolVault.InvalidListing();
        IERC721 nft = IERC721(circuits);
        if (nft.ownerOf(circuitId) != address(this)) revert IPoolVault.NotOwnerAfterBuy();
        emit RewardSettledBeforeTransfer(circuits, circuitId, address(this), settledBem, s.saleTradeId);
        nft.safeTransferFrom(address(this), buyer, circuitId);
        if (nft.ownerOf(circuitId) != buyer) revert IPoolVault.TransferFailed();
        uint256 fee = s.saleProceeds / 50;
        // No BEM has been bought with the reserved BNB yet. Later swaps record actual burns.
        emit SaleCompleted(s.saleProceeds, fee, 0, s.saleProceeds - fee - fee);
    }

    /// @notice Closed freezes balances, so same-second listing and purchase need no past-time lookup.
    function pending(PoolSaleState.SaleStorage storage s, address member, uint256 shares)
        external
        view
        returns (uint256)
    {
        return _pending(s, member, shares);
    }

    /// @dev Returns only a newly materialized liability. Vault adds it to its existing BNB credits.
    function materialize(PoolSaleState.SaleStorage storage s, address member, uint256 shares)
        external
        returns (uint256 amount)
    {
        if (s.saleBuyer == address(0) || s.saleSettled[member]) return 0;
        amount = _pending(s, member, shares);
        s.saleSettled[member] = true;
        s.saleOutstandingWei -= amount;
    }

    function _pending(PoolSaleState.SaleStorage storage s, address member, uint256 shares)
        private
        view
        returns (uint256)
    {
        if (s.saleBuyer == address(0) || s.saleSettled[member]) return 0;
        return shares * s.salePerShareWei;
    }
}
