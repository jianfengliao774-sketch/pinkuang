// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @notice Regression for audit #2/#11: zero-debt non-mining states cannot trap existing owners.
contract AuditMiningSettlementTest is SaleTestBase {
    event MiningClaimFailed(bytes32 indexed key, bytes reason);

    function test_status0ZeroSettlementAllowsTransfersMarketFillAndCompleteSale() public {
        _assertKnownZeroSettlement(0);
    }

    function test_status2ZeroSettlementAllowsTransfersMarketFillAndCompleteSale() public {
        _assertKnownZeroSettlement(2);
    }

    function test_status3ZeroSettlementAllowsTransfersMarketFillAndCompleteSale() public {
        _assertKnownZeroSettlement(3);
    }

    function test_mockClaimRejectsEveryNonMiningStatusWithRealSelector() public {
        uint8[5] memory statuses = [uint8(0), 2, 3, 4, 255];
        for (uint256 i; i < statuses.length; ++i) {
            mining.setStatus(key, statuses[i]);
            vm.expectRevert(bytes4(0x5f9bb3be));
            mining.claim(key);
        }
    }

    function test_nonMiningOutstandingPendingFailsClosedForTransferAndSale() public {
        _listSale(SALE_PRICE);
        mining.configure(address(nft), rewardId, 1, 0);
        uint8[3] memory statuses = [uint8(0), 2, 3];
        for (uint256 i; i < statuses.length; ++i) {
            mining.setStatus(key, statuses[i]);
            vm.deal(NFT_BUYER, SALE_PRICE);
            vm.prank(NFT_BUYER);
            vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
            sale.completeSale{value: SALE_PRICE}();
            assertEq(NFT_BUYER.balance, SALE_PRICE);
            assertEq(nft.ownerOf(rewardId), address(pool));
            assertEq(mining.pending(key), 1);
            assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
        }
        vm.warp(sale.expiresAt());
        sale.cancelExpired();
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        pool.transfer(DAVE, 1);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(DAVE), 0);
    }

    function test_unknownStatusesWithZeroPendingFailClosed() public {
        uint8[2] memory statuses = [uint8(4), 255];
        for (uint256 i; i < statuses.length; ++i) {
            mining.setStatus(key, statuses[i]);
            vm.prank(ALICE);
            vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
            pool.transfer(DAVE, 1);
        }
        _listSale(SALE_PRICE);
        vm.deal(NFT_BUYER, SALE_PRICE);
        vm.prank(NFT_BUYER);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        sale.completeSale{value: SALE_PRICE}();
        assertEq(nft.ownerOf(rewardId), address(pool));
        assertEq(pool.balanceOf(ALICE), 49);
    }

    function test_activeClaimFailureStillRejectsEvenWithZeroPending() public {
        assertEq(mining.pending(key), 0);
        mining.setClaimFault(1);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        pool.transfer(DAVE, 1);
        _listSale(SALE_PRICE);
        vm.deal(NFT_BUYER, SALE_PRICE);
        vm.prank(NFT_BUYER);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        sale.completeSale{value: SALE_PRICE}();
        assertEq(nft.ownerOf(rewardId), address(pool));
    }

    function test_activeClaimStillRequiresPendingPaidToCurrentVault() public {
        mining.configure(address(nft), rewardId, 1000, 0);
        mining.setClaimFault(3); // Sends new BEM to an unrelated account.
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        pool.transfer(DAVE, 1);
        assertEq(mining.pending(key), 1000);
        assertEq(bem.balanceOf(address(0xBAD)), 0);
        assertEq(pool.balanceOf(ALICE), 49);
    }

    function test_activeClaimCannotLeavePendingDebt() public {
        mining.configure(address(nft), rewardId, 1000, 0);
        mining.setClaimFault(2);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        pool.transfer(DAVE, 1);
        assertEq(mining.pending(key), 1000);
    }

    function test_unknownPostClaimStatusAlsoFailsClosed() public {
        mining.setClaimFault(6);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        pool.transfer(DAVE, 1);
        assertEq(mining.getMiner(key).status, 1, "claim side effects rolled back");
    }

    function test_zeroSettlementStillChecksIdentityAndActualNftOwner() public {
        mining.setStatus(key, 2);
        mining.setIdentity(key, address(0xBAD), uint64(rewardId));
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        pool.transfer(DAVE, 1);
        mining.setIdentity(key, address(nft), uint64(rewardId));
        nft.forceTransfer(address(0xBAD), rewardId);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NotOwnerAfterBuy.selector);
        pool.transfer(DAVE, 1);
        assertEq(pool.balanceOf(ALICE), 49);
    }

    function test_ordinaryInactiveHarvestEmitsFailureAndOldRewardsRemainClaimable() public {
        _harvestReward(10000);
        mining.setStatus(key, 2);
        vm.expectEmit(true, false, false, true, address(pool));
        emit MiningClaimFailed(key, hex"5f9bb3be");
        rewards.harvest();
        uint256 expected = rewards.claimable(ALICE);
        assertGt(expected, 0);
        vm.prank(ALICE);
        rewards.claim();
        assertEq(bem.balanceOf(ALICE), expected);
    }

    function _assertKnownZeroSettlement(uint8 status) private {
        _readyForSale();
        _harvestReward(10000);
        mining.setStatus(key, status);
        assertEq(mining.pending(key), 0);
        vm.expectRevert(bytes4(0x5f9bb3be));
        mining.claim(key);
        uint256 claimsBefore = mining.claimCalls();
        // This unrelated injected claim failure cannot be swallowed: no claim call is required at all.
        mining.setClaimFault(1);
        _donate(20000);
        uint256 supplyBefore = bem.totalSupply();
        _transfer(ALICE, DAVE, 1);
        assertEq(mining.claimCalls(), claimsBefore);
        assertEq(bem.totalSupply(), supplyBefore);
        assertEq(rewards.bemAccounted(), 28500);
        assertEq(rewards.claimable(ALICE), 13965);
        assertEq(rewards.claimable(DAVE), 0);

        vm.prank(ALICE);
        uint256 order = shareMarket.list(address(pool), 2, 0);
        vm.prank(DAVE);
        shareMarket.fill(order, 2);
        assertEq(pool.balanceOf(DAVE), 3);
        assertEq(mining.claimCalls(), claimsBefore);
        uint256 oldClaim = rewards.claimable(ALICE);
        _listSale(SALE_PRICE);
        _complete(NFT_BUYER, SALE_PRICE);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Closed));
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
        assertEq(rewards.claimable(ALICE), oldClaim);
        assertEq(mining.claimCalls(), claimsBefore);
        vm.prank(ALICE);
        rewards.claim();
        assertEq(bem.balanceOf(ALICE), oldClaim);
        assertGt(_withdraw(ALICE), 0);
    }
}
