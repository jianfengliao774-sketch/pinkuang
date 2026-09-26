// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PoolRewardState} from "../PoolRewardState.sol";

/// @notice Permanent member liabilities, executed under the Vault's reentrancy lock.
/// @dev Never calls Mining or changes shares. Existing expiry storage remains historical.
library RewardAccounting {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace224;

    uint256 private constant PRECISION = 1e36;
    uint256 private constant TOTAL_SHARES = 100;
    uint256 private constant DAY = 1 days;
    uint256 private constant MAX_LEGACY_CHECKPOINTS = 64;

    error ClaimTooSoon();
    error NothingToClaim();
    error AccountingDeficit();
    error LegacyRewardMigrationRequired();
    error BurnDisabled();

    event Harvested(uint256 gross, uint256 toPlatform, uint256 burned, uint256 toMembers);
    event BemClaimed(address indexed user, uint256 amount);
    event RewardMigrationStarted(uint32 indexed cutoverEpoch, uint256 cutoverAcc);
    event RewardUserMigrated(address indexed user, uint256 wholeAmount, uint256 fraction);

    function account(PoolRewardState.RewardStorage storage s, address bem, address treasury)
        external
        returns (uint256 gross, uint256 fee, uint256 burned, uint256 net)
    {
        _ensurePermanent(s);
        IERC20 token = IERC20(bem);
        uint256 balance = token.balanceOf(address(this));
        if (balance < s.bemAccounted) revert AccountingDeficit();
        gross = balance - s.bemAccounted;
        // Zero is the exact absence of unaccounted income, not an assumed external balance.
        // slither-disable-next-line incorrect-equality
        if (gross == 0) return (0, 0, 0, 0);
        fee = Math.mulDiv(gross, 100, 10_000);
        burned = 0; // Deprecated return value and event field retain their ABI.
        net = gross - fee;
        s.acc = SafeCast.toUint224(s.acc + Math.mulDiv(net, PRECISION, TOTAL_SHARES));
        s.bemAccounted += net;
        s.totalGross += gross;
        s.totalPlatform += fee;
        s.totalMemberNet += net;
        if (fee != 0) token.safeTransfer(treasury, fee);
        // Vault's lock covers this payment and the fresh solvency check.
        // slither-disable-next-line reentrancy-balance
        if (token.balanceOf(address(this)) < s.bemAccounted) revert AccountingDeficit();
        emit Harvested(gross, fee, 0, net);
    }

    function settle(PoolRewardState.RewardStorage storage s, address user, uint256 shares) external {
        _settle(s, user, shares);
    }

    /// @notice Pays only booked income, independently of Mining availability or NFT ownership.
    function claim(PoolRewardState.RewardStorage storage s, address user, uint256 shares, address bem)
        external
        returns (uint256 amount)
    {
        _settle(s, user, shares);
        PoolRewardState.RewardUser storage u = s.users[user];
        if (u.lastClaimAt != 0 && block.timestamp < uint256(u.lastClaimAt) + DAY) revert ClaimTooSoon();
        amount = u.owed;
        if (amount == 0) revert NothingToClaim();
        if (amount > s.bemAccounted) revert AccountingDeficit();
        u.owed = 0;
        u.lastClaimAt = SafeCast.toUint64(block.timestamp);
        s.bemAccounted -= amount;
        s.totalMemberPaid += amount;
        IERC20(bem).safeTransfer(user, amount);
        emit BemClaimed(user, amount);
    }

    function claimable(PoolRewardState.RewardStorage storage s, address user, uint256 shares)
        external
        view
        returns (uint256 amount)
    {
        PoolRewardState.RewardUser storage u = s.users[user];
        uint256 debt = u.debtAcc;
        uint256 scaled = u.globalRemainder;
        if (!s.expiryDisabled) {
            uint32 epoch = SafeCast.toUint32(block.timestamp / DAY);
            _validateLegacy(s, epoch);
            scaled += _legacyScaled(s, u, shares, epoch, s.acc);
            debt = s.acc;
        } else if (s.legacyMigrationStarted && !s.legacyUserMigrated[user]) {
            scaled += _legacyScaled(s, u, shares, s.legacyCutoverEpoch, s.legacyCutoverAcc);
            debt = s.legacyCutoverAcc;
        }
        return u.owed + (scaled + shares * (s.acc - debt)) / PRECISION;
    }

    /// @notice Compatibility stub only; the Vault does not link a burn route.
    function burnExpired(PoolRewardState.RewardStorage storage, uint32, address) external pure returns (uint256) {
        revert BurnDisabled();
    }

    function _settle(PoolRewardState.RewardStorage storage s, address user, uint256 shares) private {
        _ensurePermanent(s);
        PoolRewardState.RewardUser storage u = s.users[user];
        uint256 previousRemainder = u.globalRemainder;
        uint256 scaled = previousRemainder;
        if (s.legacyMigrationStarted && !s.legacyUserMigrated[user]) {
            uint256 legacy = _legacyScaled(s, u, shares, s.legacyCutoverEpoch, s.legacyCutoverAcc);
            scaled += legacy;
            u.debtAcc = s.legacyCutoverAcc;
            s.legacyUserMigrated[user] = true;
            emit RewardUserMigrated(user, legacy / PRECISION, legacy % PRECISION);
        }
        scaled += shares * (s.acc - u.debtAcc);
        u.owed += scaled / PRECISION;
        u.globalRemainder = scaled % PRECISION;
        s.totalGlobalRemainderScaled = s.totalGlobalRemainderScaled - previousRemainder + u.globalRemainder;
        u.debtAcc = s.acc;
    }

    function _ensurePermanent(PoolRewardState.RewardStorage storage s) private {
        if (s.expiryDisabled) return;
        uint32 epoch = SafeCast.toUint32(block.timestamp / DAY);
        _validateLegacy(s, epoch);
        // The cutover never moves again, including for users inactive for years.
        s.legacyMigrationStarted = true;
        s.legacyCutoverEpoch = epoch;
        s.legacyCutoverAcc = s.acc;
        s.expiryDisabled = true;
        emit RewardMigrationStarted(epoch, s.acc);
    }

    /// @dev Ring slots can be overwritten after eight days. We cannot recover those
    /// historical per-user payments from aggregate epochPaid, so never guess them.
    /// A bounded scan also refuses very old histories requiring a reviewed migration.
    function _validateLegacy(PoolRewardState.RewardStorage storage s, uint32 current) private view {
        uint256 length = s.accEndOf.length();
        if (length > MAX_LEGACY_CHECKPOINTS) revert LegacyRewardMigrationRequired();
        uint256 first = current > 7 ? current - 7 : 0;
        uint256 outstanding = 0;
        for (uint32 i = 0; i < length; ++i) {
            uint32 epoch = s.accEndOf.at(i)._key;
            if (s.epochPaid[epoch] > s.epochNet[epoch]) revert AccountingDeficit();
            if (s.epochBurnedFlag[epoch]) continue;
            uint256 unpaid = s.epochNet[epoch] - s.epochPaid[epoch];
            if (unpaid != 0 && (epoch < first || epoch > current)) revert LegacyRewardMigrationRequired();
            outstanding += unpaid;
        }
        // An unknown pre-epoch ledger must never be interpreted as zero debt.
        if (outstanding != s.bemAccounted) revert LegacyRewardMigrationRequired();
    }

    function _legacyScaled(
        PoolRewardState.RewardStorage storage s,
        PoolRewardState.RewardUser storage u,
        uint256 shares,
        uint32 cutoverEpoch,
        uint256 cutoverAcc
    ) private view returns (uint256 scaled) {
        if (u.debtAcc > cutoverAcc) revert AccountingDeficit();
        uint256 first = cutoverEpoch > 7 ? cutoverEpoch - 7 : 0;
        for (uint256 epoch = first; epoch <= cutoverEpoch; ++epoch) {
            if (s.epochBurnedFlag[epoch]) continue;
            // Deterministic ring identity; no randomness is used.
            // slither-disable-next-line weak-prng
            PoolRewardState.RewardSlot storage slot = u.slots[epoch % 8];
            // Exact stored batch identity is required before reusing a ring slot.
            // slither-disable-next-line incorrect-equality
            if (slot.epoch == epoch) scaled += slot.amount * PRECISION + slot.remainder;
            uint256 right = s.accEndOf.upperLookup(uint32(epoch));
            if (right > cutoverAcc) right = cutoverAcc;
            // Epoch zero has no predecessor; the integer-key guard prevents subtraction underflow.
            // slither-disable-next-line incorrect-equality
            uint256 left = epoch == 0 ? 0 : s.accEndOf.upperLookup(uint32(epoch - 1));
            if (left < u.debtAcc) left = u.debtAcc;
            if (right > left) scaled += shares * (right - left);
        }
    }
}
