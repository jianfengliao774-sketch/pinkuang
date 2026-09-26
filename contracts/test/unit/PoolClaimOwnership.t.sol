// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {RewardsTestBase, RewardsVaultHarness} from "../utils/RewardsTestBase.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract PoolClaimOwnershipTest is RewardsTestBase {
    address private constant KEEPER = address(0xCE01);
    address private constant NEW_HOLDER = address(0xCE03);

    function test_strangerHarvestsToPoolButOnlyMembersCanClaimTheirOwnIncome() public {
        _queueReward(10000);
        uint256 calls = mining.claimCalls();
        assertEq(pool.balanceOf(KEEPER), 0);
        vm.prank(KEEPER);
        rewards.harvest();

        assertEq(mining.claimCalls(), calls + 1);
        assertEq(mining.unreported(key), 0);
        assertEq(bem.balanceOf(address(pool)), 9900);
        assertEq(bem.balanceOf(TREASURY), 100);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(bem.balanceOf(ALICE), 0);
        assertEq(bem.balanceOf(BOB), 0);
        assertEq(bem.balanceOf(CAROL), 0);
        assertEq(rewards.claimable(ALICE), 4851);
        assertEq(rewards.claimable(BOB), 4851);
        assertEq(rewards.claimable(CAROL), 198);

        vm.prank(KEEPER);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        rewards.claim();
        assertEq(rewards.bemAccounted(), 9900);
        assertEq(rewards.lastClaimAt(KEEPER), 0);
        assertEq(_claim(ALICE), 4851);
        assertEq(bem.balanceOf(ALICE), 4851);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(bem.balanceOf(BOB), 0);
        assertEq(rewards.claimable(BOB), 4851);
        assertEq(rewards.bemAccounted(), 5049);
    }

    function test_selfCanClaimNewIncomeAgainInTheSameTimestamp() public {
        uint256 at = block.timestamp;
        assertEq(RewardsVaultHarness(payable(address(pool))).claimInterval(), 0);
        _harvestReward(10000);
        assertEq(_claim(ALICE), 4851);
        _queueReward(10000);
        vm.prank(KEEPER);
        rewards.harvest();
        // A stranger's harvest changes no wallet balance and cannot choose a recipient.
        assertEq(bem.balanceOf(ALICE), 4851);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(_claim(ALICE), 4851);

        assertEq(block.timestamp, at);
        assertEq(rewards.lastClaimAt(ALICE), at);
        assertEq(bem.balanceOf(ALICE), 9702);
        assertEq(rewards.claimable(ALICE), 0);
        assertEq(rewards.claimable(BOB), 9702);
        assertEq(rewards.claimable(CAROL), 396);
        assertEq(rewards.bemAccounted(), 10098);
        assertEq(bem.balanceOf(address(pool)), 10098);
    }

    function test_emptyClaimPreservesDebtFractionsAndLastSuccessfulTime() public {
        _harvestReward(100);
        assertEq(_claim(ALICE), 48);
        uint64 lastSuccess = rewards.lastClaimAt(ALICE);
        uint256 acc = rewards.accBemPerShare();
        uint256 fraction = 51 * P / 100;
        vm.warp(block.timestamp + 1 hours);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        rewards.claim();

        assertEq(rewards.bemOwed(ALICE), 0);
        assertEq(rewards.bemAccounted(), 51);
        assertEq(rewards.accBemPerShare(), acc);
        assertEq(rewards.lastClaimAt(ALICE), lastSuccess);
        assertEq(rewards.totalGlobalRemainderScaled(), fraction);
        assertEq(RewardsVaultHarness(payable(address(pool))).globalRewardRemainder(ALICE), fraction);
        assertEq(bem.balanceOf(address(pool)), 51);
        assertEq(bem.balanceOf(ALICE), 48);

        _harvestReward(100);
        assertEq(_claim(ALICE), 49);
        assertEq(bem.balanceOf(ALICE), 97);
        assertEq(rewards.totalGlobalRemainderScaled(), 2 * P / 100);
    }

    function test_removedClaimForSelectorRejectsWithoutChangingAccounting() public {
        _harvestReward(10000);
        uint256 acc = rewards.accBemPerShare();
        uint256 calls = mining.claimCalls();
        vm.prank(KEEPER);
        (bool success,) = address(pool).call(abi.encodeWithSignature("claimFor(address)", ALICE));

        assertFalse(success, "no third party payout entry point may remain");
        assertEq(rewards.bemAccounted(), 9900);
        assertEq(rewards.accBemPerShare(), acc);
        assertEq(rewards.bemOwed(ALICE), 0);
        assertEq(rewards.claimable(ALICE), 4851);
        assertEq(rewards.lastClaimAt(ALICE), 0);
        assertEq(rewards.lastClaimAt(KEEPER), 0);
        assertEq(rewards.totalGlobalRemainderScaled(), 0);
        assertEq(bem.balanceOf(address(pool)), 9900);
        assertEq(bem.balanceOf(ALICE), 0);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(mining.claimCalls(), calls);
    }

    function test_failedPersonalPaymentRollsBackSettlementAndFractions() public {
        _harvestReward(100);
        bem.rejectRecipient(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(bytes("injected BEM transfer failure"));
        rewards.claim();

        assertEq(rewards.claimable(ALICE), 48);
        assertEq(rewards.bemOwed(ALICE), 0);
        assertEq(rewards.lastClaimAt(ALICE), 0);
        assertEq(rewards.bemAccounted(), 99);
        assertEq(rewards.totalGlobalRemainderScaled(), 0);
        assertEq(RewardsVaultHarness(payable(address(pool))).globalRewardRemainder(ALICE), 0);
        assertEq(bem.balanceOf(address(pool)), 99);
        assertEq(bem.balanceOf(ALICE), 0);

        bem.rejectRecipient(address(0));
        assertEq(_claim(ALICE), 48);
        assertEq(rewards.bemAccounted(), 51);
        assertEq(rewards.totalGlobalRemainderScaled(), 51 * P / 100);
    }

    function testFuzz_claimAndHarvestShareTheReentrancyGuard(bool outerHarvest, bool innerHarvest) public {
        if (!outerHarvest) _harvestReward(10000);
        bytes memory data = innerHarvest ? abi.encodeWithSignature("harvest()") : abi.encodeCall(IPoolVault.claim, ());
        bem.setTransferReentry(address(pool), data);
        if (outerHarvest) {
            _queueReward(10000);
            vm.prank(KEEPER);
            rewards.harvest();
        } else {
            assertEq(_claim(ALICE), 4851);
        }

        assertTrue(bem.reentryAttempted());
        assertFalse(bem.reentrySucceeded());
        assertEq(bem.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(bem.balanceOf(ALICE), outerHarvest ? 0 : 4851);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(bem.balanceOf(TREASURY), 100);
        assertEq(rewards.claimable(BOB), 4851);
        assertEq(rewards.bemAccounted(), outerHarvest ? 9900 : 5049);
        assertEq(bem.balanceOf(address(pool)), rewards.bemAccounted());
    }

    function test_zeroShareFormerHolderPersonallyClaimsOldIncomeAfterRealTransfer() public {
        _registerMarketForTransfers();
        _harvestReward(10000);
        _queueReward(10000);
        uint256 calls = mining.claimCalls();
        vm.prank(ALICE);
        assertTrue(pool.transfer(NEW_HOLDER, 49));
        assertEq(mining.claimCalls(), calls + 1);
        assertEq(mining.unreported(key), 0);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(rewards.claimable(ALICE), 9702);
        assertEq(rewards.claimable(NEW_HOLDER), 0);

        _harvestReward(10000);
        assertEq(_claim(ALICE), 9702);
        assertEq(_claim(NEW_HOLDER), 4851);
        assertEq(bem.balanceOf(ALICE), 9702);
        assertEq(bem.balanceOf(NEW_HOLDER), 4851);
        assertEq(rewards.claimable(BOB), 14553);
        assertEq(rewards.claimable(CAROL), 594);
        assertEq(rewards.bemAccounted(), 15147);
        assertEq(bem.balanceOf(address(pool)), 15147);
    }

    function _registerMarketForTransfers() private {
        ShareMarket implementation = new ShareMarket();
        address registeredMarket = address(
            new ERC1967Proxy(
                address(implementation),
                abi.encodeCall(ShareMarket.initialize, (address(poolFactory), address(timelock)))
            )
        );
        bytes memory registration = abi.encodeWithSignature("registerShareMarket(address)", registeredMarket);
        bytes32 salt = keccak256("claim-ownership-market-registration");
        vm.prank(OWNER);
        timelock.schedule(address(poolFactory), 0, registration, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(poolFactory), 0, registration, bytes32(0), salt);
        assertEq(poolFactory.shareMarket(), registeredMarket);
    }
}
