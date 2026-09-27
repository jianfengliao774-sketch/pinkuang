// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {IFundingVault} from "../utils/FundingTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @notice Calls execute at the same timestamp to model two wallets whose
/// transactions enter one block. The EVM still orders those transactions.
contract WholeMinerConcurrencyTest is SaleTestBase {
    function testFuzz_twoBuyersCannotBothCompleteTheSameWholeMinerSale(bool reverseOrder) public {
        _listSale(SALE_PRICE);
        _queueReward(10_000);
        address winner = reverseOrder ? DAVE : NFT_BUYER;
        address loser = reverseOrder ? NFT_BUYER : DAVE;
        uint256 sameBlockTimestamp = block.timestamp;
        _complete(winner, SALE_PRICE);
        uint256 loserBalance = loser.balance;
        vm.deal(loser, loserBalance + SALE_PRICE);
        loserBalance = loser.balance;
        vm.prank(loser);
        vm.expectRevert(IPoolVault.WrongState.selector);
        sale.completeSale{value: SALE_PRICE}();

        assertEq(block.timestamp, sameBlockTimestamp);
        _stateIs(IPoolVault.State.Closed);
        assertEq(nft.ownerOf(rewardId), winner);
        assertEq(sale.saleBuyer(), winner);
        assertEq(sale.saleProceeds(), SALE_PRICE);
        assertEq(sale.totalBnbOwed(), 11.5 ether); // Includes the earlier purchase surplus.
        assertEq(address(pool).balance, 11.5 ether);
        assertEq(loser.balance, loserBalance, "a reverted payment cannot remain in the pool");
        assertEq(bem.balanceOf(TREASURY), 100, "strict mining settlement runs once");
        assertEq(rewards.bemAccounted(), 9_900);
    }

    function testFuzz_twoWalletsCannotPurchaseTheSamePoolTwice(bool reverseOrder) public {
        (IFundingVault target, uint256 listingId) = _fundedPoolAndListing();
        address firstCaller = reverseOrder ? BOB : ALICE;
        address secondCaller = reverseOrder ? ALICE : BOB;
        uint256 sellerBalance = REWARD_SELLER.balance;
        uint256 marketBuys = market.buyCalls();
        vm.prank(firstCaller);
        IPoolVault(address(target)).buyFromMarket(listingId);
        vm.prank(secondCaller);
        vm.expectRevert(IPoolVault.WrongState.selector);
        IPoolVault(address(target)).buyFromMarket(listingId);

        assertEq(uint256(target.state()), uint256(IPoolVault.State.Active));
        assertEq(nft.ownerOf(rewardId), address(target));
        assertEq(market.buyCalls(), marketBuys + 1);
        assertEq(REWARD_SELLER.balance - sellerBalance, uint256(REWARD_PRICE) * 99 / 100);
        assertEq(target.totalBnbOwed(), 1.5 ether);
        assertEq(address(target).balance, 1.5 ether);
    }

    function testFuzz_twoIndependentFactoriesCannotBuyTheSameOfficialListing(bool reverseOrder) public {
        (IFundingVault first, uint256 listingId) = _fundedPoolAndListing();
        _deployFactory(); // Same-site duplicates are rejected; separate factory deployments still compete on-chain.
        IFundingVault second = _createPool(defaultParams);
        _deposit(second, BOB, 100);
        IFundingVault winner = reverseOrder ? second : first;
        IFundingVault loser = reverseOrder ? first : second;
        uint256 sellerBalance = REWARD_SELLER.balance;
        uint256 marketBuys = market.buyCalls();
        vm.prank(ALICE);
        IPoolVault(address(winner)).buyFromMarket(listingId);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.InvalidListing.selector);
        IPoolVault(address(loser)).buyFromMarket(listingId);

        assertEq(nft.ownerOf(rewardId), address(winner));
        assertEq(uint256(winner.state()), uint256(IPoolVault.State.Active));
        assertEq(uint256(loser.state()), uint256(IPoolVault.State.Funded));
        assertEq(address(loser).balance, defaultParams.targetRaise);
        assertEq(loser.totalBnbOwed(), 0);
        assertEq(market.buyCalls(), marketBuys + 1);
        assertEq(REWARD_SELLER.balance - sellerBalance, uint256(REWARD_PRICE) * 99 / 100);
    }

    function _fundedPoolAndListing() private returns (IFundingVault target, uint256 listingId) {
        defaultParams.circuitId = ++rewardId;
        defaultParams.fundingDeadline = uint64(block.timestamp + 7 days);
        defaultParams.purchaseDeadline = uint64(block.timestamp + 10 days);
        target = _createPool(defaultParams);
        nft.mint(REWARD_SELLER, rewardId);
        mining.configure(address(nft), rewardId, 0, 0);
        _deposit(target, ALICE, 100);
        vm.prank(REWARD_SELLER);
        nft.approve(address(market), rewardId);
        listingId = market.createListing(REWARD_SELLER, address(nft), rewardId, REWARD_PRICE);
    }
}
