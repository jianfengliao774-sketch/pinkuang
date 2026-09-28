// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";

/// @notice Competing wallet transactions are sequential on chain, even when
/// mined in the same block. The later transaction must see the first one's
/// updated order, locks, price, and beneficial ownership.
contract ShareMarketConcurrencyTest is ShareTransferTestBase {
    uint256 private constant PRICE = 0.1 ether;

    function _list(address seller, uint256 amount, uint256 price) private returns (uint256 id) {
        vm.prank(seller);
        id = shareMarket.list(address(pool), amount, price);
    }

    function _buy(address buyer, uint256 id, uint256 amount, uint256 price) private {
        uint256 gross = amount * price;
        uint256 payment = gross + gross / 100;
        vm.deal(buyer, buyer.balance + payment);
        vm.prank(buyer);
        shareMarket.fill{value: payment}(id, amount);
    }

    function _consolidateWithAlice() private {
        _transfer(BOB, ALICE, 49);
        _transfer(CAROL, ALICE, 2);
        assertEq(pool.balanceOf(ALICE), 100);
        assertEq(pool.memberCount(), 1);
    }

    function testFuzz_competingBuyersSeeUpdatedRemainingAndLosingPaymentIsNotCharged(bool daveFirst) public {
        _consolidateWithAlice();
        uint256 id = _list(ALICE, 100, PRICE);
        uint256 timestamp = block.timestamp;
        address first = daveFirst ? DAVE : ERIN;
        address second = daveFirst ? ERIN : DAVE;

        _buy(first, id, 60, PRICE);
        assertEq(block.timestamp, timestamp);
        assertEq(shareMarket.orders(id).remaining, 40);
        assertEq(_shareVault().lockedShares(ALICE), 40);
        assertEq(shareMarket.totalBnbOwed(), 6.06 ether);
        vm.deal(second, 6 ether);
        uint256 secondBalance = second.balance;
        vm.prank(second);
        vm.expectRevert(IShareMarket.InvalidAmount.selector);
        shareMarket.fill{value: 6 ether}(id, 60);
        assertEq(second.balance, secondBalance);
        assertEq(pool.balanceOf(second), 0);
        assertEq(shareMarket.orders(id).remaining, 40);
        assertEq(_shareVault().lockedShares(ALICE), 40);
        assertEq(shareMarket.totalBnbOwed(), 6.06 ether);
        assertEq(address(shareMarket).balance, 6.06 ether);

        _buy(second, id, 40, PRICE);
        assertEq(block.timestamp, timestamp);
        assertEq(pool.balanceOf(first), 60);
        assertEq(pool.balanceOf(second), 40);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.memberCount(), 2);
        assertEq(pool.totalSupply(), 100);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertFalse(shareMarket.orders(id).active);
        assertEq(shareMarket.bnbOwed(ALICE), 9.9 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.2 ether);
        assertEq(shareMarket.totalBnbOwed(), 10.1 ether);
        assertEq(address(shareMarket).balance, 10.1 ether);
    }

    function testFuzz_independentOrdersSettleRegardlessOfBuyerTransactionOrder(bool firstOrderFirst) public {
        _consolidateWithAlice();
        uint256 firstOrder = _list(ALICE, 60, PRICE);
        uint256 secondOrder = _list(ALICE, 40, 2 * PRICE);
        assertEq(_shareVault().lockedShares(ALICE), 100);
        uint256 timestamp = block.timestamp;

        if (firstOrderFirst) {
            _buy(DAVE, firstOrder, 60, PRICE);
            _buy(ERIN, secondOrder, 40, 2 * PRICE);
        } else {
            _buy(ERIN, secondOrder, 40, 2 * PRICE);
            _buy(DAVE, firstOrder, 60, PRICE);
        }
        assertEq(block.timestamp, timestamp);
        assertEq(pool.balanceOf(DAVE), 60);
        assertEq(pool.balanceOf(ERIN), 40);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.totalSupply(), 100);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(shareMarket.orders(firstOrder).remaining, 0);
        assertEq(shareMarket.orders(secondOrder).remaining, 0);
        assertEq(shareMarket.bnbOwed(ALICE), 13.86 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.28 ether);
        assertEq(shareMarket.totalBnbOwed(), 14.14 ether);
        assertEq(address(shareMarket).balance, 14.14 ether);
    }

    function testFuzz_sellerCancellationAndBuyerFillFollowTheFirstMinedTransaction(bool fillFirst) public {
        uint256 id = _list(ALICE, 10, PRICE);
        uint256 timestamp = block.timestamp;
        if (fillFirst) {
            _buy(DAVE, id, 4, PRICE);
            vm.prank(ALICE);
            shareMarket.cancel(id);
            assertEq(pool.balanceOf(DAVE), 4);
            assertEq(pool.balanceOf(ALICE), 45);
            assertEq(shareMarket.bnbOwed(ALICE), 0.396 ether);
            assertEq(shareMarket.bnbOwed(TREASURY), 0.008 ether);
            assertEq(shareMarket.totalBnbOwed(), 0.404 ether);
        } else {
            vm.prank(ALICE);
            shareMarket.cancel(id);
            vm.deal(DAVE, 4 * PRICE);
            uint256 beforeBalance = DAVE.balance;
            vm.prank(DAVE);
            vm.expectRevert(IShareMarket.InactiveOrder.selector);
            shareMarket.fill{value: 4 * PRICE}(id, 4);
            assertEq(DAVE.balance, beforeBalance);
            assertEq(pool.balanceOf(DAVE), 0);
            assertEq(pool.balanceOf(ALICE), 49);
            assertEq(shareMarket.totalBnbOwed(), 0);
        }
        assertEq(block.timestamp, timestamp);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(shareMarket.orders(id).remaining, 0);
        assertFalse(shareMarket.orders(id).active);
        assertEq(address(shareMarket).balance, shareMarket.totalBnbOwed());
    }

    function testFuzz_expiryBoundaryAndBuyerFillFollowTheFirstValidTransaction(bool fillBeforeExpiry) public {
        uint256 id = _list(ALICE, 10, PRICE);
        uint64 expiry = shareMarket.orderExpiresAt(id);
        if (fillBeforeExpiry) {
            vm.warp(uint256(expiry) - 1);
            _buy(DAVE, id, 4, PRICE);
            vm.warp(expiry);
            vm.prank(ERIN);
            shareMarket.expire(id);
            assertEq(pool.balanceOf(DAVE), 4);
            assertEq(pool.balanceOf(ALICE), 45);
            assertEq(shareMarket.totalBnbOwed(), 0.404 ether);
        } else {
            vm.warp(expiry);
            vm.deal(DAVE, 4 * PRICE);
            uint256 beforeBalance = DAVE.balance;
            vm.prank(DAVE);
            vm.expectRevert(IShareMarket.OrderExpired.selector);
            shareMarket.fill{value: 4 * PRICE}(id, 4);
            assertEq(DAVE.balance, beforeBalance);
            vm.prank(ERIN);
            shareMarket.expire(id);
            assertEq(pool.balanceOf(DAVE), 0);
            assertEq(pool.balanceOf(ALICE), 49);
            assertEq(shareMarket.totalBnbOwed(), 0);
        }
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(shareMarket.orders(id).remaining, 0);
        assertFalse(shareMarket.orders(id).active);
        assertEq(address(shareMarket).balance, shareMarket.totalBnbOwed());
    }

    function test_cancelAndRelistAtNewPriceRejectsBothStaleOrderIdAndStalePayment() public {
        uint256 oldId = _list(ALICE, 10, PRICE);
        vm.prank(ALICE);
        shareMarket.cancel(oldId);
        uint256 newId = _list(ALICE, 10, 2 * PRICE);
        assertEq(newId, oldId + 1);
        vm.deal(DAVE, 2 ether);
        uint256 beforeBalance = DAVE.balance;
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.InactiveOrder.selector);
        shareMarket.fill{value: 1 ether}(oldId, 10);
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.PaymentMismatch.selector);
        shareMarket.fill{value: 1 ether}(newId, 10);
        assertEq(DAVE.balance, beforeBalance);
        assertEq(shareMarket.orders(newId).remaining, 10);
        assertEq(_shareVault().lockedShares(ALICE), 10);
        assertEq(shareMarket.totalBnbOwed(), 0);
        _buy(DAVE, newId, 10, 2 * PRICE);
        assertEq(pool.balanceOf(DAVE), 10);
        assertEq(shareMarket.bnbOwed(ALICE), 1.98 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.04 ether);
        assertEq(shareMarket.totalBnbOwed(), 2.02 ether);
        assertEq(address(shareMarket).balance, 2.02 ether);
    }

    function test_sameBlockCompetingBuysAllocateQueuedRewardsToPreFillOwners() public {
        _consolidateWithAlice();
        uint256 id = _list(ALICE, 60, PRICE);
        uint256 timestamp = block.timestamp;

        _queueReward(10000); // The first fill's strict harvest belongs to Alice's 100 shares.
        _buy(DAVE, id, 30, PRICE);
        assertEq(rewards.claimable(ALICE), 9900);
        assertEq(rewards.claimable(DAVE), 0);

        _queueReward(10000); // The second fill sees Alice 70 / Dave 30, not Erin's new shares.
        _buy(ERIN, id, 30, PRICE);
        assertEq(rewards.claimable(ALICE), 16830);
        assertEq(rewards.claimable(DAVE), 2970);
        assertEq(rewards.claimable(ERIN), 0);

        _harvestReward(10000); // New income sees Alice 40 / Dave 30 / Erin 30.
        assertEq(block.timestamp, timestamp);
        assertEq(pool.balanceOf(ALICE), 40);
        assertEq(pool.balanceOf(DAVE), 30);
        assertEq(pool.balanceOf(ERIN), 30);
        assertEq(_claim(ALICE), 20790);
        assertEq(_claim(DAVE), 5940);
        assertEq(_claim(ERIN), 2970);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(bem.balanceOf(TREASURY), 300);
        assertEq(shareMarket.bnbOwed(ALICE), 5.94 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.12 ether);
        assertEq(shareMarket.totalBnbOwed(), 6.06 ether);
        assertEq(address(shareMarket).balance, 6.06 ether);
    }

    function testFuzz_competingForFinalTwoSharesCannotBothReachOneHundred(bool daveFirst) public {
        uint256 aliceOrder = _list(ALICE, 49, PRICE);
        uint256 bobOrder = _list(BOB, 49, PRICE);
        uint256 lastOrder = _list(CAROL, 2, PRICE);
        _buy(DAVE, aliceOrder, 49, PRICE);
        _buy(DAVE, bobOrder, 49, PRICE);
        assertEq(pool.balanceOf(DAVE), 98);
        uint256 timestamp = block.timestamp;
        address winner = daveFirst ? DAVE : ERIN;
        address loser = daveFirst ? ERIN : DAVE;
        _buy(winner, lastOrder, 2, PRICE);
        vm.deal(loser, 2 * PRICE);
        uint256 loserBalance = loser.balance;
        vm.prank(loser);
        vm.expectRevert(IShareMarket.InactiveOrder.selector);
        shareMarket.fill{value: 2 * PRICE}(lastOrder, 2);
        assertEq(loser.balance, loserBalance);
        assertEq(block.timestamp, timestamp);
        assertEq(pool.balanceOf(DAVE), daveFirst ? 100 : 98);
        assertEq(pool.balanceOf(ERIN), daveFirst ? 0 : 2);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.balanceOf(address(shareMarket)), 0);
        assertEq(shareMarket.totalBnbOwed(), 10.1 ether);
        assertEq(address(shareMarket).balance, 10.1 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.2 ether);
        assertEq(shareMarket.orders(lastOrder).remaining, 0);
        assertEq(_shareVault().lockedShares(CAROL), 0);
    }
}
