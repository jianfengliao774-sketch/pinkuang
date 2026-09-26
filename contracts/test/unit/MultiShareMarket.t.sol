// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolSaleState} from "../../src/PoolSaleState.sol";

/// @notice One wallet may accumulate all 100 shares through many fills without
/// receiving extra rewards, voting weight, or capacity from its own listed shares.
contract MultiShareMarketTest is ShareTransferTestBase {
    uint256 private constant PRICE = 0.1 ether;

    function _list(address seller, uint256 amount) private returns (uint256 id) {
        vm.prank(seller);
        id = shareMarket.list(address(pool), amount, PRICE);
    }

    function _buy(address buyer, uint256 id, uint256 amount) private {
        uint256 payment = amount * PRICE;
        vm.deal(buyer, buyer.balance + payment);
        vm.prank(buyer);
        shareMarket.fill{value: payment}(id, amount);
    }

    function test_sameWalletMayBuyRepeatedlyFromSeveralPartialOrdersUpToOneHundred() public {
        uint256 aliceOrder = _list(ALICE, 49);
        uint256 bobOrder = _list(BOB, 49);
        uint256 carolOrder = _list(CAROL, 2);

        _buy(DAVE, aliceOrder, 7);
        _buy(DAVE, aliceOrder, 13);
        _buy(DAVE, aliceOrder, 29);
        _buy(DAVE, bobOrder, 29);
        _buy(DAVE, bobOrder, 20);
        _buy(DAVE, carolOrder, 2);
        assertEq(pool.balanceOf(DAVE), 100);
        assertEq(pool.bnbOwed(DAVE), 0, "later buyers do not inherit purchase-time refunds");
        assertEq(pool.memberCount(), 1);
        assertEq(pool.totalSupply(), 100);
        assertEq(shareMarket.orders(aliceOrder).remaining, 0);
        assertEq(shareMarket.orders(bobOrder).remaining, 0);
        assertEq(shareMarket.orders(carolOrder).remaining, 0);
        assertFalse(shareMarket.orders(aliceOrder).active);
        assertFalse(shareMarket.orders(bobOrder).active);
        assertFalse(shareMarket.orders(carolOrder).active);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(_shareVault().lockedShares(BOB), 0);
        assertEq(_shareVault().lockedShares(CAROL), 0);
        assertEq(shareMarket.bnbOwed(ALICE), 4.851 ether);
        assertEq(shareMarket.bnbOwed(BOB), 4.851 ether);
        assertEq(shareMarket.bnbOwed(CAROL), 0.198 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.1 ether);
        assertEq(shareMarket.totalBnbOwed(), 10 ether);
        assertEq(address(shareMarket).balance, 10 ether);
    }

    function test_oneOrderCanListAndFillAllOneHundredShares() public {
        _transfer(BOB, ALICE, 49);
        _transfer(CAROL, ALICE, 2);
        assertEq(pool.balanceOf(ALICE), 100);
        assertEq(pool.memberCount(), 1);

        uint256 id = _list(ALICE, 100);
        assertEq(_shareVault().lockedShares(ALICE), 100);
        vm.deal(DAVE, 101 * PRICE);
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.InvalidAmount.selector);
        shareMarket.fill{value: 101 * PRICE}(id, 101);
        assertEq(shareMarket.orders(id).remaining, 100);
        assertEq(_shareVault().lockedShares(ALICE), 100);
        assertEq(shareMarket.totalBnbOwed(), 0);
        _buy(DAVE, id, 100);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.balanceOf(DAVE), 100);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.totalSupply(), 100);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(shareMarket.orders(id).remaining, 0);
        assertFalse(shareMarket.orders(id).active);
        assertEq(shareMarket.bnbOwed(ALICE), 9.9 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.1 ether);
        assertEq(shareMarket.totalBnbOwed(), 10 ether);
        assertEq(address(shareMarket).balance, 10 ether);
    }

    function test_repeatedBuysSettleEachRewardPeriodToTheActualOwners() public {
        uint256 aliceOrder = _list(ALICE, 20);
        uint256 bobOrder = _list(BOB, 10);

        _harvestReward(10000); // 99 BEM per share: 49/49/2 holders.
        _buy(DAVE, aliceOrder, 5);
        _buy(DAVE, aliceOrder, 5);
        _harvestReward(10000); // 39/49/2/10 holders.
        _buy(DAVE, bobOrder, 10);
        _harvestReward(10000); // 39/39/2/20 holders.

        assertEq(pool.balanceOf(DAVE), 20);
        assertEq(rewards.claimable(ALICE), 12573);
        assertEq(rewards.claimable(BOB), 13563);
        assertEq(rewards.claimable(CAROL), 594);
        assertEq(rewards.claimable(DAVE), 2970);
        assertEq(_claim(ALICE), 12573);
        assertEq(_claim(BOB), 13563);
        assertEq(_claim(CAROL), 594);
        assertEq(_claim(DAVE), 2970);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(bem.balanceOf(address(pool)), 0);

        _harvestReward(10000);
        assertEq(_claim(DAVE), 1980); // A second claim in the same timestamp is allowed.
        assertEq(bem.balanceOf(DAVE), 4950);
    }

    function test_multipleBuysProduceOneCombinedVotingWeightAndVoteFreezesFills() public {
        PoolVault vault = PoolVault(payable(address(pool)));
        vm.warp(uint256(vault.activatedAt()) + 7 days);
        uint256 aliceOrder = _list(ALICE, 25);
        uint256 bobOrder = _list(BOB, 10);
        _buy(DAVE, aliceOrder, 10);
        _buy(DAVE, aliceOrder, 15);
        assertEq(pool.balanceOf(DAVE), 25);
        assertEq(pool.memberCount(), 4);

        vm.prank(CAROL);
        uint256 proposalId = vault.propose(5 ether, 5 ether, uint64(block.timestamp));
        PoolSaleState.Proposal memory proposal = vault.getProposal(proposalId);
        assertEq(proposal.snapshotMemberCount, 4);
        assertEq(proposal.snapshotTotalShares, 100);
        assertFalse(vault.shareTradingAllowed());

        vm.deal(DAVE, 10 * PRICE);
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.WrongState.selector);
        shareMarket.fill{value: 10 * PRICE}(bobOrder, 10);
        assertEq(pool.balanceOf(DAVE), 25);
        assertEq(shareMarket.orders(bobOrder).remaining, 10);

        vm.prank(DAVE);
        vault.vote(proposalId, true);
        assertEq(vault.getProposal(proposalId).yesShares, 25);
        assertEq(vault.getProposal(proposalId).yesCount, 1);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.AlreadyVoted.selector);
        vault.vote(proposalId, true);

        vm.warp(proposal.endsAt);
        _buy(DAVE, bobOrder, 10);
        assertEq(pool.balanceOf(DAVE), 35);
        assertEq(pool.getPastShares(DAVE, proposal.snapshotTs), 25);
        assertEq(vault.getProposal(proposalId).yesShares, 25);
        assertEq(vault.getProposal(proposalId).yesCount, 1);
    }

    function test_buyerWithLockedListingsCannotListMoreThanActualUnencumberedBalance() public {
        // Buying 29 shares first and listing them does not reduce beneficial ownership.
        uint256 aliceOrder = _list(ALICE, 29);
        _buy(DAVE, aliceOrder, 29);
        uint256 daveOrder = _list(DAVE, 29);
        uint256 bobOrder = _list(BOB, 49);
        uint256 aliceRemainder = _list(ALICE, 20);
        uint256 carolOrder = _list(CAROL, 2);
        _buy(DAVE, bobOrder, 49);
        _buy(DAVE, aliceRemainder, 20);
        _buy(DAVE, carolOrder, 2);
        assertEq(pool.balanceOf(DAVE), 100);
        assertEq(_shareVault().lockedShares(DAVE), 29);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.InsufficientUnlockedShares.selector);
        shareMarket.list(address(pool), 72, PRICE);
        uint256 secondDaveOrder = _list(DAVE, 71);
        assertEq(_shareVault().lockedShares(DAVE), 100);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.InsufficientUnlockedShares.selector);
        shareMarket.list(address(pool), 1, PRICE);
        assertEq(shareMarket.orders(daveOrder).remaining, 29);
        assertEq(shareMarket.orders(secondDaveOrder).remaining, 71);
        assertEq(_shareVault().lockedShares(DAVE), 100);
    }
}
