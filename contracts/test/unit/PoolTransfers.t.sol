// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    ShareTransferTestBase,
    IShareTransferVault,
    ShareTransferVaultHarness
} from "../utils/ShareTransferTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract PoolTransfersTest is ShareTransferTestBase {
    function testFuzz_pendingRewardsBelongToOldSharesBeforeTransfer(uint8 sharesSeed) public {
        uint256 moved = bound(sharesSeed, 1, 49);
        _queueReward(10000);
        _transfer(ALICE, DAVE, moved);
        assertEq(rewards.claimable(ALICE), 4655);
        assertEq(rewards.claimable(DAVE), 0);
        assertEq(pool.balanceOf(ALICE), 49 - moved);
        assertEq(pool.balanceOf(DAVE), moved);
        _harvestReward(10000);
        assertEq(_claim(ALICE), (98 - moved) * 95);
        assertEq(_claim(DAVE), moved * 95);
        assertEq(_claim(BOB), 9310);
        assertEq(_claim(CAROL), 380);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(pool.totalSupply(), 100);
    }

    function test_zeroBalanceFormerMemberStillClaimsOldRewards() public {
        _queueReward(10000);
        _transfer(ALICE, DAVE, 49);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.memberCount(), 3);
        assertEq(_claim(ALICE), 4655);
        _harvestReward(10000);
        assertEq(rewards.claimable(ALICE), 0);
        assertEq(_claim(DAVE), 4655);
    }

    function test_sameEpochFractionStaysWithOriginalOwnerAcrossTransfers() public {
        _harvestReward(100);
        _transfer(ALICE, DAVE, 1);
        _harvestReward(100);
        _transfer(DAVE, ERIN, 1);
        (, uint256 daveAmount, uint256 daveFraction) = rewards.rewardSlot(DAVE, uint8(firstEpoch % 8));
        assertEq(daveAmount, 0);
        assertEq(daveFraction, 95 * P / 100);
        _harvestReward(100);
        _settle(ALICE);
        _settle(ERIN);
        assertEq(rewards.claimable(ALICE), 137); // 46.55 + 45.60 + 45.60
        assertEq(rewards.claimable(DAVE), 0);
        assertEq(rewards.claimable(ERIN), 0, "buyer cannot inherit seller's 0.95 fraction");
        (,, uint256 erinFraction) = rewards.rewardSlot(ERIN, uint8(firstEpoch % 8));
        assertEq(erinFraction, 95 * P / 100);
        assertEq(rewards.claimable(BOB), 139);
        assertEq(rewards.claimable(CAROL), 5);
    }

    function test_transferDoesNotRestartOldEpochExpiry() public {
        _harvestReward(10000);
        _atEpoch(firstEpoch + 6);
        _transfer(ALICE, DAVE, 49);
        _harvestReward(10000);
        assertEq(rewards.claimable(ALICE), 4655);
        assertEq(rewards.claimable(DAVE), 4655);
        _atEpoch(firstEpoch + 8);
        assertEq(rewards.claimable(ALICE), 0);
        assertEq(rewards.claimable(DAVE), 4655);
        rewards.burnExpired(firstEpoch);
        assertEq(rewards.epochBurned(firstEpoch), 9500);
        assertEq(_claim(DAVE), 4655);
        assertEq(rewards.bemAccounted(), 4845);
    }

    function test_disabledExpiryPreservesFractionsAcrossDaysAndOwnershipChanges() public {
        _disableExpiryForNewPool();
        _harvestReward(100);
        _transfer(ALICE, DAVE, 1);
        _atEpoch(firstEpoch + 1);
        _harvestReward(100);
        _transfer(DAVE, ALICE, 1);
        _atEpoch(firstEpoch + 2);
        _harvestReward(100);
        _atEpoch(firstEpoch + 30000);
        assertEq(_claim(ALICE), 138); // 46.55 + 45.60 + 46.55
        assertEq(_claim(BOB), 139);
        assertEq(_claim(CAROL), 5);
        assertEq(rewards.claimable(DAVE), 0);
        assertEq(rewards.bemAccounted(), 3);
    }

    function test_purchaseTimestampTransferCannotCarryOldBnbSurplus() public {
        uint256 purchaseTime = block.timestamp;
        _transfer(ALICE, DAVE, 49);
        assertEq(block.timestamp, purchaseTime);
        assertEq(pool.bnbOwed(ALICE), 0.735 ether);
        assertEq(pool.bnbOwed(DAVE), 0);
        _transfer(DAVE, ERIN, 1);
        assertEq(pool.bnbOwed(ERIN), 0);
        assertEq(pool.totalBnbOwed(), 1.5 ether);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - before, 0.735 ether);
        assertEq(pool.balanceOf(ALICE), 0);
    }

    function test_transferFromConsumesAllowanceAndMaintainsHolderCap() public {
        vm.prank(ALICE);
        pool.approve(FRANK, 10);
        vm.prank(FRANK);
        assertTrue(pool.transferFrom(ALICE, DAVE, 7));
        assertEq(pool.allowance(ALICE, FRANK), 3);
        assertEq(pool.balanceOf(ALICE), 42);
        assertEq(pool.balanceOf(DAVE), 7);
        vm.prank(FRANK);
        vm.expectRevert(abi.encodeWithSignature("ERC20InsufficientAllowance(address,uint256,uint256)", FRANK, 3, 4));
        pool.transferFrom(ALICE, DAVE, 4);
        vm.prank(ALICE);
        pool.approve(FRANK, type(uint256).max);
        vm.prank(FRANK);
        pool.transferFrom(ALICE, DAVE, 1);
        assertEq(pool.allowance(ALICE, FRANK), type(uint256).max);
    }

    function test_memberCheckpointsRecordExitEntryAndNewMemberCount() public {
        uint48 beforeTransfer = pool.clock();
        vm.warp(block.timestamp + 1);
        uint48 movedAt = pool.clock();
        _transfer(ALICE, DAVE, 49);
        _transfer(BOB, ERIN, 1);
        assertEq(pool.memberCount(), 4);
        vm.warp(block.timestamp + 1);
        assertEq(pool.getPastShares(ALICE, beforeTransfer), 49);
        assertEq(pool.getPastShares(DAVE, beforeTransfer), 0);
        assertEq(pool.getPastMemberCount(beforeTransfer), 3);
        assertEq(pool.getPastShares(ALICE, movedAt), 0);
        assertEq(pool.getPastShares(DAVE, movedAt), 49);
        assertEq(pool.getPastShares(ERIN, movedAt), 1);
        assertEq(pool.getPastMemberCount(movedAt), 4);
        address[] memory members = pool.activeMembers();
        for (uint256 i; i < members.length; ++i) {
            assertTrue(members[i] != ALICE);
        }
    }

    function test_zeroOverCapAndMarketDestinationRejected() public {
        vm.startPrank(ALICE);
        vm.expectRevert(IPoolVault.InvalidShareCount.selector);
        pool.transfer(DAVE, 0);
        vm.expectRevert(IPoolVault.ShareOutOfRange.selector);
        pool.transfer(DAVE, 50);
        vm.expectRevert(IPoolVault.ShareOutOfRange.selector);
        pool.transfer(BOB, 1);
        _expectError("MarketCannotHoldShares()");
        pool.transfer(address(shareMarket), 1);
        vm.stopPrank();
        assertEq(pool.totalSupply(), 100);
    }

    function test_selfTransferRespectsUnlockedBalanceWithoutArtificiallyExceedingCap() public {
        _queueReward(10000);
        _transfer(ALICE, ALICE, 49);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.memberCount(), 3);
        assertEq(rewards.claimable(ALICE), 4655);
        vm.prank(ALICE);
        shareMarket.list(address(pool), 1, 0);
        vm.prank(ALICE);
        _expectError("InsufficientUnlockedShares()");
        pool.transfer(ALICE, 49);
    }

    function test_lockedSharesRemainSellerPropertyAndCannotBeTransferredOrdinarily() public {
        vm.prank(ALICE);
        uint256 order = shareMarket.list(address(pool), 20, 0);
        assertEq(_shareVault().lockedShares(ALICE), 20);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(address(shareMarket)), 0);
        assertEq(pool.memberCount(), 3);
        _harvestReward(10000);
        assertEq(rewards.claimable(ALICE), 4655);
        vm.prank(ALICE);
        pool.approve(FRANK, 49);
        vm.prank(FRANK);
        _expectError("InsufficientUnlockedShares()");
        pool.transferFrom(ALICE, DAVE, 30);
        assertEq(pool.allowance(ALICE, FRANK), 49);
        _transfer(ALICE, DAVE, 29);
        vm.prank(ALICE);
        _expectError("InsufficientUnlockedShares()");
        pool.transfer(ERIN, 1);
        vm.prank(DAVE);
        shareMarket.fill(order, 20); // Buyer's final real holding is 49, including all former locks.
        assertEq(pool.balanceOf(DAVE), 49);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(_shareVault().lockedShares(ALICE), 0);
    }

    function test_onlyRegisteredMarketCanChangeLocksOrTransferLockedShares() public {
        IShareTransferVault vault = _shareVault();
        vm.startPrank(ALICE);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        vault.lock(ALICE, 1);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        vault.unlock(ALICE, 1);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        vault.transferLocked(ALICE, DAVE, 1);
        vm.stopPrank();
    }

    function test_lockDoesNotProvideASecondFortyNineShareAllowance() public {
        vm.prank(BOB);
        shareMarket.list(address(pool), 49, 0);
        vm.prank(ALICE);
        uint256 aliceOrder = shareMarket.list(address(pool), 1, 0);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.ShareOutOfRange.selector);
        shareMarket.fill(aliceOrder, 1);
        assertEq(pool.balanceOf(BOB), 49);
        assertEq(_shareVault().lockedShares(BOB), 49);
        assertEq(_shareVault().lockedShares(ALICE), 1);
    }

    function testFuzz_failedStrictClaimRollsBackTransferAndAllowance(uint8 faultSeed) public {
        uint8 fault = uint8(bound(faultSeed, 1, 3));
        mining.configure(address(nft), rewardId, 1000, 9000);
        mining.setClaimFault(fault);
        vm.prank(ALICE);
        pool.approve(FRANK, 10);
        vm.prank(FRANK);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        pool.transferFrom(ALICE, DAVE, 10);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(DAVE), 0);
        assertEq(pool.allowance(ALICE, FRANK), 10);
        assertEq(pool.memberCount(), 3);
        assertEq(mining.pending(key), 1000);
        assertEq(mining.unreported(key), 9000);
        assertEq(bem.totalSupply(), 0);
        assertEq(rewards.bemAccounted(), 0);
    }

    function test_miningClaimCannotReenterApprovedTransferFrom() public {
        vm.startPrank(ALICE);
        pool.approve(address(mining), 20);
        pool.approve(FRANK, 1);
        vm.stopPrank();
        _queueReward(10000);
        mining.setClaimReentry(address(pool), abi.encodeCall(IERC20.transferFrom, (ALICE, ERIN, 1)));
        vm.prank(FRANK);
        pool.transferFrom(ALICE, DAVE, 1);
        assertTrue(mining.reentryAttempted());
        assertFalse(mining.reentrySucceeded());
        assertEq(mining.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(pool.allowance(ALICE, address(mining)), 20);
        assertEq(pool.balanceOf(ALICE), 48);
        assertEq(pool.balanceOf(DAVE), 1);
        assertEq(pool.balanceOf(ERIN), 0);
        assertEq(rewards.claimable(ALICE), 4655);
    }

    function test_listedAndClosedOrdinaryTransfersFailWithoutMovingShares() public {
        uint256 snapshot = vm.snapshotState();
        ShareTransferVaultHarness(payable(address(pool))).fixtureSetListed();
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.transfer(DAVE, 1);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(DAVE), 0);
        assertTrue(vm.revertToState(snapshot));
        ShareTransferVaultHarness(payable(address(pool))).fixtureSetTerminalState(IPoolVault.State.Closed);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.transfer(DAVE, 1);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(DAVE), 0);
    }
}
