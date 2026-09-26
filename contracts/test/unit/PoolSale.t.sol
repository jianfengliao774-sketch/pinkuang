// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {SaleTestBase, ISaleVault, SaleCallbackBuyer} from "../utils/SaleTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";

contract PoolSaleTest is SaleTestBase {
    event SaleListed(uint256 indexed proposalId, uint256 listingId, uint256 price, uint64 expiresAt);
    event SaleExpired(uint256 indexed proposalId);
    event SaleCompleted(uint256 gross, uint256 toPlatform, uint256 burnedBem, uint256 toMembers);

    function test_executeRequiresCurrentPassingProposalAndRecordsSevenDayListing() public {
        _readyForSale();
        vm.prank(ALICE);
        uint256 id = saleVault.propose(SALE_PRICE, 0, 0);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        sale.executeSale(0);
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        sale.executeSale(id);
        vm.prank(ALICE);
        saleVault.vote(id, true);
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        sale.executeSale(id);
        vm.prank(BOB);
        saleVault.vote(id, true);
        vm.expectEmit(true, false, false, true, address(pool));
        emit SaleListed(id, 0, SALE_PRICE, uint64(block.timestamp + 7 days));
        vm.prank(NFT_BUYER); // Execution is permissionless once the vote passes.
        sale.executeSale(id);
        _stateIs(IPoolVault.State.Listed);
        assertTrue(saleVault.getProposal(id).executed);
        assertEq(sale.listedProposalId(), id);
        assertEq(sale.listedAt(), block.timestamp);
        assertEq(sale.expiresAt(), block.timestamp + 7 days);
        assertEq(sale.salePrice(), SALE_PRICE);
        assertEq(nft.getApproved(rewardId), address(0));
        assertEq(nft.ownerOf(rewardId), address(pool));
        vm.expectRevert(IPoolVault.WrongState.selector);
        sale.executeSale(id);
    }

    function test_executeLastSecondBeforeVoteDeadlineSucceeds() public {
        uint256 id = _passSaleProposal(SALE_PRICE);
        vm.warp(uint256(saleVault.getProposal(id).endsAt) - 1);
        sale.executeSale(id);
        assertEq(sale.listedAt(), block.timestamp);
    }

    function test_executeAtVoteDeadlineRejectsEvenPassingProposal() public {
        uint256 id = _passSaleProposal(SALE_PRICE);
        vm.warp(saleVault.getProposal(id).endsAt);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        sale.executeSale(id);
        _stateIs(IPoolVault.State.Active);
        assertFalse(saleVault.getProposal(id).executed);
        assertEq(sale.listedProposalId(), 0);
    }

    function test_expiryBoundaryClearsListingAndRequiresNewApprovedProposalForRelist() public {
        uint256 first = _listSale(SALE_PRICE);
        uint64 expires = sale.expiresAt();
        vm.warp(uint256(expires) - 1);
        vm.expectRevert(IPoolVault.DeadlineNotReached.selector);
        sale.cancelExpired();
        vm.warp(expires);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        _complete(NFT_BUYER, SALE_PRICE);
        vm.expectEmit(true, false, false, true, address(pool));
        emit SaleExpired(first);
        vm.prank(NFT_BUYER);
        sale.cancelExpired();
        _stateIs(IPoolVault.State.Active);
        assertEq(sale.listedProposalId(), 0);
        assertEq(sale.listedAt(), 0);
        assertEq(sale.expiresAt(), 0);
        assertEq(sale.salePrice(), 0);
        assertTrue(saleVault.getProposal(first).executed);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        sale.relist(first);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        sale.executeSale(first);
        uint256 next = _passSaleProposal(SALE_PRICE + 17);
        sale.relist(next);
        assertGt(next, first);
        assertEq(sale.salePrice(), SALE_PRICE + 17);
        vm.warp(sale.expiresAt());
        sale.cancelExpired();
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        sale.relist(next);
        assertEq(nft.ownerOf(rewardId), address(pool));
    }

    function test_completeLastSecondBeforeListingExpirySucceeds() public {
        _listSale(SALE_PRICE);
        vm.warp(uint256(sale.expiresAt()) - 1);
        _complete(NFT_BUYER, SALE_PRICE);
        _stateIs(IPoolVault.State.Closed);
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
    }

    function test_listedFreezesTransfersAndFillsButOrderCanBeCancelled() public {
        _readyForSale();
        vm.prank(ALICE);
        uint256 order = shareMarket.list(address(pool), 10, 0);
        _listSale(SALE_PRICE);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.transfer(DAVE, 1);
        vm.prank(ALICE);
        pool.approve(FRANK, 1);
        vm.prank(FRANK);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.transferFrom(ALICE, DAVE, 1);
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.WrongState.selector);
        shareMarket.fill(order, 1);
        assertEq(shareMarket.orders(order).remaining, 10);
        assertEq(_shareVault().lockedShares(ALICE), 10);
        vm.prank(ALICE);
        shareMarket.cancel(order);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.memberCount(), 3);
    }

    function test_sameSecondListingAndCompletionLazilyDistributeActualFrozenHoldings() public {
        _transfer(ALICE, DAVE, 49);
        vm.warp(block.timestamp + 1);
        uint256 id = _passSaleProposal(SALE_PRICE);
        uint256 timestamp = block.timestamp;
        sale.executeSale(id);
        _complete(NFT_BUYER, SALE_PRICE);
        assertEq(block.timestamp, timestamp);
        assertEq(sale.completedAt(), sale.listedAt());
        assertEq(sale.pendingSaleProceeds(ALICE), 0);
        assertEq(sale.pendingSaleProceeds(DAVE), 4.802 ether);
        assertEq(pool.bnbOwed(ALICE), 0.735 ether, "original purchase surplus remains Alice's");
        assertEq(pool.bnbOwed(DAVE), 4.802 ether);
        assertEq(pool.bnbOwed(BOB), 5.537 ether);
        assertEq(pool.bnbOwed(CAROL), 0.226 ether);
        assertEq(pool.bnbOwed(TREASURY), 0.2 ether);
        assertEq(sale.saleOutstandingWei(), 9.8 ether);
        assertEq(pool.totalBnbOwed(), 11.5 ether);
        assertEq(address(pool).balance, 11.5 ether);
        assertEq(sale.burnBudget(), 0);
        assertEq(_withdraw(DAVE), 4.802 ether);
        assertTrue(sale.saleSettled(DAVE));
        assertEq(sale.pendingSaleProceeds(DAVE), 0);
        assertEq(sale.saleOutstandingWei(), 4.998 ether);
        assertEq(_withdraw(ALICE), 0.735 ether);
        assertEq(_withdraw(BOB), 5.537 ether);
        assertEq(_withdraw(CAROL), 0.226 ether);
        assertEq(_withdraw(TREASURY), 0.2 ether);
        assertEq(sale.saleOutstandingWei(), 0);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(address(pool).balance, sale.burnBudget());
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        pool.withdrawBnb();
    }

    function test_treasuryMemberReceivesFeeAndOwnSharesWithoutLosingFormerMemberSurplus() public {
        _transfer(CAROL, TREASURY, 2);
        _listSale(SALE_PRICE);
        uint256 beforeBalance = TREASURY.balance;
        _complete(NFT_BUYER, SALE_PRICE);
        assertEq(TREASURY.balance, beforeBalance, "sale records pull credits");
        assertEq(pool.bnbOwed(TREASURY), 0.396 ether);
        assertEq(pool.bnbOwed(CAROL), 0.03 ether);
        assertEq(sale.pendingSaleProceeds(CAROL), 0);
        assertEq(_withdraw(TREASURY), 0.396 ether);
        assertEq(_withdraw(CAROL), 0.03 ether);
    }

    function test_memberBuyerRetainsHistoricShareRightsAndOwnsFutureNftRewards() public {
        _listSale(SALE_PRICE);
        _complete(ALICE, SALE_PRICE);
        assertEq(nft.ownerOf(rewardId), ALICE);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(sale.pendingSaleProceeds(ALICE), 4.802 ether);
        assertEq(_withdraw(ALICE), 5.537 ether);
        mining.configure(address(nft), rewardId, 0, 10000);
        mining.claim(key);
        assertEq(bem.balanceOf(ALICE), 10000);
        assertEq(bem.balanceOf(address(pool)), 0);
        assertEq(rewards.bemAccounted(), 0);
    }

    function test_saleAddsToOldRefundDirectSellerAndPurchaseSurplusCredits() public {
        _directPoolWithRefund(5 ether);
        assertEq(pool.bnbOwed(ALICE), 5.865 ether);
        assertEq(address(pool).balance, 6.63 ether);
        _listSale(SALE_PRICE);
        _complete(NFT_BUYER, SALE_PRICE);
        assertEq(pool.bnbOwed(ALICE), 10.667 ether);
        assertEq(pool.totalBnbOwed(), 16.63 ether);
        assertEq(_withdraw(ALICE), 10.667 ether);
        assertEq(_withdraw(BOB), 5.537 ether);
        assertEq(_withdraw(CAROL), 0.226 ether);
        assertEq(_withdraw(TREASURY), 0.2 ether);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(address(pool).balance, 0);
    }

    function test_saleRemainderAssignedToLastHolderWhileHistoricalPurchaseTailRemains() public {
        _directPoolWithRefund(5 ether + 17);
        assertEq(saleVault.surplusRemainder(), 83);
        _listSale(10003);
        _complete(NFT_BUYER, 10003);
        assertEq(sale.salePerShareWei(), 98);
        assertEq(sale.saleRemainder(), 3);
        assertEq(sale.saleOutstandingWei(), 9803);
        assertEq(sale.burnBudget(), 0);
        assertEq(saleVault.surplusRemainder(), 83);
        _withdraw(ALICE);
        _withdraw(BOB);
        _withdraw(CAROL);
        _withdraw(TREASURY);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(sale.saleOutstandingWei(), 0);
        assertEq(address(pool).balance, 83, "only the existing purchase tail remains; all sale proceeds were assigned");
    }

    function test_zeroPriceProposalRejectedBeforeAnySale() public {
        _readyForSale();
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.InvalidSalePrice.selector);
        saleVault.propose(0, 0, 0);
        _stateIs(IPoolVault.State.Active);
    }

    function test_wrongPaymentRollsBackWithoutHarvestingOrCrediting() public {
        _listSale(SALE_PRICE);
        mining.configure(address(nft), rewardId, 100, 900);
        uint256 calls = mining.claimCalls();
        vm.expectRevert(IPoolVault.PaymentMismatch.selector);
        _complete(NFT_BUYER, SALE_PRICE - 1);
        _assertFailedCompletion(calls);
        vm.expectRevert(IPoolVault.PaymentMismatch.selector);
        _complete(NFT_BUYER, SALE_PRICE + 1);
        _assertFailedCompletion(calls);
    }

    function testFuzz_finalClaimFaultsRollbackAllAssetsAndLiabilities(uint8 faultSeed) public {
        uint8 fault = uint8(bound(faultSeed, 1, 4));
        _listSale(SALE_PRICE);
        mining.configure(address(nft), rewardId, 100, 900);
        mining.setClaimFault(fault);
        uint256 calls = mining.claimCalls();
        vm.expectRevert(
            fault == 4 ? IPoolVault.NotOwnerAfterBuy.selector : IPoolVault.FinalRewardSettlementFailed.selector
        );
        _complete(NFT_BUYER, SALE_PRICE);
        _assertFailedCompletion(calls);
    }

    function test_changedNftOwnerBeforeSaleRejectsWithoutTouchingFunds() public {
        _listSale(SALE_PRICE);
        nft.forceTransfer(DAVE, rewardId);
        uint256 calls = mining.claimCalls();
        vm.expectRevert(IPoolVault.NotOwnerAfterBuy.selector);
        _complete(NFT_BUYER, SALE_PRICE);
        _stateIs(IPoolVault.State.Listed);
        assertEq(nft.ownerOf(rewardId), DAVE);
        assertEq(mining.claimCalls(), calls);
        assertEq(sale.saleBuyer(), address(0));
        assertEq(address(pool).balance, 1.5 ether);
        assertEq(pool.totalBnbOwed(), 1.5 ether);
    }

    function testFuzz_buyerRejectingNftOrMovingItAwayRollsBackWholeSale(uint8 faultSeed) public {
        uint8 fault = uint8(bound(faultSeed, 1, 3));
        _listSale(SALE_PRICE);
        mining.configure(address(nft), rewardId, 100, 900);
        uint256 calls = mining.claimCalls();
        SaleCallbackBuyer buyer = new SaleCallbackBuyer();
        buyer.configure(fault, "", false);
        vm.deal(address(this), SALE_PRICE);
        if (fault == 3) vm.expectRevert(IPoolVault.TransferFailed.selector);
        else vm.expectRevert();
        buyer.buy{value: SALE_PRICE}(address(pool));
        _assertFailedCompletion(calls);
        assertEq(address(buyer).balance, 0);
        assertEq(address(this).balance, SALE_PRICE);
    }

    function test_buyerCallbackSeesClosedStateAndCannotCompleteAgainOrWithdraw() public {
        SaleCallbackBuyer buyer = new SaleCallbackBuyer();
        _transfer(CAROL, address(buyer), 2);
        _listSale(SALE_PRICE);
        buyer.configure(0, abi.encodeCall(ISaleVault.withdrawBnb, ()), false);
        vm.deal(address(this), SALE_PRICE);
        buyer.buy{value: SALE_PRICE}(address(pool));
        assertEq(uint256(buyer.observedState()), uint256(IPoolVault.State.Closed));
        assertEq(buyer.observedOwner(), address(buyer));
        assertEq(buyer.observedOwed(), 0.196 ether);
        assertTrue(buyer.attempted());
        assertFalse(buyer.succeeded());
        assertEq(buyer.result(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(sale.saleProceeds(), SALE_PRICE);
        assertEq(pool.bnbOwed(address(buyer)), 0.196 ether);
        assertFalse(sale.saleSettled(address(buyer)));
        buyer.withdraw();
        assertEq(address(buyer).balance, 0.196 ether);
        assertTrue(sale.saleSettled(address(buyer)));
    }

    function test_buyerBubblingReentryFailureRollsBackFinalClaimAndSale() public {
        _listSale(SALE_PRICE);
        mining.configure(address(nft), rewardId, 100, 900);
        uint256 calls = mining.claimCalls();
        SaleCallbackBuyer buyer = new SaleCallbackBuyer();
        buyer.configure(0, abi.encodeCall(ISaleVault.completeSale, ()), true);
        vm.deal(address(this), SALE_PRICE);
        vm.expectRevert(SaleCallbackBuyer.BuyerRejected.selector);
        buyer.buy{value: SALE_PRICE}(address(pool));
        _assertFailedCompletion(calls);
    }

    function test_miningClaimCallbackCannotReenterCompletion() public {
        _listSale(SALE_PRICE);
        mining.setClaimReentry(address(pool), abi.encodeCall(ISaleVault.completeSale, ()));
        uint256 beforeCalls = mining.claimCalls();
        _complete(NFT_BUYER, SALE_PRICE);
        assertTrue(mining.reentryAttempted());
        assertFalse(mining.reentrySucceeded());
        assertEq(mining.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(mining.claimCalls(), beforeCalls + 1);
        assertEq(sale.saleProceeds(), SALE_PRICE);
        assertEq(sale.saleOutstandingWei(), 9.8 ether);
    }

    function test_failedBnbWithdrawalRestoresLazySaleEntitlementForRetry() public {
        SaleCallbackBuyer buyer = new SaleCallbackBuyer();
        _transfer(CAROL, address(buyer), 2);
        _listSale(SALE_PRICE);
        vm.deal(address(this), SALE_PRICE);
        buyer.buy{value: SALE_PRICE}(address(pool));
        buyer.setRejectBnb(true);
        uint256 outstanding = sale.saleOutstandingWei();
        uint256 total = pool.totalBnbOwed();
        vm.expectRevert(IPoolVault.TransferFailed.selector);
        buyer.withdraw();
        assertFalse(sale.saleSettled(address(buyer)));
        assertEq(sale.pendingSaleProceeds(address(buyer)), 0.196 ether);
        assertEq(sale.saleOutstandingWei(), outstanding);
        assertEq(pool.totalBnbOwed(), total);
        buyer.setRejectBnb(false);
        buyer.withdraw();
        assertEq(address(buyer).balance, 0.196 ether);
        assertEq(sale.saleOutstandingWei(), outstanding - 0.196 ether);
    }

    function test_saleStrictlySettlesRewardsBeforeNftTransferWithoutBurn() public {
        uint256 id = _listSale(SALE_PRICE);
        mining.configure(address(nft), rewardId, 0, 10000);
        vm.recordLogs();
        _complete(NFT_BUYER, SALE_PRICE);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 settled = type(uint256).max;
        uint256 transferred = type(uint256).max;
        uint256 completed = type(uint256).max;
        bytes32 tradeId = keccak256(abi.encode(address(pool), id, NFT_BUYER, address(nft), rewardId, SALE_PRICE));
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(nft) && logs[i].topics[0] == keccak256("Transfer(address,address,uint256)"))
            {
                transferred = i;
            }
            if (logs[i].emitter != address(pool)) continue;
            if (logs[i].topics[0] == keccak256("RewardSettledBeforeTransfer(address,uint256,address,uint256,bytes32)"))
            {
                settled = i;
                (address previousOwner, uint256 amount, bytes32 recordedTrade) =
                    abi.decode(logs[i].data, (address, uint256, bytes32));
                assertEq(previousOwner, address(pool));
                assertEq(amount, 10000);
                assertEq(recordedTrade, tradeId);
            }
            if (logs[i].topics[0] == keccak256("SaleCompleted(uint256,uint256,uint256,uint256)")) {
                completed = i;
                (uint256 gross, uint256 fee, uint256 burnedBem, uint256 net) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                assertEq(gross, SALE_PRICE);
                assertEq(fee, 0.2 ether);
                assertEq(burnedBem, 0);
                assertEq(net, 9.8 ether);
            }
        }
        assertLt(settled, transferred);
        assertLt(transferred, completed);
        assertLt(completed, type(uint256).max);
        assertEq(sale.saleTradeId(), tradeId);
        assertEq(rewards.bemAccounted(), 9900);
        assertEq(bem.balanceOf(TREASURY), 100);
        assertEq(bem.balanceOf(DEAD), 0);
        assertEq(mining.pending(key), 0);
        assertEq(mining.getMiner(key).status, 1, "handover does not stop the miner");
        assertEq(nft.getApproved(rewardId), address(0));
        assertEq(pool.balanceOf(NFT_BUYER), 0);
    }

    function test_closedClaimsRemainPermanentAndNeverClaimSoldNftAgain() public {
        _harvestReward(10000);
        _listSale(SALE_PRICE);
        _complete(NFT_BUYER, SALE_PRICE);
        uint256 calls = mining.claimCalls();
        mining.setClaimFault(1);
        assertEq(_claim(ALICE), 4851);
        vm.warp(block.timestamp + 30000 days);
        assertEq(_claim(BOB), 4851);
        assertEq(_claim(CAROL), 198);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(mining.claimCalls(), calls);
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
    }

    function test_closedClaimsWithExpiryDisabledRemainClaimableAfterLongDelay() public {
        _disableExpiryForNewPool();
        _useSalePool();
        _harvestReward(10000);
        _listSale(SALE_PRICE);
        _complete(NFT_BUYER, SALE_PRICE);
        uint256 calls = mining.claimCalls();
        mining.setClaimFault(1);
        vm.warp(block.timestamp + 100 days);
        assertEq(_claim(BOB), 4851);
        assertEq(mining.claimCalls(), calls);
    }

    function test_closedRejectsReplayAndPermanentlyFreezesShares() public {
        uint256 id = _listSale(SALE_PRICE);
        _complete(NFT_BUYER, SALE_PRICE);
        uint256 owed = pool.totalBnbOwed();
        vm.expectRevert(IPoolVault.WrongState.selector);
        _complete(DAVE, SALE_PRICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        sale.executeSale(id);
        vm.expectRevert(IPoolVault.WrongState.selector);
        sale.cancelExpired();
        vm.expectRevert(IPoolVault.WrongState.selector);
        sale.relist(id);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.transfer(DAVE, 1);
        assertEq(pool.totalBnbOwed(), owed);
        assertEq(sale.saleBuyer(), NFT_BUYER);
        assertEq(sale.saleProceeds(), SALE_PRICE);
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
    }

    function test_settleSaleNeverAcceptsAnUnverifiedExternalSaleRoute() public {
        _expectUnverifiedRoute();
        _listSale(SALE_PRICE);
        _expectUnverifiedRoute();
        _complete(NFT_BUYER, SALE_PRICE);
        uint256 owed = pool.totalBnbOwed();
        _expectUnverifiedRoute();
        assertEq(pool.totalBnbOwed(), owed);
    }

    function _expectUnverifiedRoute() private {
        vm.expectRevert(bytes4(keccak256("UnverifiedSaleRoute()")));
        sale.settleSale();
    }

    function _assertFailedCompletion(uint256 calls) private view {
        _stateIs(IPoolVault.State.Listed);
        assertEq(nft.ownerOf(rewardId), address(pool));
        assertEq(mining.claimCalls(), calls);
        assertEq(mining.pending(key), 100);
        assertEq(mining.unreported(key), 900);
        assertEq(bem.balanceOf(address(pool)), 0);
        assertEq(bem.balanceOf(TREASURY), 0);
        assertEq(bem.balanceOf(DEAD), 0);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(sale.saleBuyer(), address(0));
        assertEq(sale.completedAt(), 0);
        assertEq(sale.saleProceeds(), 0);
        assertEq(sale.saleOutstandingWei(), 0);
        assertEq(sale.burnBudget(), 0);
        assertEq(pool.bnbOwed(TREASURY), 0);
        assertEq(pool.totalBnbOwed(), 1.5 ether);
        assertEq(address(pool).balance, 1.5 ether);
    }
}
