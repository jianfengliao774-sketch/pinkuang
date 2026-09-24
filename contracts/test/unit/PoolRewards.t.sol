// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {RewardsTestBase, RewardsVaultHarness, IRewardsVault, IRewardsFactory} from "../utils/RewardsTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract PoolRewardsTest is RewardsTestBase {
    function test_oneBemSpecificationExampleAndAllMembersConserve() public {
        assertTrue(rewards.expiryEnabled());
        vm.recordLogs();
        _harvestReward(1e8);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 matches;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(pool)
                    && logs[i].topics[0] == keccak256("Harvested(uint256,uint256,uint256,uint256)")
            ) {
                (uint256 gross, uint256 fee, uint256 burned, uint256 net) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                assertEq(gross, 100000000);
                assertEq(fee, 1000000);
                assertEq(burned, 4000000);
                assertEq(net, 95000000);
                ++matches;
            }
        }
        assertEq(matches, 1);
        assertEq(bem.balanceOf(TREASURY), 1000000);
        assertEq(bem.balanceOf(DEAD), 4000000);
        assertEq(rewards.accBemPerShare(), 950000 * P);
        assertEq(rewards.epochNet(firstEpoch), 95000000);
        assertEq(rewards.claimable(ALICE), 46550000);
        assertEq(rewards.claimable(BOB), 46550000);
        assertEq(rewards.claimable(CAROL), 1900000);
        assertEq(_claim(ALICE), 46550000);
        assertEq(_claim(BOB), 46550000);
        assertEq(_claim(CAROL), 1900000);
        assertEq(rewards.epochPaid(firstEpoch), 95000000);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(bem.balanceOf(address(pool)), 0);
    }

    function test_twoOneBemHarvestsAccumulateWithoutChargingOldBalancesAgain() public {
        _harvestReward(1e8);
        assertEq(_claim(ALICE), 46550000);
        _harvestReward(1e8);
        assertEq(bem.balanceOf(TREASURY), 2000000);
        assertEq(bem.balanceOf(DEAD), 8000000);
        assertEq(rewards.epochNet(firstEpoch), 190000000);
        assertEq(rewards.claimable(ALICE), 46550000);
        assertEq(rewards.claimable(BOB), 93100000);
        assertEq(rewards.claimable(CAROL), 3800000);
        vm.warp(block.timestamp + 1 days);
        assertEq(_claim(ALICE), 46550000);
        assertEq(_claim(BOB), 93100000);
        assertEq(_claim(CAROL), 3800000);
        rewards.harvest();
        assertEq(bem.balanceOf(TREASURY), 2000000);
        assertEq(bem.balanceOf(DEAD), 8000000);
        assertEq(rewards.bemAccounted(), 0);
    }

    function test_sameEpochMultipleSettlementsPreserveFractionalRemainder() public {
        _harvestReward(100); // net 95, Alice owns 46.55 minimum units.
        _settle(ALICE);
        (uint32 e, uint256 amount, uint256 remainder) = rewards.rewardSlot(ALICE, uint8(firstEpoch % 8));
        assertEq(e, firstEpoch);
        assertEq(amount, 46);
        assertEq(remainder, 55 * P / 100);
        assertEq(rewards.epochRemainderScaled(firstEpoch), 55 * P / 100);
        _harvestReward(100);
        _settle(ALICE);
        (, amount, remainder) = rewards.rewardSlot(ALICE, uint8(firstEpoch % 8));
        assertEq(amount, 93, "settlement frequency must not turn 93.10 into 46 + 46");
        assertEq(remainder, 10 * P / 100);
        assertEq(
            rewards.epochRemainderScaled(firstEpoch),
            10 * P / 100,
            "replace known fraction, do not accumulate old residue"
        );
        _settle(ALICE);
        assertEq(rewards.claimable(ALICE), 93);
        assertEq(_claim(ALICE), 93);
        (, amount, remainder) = rewards.rewardSlot(ALICE, uint8(firstEpoch % 8));
        assertEq(amount, 0);
        assertEq(remainder, 10 * P / 100, "claim cannot discard the same epoch's fractional residue");
        assertEq(rewards.epochRemainderScaled(firstEpoch), 10 * P / 100);
        assertEq(_claim(BOB), 93);
        assertEq(rewards.epochRemainderScaled(firstEpoch), 20 * P / 100);
        assertEq(_claim(CAROL), 3);
        assertEq(rewards.epochRemainderScaled(firstEpoch), P, "0.10 + 0.10 + 0.80 are known fractions, not extra debt");
        assertEq(rewards.bemAccounted(), 1);
    }

    function test_expiringBatchesDoNotCarryFractionAcrossEpochs() public {
        _harvestReward(100);
        _settle(ALICE);
        _atEpoch(firstEpoch + 1);
        _harvestReward(100);
        _settle(ALICE);
        assertEq(rewards.claimable(ALICE), 92, "46.55 in each epoch remains 46 per original batch");
        assertEq(_claim(ALICE), 92);
        assertEq(_claim(BOB), 92);
        assertEq(_claim(CAROL), 2);
        assertEq(rewards.bemAccounted(), 4);
    }

    function test_ringOverwritePreservesExpiredGlobalLiabilityAndNewRewards() public {
        _harvestReward(10001); // Net 9501: Alice and Bob each identify a 0.49-unit fraction.
        assertEq(_claim(ALICE), 4655);
        _settle(BOB); // Materialize an unpaid old slot, exactly as a future share transfer would.
        assertEq(rewards.epochRemainderScaled(firstEpoch), 98 * P / 100);
        _atEpoch(firstEpoch + 8);
        _harvestReward(20000);
        _settle(BOB);
        (uint32 e, uint256 amount,) = rewards.rewardSlot(BOB, uint8(firstEpoch % 8));
        assertEq(e, firstEpoch + 8);
        assertEq(amount, 9310);
        assertEq(
            rewards.epochRemainderScaled(firstEpoch),
            98 * P / 100,
            "overwriting a cache retains identified historical fractions"
        );
        assertEq(rewards.epochNet(firstEpoch), 9501);
        assertEq(rewards.epochPaid(firstEpoch), 4655);
        rewards.burnExpired(firstEpoch);
        assertEq(rewards.epochBurned(firstEpoch), 4846);
        assertEq(
            rewards.epochRemainderScaled(firstEpoch),
            98 * P / 100,
            "burn retains the audit counter without recreating liability"
        );
        assertEq(_claim(BOB), 9310);
        assertEq(_claim(ALICE), 9310);
        assertEq(_claim(CAROL), 380);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(bem.balanceOf(DEAD), 400 + 800 + 4846);
    }

    function test_allEightLiveEpochsIncludedBeforeExactExpiry() public {
        for (uint32 i; i < 8; ++i) {
            _atEpoch(firstEpoch + i);
            _harvestReward(10000);
        }
        vm.warp(uint256(firstEpoch + 8) * 1 days - 1);
        assertEq(rewards.claimable(ALICE), 8 * 4655);
        assertEq(_claim(ALICE), 8 * 4655);
        _expectError("EpochNotExpired()");
        rewards.burnExpired(firstEpoch);
        vm.warp(uint256(firstEpoch + 8) * 1 days);
        assertEq(rewards.claimable(BOB), 7 * 4655);
        rewards.burnExpired(firstEpoch);
        assertEq(rewards.epochBurned(firstEpoch), 4845);
        assertEq(_claim(BOB), 7 * 4655);
    }

    function test_longGapRecordsOnlyActualCurrentReceiptWithoutInventingPastDays() public {
        _harvestReward(10000);
        _settle(ALICE);
        _atEpoch(firstEpoch + 30000);
        uint256 beforeGas = gasleft();
        _harvestReward(20000);
        uint256 received = _claim(ALICE);
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("harvest and claim after 30000 empty days", used);
        assertLt(used, 2000000, "empty days must not cause an unbounded daily loop");
        assertEq(received, 9310);
        assertEq(rewards.epochNet(firstEpoch + 1), 0);
        assertEq(rewards.epochNet(firstEpoch + 29999), 0);
        assertEq(rewards.epochNet(firstEpoch + 30000), 19000);
        assertEq(rewards.epochNet(firstEpoch), 9500);
        rewards.burnExpired(firstEpoch);
        assertEq(rewards.epochBurned(firstEpoch), 9500);
        assertEq(rewards.claimable(BOB), 9310);
    }

    function test_burnIncludesBatchDustAndCannotChargeAgain() public {
        _harvestReward(100); // Net 95; 46 + 46 + 1 leaves two units of rounding dust.
        assertEq(_claim(ALICE), 46);
        assertEq(_claim(BOB), 46);
        assertEq(_claim(CAROL), 1);
        assertEq(rewards.bemAccounted(), 2);
        assertEq(rewards.epochRemainderScaled(firstEpoch), 2 * P);
        _atEpoch(firstEpoch + 8);
        rewards.burnExpired(firstEpoch);
        assertEq(rewards.epochBurned(firstEpoch), 2);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(
            rewards.epochRemainderScaled(firstEpoch),
            2 * P,
            "historical known fractions survive burning, but are not owed twice"
        );
        assertEq(bem.balanceOf(DEAD), 6);
        _expectError("EpochAlreadyBurned()");
        rewards.burnExpired(firstEpoch);
        rewards.harvest();
        assertEq(bem.balanceOf(TREASURY), 1);
        assertEq(bem.balanceOf(DEAD), 6);
        _harvestReward(100);
        assertEq(rewards.epochNet(firstEpoch + 8), 95);
        assertEq(rewards.bemAccounted(), 95);
        assertEq(bem.balanceOf(TREASURY), 2);
        assertEq(bem.balanceOf(DEAD), 10);
    }

    function test_cumulativeDustMayExceedSingleDivisionBound() public {
        for (uint32 i; i < 52; ++i) {
            _atEpoch(firstEpoch + i);
            _harvestReward(100);
            _settle(ALICE);
            _settle(BOB);
            _settle(CAROL);
        }
        for (uint32 i; i < 44; ++i) {
            rewards.burnExpired(firstEpoch + i);
        }
        assertEq(_claim(ALICE), 8 * 46);
        assertEq(_claim(BOB), 8 * 46);
        assertEq(_claim(CAROL), 8);
        uint256 paid = bem.balanceOf(ALICE) + bem.balanceOf(BOB) + bem.balanceOf(CAROL);
        uint256 expiryBurned = 44 * 95;
        uint256 heldDust = 8 * 2;
        assertEq(paid + expiryBurned + heldDust, 52 * 95);
        uint256 cumulativeDust;
        for (uint32 i; i < 52; ++i) {
            uint256 net = rewards.epochNet(firstEpoch + i);
            cumulativeDust += net - (net * 49 / 100) * 2 - net * 2 / 100;
        }
        assertEq(cumulativeDust, 104, "cumulative per-epoch dust is not bounded by one division's denominator");
        assertEq(rewards.bemAccounted(), heldDust);
        assertEq(bem.balanceOf(DEAD), 52 * 4 + expiryBurned);
    }

    function test_firstClaimImmediateThenExactTwentyFourHourBoundary() public {
        uint256 t = block.timestamp;
        assertEq(rewards.lastClaimAt(ALICE), 0);
        _harvestReward(1e8);
        assertEq(_claim(ALICE), 46550000);
        assertEq(rewards.lastClaimAt(ALICE), t);
        _queueReward(1e8);
        vm.warp(t + 1 days - 1);
        vm.prank(ALICE);
        _expectError("ClaimTooSoon()");
        rewards.claim();
        assertEq(mining.unreported(key), 1e8, "failed claim rolls back its preliminary harvest");
        assertEq(rewards.lastClaimAt(ALICE), t);
        vm.warp(t + 1 days);
        assertEq(_claim(ALICE), 46550000);
        assertEq(rewards.lastClaimAt(ALICE), t + 1 days);
    }

    function test_zeroClaimDoesNotStartCooldownAndOtherUsersDoNotResetIt() public {
        vm.prank(ALICE);
        _expectError("NothingToClaim()");
        rewards.claim();
        assertEq(rewards.lastClaimAt(ALICE), 0);
        _harvestReward(10000);
        assertEq(_claim(ALICE), 4655);
        uint64 claimedAt = rewards.lastClaimAt(ALICE);
        vm.warp(block.timestamp + 100);
        assertEq(_claim(BOB), 4655);
        rewards.harvest();
        assertEq(rewards.lastClaimAt(ALICE), claimedAt);
        vm.warp(uint256(claimedAt) + 1 days);
        vm.prank(ALICE);
        _expectError("NothingToClaim()");
        rewards.claim();
        assertEq(rewards.lastClaimAt(ALICE), claimedAt);
    }

    function test_bnbSurplusWithdrawalNotBlockedByBemCooldown() public {
        _harvestReward(10000);
        _claim(ALICE);
        uint256 beforeBalance = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - beforeBalance, 0.735 ether);
    }

    function test_directBemAndExternalMiningClaimAreRecognizedExactlyOnce() public {
        _donate(40000000);
        _queueReward(60000000);
        vm.prank(address(0x9999));
        mining.claim(key); // Protocol pays the NFT owner even when an outsider calls it.
        assertEq(bem.balanceOf(address(pool)), 1e8);
        assertEq(rewards.bemAccounted(), 0);
        vm.prank(address(0x8888));
        rewards.harvest();
        assertEq(rewards.epochNet(firstEpoch), 95000000);
        assertEq(rewards.bemAccounted(), 95000000);
        rewards.harvest();
        assertEq(bem.balanceOf(TREASURY), 1000000);
        assertEq(bem.balanceOf(DEAD), 4000000);
        assertEq(rewards.epochNet(firstEpoch), 95000000);
    }

    function test_directReceiptUsesAccountingEpochAfterLongIdlePeriod() public {
        _donate(10000);
        _atEpoch(firstEpoch + 90);
        rewards.harvest();
        assertEq(rewards.epochNet(firstEpoch), 0);
        assertEq(rewards.epochNet(firstEpoch + 90), 9500);
        assertEq(_claim(ALICE), 4655);
    }

    function test_feeRoundingIsPerHarvestNotRecomputedFromLifetimeGross() public {
        uint256 snapshot = vm.snapshotState();
        _harvestReward(100);
        assertEq(rewards.epochNet(firstEpoch), 95);
        assertEq(bem.balanceOf(TREASURY), 1);
        assertEq(bem.balanceOf(DEAD), 4);
        assertTrue(vm.revertToState(snapshot));
        for (uint256 i; i < 100; ++i) {
            _harvestReward(1);
        }
        assertEq(rewards.epochNet(firstEpoch), 100);
        assertEq(bem.balanceOf(TREASURY), 0);
        assertEq(bem.balanceOf(DEAD), 0);
        assertEq(_claim(ALICE), 49);
        assertEq(_claim(BOB), 49);
        assertEq(_claim(CAROL), 2);
    }

    function test_expiryDisabledKeepsOldRewardsAndGlobalFractionalCarry() public {
        _disableExpiryForNewPool();
        _harvestReward(100);
        _settle(ALICE);
        assertEq(rewards.totalGlobalRemainderScaled(), 55 * P / 100);
        _atEpoch(firstEpoch + 1);
        _harvestReward(100);
        _settle(ALICE);
        assertEq(rewards.totalGlobalRemainderScaled(), 10 * P / 100, "global carry replaces the prior fraction");
        _atEpoch(firstEpoch + 30000);
        assertEq(rewards.claimable(ALICE), 93);
        assertEq(rewards.bemOwed(ALICE), 93);
        assertEq(_claim(ALICE), 93);
        assertEq(rewards.totalGlobalRemainderScaled(), 10 * P / 100);
        assertEq(_claim(BOB), 93);
        assertEq(rewards.totalGlobalRemainderScaled(), 20 * P / 100);
        assertEq(_claim(CAROL), 3);
        assertEq(rewards.totalGlobalRemainderScaled(), P);
        assertEq(rewards.bemAccounted(), 1);
        _expectError("ExpiryDisabled()");
        rewards.burnExpired(firstEpoch);
    }

    function test_expiryDisabledSampleStillSplitsNinetyFiveFourOne() public {
        _disableExpiryForNewPool();
        _harvestReward(1e8);
        _atEpoch(firstEpoch + 1000);
        assertEq(_claim(ALICE), 46550000);
        assertEq(_claim(BOB), 46550000);
        assertEq(_claim(CAROL), 1900000);
        assertEq(bem.balanceOf(TREASURY), 1000000);
        assertEq(bem.balanceOf(DEAD), 4000000);
        assertEq(rewards.bemAccounted(), 0);
    }

    function test_expiryCanOnlyBeConfiguredOnceDuringFactoryCreation() public {
        assertTrue(rewards.expiryEnabled(), "legacy createPool defaults to expiry enabled");
        IPoolVault freshFunding = IPoolVault(address(_createPool(defaultParams)));
        address[3] memory unauthorized = [OWNER, OPERATOR, address(0x9999)];
        for (uint256 i; i < unauthorized.length; ++i) {
            vm.prank(unauthorized[i]);
            vm.expectRevert(IPoolVault.Unauthorized.selector);
            freshFunding.configureExpiry(false);
        }
        vm.prank(address(poolFactory));
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        freshFunding.configureExpiry(false);
        assertTrue(IRewardsVault(address(freshFunding)).expiryEnabled());
        assertTrue(rewards.expiryEnabled());
        vm.prank(OPERATOR);
        address disabledFunding = IRewardsFactory(address(poolFactory)).createPoolWithExpiry(defaultParams, false);
        vm.prank(address(poolFactory));
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        IPoolVault(disabledFunding).configureExpiry(true);
        assertFalse(IRewardsVault(disabledFunding).expiryEnabled());
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
        assertEq(rewards.epochNet(firstEpoch), 9500);
        assertEq(_claim(ALICE), 4655);
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
        assertEq(burned, 600);
        assertEq(net, 14250);
        assertEq(mining.claimCalls(), callsBefore + 1);
        assertEq(mining.pending(key), 0);
        assertEq(mining.unreported(key), 0);
        assertEq(nft.ownerOf(rewardId), address(pool));
        assertEq(rewards.epochNet(firstEpoch), 14250);
        assertEq(rewards.bemAccounted(), 14250);
        assertEq(bem.balanceOf(TREASURY), 150);
        assertEq(bem.balanceOf(DEAD), 600);
        _stateIs(IPoolVault.State.Active); // No sale or ownership handover is claimed by this harness test.
    }

    function testFuzz_harnessTerminalStateKeepsHistoricalClaimsAndOriginalExpiry(bool refunding) public {
        _harvestReward(10000);
        _queueReward(50000);
        _atEpoch(firstEpoch + 6);
        IPoolVault.State terminal = refunding ? IPoolVault.State.Refunding : IPoolVault.State.Closed;
        RewardsVaultHarness(payable(address(pool))).fixtureSetTerminalState(terminal);
        mining.setClaimFault(1);
        nft.forceTransfer(address(0xB00B), rewardId); // A transferred NFT must never be queried/harvested by claim.
        uint256 callsBefore = mining.claimCalls();
        assertEq(_claim(ALICE), 4655);
        assertEq(mining.claimCalls(), callsBefore);
        assertEq(mining.unreported(key), 50000);
        assertEq(rewards.epochNet(firstEpoch), 9500);
        assertEq(rewards.epochNet(firstEpoch + 6), 0);
        assertEq(rewards.lastClaimAt(ALICE), block.timestamp);
        vm.warp(uint256(firstEpoch + 8) * 1 days);
        assertEq(rewards.claimable(BOB), 0, "entering a terminal state cannot restart the seven-day expiry");
        vm.prank(BOB);
        _expectError("NothingToClaim()");
        rewards.claim();
        rewards.burnExpired(firstEpoch);
        assertEq(rewards.epochBurned(firstEpoch), 4845);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(mining.claimCalls(), callsBefore);
        _stateIs(terminal);
    }

    function test_harnessClosedStatePreservesExistingClaimCooldown() public {
        _harvestReward(10000);
        _claim(ALICE);
        uint64 claimedAt = rewards.lastClaimAt(ALICE);
        _harvestReward(10000);
        RewardsVaultHarness(payable(address(pool))).fixtureSetTerminalState(IPoolVault.State.Closed);
        mining.setClaimFault(1);
        nft.forceTransfer(address(0xB00B), rewardId);
        uint256 callsBefore = mining.claimCalls();
        vm.prank(ALICE);
        _expectError("ClaimTooSoon()");
        rewards.claim();
        assertEq(rewards.lastClaimAt(ALICE), claimedAt);
        vm.warp(uint256(claimedAt) + 1 days);
        assertEq(_claim(ALICE), 4655);
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
        assertEq(_claim(ALICE), 4655);
        assertEq(_claim(BOB), 4655);
        assertEq(_claim(CAROL), 190);
        assertEq(mining.claimCalls(), callsBefore);
        assertEq(rewards.bemAccounted(), 0);
    }

    function testFuzz_failedFeeOrBurnTransferRollsBackHarvest(bool failBurn) public {
        _queueReward(10000);
        bem.rejectRecipient(failBurn ? DEAD : TREASURY);
        vm.expectRevert();
        rewards.harvest();
        assertEq(mining.unreported(key), 10000);
        assertEq(rewards.epochNet(firstEpoch), 0);
        assertEq(rewards.accBemPerShare(), 0);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(bem.balanceOf(address(pool)), 0);
        assertEq(bem.balanceOf(TREASURY), 0);
        assertEq(bem.balanceOf(DEAD), 0);
    }

    function test_failedMemberTransferPreservesDebtAndClaimTime() public {
        _harvestReward(10000);
        bem.rejectRecipient(ALICE);
        vm.prank(ALICE);
        vm.expectRevert();
        rewards.claim();
        assertEq(rewards.claimable(ALICE), 4655);
        assertEq(rewards.epochPaid(firstEpoch), 0);
        assertEq(rewards.lastClaimAt(ALICE), 0);
        assertEq(rewards.bemAccounted(), 9500);
        bem.rejectRecipient(address(0));
        assertEq(_claim(ALICE), 4655);
    }

    function test_failedExpiryBurnPreservesWholeBatchAndCanRetry() public {
        _harvestReward(10000);
        _atEpoch(firstEpoch + 8);
        bem.rejectRecipient(DEAD);
        vm.expectRevert();
        rewards.burnExpired(firstEpoch);
        assertEq(rewards.epochBurned(firstEpoch), 0);
        assertEq(rewards.bemAccounted(), 9500);
        bem.rejectRecipient(address(0));
        rewards.burnExpired(firstEpoch);
        assertEq(rewards.epochBurned(firstEpoch), 9500);
        assertEq(rewards.bemAccounted(), 0);
    }

    function test_miningClaimCannotReenterHarvest() public {
        _queueReward(10000);
        mining.setClaimReentry(address(pool), abi.encodeCall(IRewardsVault.harvest, ()));
        rewards.harvest();
        assertTrue(mining.reentryAttempted());
        assertFalse(mining.reentrySucceeded());
        assertEq(mining.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(rewards.epochNet(firstEpoch), 9500);
    }

    function test_bemTransferCannotReenterHarvest() public {
        _queueReward(10000);
        bem.setTransferReentry(address(pool), abi.encodeCall(IRewardsVault.harvest, ()));
        rewards.harvest();
        assertTrue(bem.reentryAttempted());
        assertFalse(bem.reentrySucceeded());
        assertEq(bem.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(rewards.epochNet(firstEpoch), 9500);
        assertEq(bem.balanceOf(TREASURY), 100);
    }
}
