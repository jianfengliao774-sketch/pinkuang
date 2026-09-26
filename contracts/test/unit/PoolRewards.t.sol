// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Vm} from "forge-std/Vm.sol";
import {RewardsTestBase, RewardsVaultHarness, IRewardsVault, IRewardsFactory} from "../utils/RewardsTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract PoolRewardsTest is RewardsTestBase {
    function test_onePercentFeeAndNinetyNinePercentMembersWithNoBurn() public {
        assertFalse(rewards.expiryEnabled());
        _harvestReward(1e8);
        assertEq(bem.balanceOf(TREASURY), 1000000);
        assertEq(bem.balanceOf(DEAD), 0);
        assertEq(_claim(ALICE), 48510000);
        assertEq(_claim(BOB), 48510000);
        assertEq(_claim(CAROL), 1980000);
        assertEq(rewards.bemAccounted(), 0);
        rewards.harvest();
        assertEq(bem.balanceOf(TREASURY), 1000000);
    }

    function test_claimDoesNotHarvestEvenWhenPendingMiningExists() public {
        _harvestReward(10000);
        _queueReward(50000);
        mining.setClaimFault(1);
        uint256 calls = mining.claimCalls();
        nft.forceTransfer(address(0xB00B), rewardId);
        assertEq(_claim(ALICE), 4851);
        assertEq(mining.claimCalls(), calls);
        assertEq(mining.unreported(key), 50000);
        assertEq(rewards.bemAccounted(), 5049);
    }

    function test_unbookedRewardIsNotPayableUntilExplicitHarvest() public {
        _queueReward(10000);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        rewards.claim();
        assertEq(mining.unreported(key), 10000);
        rewards.harvest();
        assertEq(_claim(ALICE), 4851);
    }

    function test_permanentRewardsAndFractionsSurviveThirtyThousandDays() public {
        _harvestReward(100);
        _settle(ALICE);
        assertEq(rewards.totalGlobalRemainderScaled(), 51 * P / 100);
        _atEpoch(firstEpoch + 1);
        _harvestReward(100);
        _settle(ALICE);
        assertEq(rewards.bemOwed(ALICE), 97);
        assertEq(rewards.totalGlobalRemainderScaled(), 2 * P / 100);
        _atEpoch(firstEpoch + 30000);
        uint256 gasBefore = gasleft();
        assertEq(_claim(ALICE), 97);
        assertLt(gasBefore - gasleft(), 500000);
        assertEq(_claim(BOB), 97);
        assertEq(_claim(CAROL), 3);
        assertEq(rewards.bemAccounted(), 1);
        vm.expectRevert(IPoolVault.BurnDisabled.selector);
        rewards.burnExpired(firstEpoch);
        assertEq(bem.balanceOf(DEAD), 0);
    }

    function test_newBookedRewardsCanBeClaimedAgainInTheSameSecond() public {
        _harvestReward(10000);
        uint256 at = block.timestamp;
        assertEq(_claim(ALICE), 4851);
        _harvestReward(10000);
        assertEq(block.timestamp, at);
        assertEq(_claim(ALICE), 4851);
        assertEq(bem.balanceOf(ALICE), 9702);
        assertEq(rewards.lastClaimAt(ALICE), at);
        assertEq(rewards.claimable(ALICE), 0);
        assertEq(rewards.bemAccounted(), 10098);
    }

    function test_emptyClaimDoesNotChangeLastSuccessfulTimeOrAccounting() public {
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        rewards.claim();
        assertEq(rewards.lastClaimAt(ALICE), 0);
        _harvestReward(10000);
        assertEq(_claim(ALICE), 4851);
        uint64 paidAt = rewards.lastClaimAt(ALICE);
        uint256 reserved = rewards.bemAccounted();
        vm.warp(block.timestamp + 1);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        rewards.claim();
        assertEq(rewards.lastClaimAt(ALICE), paidAt);
        assertEq(rewards.bemAccounted(), reserved);
        assertEq(bem.balanceOf(ALICE), 4851);
    }

    function test_feeFailureRollsBackAndDeadRejectionHasNoEffect() public {
        _queueReward(10000);
        bem.rejectRecipient(TREASURY);
        vm.expectRevert();
        rewards.harvest();
        assertEq(rewards.bemAccounted(), 0);
        assertEq(mining.unreported(key), 10000);
        bem.rejectRecipient(DEAD);
        rewards.harvest();
        assertEq(rewards.bemAccounted(), 9900);
        assertEq(bem.balanceOf(DEAD), 0);
    }

    function test_legacyExpiryParameterCannotEnableForfeitureInNewPool() public {
        vm.prank(OPERATOR);
        address fresh = IRewardsFactory(address(poolFactory)).createPoolWithExpiry(defaultParams, true);
        assertFalse(IRewardsVault(fresh).expiryEnabled());
        vm.prank(address(poolFactory));
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        IPoolVault(fresh).configureExpiry(true);
    }

    function test_miningClaimChangingOwnerRollsBackEntireHarvest() public {
        _queueReward(10000);
        mining.setClaimFault(4);
        vm.expectRevert(IPoolVault.NotOwnerAfterBuy.selector);
        rewards.harvest();
        assertEq(nft.ownerOf(rewardId), address(pool));
        assertEq(mining.unreported(key), 10000);
        assertEq(rewards.epochNet(firstEpoch), 0);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(bem.totalSupply(), 0);
    }

    function test_ordinaryClaimFailureStillAccountsIndependentDirectReceipt() public {
        mining.setClaimFault(1);
        _donate(10000);
        vm.recordLogs();
        rewards.harvest();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 failures;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pool) && logs[i].topics[0] == keccak256("MiningClaimFailed(bytes32,bytes)"))
            {
                assertEq(logs[i].topics[1], key);
                assertEq(
                    abi.decode(logs[i].data, (bytes)), abi.encodeWithSignature("Error(string)", "injected claim revert")
                );
                ++failures;
            }
        }
        assertEq(failures, 1, "ordinary failed protocol claims must be observable");
        assertEq(rewards.epochNet(firstEpoch), 0);
        assertEq(_claim(ALICE), 4851);
        assertEq(bem.balanceOf(TREASURY), 100);
    }

    function testFuzz_harnessStrictHarvestRejectsFailedOrUnsettledClaimWithoutCharging(uint8 fault) public {
        fault = uint8(bound(fault, 1, 3)); // Revert, pending remains, or reward diverted away from Vault.
        mining.configure(address(nft), rewardId, 1000, 9000);
        mining.setClaimFault(fault);
        _donate(5000);
        uint256 callsBefore = mining.claimCalls();
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        RewardsVaultHarness(payable(address(pool))).strictHarvest();
        assertEq(mining.claimCalls(), callsBefore);
        assertEq(mining.pending(key), 1000);
        assertEq(mining.unreported(key), 9000);
        assertEq(bem.balanceOf(address(pool)), 5000);
        assertEq(bem.totalSupply(), 5000, "strict failure must roll back minted and diverted rewards");
        assertEq(bem.balanceOf(TREASURY), 0);
        assertEq(bem.balanceOf(DEAD), 0);
        assertEq(rewards.epochNet(firstEpoch), 0);
        assertEq(rewards.bemAccounted(), 0);
    }

    function test_harnessStrictHarvestSuccessfullyAccountsActualReceipt() public {
        mining.configure(address(nft), rewardId, 1000, 9000);
        _donate(5000);
        uint256 callsBefore = mining.claimCalls();
        (uint256 gross, uint256 fee, uint256 burned, uint256 net) =
            RewardsVaultHarness(payable(address(pool))).strictHarvest();
        assertEq(gross, 15000);
        assertEq(fee, 150);
        assertEq(burned, 0);
        assertEq(net, 14850);
        assertEq(mining.claimCalls(), callsBefore + 1);
        assertEq(mining.pending(key), 0);
        assertEq(mining.unreported(key), 0);
        assertEq(nft.ownerOf(rewardId), address(pool));
        assertEq(rewards.epochNet(firstEpoch), 0);
        assertEq(rewards.bemAccounted(), 14850);
        assertEq(bem.balanceOf(TREASURY), 150);
        assertEq(bem.balanceOf(DEAD), 0);
        _stateIs(IPoolVault.State.Active); // No sale or ownership handover is claimed by this harness test.
    }

    function test_harnessClosedStatePaysNewBookedRewardImmediatelyWithoutMining() public {
        _harvestReward(10000);
        _claim(ALICE);
        uint64 claimedAt = rewards.lastClaimAt(ALICE);
        _harvestReward(10000);
        RewardsVaultHarness(payable(address(pool))).fixtureSetTerminalState(IPoolVault.State.Closed);
        mining.setClaimFault(1);
        nft.forceTransfer(address(0xB00B), rewardId);
        uint256 callsBefore = mining.claimCalls();
        assertEq(block.timestamp, claimedAt);
        assertEq(_claim(ALICE), 4851);
        assertEq(bem.balanceOf(ALICE), 9702);
        assertEq(rewards.lastClaimAt(ALICE), claimedAt);
        assertEq(mining.claimCalls(), callsBefore);
        vm.warp(block.timestamp + 1);
        vm.prank(ALICE);
        _expectError("NothingToClaim()");
        rewards.claim();
        assertEq(rewards.lastClaimAt(ALICE), claimedAt);
        assertEq(mining.claimCalls(), callsBefore);
    }

    function test_harnessClosedWithExpiryDisabledKeepsRewardsForYears() public {
        _disableExpiryForNewPool();
        _harvestReward(10000);
        RewardsVaultHarness(payable(address(pool))).fixtureSetTerminalState(IPoolVault.State.Closed);
        mining.setClaimFault(1);
        nft.forceTransfer(address(0xB00B), rewardId);
        uint256 callsBefore = mining.claimCalls();
        _atEpoch(firstEpoch + 30000);
        assertEq(_claim(ALICE), 4851);
        assertEq(_claim(BOB), 4851);
        assertEq(_claim(CAROL), 198);
        assertEq(mining.claimCalls(), callsBefore);
        assertEq(rewards.bemAccounted(), 0);
    }

    function test_failedMemberTransferPreservesDebtAndClaimTime() public {
        _harvestReward(10000);
        bem.rejectRecipient(ALICE);
        vm.prank(ALICE);
        vm.expectRevert();
        rewards.claim();
        assertEq(rewards.claimable(ALICE), 4851);
        assertEq(rewards.epochPaid(firstEpoch), 0);
        assertEq(rewards.lastClaimAt(ALICE), 0);
        assertEq(rewards.bemAccounted(), 9900);
        bem.rejectRecipient(address(0));
        assertEq(_claim(ALICE), 4851);
    }

    function test_miningClaimCannotReenterHarvest() public {
        _queueReward(10000);
        mining.setClaimReentry(address(pool), abi.encodeCall(IRewardsVault.harvest, ()));
        rewards.harvest();
        assertTrue(mining.reentryAttempted());
        assertFalse(mining.reentrySucceeded());
        assertEq(mining.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(rewards.epochNet(firstEpoch), 0);
    }

    function test_bemTransferCannotReenterHarvest() public {
        _queueReward(10000);
        bem.setTransferReentry(address(pool), abi.encodeCall(IRewardsVault.harvest, ()));
        rewards.harvest();
        assertTrue(bem.reentryAttempted());
        assertFalse(bem.reentrySucceeded());
        assertEq(bem.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(rewards.epochNet(firstEpoch), 0);
        assertEq(bem.balanceOf(TREASURY), 100);
    }
}
