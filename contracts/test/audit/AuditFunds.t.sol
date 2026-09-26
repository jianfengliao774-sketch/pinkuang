// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {RewardsVaultHarness} from "../utils/RewardsTestBase.sol";
import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {LegacySaleVaultFixture} from "../unit/SaleBudgetMigration.t.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @dev Audit-only model: each harvest grants shares * net / 100 rational atoms.
/// This does not use production accumulators, debt, checkpoints, or settlement helpers.
contract AuditFundsRewardsTest is ShareTransferTestBase {
    function testFuzz_rewardsFollowOldOwnersAcrossMixedHarvestTransferAndClaims(uint256 seed) public {
        address[5] memory actors = [ALICE, BOB, CAROL, DAVE, ERIN];
        uint256[5] memory holdings = [uint256(49), 49, 2, 0, 0];
        uint256[5] memory earnedHundredths;
        uint256 netTotal;
        for (uint256 i; i < 24; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 gross = 1 + seed % 10000;
            uint256 net = gross - gross / 100;
            netTotal += net;
            for (uint256 j; j < actors.length; ++j) {
                earnedHundredths[j] += holdings[j] * net;
            }
            _queueReward(gross);
            uint256 from = (seed >> 16) % actors.length;
            uint256 to = (seed >> 32) % actors.length;
            if (from != to && holdings[from] > 0 && holdings[to] < 100) {
                uint256 available = holdings[from] < 100 - holdings[to] ? holdings[from] : 100 - holdings[to];
                uint256 amount = 1 + (seed >> 48) % available;
                _transfer(actors[from], actors[to], amount); // Includes strict harvest before ownership changes.
                holdings[from] -= amount;
                holdings[to] += amount;
            } else {
                rewards.harvest();
            }
            uint256 claimant = (seed >> 64) % actors.length;
            uint256 expected = earnedHundredths[claimant] / 100 - bem.balanceOf(actors[claimant]);
            assertEq(rewards.claimable(actors[claimant]), expected, "rational oracle before partial claim");
            if (expected != 0) assertEq(_claim(actors[claimant]), expected);
            uint256 paid;
            for (uint256 j; j < actors.length; ++j) {
                paid += bem.balanceOf(actors[j]);
            }
            assertEq(rewards.bemAccounted() + paid, netTotal, "income never becomes double debt");
            assertEq(bem.balanceOf(address(pool)), rewards.bemAccounted(), "actual assets cover the ledger");
        }
        uint256 paidTotal;
        uint256 fractionalHundredths;
        for (uint256 j; j < actors.length; ++j) {
            uint256 expected = earnedHundredths[j] / 100 - bem.balanceOf(actors[j]);
            assertEq(rewards.claimable(actors[j]), expected);
            if (expected != 0) assertEq(_claim(actors[j]), expected);
            assertEq(bem.balanceOf(actors[j]), earnedHundredths[j] / 100);
            paidTotal += bem.balanceOf(actors[j]);
            fractionalHundredths += earnedHundredths[j] % 100;
        }
        assertEq(paidTotal + rewards.bemAccounted(), netTotal);
        assertEq(rewards.bemAccounted() * 100, fractionalHundredths);
    }

    function testFuzz_legacyPaidClaimsAndFormerOwnersMigrateExactlyOnce(uint256 a, uint256 b, uint256 c) public {
        RewardsVaultHarness legacy = RewardsVaultHarness(payable(address(pool)));
        legacy.fixtureLegacyStart();
        a = bound(a, 1000, 1e12);
        b = bound(b, 1000, 1e12);
        c = bound(c, 1000, 1e12);
        uint256 oldA = a - a / 100 - a * 4 / 100;
        uint256 oldB = b - b / 100 - b * 4 / 100;
        _donate(a);
        legacy.fixtureLegacyAccount();
        vm.prank(ALICE);
        legacy.fixtureLegacyClaim();
        legacy.fixtureLegacyTransfer(ALICE, DAVE, 49);
        _atEpoch(firstEpoch + 1);
        _donate(b);
        legacy.fixtureLegacyAccount();
        vm.prank(BOB);
        legacy.fixtureLegacyClaim();
        // A zero-balance former holder fixes the cutover; inactive users migrate after many years.
        legacy.settleUser(ALICE);
        legacy.settleUser(ALICE);
        _atEpoch(firstEpoch + 30000);
        _harvestReward(c);
        uint256 fresh = c - c / 100;
        address[4] memory actors = [ALICE, BOB, CAROL, DAVE];
        uint256[4] memory rational =
            [49 * oldA, 49 * (oldA + oldB + fresh), 2 * (oldA + oldB + fresh), 49 * (oldB + fresh)];
        uint256 paidTotal;
        for (uint256 i; i < actors.length; ++i) {
            uint256 expected = rational[i] / 100 - bem.balanceOf(actors[i]);
            assertEq(rewards.claimable(actors[i]), expected, "migration preserves exact rational entitlement");
            if (expected != 0) assertEq(_claim(actors[i]), expected);
            legacy.settleUser(actors[i]);
            assertEq(rewards.claimable(actors[i]), 0, "repeat settlement does not recreate old slots");
            assertEq(bem.balanceOf(actors[i]), rational[i] / 100);
            paidTotal += bem.balanceOf(actors[i]);
        }
        assertEq(paidTotal + rewards.bemAccounted(), oldA + oldB + fresh);
        assertEq(bem.balanceOf(address(pool)), rewards.bemAccounted());
    }
}

