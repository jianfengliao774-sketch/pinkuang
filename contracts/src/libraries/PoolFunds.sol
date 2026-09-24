// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {PoolVaultState} from "../PoolVaultState.sol";

/// @notice Existing BNB liabilities and purchase surplus, in the guarded Vault context.
/// @dev Vault retains mint/burn, NFT verification and each nonReentrant entry point.
library PoolFunds {
    uint256 private constant TOTAL_SHARES = 100;

    event Failed(uint8 reason);
    event BnbWithdrawn(address indexed user, uint256 amount);
    event Purchased(uint256 cost, uint8 path, uint256 listingId);
    event PurchaseSurplusSettled(address indexed user, uint256 shares, uint256 amount);

    /// @notice Wallet metadata identifies both the collection and the intended miner.
    function shareName(address circuits, uint256 circuitId) external pure returns (string memory) {
        string memory collection = circuits == 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C ? "Behemoth" : "TapeOut";
        return string.concat(collection, " #", Strings.toString(circuitId), " Pool Share");
    }

    function finalizeFailure(PoolVaultState.VaultStorage storage s) external {
        uint8 reason = 0;
        if (s.state == IPoolVault.State.Funding) {
            if (block.timestamp < s.params.fundingDeadline) revert IPoolVault.DeadlineNotReached();
        } else if (s.state == IPoolVault.State.Funded) {
            if (block.timestamp < s.params.purchaseDeadline) revert IPoolVault.DeadlineNotReached();
            reason = 1;
        } else {
            revert IPoolVault.WrongState();
        }
        if (s.refundsRecorded) revert IPoolVault.WrongState();
        s.state = IPoolVault.State.Refunding;
        s.refundsRecorded = true;
        uint256 count = s.activeMembers.length;
        for (uint256 i; i < count; ++i) {
            address member = s.activeMembers[i];
            uint256 amount = s.contributedWei[member];
            s.contributedWei[member] = 0;
            _credit(s, member, amount);
        }
        emit Failed(reason);
    }

    /// @dev Called only after Vault has verified its exact expected NFT callback, owner and miner key.
    function recordPurchase(PoolVaultState.VaultStorage storage s, uint256 cost, uint8 path, uint256 listingId)
        external
    {
        delete s.expectedNftSeller;
        delete s.expectedNftOperator;
        delete s.nftReceived;
        s.purchaseCost = cost;
        s.activatedAt = SafeCast.toUint64(block.timestamp);
        s.state = IPoolVault.State.Active;
        uint256 surplus = s.totalRaised - cost;
        s.surplusPerShareWei = surplus / TOTAL_SHARES;
        // Deterministic integer division remainder, not randomness.
        // slither-disable-next-line weak-prng
        s.surplusRemainder = surplus % TOTAL_SHARES;
        s.surplusOutstandingWei = s.surplusPerShareWei * TOTAL_SHARES;
        emit Purchased(cost, path, listingId);
    }

    function pendingPurchase(PoolVaultState.VaultStorage storage s, address member, uint256 shares)
        external
        view
        returns (uint256)
    {
        return _pending(s, member, shares);
    }

    function materializePurchase(PoolVaultState.VaultStorage storage s, address member, uint256 shares) external {
        if (!_hasPurchase(s.state) || s.surplusSettled[member]) return;
        uint256 amount = _pending(s, member, shares);
        s.surplusSettled[member] = true;
        s.surplusOutstandingWei -= amount;
        _credit(s, member, amount);
        emit PurchaseSurplusSettled(member, shares, amount);
    }

    /// @dev Only the original caller's credit can be withdrawn; CEI precedes its one external call.
    function withdraw(PoolVaultState.VaultStorage storage s) external {
        uint256 amount = s.bnbOwed[msg.sender];
        if (amount == 0) revert IPoolVault.NothingToClaim();
        s.bnbOwed[msg.sender] = 0;
        s.totalBnbOwed -= amount;
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert IPoolVault.TransferFailed();
        emit BnbWithdrawn(msg.sender, amount);
    }

    function _credit(PoolVaultState.VaultStorage storage s, address member, uint256 amount) private {
        s.bnbOwed[member] += amount;
        s.totalBnbOwed += amount;
    }

    function _pending(PoolVaultState.VaultStorage storage s, address member, uint256 shares)
        private
        view
        returns (uint256)
    {
        if (!_hasPurchase(s.state) || s.surplusSettled[member]) return 0;
        return shares * s.surplusPerShareWei;
    }

    function _hasPurchase(IPoolVault.State state) private pure returns (bool) {
        return state == IPoolVault.State.Active || state == IPoolVault.State.Listed || state == IPoolVault.State.Closed;
    }
}
