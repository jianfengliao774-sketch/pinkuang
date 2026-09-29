// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Accounting for BEM that follows unclaimed portfolio shares.
/// @dev The caller must always have exactly 100 issued shares when recording a receipt,
/// and must pass balances from immediately before a share transfer. No token calls occur here.
library TransferableBemRewards {
    uint256 internal constant TOTAL_SHARES = 100;

    error InvalidTransfer();
    error AccountingDeficit();

    struct Ledger {
        uint256 accPerShare;
        uint256 remainder;
        uint256 totalReceived;
        uint256 totalClaimed;
        mapping(address => uint256) pending;
        mapping(address => uint256) debt;
    }

    /// @return distributed Amount credited across all 100 shares. The remainder stays
    /// in the project until a later BEM receipt makes another whole atomic unit/share.
    function record(Ledger storage s, uint256 received) internal returns (uint256 distributed) {
        uint256 available = received + s.remainder;
        uint256 perShare = available / TOTAL_SHARES;
        s.remainder = available % TOTAL_SHARES;
        s.accPerShare += perShare;
        s.totalReceived += received;
        distributed = available - s.remainder;
    }

    function claimable(Ledger storage s, address holder, uint256 balance) internal view returns (uint256) {
        uint256 accumulated = s.accPerShare * balance;
        uint256 alreadyAccounted = s.debt[holder];
        if (accumulated < alreadyAccounted) revert AccountingDeficit();
        return s.pending[holder] + accumulated - alreadyAccounted;
    }

    /// @notice Removes only what the caller manually claims. A later transfer moves
    /// the unclaimed remainder with the shares rather than freezing it for the seller.
    function take(Ledger storage s, address holder, uint256 balance) internal returns (uint256 amount) {
        amount = claimable(s, holder, balance);
        s.pending[holder] = 0;
        s.debt[holder] = s.accPerShare * balance;
        s.totalClaimed += amount;
    }

    /// @notice Move the proportional unclaimed BEM attached to transferred shares.
    /// A wallet mixing claimed and unclaimed acquisitions has fungible shares, so its
    /// outstanding entitlement is split pro rata with integer dust left to the seller.
    function move(Ledger storage s, address from, address to, uint256 fromBefore, uint256 toBefore, uint256 shares)
        internal
        returns (uint256 moved)
    {
        if (from == address(0) || to == address(0) || shares == 0 || shares > fromBefore) revert InvalidTransfer();
        _settle(s, from, fromBefore);
        if (from == to) return 0;
        _settle(s, to, toBefore);
        moved = s.pending[from] * shares / fromBefore;
        s.pending[from] -= moved;
        s.pending[to] += moved;
        s.debt[from] = s.accPerShare * (fromBefore - shares);
        s.debt[to] = s.accPerShare * (toBefore + shares);
    }

    function _settle(Ledger storage s, address holder, uint256 balance) private {
        s.pending[holder] = claimable(s, holder, balance);
        s.debt[holder] = s.accPerShare * balance;
    }
}
