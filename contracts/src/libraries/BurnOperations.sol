// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolSaleState} from "../PoolSaleState.sol";
import {IPancakeBurnRouter, IWbnb} from "../interfaces/IPancakeBurnRouter.sol";

/// @notice Fixed BNB-to-BEM budget route, linked into the guarded Closed Vault.
/// @dev It neither distributes rewards nor touches existing BEM, WBNB or member BNB reserves.
library BurnOperations {
    using SafeERC20 for IERC20;

    address private constant ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address private constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address private constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    error NothingToBurn();
    error BurnAccountingMismatch();
    error BurnOutputMismatch();

    event BurnExecuted(uint256 bnbSpent, uint256 bemBurned);

    struct BeforeBalances {
        uint256 bnb;
        uint256 wbnb;
        uint256 bem;
    }

    function execute(PoolSaleState.SaleStorage storage s, uint256 minOut, uint256 maxIn)
        external
        returns (uint256 spent, uint256 burned)
    {
        uint256 amount = maxIn < s.burnBudget ? maxIn : s.burnBudget;
        if (amount == 0) revert NothingToBurn();
        BeforeBalances memory beforeBalances = BeforeBalances(
            address(this).balance, IERC20(WBNB).balanceOf(address(this)), IERC20(BEM).balanceOf(address(this))
        );
        if (beforeBalances.bnb < s.burnBudget || s.expectedWbnbRefund != 0) revert BurnAccountingMismatch();

        // The Vault holds nonReentrant across the whole delegatecall and every token/router callback.
        s.burnBudget -= amount;
        IWbnb(WBNB).deposit{value: amount}();
        // Guarded balance delta proves only this call's native input was wrapped.
        // slither-disable-next-line reentrancy-balance
        if (IERC20(WBNB).balanceOf(address(this)) != beforeBalances.wbnb + amount) revert BurnAccountingMismatch();
        IERC20(WBNB).forceApprove(ROUTER, amount);
        uint256 reported = IPancakeBurnRouter(ROUTER)
            .exactInputSingle(
                IPancakeBurnRouter.ExactInputSingleParams(WBNB, BEM, 10_000, address(this), amount, minOut, 0)
            );
        IERC20(WBNB).forceApprove(ROUTER, 0);
        uint256 wbnbAfter = IERC20(WBNB).balanceOf(address(this));
        // Historical WBNB is a protected reserve; Vault's lock excludes nested budget spending.
        // slither-disable-next-line reentrancy-balance
        if (
            wbnbAfter < beforeBalances.wbnb || wbnbAfter - beforeBalances.wbnb > amount
                || IERC20(WBNB).allowance(address(this), ROUTER) != 0
        ) revert BurnAccountingMismatch();
        uint256 refund = wbnbAfter - beforeBalances.wbnb;
        spent = amount - refund;
        if (refund != 0) {
            // WBNB pays with a 2300-gas transfer. The prewritten warm slot lets the
            // BeaconProxy's receive function validate the exact refund without SSTORE.
            uint256 bnbBeforeRefund = address(this).balance;
            s.expectedWbnbRefund = refund;
            IWbnb(WBNB).withdraw(refund);
            s.expectedWbnbRefund = 0;
            // The fixed WBNB callback is read-only and amount-gated; verify actual native receipt.
            // slither-disable-next-line reentrancy-balance
            if (address(this).balance != bnbBeforeRefund + refund) revert BurnAccountingMismatch();
            s.burnBudget += refund;
        }
        // Final conservation under the outer lock preserves all balances outside this budget.
        // slither-disable-next-line reentrancy-balance
        if (
            IERC20(WBNB).balanceOf(address(this)) != beforeBalances.wbnb
                || address(this).balance < beforeBalances.bnb - spent
        ) revert BurnAccountingMismatch();

        uint256 bemAfter = IERC20(BEM).balanceOf(address(this));
        // Before-swap BEM belongs to old rewards/donations, never this burn's swap proceeds.
        // slither-disable-next-line reentrancy-balance
        if (bemAfter < beforeBalances.bem) revert BurnOutputMismatch();
        burned = bemAfter - beforeBalances.bem;
        // Zero is an intentional no-output guard; exact delta/report matching is accounting,
        // not an assumption about an unsolicited balance. All callback entry points stay locked.
        // slither-disable-next-line reentrancy-balance,incorrect-equality
        if (burned == 0 || burned != reported || burned < minOut) revert BurnOutputMismatch();
        s.totalBurnBnbSpent += spent;
        s.totalBurnBem += burned;
        IERC20(BEM).safeTransfer(DEAD, burned);
        // Verify the fixed token transferred only newly bought BEM, preserving the locked baseline.
        // slither-disable-next-line reentrancy-balance
        if (IERC20(BEM).balanceOf(address(this)) != beforeBalances.bem) revert BurnAccountingMismatch();
        emit BurnExecuted(spent, burned);
    }
}