contract AuditFundsSaleTest is SaleTestBase {
    function testFuzz_legacyBudgetReleasePreservesAllPriorPaymentsAndPrincipal(
        uint96 gross,
        uint8 paidMask,
        uint96 spentSeed
    ) public {
        gross = uint96(bound(gross, 1, 100 ether));
        LegacySaleVaultFixture implementation = new LegacySaleVaultFixture(address(poolFactory));
        bytes memory upgrade = abi.encodeWithSignature("upgradeTo(address)", address(implementation));
        bytes32 salt = keccak256("audit-funds-legacy");
        vm.prank(OWNER);
        timelock.schedule(address(beacon), 0, upgrade, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(beacon), 0, upgrade, bytes32(0), salt);
        LegacySaleVaultFixture legacy = LegacySaleVaultFixture(payable(address(pool)));
        _listSale(gross);
        _complete(NFT_BUYER, gross);
        uint256 fee = uint256(gross) / 50;
        uint256 spent = bound(spentSeed, 0, fee);
        legacy.fixtureLegacyClosedSale(spent);
        vm.deal(address(pool), address(pool).balance - spent);
        address[3] memory members = [ALICE, BOB, CAROL];
        uint256[3] memory balancesBefore = [ALICE.balance, BOB.balance, CAROL.balance];
        uint256 initialPoolBnb = address(pool).balance;
        for (uint256 i; i < members.length; ++i) {
            if ((paidMask & (1 << i)) != 0) legacy.fixturePayOldSale(members[i]);
        }
        // Exercise arbitrary first claimant and reverse order; each withdrawal merges sale + original purchase surplus.
        uint256 first = uint256(paidMask) % members.length;
        for (uint256 i; i < members.length; ++i) {
            address member = members[(first + 3 - i) % 3];
            uint256 expected = pool.bnbOwed(member);
            assertEq(_withdraw(member), expected);
            assertEq(pool.bnbOwed(member), 0);
            vm.prank(member);
            vm.expectRevert(IPoolVault.NothingToClaim.selector);
            pool.withdrawBnb();
        }
        if (fee != 0) assertEq(_withdraw(TREASURY), fee);
        uint256 totalPaid = fee;
        for (uint256 i; i < members.length; ++i) {
            totalPaid += members[i].balance - balancesBefore[i];
        }
        assertEq(totalPaid, initialPoolBnb, "old paid, unpaid, bonus and purchase principal exhaust exact assets");
        assertEq(address(pool).balance, 0);
        assertEq(pool.totalBnbOwed(), 0);
    }
}
