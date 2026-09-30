// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase} from "../utils/FundingTestBase.sol";
import {AtomicRefundRecipient} from "../utils/AtomicRefundRecipient.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract AtomicPoolRefundTest is FundingTestBase {
    event DepositWithdrawn(address indexed user, uint8 shares, uint256 amount);
    event BnbWithdrawn(address indexed user, uint256 amount);

    function test_atomicCancellationPaysWalletAndPreservesOtherSubscriptions() public {
        _deposit(pool, ALICE, 3);
        _deposit(pool, BOB, 4);
        uint256 before = ALICE.balance;
        vm.expectEmit(true, false, false, true, address(pool));
        emit DepositWithdrawn(ALICE, 3, 3 * UNIT_PRICE);
        vm.expectEmit(true, false, false, true, address(pool));
        emit BnbWithdrawn(ALICE, 3 * UNIT_PRICE);
        vm.prank(ALICE);
        pool.withdrawDepositAndWithdrawBnb();
        assertEq(ALICE.balance - before, 3 * UNIT_PRICE);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.contributedWei(ALICE), 0);
        assertEq(pool.bnbOwed(ALICE), 0);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(pool.totalRaised(), 4 * UNIT_PRICE);
        assertEq(pool.totalSupply(), 4);
        assertEq(pool.memberCount(), 1);
        assertEq(address(pool).balance, 4 * UNIT_PRICE);
        assertEq(pool.balanceOf(BOB), 4);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        pool.withdrawDepositAndWithdrawBnb();
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        pool.withdrawBnb();
    }

    function test_atomicCancellationPaysOwnEarlierCreditWithoutTakingAnotherWalletCredit() public {
        _deposit(pool, ALICE, 2);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        _deposit(pool, BOB, 5);
        vm.prank(BOB);
        pool.withdrawDeposit();
        _deposit(pool, ALICE, 3);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawDepositAndWithdrawBnb();
        assertEq(ALICE.balance - before, 5 * UNIT_PRICE);
        assertEq(pool.bnbOwed(ALICE), 0);
        assertEq(pool.bnbOwed(BOB), 5 * UNIT_PRICE);
        assertEq(pool.totalBnbOwed(), 5 * UNIT_PRICE);
        assertEq(address(pool).balance, 5 * UNIT_PRICE);
        vm.prank(BOB);
        pool.withdrawBnb();
        assertEq(address(pool).balance, 0);
    }

    function test_rejectedAtomicPaymentRollsBackBurnAndPreservesEarlierCredit() public {
        AtomicRefundRecipient recipient = new AtomicRefundRecipient(address(pool));
        _deposit(pool, address(recipient), 2);
        recipient.execute(abi.encodeCall(IPoolVault.withdrawDeposit, ()));
        _deposit(pool, address(recipient), 3);
        _deposit(pool, BOB, 4);
        recipient.configure(true, "");
        uint256 poolBefore = address(pool).balance;
        vm.expectRevert(IPoolVault.TransferFailed.selector);
        recipient.execute(abi.encodeCall(IPoolVault.withdrawDepositAndWithdrawBnb, ()));
        assertEq(pool.balanceOf(address(recipient)), 3);
        assertEq(pool.contributedWei(address(recipient)), 3 * UNIT_PRICE);
        assertEq(pool.totalRaised(), 7 * UNIT_PRICE);
        assertEq(pool.totalSupply(), 7);
        assertEq(pool.memberCount(), 2);
        assertEq(pool.bnbOwed(address(recipient)), 2 * UNIT_PRICE);
        assertEq(pool.totalBnbOwed(), 2 * UNIT_PRICE);
        assertEq(address(pool).balance, poolBefore);
        // Contracts that reject BNB retain the original pull-payment cancellation path.
        recipient.execute(abi.encodeCall(IPoolVault.withdrawDeposit, ()));
        assertEq(pool.bnbOwed(address(recipient)), 5 * UNIT_PRICE);
        recipient.configure(false, "");
        recipient.execute(abi.encodeCall(IPoolVault.withdrawBnb, ()));
        assertEq(address(recipient).balance, 5 * UNIT_PRICE);
        assertEq(address(pool).balance, 4 * UNIT_PRICE);
    }

    function test_atomicRefundCallbackCannotRepeatWithdrawalOrCancellation() public {
        bytes[3] memory attempts = [
            abi.encodeCall(IPoolVault.withdrawBnb, ()),
            abi.encodeCall(IPoolVault.withdrawDeposit, ()),
            abi.encodeCall(IPoolVault.withdrawDepositAndWithdrawBnb, ())
        ];
        for (uint256 i; i < attempts.length; ++i) {
            AtomicRefundRecipient recipient = new AtomicRefundRecipient(address(pool));
            _deposit(pool, address(recipient), 3);
            recipient.configure(false, attempts[i]);
            recipient.execute(abi.encodeCall(IPoolVault.withdrawDepositAndWithdrawBnb, ()));
            assertTrue(recipient.callbackSeen());
            assertFalse(recipient.reentrySucceeded());
            assertEq(address(recipient).balance, 3 * UNIT_PRICE);
            assertEq(pool.bnbOwed(address(recipient)), 0);
            assertEq(pool.balanceOf(address(recipient)), 0);
        }
        assertEq(address(pool).balance, 0);
        assertEq(pool.totalBnbOwed(), 0);
    }

    function test_atomicCancellationStillRequiresFundingAndMembership() public {
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        pool.withdrawDepositAndWithdrawBnb();
        _deposit(pool, ALICE, 1);
        _deposit(pool, BOB, 99);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.withdrawDepositAndWithdrawBnb();
        assertEq(pool.balanceOf(ALICE), 1);
        assertEq(pool.totalRaised(), defaultParams.targetRaise);
        vm.warp(defaultParams.purchaseDeadline);
        pool.finalizeFailure();
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.withdrawDepositAndWithdrawBnb();
        // A finalized single-pool failure already refunds in one existing withdrawal.
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - before, UNIT_PRICE);
    }

    function test_atomicCancellationWorksWhenDepositsPausedAndAfterDeadlineBeforeFinalization() public {
        _deposit(pool, ALICE, 3);
        vm.prank(OPERATOR);
        pool.setDepositPaused(true);
        vm.warp(defaultParams.fundingDeadline);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawDepositAndWithdrawBnb();
        assertEq(ALICE.balance - before, 3 * UNIT_PRICE);
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.totalBnbOwed(), 0);
    }

    function testFuzz_atomicCancellationConservesBalanceForEveryPartialSubscription(uint8 seed) public {
        uint8 shares = uint8(bound(seed, 1, 99));
        _deposit(pool, ALICE, shares);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawDepositAndWithdrawBnb();
        assertEq(ALICE.balance - before, uint256(shares) * UNIT_PRICE);
        assertEq(address(pool).balance, 0);
        assertEq(pool.totalRaised(), 0);
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.totalBnbOwed(), 0);
    }
}
