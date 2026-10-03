// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase} from "../utils/FundingTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @notice Same-block subscriptions are ordered by the EVM; a losing call must
/// revert without reserving shares or BNB. Each external call below is atomic.
contract PoolFundingConcurrencyTest is FundingTestBase {
    function test_aliceWinsLastShareInSameBlock() public {
        _raceForLastShare(ALICE, BOB);
    }

    function test_bobWinsLastShareInSameBlock() public {
        _raceForLastShare(BOB, ALICE);
    }

    function test_wrongPaymentAndExcessSharesCannotReserveTheLastTwoShares() public {
        _deposit(pool, ALICE, 98);
        uint256 beforeBalance = address(pool).balance;
        uint256 sharedBlock = block.number;
        uint256 sharedTime = block.timestamp;

        vm.deal(BOB, 2 * UNIT_PRICE + 1);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.PaymentMismatch.selector);
        pool.deposit{value: 2 * UNIT_PRICE + 1}(2);
        vm.deal(CAROL, 3 * UNIT_PRICE);
        vm.prank(CAROL);
        vm.expectRevert(IPoolVault.ExceedsTarget.selector);
        pool.deposit{value: 3 * UNIT_PRICE}(3);
        vm.deal(CAROL, 3 * UNIT_PRICE);
        vm.prank(CAROL);
        vm.expectRevert(IPoolVault.PaymentMismatch.selector);
        pool.deposit{value: UNIT_PRICE - 1}(1);

        assertEq(pool.totalSupply(), 98);
        assertEq(pool.totalRaised(), 98 * UNIT_PRICE);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.contributedWei(BOB), 0);
        assertEq(pool.contributedWei(CAROL), 0);
        assertEq(address(pool).balance, beforeBalance);

        _deposit(pool, BOB, 2);
        _stateIs(IPoolVault.State.Funded);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.memberCount(), 2);
        assertEq(pool.contributedWei(BOB), 2 * UNIT_PRICE);
        assertEq(address(pool).balance, defaultParams.targetRaise);
        assertEq(block.number, sharedBlock);
        assertEq(block.timestamp, sharedTime);
    }

    function test_oneWalletHundredFirstLeavesNoCapacityForAnotherWallet() public {
        uint256 sharedBlock = block.number;
        _deposit(pool, ALICE, 100);
        vm.deal(BOB, UNIT_PRICE);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.deposit{value: UNIT_PRICE}(1);

        _stateIs(IPoolVault.State.Funded);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.totalRaised(), defaultParams.targetRaise);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.contributedWei(ALICE), defaultParams.targetRaise);
        assertEq(pool.contributedWei(BOB), 0);
        assertEq(address(pool).balance, defaultParams.targetRaise);
        assertEq(block.number, sharedBlock);
    }

    function test_otherWalletFirstMakesHundredShareOrderAllOrNothing() public {
        uint256 sharedBlock = block.number;
        _deposit(pool, BOB, 1);
        vm.deal(ALICE, defaultParams.targetRaise);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.ExceedsTarget.selector);
        pool.deposit{value: defaultParams.targetRaise}(100);

        assertEq(pool.totalSupply(), 1);
        assertEq(pool.totalRaised(), UNIT_PRICE);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.contributedWei(ALICE), 0);
        assertEq(address(pool).balance, UNIT_PRICE);
        _deposit(pool, ALICE, 99);
        _stateIs(IPoolVault.State.Funded);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.memberCount(), 2);
        assertEq(pool.contributedWei(ALICE), 99 * UNIT_PRICE);
        assertEq(pool.contributedWei(BOB), UNIT_PRICE);
        assertEq(address(pool).balance, defaultParams.targetRaise);
        assertEq(block.number, sharedBlock);
    }

    function test_lastDepositBeforeWithdrawalWinsAndPreventsBurningFundedShares() public {
        _deposit(pool, ALICE, 99);
        uint256 sharedBlock = block.number;
        _deposit(pool, BOB, 1);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.withdrawDeposit();

        assertEq(pool.balanceOf(ALICE), 99);
        assertEq(pool.balanceOf(BOB), 1);
        assertEq(pool.contributedWei(ALICE), 99 * UNIT_PRICE);
        assertEq(pool.bnbOwed(ALICE), 0);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.memberCount(), 2);
        assertEq(address(pool).balance, defaultParams.targetRaise);
        assertEq(block.number, sharedBlock);
    }

    function test_withdrawalBeforeCompetingDepositsKeepsRefundSeparate() public {
        _deposit(pool, ALICE, 99);
        uint256 sharedBlock = block.number;
        vm.prank(ALICE);
        pool.withdrawDeposit();
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.contributedWei(ALICE), 0);
        assertEq(pool.bnbOwed(ALICE), 99 * UNIT_PRICE);

        _deposit(pool, BOB, 1);
        _deposit(pool, CAROL, 99);
        _stateIs(IPoolVault.State.Funded);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.memberCount(), 2);
        assertEq(pool.contributedWei(BOB), UNIT_PRICE);
        assertEq(pool.contributedWei(CAROL), 99 * UNIT_PRICE);
        assertEq(pool.bnbOwed(ALICE), 99 * UNIT_PRICE);
        assertEq(pool.totalBnbOwed(), 99 * UNIT_PRICE);
        assertEq(address(pool).balance, 199 * UNIT_PRICE);

        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - before, 99 * UNIT_PRICE);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(address(pool).balance, defaultParams.targetRaise);
        assertEq(block.number, sharedBlock);
    }

    function test_lastSecondWinnerAndDeadlineLosersNeverChangeFunding() public {
        _deposit(pool, ALICE, 99);
        vm.warp(defaultParams.fundingDeadline - 1);
        uint256 sharedTime = block.timestamp;
        vm.deal(BOB, UNIT_PRICE);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.PaymentMismatch.selector);
        pool.deposit{value: UNIT_PRICE - 1}(1);
        _deposit(pool, CAROL, 1);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.deposit{value: UNIT_PRICE}(1);
        assertEq(pool.contributedWei(BOB), 0);
        assertEq(pool.contributedWei(CAROL), UNIT_PRICE);
        assertEq(pool.totalSupply(), 100);
        assertEq(block.timestamp, sharedTime);
    }

    function test_atFundingDeadlineNeitherWalletCanTakeLastShare() public {
        _deposit(pool, ALICE, 99);
        vm.warp(defaultParams.fundingDeadline);
        vm.deal(BOB, UNIT_PRICE);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        pool.deposit{value: UNIT_PRICE}(1);
        vm.deal(CAROL, UNIT_PRICE);
        vm.prank(CAROL);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        pool.deposit{value: UNIT_PRICE}(1);

        assertEq(pool.totalSupply(), 99);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.totalRaised(), 99 * UNIT_PRICE);
        assertEq(pool.contributedWei(BOB), 0);
        assertEq(pool.contributedWei(CAROL), 0);
        assertEq(address(pool).balance, 99 * UNIT_PRICE);
        pool.finalizeFailure();
        _stateIs(IPoolVault.State.Refunding);
        assertEq(pool.bnbOwed(ALICE), 99 * UNIT_PRICE);
        assertEq(pool.totalBnbOwed(), 99 * UNIT_PRICE);
    }

    function _raceForLastShare(address winner, address loser) private {
        _deposit(pool, CAROL, 99);
        uint256 sharedBlock = block.number;
        uint48 sharedTime = pool.clock();
        _deposit(pool, winner, 1);
        vm.deal(loser, UNIT_PRICE);
        vm.prank(loser);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.deposit{value: UNIT_PRICE}(1);

        _stateIs(IPoolVault.State.Funded);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.totalRaised(), defaultParams.targetRaise);
        assertEq(pool.memberCount(), 2);
        assertEq(pool.contributedWei(CAROL), 99 * UNIT_PRICE);
        assertEq(pool.contributedWei(winner), UNIT_PRICE);
        assertEq(pool.contributedWei(loser), 0);
        assertEq(pool.balanceOf(winner), 1);
        assertEq(pool.balanceOf(loser), 0);
        assertEq(address(pool).balance, defaultParams.targetRaise);
        assertEq(block.number, sharedBlock);
        vm.warp(block.timestamp + 1);
        assertEq(pool.getPastShares(winner, sharedTime), 1);
        assertEq(pool.getPastShares(loser, sharedTime), 0);
        assertEq(pool.getPastMemberCount(sharedTime), 2);
    }
}
