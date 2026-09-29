// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {RewardsTestBase, RewardsVaultHarness} from "../utils/RewardsTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract RewardMigrationTest is RewardsTestBase {
    RewardsVaultHarness private legacy;

    function setUp() public override {
        super.setUp();
        legacy = RewardsVaultHarness(payable(address(pool)));
        legacy.fixtureLegacyStart();
    }

    function _oldIncome(uint256 amount) private {
        _donate(amount);
        legacy.fixtureLegacyAccount();
    }

    function test_paidOldSlotsMixedFractionsAndNewIncomeAreNotClaimedTwice() public {
        _oldIncome(100);
        vm.prank(ALICE);
        legacy.fixtureLegacyClaim();
        assertEq(bem.balanceOf(ALICE), 46);
        legacy.fixtureLegacySettle(BOB);
        _atEpoch(firstEpoch + 1);
        _oldIncome(100);
        assertEq(rewards.claimable(ALICE), 47);
        uint256 reserved = rewards.bemAccounted();
        _settle(ALICE);
        _settle(ALICE);
        assertFalse(rewards.expiryEnabled());
        assertEq(rewards.bemAccounted(), reserved);
        assertEq(rewards.bemOwed(ALICE), 47);
        _harvestReward(100);
        assertEq(_claim(ALICE), 95);
        assertEq(_claim(BOB), 141);
        assertEq(_claim(CAROL), 5);
        assertEq(rewards.bemAccounted(), 2);
        assertEq(rewards.epochPaid(firstEpoch), 46, "old daily ledger remains historical after cutover");
        assertEq(bem.balanceOf(DEAD), 8, "only the pre-upgrade fixture burned");
        _atEpoch(firstEpoch + 30000);
        _settle(BOB);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        rewards.claim();
        assertEq(rewards.bemAccounted(), 2);
    }

    function test_fixedCutoverPreservesFormerHolderAndInactiveRecipientForYears() public {
        _oldIncome(100);
        address dave = address(0xDA7E);
        legacy.fixtureLegacyTransfer(ALICE, dave, 49);
        _atEpoch(firstEpoch + 1);
        _oldIncome(100);
        _settle(ALICE); // Fix the cutover before any ring slot can be overwritten.
        _atEpoch(firstEpoch + 30000);
        assertEq(_claim(ALICE), 46);
        assertEq(_claim(dave), 46);
        assertEq(_claim(BOB), 93);
        assertEq(_claim(CAROL), 3);
        assertEq(rewards.bemAccounted(), 2);
        assertEq(bem.balanceOf(DEAD), 8);
    }

    function test_burnedHistoricalEpochCannotBeRecreatedAsNewDebt() public {
        _oldIncome(10000);
        legacy.fixtureLegacySettle(BOB);
        _atEpoch(firstEpoch + 8);
        legacy.fixtureLegacyBurn(firstEpoch);
        _oldIncome(10000);
        assertEq(_claim(BOB), 4655);
        assertEq(_claim(ALICE), 4655);
        assertEq(_claim(CAROL), 190);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(rewards.epochBurned(firstEpoch), 9500);
        assertEq(bem.balanceOf(DEAD), 10300);
    }

    function test_expiredUnpaidEpochFailsClosedWithoutMovingOrForfeitingFunds() public {
        _oldIncome(10000);
        legacy.fixtureLegacySettle(ALICE);
        _atEpoch(firstEpoch + 8);
        _oldIncome(100);
        legacy.fixtureLegacySettle(ALICE); // Old ring overwrites an unpaid user cache.
        uint256 reserved = rewards.bemAccounted();
        vm.expectRevert(IPoolVault.LegacyRewardMigrationRequired.selector);
        rewards.claimable(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.LegacyRewardMigrationRequired.selector);
        rewards.claim();
        vm.expectRevert(IPoolVault.LegacyRewardMigrationRequired.selector);
        rewards.harvest();
        vm.expectRevert(IPoolVault.BurnDisabled.selector);
        rewards.burnExpired(firstEpoch);
        assertEq(rewards.bemAccounted(), reserved);
        assertTrue(rewards.expiryEnabled(), "failed migration must not flip the historical flag");
    }

    function test_moreThanSixtyFourCheckpointsRequiresReviewedMigration() public {
        for (uint32 i = 0; i < 65; ++i) {
            _atEpoch(firstEpoch + i);
            _oldIncome(100);
            if (i >= 8) legacy.fixtureLegacyBurn(firstEpoch + i - 8);
        }
        vm.expectRevert(IPoolVault.LegacyRewardMigrationRequired.selector);
        rewards.claimable(ALICE);
        assertEq(rewards.bemAccounted(), 8 * 95);
    }

    function test_sixtyFourCheckpointBoundaryAndAllLiveRightsReconstruct() public {
        for (uint32 i = 0; i < 64; ++i) {
            _atEpoch(firstEpoch + i);
            _oldIncome(100);
            if (i >= 8) legacy.fixtureLegacyBurn(firstEpoch + i - 8);
        }
        assertEq(_claim(ALICE), 372);
        assertEq(_claim(BOB), 372);
        assertEq(_claim(CAROL), 15);
        assertEq(rewards.bemAccounted(), 1);
    }
}
