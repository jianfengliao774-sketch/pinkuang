// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PoolRewardState} from "../../src/PoolRewardState.sol";

/// @notice Frozen pre-no-burn accounting, used only to construct upgrade test states.
/// @notice Accounting executed in the PoolVault context through Solidity library calls.
/// @dev Vault owns the state/permission checks and nonReentrant entry points. This
/// library never calls back into Vault, calls Mining, or changes anyone's shares.
library LegacyRewardAccounting {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace224;

    uint256 private constant PRECISION = 1e36;
    uint256 private constant TOTAL_SHARES = 100;
    uint256 private constant DAY = 1 days;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    error ClaimTooSoon();
    error NothingToClaim();
    error EpochNotExpired();
    error EpochAlreadyBurned();
    error ExpiryDisabled();
    error AccountingDeficit();

    event Harvested(uint256 gross, uint256 toPlatform, uint256 burned, uint256 toMembers);
    event BemClaimed(address indexed user, uint256 amount);
    event EpochExpiredBurned(uint32 indexed epoch, uint256 amount);
    event RewardEpochRecorded(uint32 indexed epoch, uint256 previousAcc, uint256 cumulativeAcc, uint256 net);

    /// @notice Splits only actual BEM not already reserved for members or dust.
    function account(PoolRewardState.RewardStorage storage s, address bem, address treasury)
        external
        returns (uint256 gross, uint256 fee, uint256 burned, uint256 net)
    {
        IERC20 token = IERC20(bem);
        uint256 balance = token.balanceOf(address(this));
        if (balance < s.bemAccounted) revert AccountingDeficit();
        gross = balance - s.bemAccounted;
        // Exact zero means no unaccounted token income; donations simply make gross positive.
        // This does not require an externally manipulable balance to equal a fixed target.
        // slither-disable-next-line incorrect-equality
        if (gross == 0) return (0, 0, 0, 0);
        fee = Math.mulDiv(gross, 100, 10_000);
        burned = Math.mulDiv(gross, 400, 10_000);
        net = gross - fee - burned;

        // 100 divides PRECISION exactly, so this global increment has no dust.
        // Checked conversion protects the checkpoint value in both expiry modes.
        s.acc = SafeCast.toUint224(s.acc + Math.mulDiv(net, PRECISION, TOTAL_SHARES));
        if (!s.expiryDisabled) {
            uint32 epoch = SafeCast.toUint32(block.timestamp / DAY);
            (uint224 previousAcc, uint224 cumulativeAcc) = s.accEndOf.push(epoch, uint224(s.acc));
            s.epochNet[epoch] += net;
            emit RewardEpochRecorded(epoch, previousAcc, cumulativeAcc, net);
        }
        s.bemAccounted += net;
        s.totalGross += gross;
        s.totalPlatform += fee;
        s.totalBaseBurned += burned;
        s.totalMemberNet += net;

        if (fee != 0) token.safeTransfer(treasury, fee);
        if (burned != 0) token.safeTransfer(DEAD, burned);
        // Every caller holds Vault's nonReentrant lock; liabilities were updated
        // before payment. This reads a fresh balance to check remaining solvency,
        // and never authorizes a payment using a stale pre-call balance.
        // slither-disable-next-line reentrancy-balance
        if (token.balanceOf(address(this)) < s.bemAccounted) revert AccountingDeficit();
        emit Harvested(gross, fee, burned, net);
    }

    /// @notice Call before changing shares, using the user's old share balance.
    function settle(PoolRewardState.RewardStorage storage s, address user, uint256 shares) external {
        _settle(s, user, shares);
    }

    function claim(PoolRewardState.RewardStorage storage s, address user, uint256 shares, address bem)
        external
        returns (uint256 amount)
    {
        _settle(s, user, shares);
        PoolRewardState.RewardUser storage u = s.users[user];
        if (u.lastClaimAt != 0 && block.timestamp < uint256(u.lastClaimAt) + DAY) revert ClaimTooSoon();

        if (s.expiryDisabled) {
            amount = u.owed;
            u.owed = 0;
        } else {
            uint256 current = block.timestamp / DAY;
            uint256 first = _firstLiveEpoch(current);
            for (uint256 epoch = first; epoch <= current; ++epoch) {
                // Deterministic daily ring index, not a random draw.
                // slither-disable-next-line weak-prng
                PoolRewardState.RewardSlot storage slot = u.slots[epoch % 8];
                if (slot.epoch != epoch || s.epochBurnedFlag[epoch]) continue;
                uint256 paid = slot.amount;
                if (paid == 0) continue;
                if (paid > s.epochNet[epoch] - s.epochPaid[epoch]) revert AccountingDeficit();
                s.epochPaid[epoch] += paid;
                amount += paid;
                // Keep the fraction in this same batch; payment cannot reset it.
                slot.amount = 0;
            }
        }
        if (amount == 0) revert NothingToClaim();
        if (amount > s.bemAccounted) revert AccountingDeficit();
        u.lastClaimAt = SafeCast.toUint64(block.timestamp);
        s.bemAccounted -= amount;
        s.totalMemberPaid += amount;
        IERC20(bem).safeTransfer(user, amount);
        emit BemClaimed(user, amount);
    }

    /// @notice View of already-accounted rewards; it does not estimate Mining.pending.
    function claimable(PoolRewardState.RewardStorage storage s, address user, uint256 shares)
        external
        view
        returns (uint256 amount)
    {
        PoolRewardState.RewardUser storage u = s.users[user];
        if (s.expiryDisabled) {
            return u.owed + (u.globalRemainder + shares * (s.acc - u.debtAcc)) / PRECISION;
        }
        uint256 current = block.timestamp / DAY;
        uint256 first = _firstLiveEpoch(current);
        for (uint256 epoch = first; epoch <= current; ++epoch) {
            if (s.epochBurnedFlag[epoch]) continue;
            // Deterministic daily ring index, not a random draw.
            // slither-disable-next-line weak-prng
            PoolRewardState.RewardSlot storage slot = u.slots[epoch % 8];
            uint256 remainder = 0;
            // Exact identity of a stored integer batch key, not timestamp guessing.
            // slither-disable-next-line incorrect-equality
            if (slot.epoch == epoch) {
                amount += slot.amount;
                remainder = slot.remainder;
            }
            amount += (remainder + shares * _epochDelta(s, epoch, u.debtAcc)) / PRECISION;
        }
    }

    /// @notice Burns all remaining members' BEM in an expired day, including dust.
    function burnExpired(PoolRewardState.RewardStorage storage s, uint32 epoch, address bem)
        external
        returns (uint256 amount)
    {
        if (s.expiryDisabled) revert ExpiryDisabled();
        uint256 current = block.timestamp / DAY;
        // Subtract only after checking the order, including for arbitrary large input.
        if (epoch >= current || current - epoch <= 7) revert EpochNotExpired();
        if (s.epochBurnedFlag[epoch]) revert EpochAlreadyBurned();
        amount = s.epochNet[epoch] - s.epochPaid[epoch];
        if (amount > s.bemAccounted) revert AccountingDeficit();
        s.epochBurnedFlag[epoch] = true;
        s.epochBurned[epoch] = amount;
        s.bemAccounted -= amount;
        s.totalExpiredBurned += amount;
        if (amount != 0) IERC20(bem).safeTransfer(DEAD, amount);
        emit EpochExpiredBurned(epoch, amount);
    }

    function _settle(PoolRewardState.RewardStorage storage s, address user, uint256 shares) private {
        PoolRewardState.RewardUser storage u = s.users[user];
        if (u.debtAcc == s.acc) return;
        if (s.expiryDisabled) {
            uint256 previousRemainder = u.globalRemainder;
            uint256 scaled = previousRemainder + shares * (s.acc - u.debtAcc);
            u.owed += scaled / PRECISION;
            // Deterministic fixed-point fraction; no randomness is derived here.
            // slither-disable-next-line weak-prng
            u.globalRemainder = scaled % PRECISION;
            s.totalGlobalRemainderScaled = s.totalGlobalRemainderScaled - previousRemainder + u.globalRemainder;
        } else {
            uint256 current = block.timestamp / DAY;
            uint256 first = _firstLiveEpoch(current);
            for (uint256 epoch = first; epoch <= current; ++epoch) {
                uint256 delta = _epochDelta(s, epoch, u.debtAcc);
                // Skip exactly zero earned increments or zero integer shares.
                // These are accounting values, not a target balance or time lottery.
                // slither-disable-next-line incorrect-equality
                if (delta == 0 || shares == 0 || s.epochBurnedFlag[epoch]) continue;
                // Deterministic daily ring index, not a random draw.
                // slither-disable-next-line weak-prng
                PoolRewardState.RewardSlot storage slot = u.slots[epoch % 8];
                if (slot.epoch != epoch) {
                    // An eight-day-separated slot is expired. Its entire unpaid
                    // liability stays in epochNet - epochPaid until burnExpired;
                    // neither clearing this cache nor advancing debt erases it.
                    slot.epoch = SafeCast.toUint32(epoch);
                    slot.amount = 0;
                    slot.remainder = 0;
                }
                uint256 previousRemainder = slot.remainder;
                uint256 scaled = previousRemainder + shares * delta;
                slot.amount += scaled / PRECISION;
                // Deterministic fixed-point fraction; no randomness is derived here.
                // slither-disable-next-line weak-prng
                slot.remainder = scaled % PRECISION;
                // Net change, not a cumulative sum of every observed remainder.
                // Overwriting an expired slot above leaves that OLD epoch's
                // identified-fraction history untouched, including after burn.
                s.epochRemainderScaled[epoch] = s.epochRemainderScaled[epoch] - previousRemainder + slot.remainder;
            }
        }
        // Expired entitlement is intentionally omitted from the user's live
        // cache, but remains fully reserved in the global per-epoch ledger.
        u.debtAcc = s.acc;
    }

    function _firstLiveEpoch(uint256 current) private pure returns (uint256) {
        return current > 7 ? current - 7 : 0;
    }

    function _epochDelta(PoolRewardState.RewardStorage storage s, uint256 epoch, uint256 debtAcc)
        private
        view
        returns (uint256)
    {
        // Missing dates inherit the last recorded accumulator; they add no income.
        uint256 right = s.accEndOf.upperLookup(SafeCast.toUint32(epoch));
        if (right > s.acc) right = s.acc;
        // Epoch zero has no predecessor; the exact integer-key check prevents underflow.
        // slither-disable-next-line incorrect-equality
        uint256 left = epoch == 0 ? 0 : s.accEndOf.upperLookup(SafeCast.toUint32(epoch - 1));
        if (left < debtAcc) left = debtAcc;
        return right > left ? right - left : 0;
    }
}
