// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";

/// @notice A wallet may subscribe in several transactions and later buy more shares.
/// These tests exercise the real Vault and Market entry points across that lifecycle.
contract PoolMultiShareLifecycleTest is SaleTestBase {
    uint256 private constant MARKET_UNIT_PRICE = 0.1 ether;

    function test_soleSubscriberCanPurchaseClaimRewardsAndCompleteWholeSale() public {
        _useFreshPool();
        nft.mint(REWARD_SELLER, rewardId);
        mining.configure(address(nft), rewardId, 0, 0);
        key = mining.minerKey(address(nft), rewardId);
        _deposit(pool, ALICE, 100);
        _stateIs(IPoolVault.State.Funded);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.totalRaised(), defaultParams.targetRaise);

        vm.prank(REWARD_SELLER);
        nft.approve(address(market), rewardId);
        uint256 listing = market.createListing(REWARD_SELLER, address(nft), rewardId, REWARD_PRICE);
        pool.buyFromMarket(listing);
        _stateIs(IPoolVault.State.Active);
        assertEq(pool.balanceOf(ALICE), 100);
        assertEq(pool.bnbOwed(ALICE), 1.5 ether);
        assertEq(pool.totalBnbOwed(), 1.5 ether);

        _harvestReward(10_000);
        assertEq(rewards.claimable(ALICE), 9_900);
        assertEq(_claim(ALICE), 9_900);
        _queueReward(10_000);
        _listSale(SALE_PRICE);
        _complete(NFT_BUYER, SALE_PRICE);
        _stateIs(IPoolVault.State.Closed);
        assertEq(rewards.claimable(ALICE), 9_900);
        assertEq(_claim(ALICE), 9_900);
        assertEq(bem.balanceOf(TREASURY), 200);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(sale.pendingSaleProceeds(ALICE), 9.9 ether);
        assertEq(pool.bnbOwed(ALICE), 11.4 ether);
        assertEq(pool.bnbOwed(TREASURY), 0.1 ether);
        assertEq(_withdraw(ALICE), 11.4 ether);
        assertEq(_withdraw(TREASURY), 0.1 ether);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(address(pool).balance, 0);
    }

    function test_splitSubscriptionRefundsExactlyOncePerWallet() public {
        _useFreshPool();
        _deposit(pool, ALICE, 12);
        _deposit(pool, ALICE, 18);
        _deposit(pool, BOB, 11);
        _deposit(pool, BOB, 19);
        _deposit(pool, CAROL, 5);

        assertEq(pool.memberCount(), 3);
        assertEq(pool.totalSupply(), 65);
        assertEq(pool.contributedWei(ALICE), 30 * UNIT_PRICE);
        assertEq(pool.contributedWei(BOB), 30 * UNIT_PRICE);
        assertEq(pool.contributedWei(CAROL), 5 * UNIT_PRICE);

        vm.warp(defaultParams.fundingDeadline);
        pool.finalizeFailure();
        _stateIs(IPoolVault.State.Refunding);
        assertEq(pool.bnbOwed(ALICE), 30 * UNIT_PRICE);
        assertEq(pool.bnbOwed(BOB), 30 * UNIT_PRICE);
        assertEq(pool.bnbOwed(CAROL), 5 * UNIT_PRICE);
        assertEq(pool.totalBnbOwed(), 65 * UNIT_PRICE);

        assertEq(_withdraw(ALICE), 30 * UNIT_PRICE);
        assertEq(_withdraw(BOB), 30 * UNIT_PRICE);
        assertEq(_withdraw(CAROL), 5 * UNIT_PRICE);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(address(pool).balance, 0);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        pool.withdrawBnb();
    }

    function test_splitSubscriptionsPurchaseRewardAndWholeSaleUseAggregatedShares() public {
        _activateSplitPool();
        assertEq(pool.memberCount(), 3);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.balanceOf(ALICE), 30);
        assertEq(pool.balanceOf(BOB), 40);
        assertEq(pool.balanceOf(CAROL), 30);
        assertEq(pool.contributedWei(ALICE), 30 * UNIT_PRICE);
        assertEq(pool.contributedWei(BOB), 40 * UNIT_PRICE);
        assertEq(pool.contributedWei(CAROL), 30 * UNIT_PRICE);
        assertEq(pool.bnbOwed(ALICE), 0.45 ether);
        assertEq(pool.bnbOwed(BOB), 0.6 ether);
        assertEq(pool.bnbOwed(CAROL), 0.45 ether);

        _harvestReward(10_000);
        assertEq(rewards.claimable(ALICE), 2_970);
        assertEq(rewards.claimable(BOB), 3_960);
        assertEq(rewards.claimable(CAROL), 2_970);
        assertEq(_claim(ALICE), 2_970);
        assertEq(_claim(BOB), 3_960);
        assertEq(_claim(CAROL), 2_970);
        assertEq(rewards.bemAccounted(), 0);

        _listSale(SALE_PRICE);
        _complete(NFT_BUYER, SALE_PRICE);
        _stateIs(IPoolVault.State.Closed);
        assertEq(sale.pendingSaleProceeds(ALICE), 2.97 ether);
        assertEq(sale.pendingSaleProceeds(BOB), 3.96 ether);
        assertEq(sale.pendingSaleProceeds(CAROL), 2.97 ether);
        assertEq(pool.bnbOwed(ALICE), 3.42 ether);
        assertEq(pool.bnbOwed(BOB), 4.56 ether);
        assertEq(pool.bnbOwed(CAROL), 3.42 ether);
        assertEq(pool.bnbOwed(TREASURY), 0.1 ether);
        assertEq(pool.totalBnbOwed(), 11.5 ether);

        assertEq(_withdraw(ALICE), 3.42 ether);
        assertEq(_withdraw(BOB), 4.56 ether);
        assertEq(_withdraw(CAROL), 3.42 ether);
        assertEq(_withdraw(TREASURY), 0.1 ether);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(address(pool).balance, 0);
    }

    function test_marketPurchasesCanConsolidateAllHundredWithoutMovingOldRights() public {
        _activateSplitPool();
        _harvestReward(10_000);

        vm.prank(BOB);
        uint256 bobOrder = shareMarket.list(address(pool), 40, MARKET_UNIT_PRICE);
        vm.prank(CAROL);
        uint256 carolOrder = shareMarket.list(address(pool), 30, MARKET_UNIT_PRICE);
        _fill(ALICE, bobOrder, 15);
        _fill(ALICE, bobOrder, 25);
        _fill(ALICE, carolOrder, 30);
        assertEq(pool.balanceOf(ALICE), 100);
        assertEq(pool.balanceOf(BOB), 0);
        assertEq(pool.balanceOf(CAROL), 0);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.totalSupply(), 100);
        assertEq(shareMarket.bnbOwed(BOB), 3.96 ether);
        assertEq(shareMarket.bnbOwed(CAROL), 2.97 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.07 ether);
        assertEq(shareMarket.totalBnbOwed(), 7 ether);

        assertEq(rewards.claimable(ALICE), 2_970);
        assertEq(rewards.claimable(BOB), 3_960);
        assertEq(rewards.claimable(CAROL), 2_970);
        assertEq(pool.bnbOwed(ALICE), 0.45 ether);
        assertEq(pool.bnbOwed(BOB), 0.6 ether);
        assertEq(pool.bnbOwed(CAROL), 0.45 ether);

        _harvestReward(10_000);
        assertEq(_claim(ALICE), 12_870); // 30 old shares + all 100 new shares.
        assertEq(_claim(BOB), 3_960); // 40 old shares, retained after selling all.
        assertEq(_claim(CAROL), 2_970); // 30 old shares, retained after selling all.
        assertEq(rewards.bemAccounted(), 0);

        _readyForSale();
        uint256 discountPrice = REWARD_PRICE - 0.1 ether;
        vm.prank(ALICE);
        uint256 proposalId = saleVault.propose(discountPrice, 0, 0);
        vm.prank(ALICE);
        saleVault.vote(proposalId, true);
        assertEq(saleVault.getProposal(proposalId).snapshotMemberCount, 1);
        assertEq(saleVault.getProposal(proposalId).yesCount, 1);
        assertEq(saleVault.getProposal(proposalId).yesShares, 100);
        assertTrue(saleVault.proposalPassed(proposalId));
        sale.executeSale(proposalId);
        _complete(NFT_BUYER, discountPrice);
        uint256 perShare = (discountPrice - discountPrice / 100) / 100;
        assertEq(sale.pendingSaleProceeds(ALICE), 100 * perShare);
        assertEq(sale.pendingSaleProceeds(BOB), 0);
        assertEq(sale.pendingSaleProceeds(CAROL), 0);
        assertEq(pool.bnbOwed(ALICE), 0.45 ether + 100 * perShare);
        assertEq(pool.bnbOwed(BOB), 0.6 ether);
        assertEq(pool.bnbOwed(CAROL), 0.45 ether);
    }

    function _useFreshPool() private {
        defaultParams.circuitId = ++rewardId;
        defaultParams.fundingDeadline = uint64(block.timestamp + 7 days);
        defaultParams.purchaseDeadline = uint64(block.timestamp + 10 days);
        pool = _createPool(defaultParams);
        _useSalePool();
    }

    function _activateSplitPool() private {
        _useFreshPool();
        nft.mint(REWARD_SELLER, rewardId);
        mining.configure(address(nft), rewardId, 0, 0);
        key = mining.minerKey(address(nft), rewardId);

        _deposit(pool, ALICE, 12);
        _deposit(pool, BOB, 11);
        _deposit(pool, CAROL, 5);
        _deposit(pool, ALICE, 18);
        _deposit(pool, BOB, 29);
        _deposit(pool, CAROL, 25);
        _stateIs(IPoolVault.State.Funded);

        vm.prank(REWARD_SELLER);
        nft.approve(address(market), rewardId);
        uint256 listing = market.createListing(REWARD_SELLER, address(nft), rewardId, REWARD_PRICE);
        pool.buyFromMarket(listing);
        firstEpoch = _epoch();
        _stateIs(IPoolVault.State.Active);
    }

    function _fill(address buyer, uint256 orderId, uint256 amount) private {
        uint256 payment = amount * MARKET_UNIT_PRICE;
        vm.deal(buyer, buyer.balance + payment);
        vm.prank(buyer);
        shareMarket.fill{value: payment}(orderId, amount);
    }
}
