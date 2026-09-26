// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {RewardsTestBase, RewardsVaultHarness} from "../utils/RewardsTestBase.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract PermissionlessClaimsTest is RewardsTestBase {
    address private constant KEEPER = address(0xCE01);
    address private constant OTHER_KEEPER = address(0xCE02);
    address private constant NEW_HOLDER = address(0xCE03);

    function test_strangerWithNoSharesCanOnlyPayTheBeneficiary() public {
        _harvestReward(10000);
        assertEq(pool.balanceOf(KEEPER), 0);
        assertEq(rewards.claimable(KEEPER), 0);

        assertEq(_claimFor(KEEPER, ALICE), 4851);

        assertEq(bem.balanceOf(ALICE), 4851);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(bem.balanceOf(OTHER_KEEPER), 0);
        assertEq(bem.balanceOf(TREASURY), 100);
        assertEq(rewards.claimable(ALICE), 0);
        assertEq(rewards.claimable(BOB), 4851);
        assertEq(rewards.claimable(CAROL), 198);
        assertEq(rewards.bemAccounted(), 5049);
        assertEq(bem.balanceOf(address(pool)), 5049);
        assertEq(pool.balanceOf(ALICE), 49);
    }

    function test_zeroBeneficiaryRevertsWithoutChangingAccounting() public {
        _harvestReward(10000);
        uint256 acc = rewards.accBemPerShare();
        vm.prank(KEEPER);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        IPoolVault(address(pool)).claimFor(address(0));

        assertEq(rewards.bemAccounted(), 9900);
        assertEq(rewards.accBemPerShare(), acc);
        assertEq(rewards.claimable(ALICE), 4851);
        assertEq(rewards.bemOwed(ALICE), 0);
        assertEq(rewards.lastClaimAt(address(0)), 0);
        assertEq(rewards.totalGlobalRemainderScaled(), 0);
        assertEq(bem.balanceOf(address(pool)), 9900);
        assertEq(bem.balanceOf(KEEPER), 0);
    }

    function test_callerCannotClaimOtherMembersIncomeForItself() public {
        _harvestReward(10000);
        vm.prank(KEEPER);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        IPoolVault(address(pool)).claimFor(KEEPER);

        assertEq(rewards.bemAccounted(), 9900);
        assertEq(rewards.bemOwed(KEEPER), 0);
        assertEq(rewards.lastClaimAt(KEEPER), 0);
        assertEq(rewards.claimable(ALICE), 4851);
        assertEq(rewards.claimable(BOB), 4851);
        assertEq(rewards.claimable(CAROL), 198);
        assertEq(bem.balanceOf(address(pool)), 9900);
        assertEq(bem.balanceOf(KEEPER), 0);
    }

    function test_selfAndDifferentCallersCanClaimNewIncomeInTheSameTimestamp() public {
        uint256 at = block.timestamp;
        assertEq(RewardsVaultHarness(payable(address(pool))).claimInterval(), 0);
        _harvestReward(10000);
        assertEq(_claim(ALICE), 4851);
        _harvestReward(10000);
        assertEq(_claimFor(KEEPER, ALICE), 4851);
        _harvestReward(10000);
        assertEq(_claimFor(OTHER_KEEPER, ALICE), 4851);
        _harvestReward(10000);
        assertEq(_claim(ALICE), 4851);

        assertEq(block.timestamp, at);
        assertEq(rewards.lastClaimAt(ALICE), at);
        assertEq(bem.balanceOf(ALICE), 19404);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(bem.balanceOf(OTHER_KEEPER), 0);
        assertEq(rewards.claimable(ALICE), 0);
        assertEq(rewards.claimable(BOB), 19404);
        assertEq(rewards.claimable(CAROL), 792);
        assertEq(rewards.bemAccounted(), 20196);
        assertEq(bem.balanceOf(address(pool)), 20196);
        assertEq(bem.balanceOf(TREASURY), 400);
    }

    function test_repeatedEmptyClaimsPreserveDebtFractionsAndLastSuccessfulTime() public {
        _harvestReward(100);
        assertEq(_claimFor(KEEPER, ALICE), 48);
        uint64 lastSuccess = rewards.lastClaimAt(ALICE);
        uint256 acc = rewards.accBemPerShare();
        uint256 fraction = 51 * P / 100;

        vm.prank(OTHER_KEEPER);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        IPoolVault(address(pool)).claimFor(ALICE);
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
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(bem.balanceOf(OTHER_KEEPER), 0);

        _harvestReward(100);
        assertEq(_claimFor(OTHER_KEEPER, ALICE), 49);
        assertEq(bem.balanceOf(ALICE), 97);
        assertEq(rewards.lastClaimAt(ALICE), block.timestamp);
        assertEq(rewards.totalGlobalRemainderScaled(), 2 * P / 100);
    }

    function test_failedBemPaymentRollsBackSettlementFractionsAndClaimTime() public {
        _harvestReward(100);
        // Alice owns 48.51 atomic BEM: the failed payment must also undo the
        // first materialization of her 0.51-unit fractional entitlement.
        assertEq(rewards.claimable(ALICE), 48);
        assertEq(rewards.bemOwed(ALICE), 0);
        assertEq(rewards.totalGlobalRemainderScaled(), 0);
        bem.rejectRecipient(ALICE);
        vm.prank(KEEPER);
        vm.expectRevert(bytes("injected BEM transfer failure"));
        IPoolVault(address(pool)).claimFor(ALICE);

        assertEq(rewards.claimable(ALICE), 48);
        assertEq(rewards.bemOwed(ALICE), 0);
        assertEq(rewards.lastClaimAt(ALICE), 0);
        assertEq(rewards.bemAccounted(), 99);
        assertEq(rewards.totalGlobalRemainderScaled(), 0);
        assertEq(RewardsVaultHarness(payable(address(pool))).globalRewardRemainder(ALICE), 0);
        assertEq(bem.balanceOf(address(pool)), 99);
        assertEq(bem.balanceOf(ALICE), 0);
        assertEq(bem.balanceOf(KEEPER), 0);

        bem.rejectRecipient(address(0));
        assertEq(_claimFor(OTHER_KEEPER, ALICE), 48);
        assertEq(rewards.bemAccounted(), 51);
        assertEq(rewards.totalGlobalRemainderScaled(), 51 * P / 100);
        assertEq(bem.balanceOf(ALICE), 48);
    }

    function testFuzz_bemCallbackCannotReenterClaimForAnyBeneficiary(bool differentBeneficiary) public {
        _harvestReward(10000);
        address innerBeneficiary = differentBeneficiary ? BOB : ALICE;
        bem.setTransferReentry(address(pool), abi.encodeCall(IPoolVault.claimFor, (innerBeneficiary)));

        assertEq(_claimFor(KEEPER, ALICE), 4851);

        assertTrue(bem.reentryAttempted());
        assertFalse(bem.reentrySucceeded());
        assertEq(bem.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(bem.balanceOf(ALICE), 4851);
        assertEq(bem.balanceOf(BOB), 0);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(bem.balanceOf(address(pool)), 5049);
        assertEq(rewards.bemAccounted(), 5049);
        assertEq(rewards.claimable(ALICE), 0);
        assertEq(rewards.claimable(BOB), 4851);
    }

    function test_selfClaimAndThirdPartyClaimShareTheReentrancyGuard() public {
        _harvestReward(10000);
        bem.setTransferReentry(address(pool), abi.encodeCall(IPoolVault.claimFor, (BOB)));

        assertEq(_claim(ALICE), 4851);

        assertTrue(bem.reentryAttempted());
        assertFalse(bem.reentrySucceeded());
        assertEq(bem.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(bem.balanceOf(ALICE), 4851);
        assertEq(bem.balanceOf(BOB), 0);
        assertEq(rewards.claimable(BOB), 4851);
        assertEq(rewards.bemAccounted(), 5049);
    }

    function test_zeroShareFormerHolderKeepsOldIncomeAfterRealTransfer() public {
        _registerMarketForTransfers();
        _harvestReward(10000);
        _queueReward(10000);
        uint256 calls = mining.claimCalls();
        vm.prank(ALICE);
        assertTrue(pool.transfer(NEW_HOLDER, 49));
        assertEq(mining.claimCalls(), calls + 1);
        assertEq(mining.unreported(key), 0);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.balanceOf(NEW_HOLDER), 49);
        assertEq(rewards.claimable(ALICE), 9702);
        assertEq(rewards.claimable(NEW_HOLDER), 0);

        _harvestReward(10000);
        assertEq(rewards.claimable(ALICE), 9702);
        assertEq(rewards.claimable(NEW_HOLDER), 4851);
        assertEq(_claimFor(KEEPER, ALICE), 9702);
        assertEq(_claimFor(OTHER_KEEPER, NEW_HOLDER), 4851);
        assertEq(bem.balanceOf(ALICE), 9702);
        assertEq(bem.balanceOf(NEW_HOLDER), 4851);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(rewards.claimable(BOB), 14553);
        assertEq(rewards.claimable(CAROL), 594);
        assertEq(rewards.bemAccounted(), 15147);
        assertEq(bem.balanceOf(address(pool)), 15147);
    }

    function test_bookedIncomeIsPayableWhenMiningFailsAndNftHasLeft() public {
        _harvestReward(10000);
        _queueReward(50000);
        mining.setClaimFault(1);
        nft.forceTransfer(address(0xB00B), rewardId);
        uint256 calls = mining.claimCalls();

        assertEq(_claimFor(KEEPER, ALICE), 4851);

        assertEq(mining.claimCalls(), calls);
        assertEq(mining.unreported(key), 50000);
        assertEq(bem.balanceOf(ALICE), 4851);
        assertEq(bem.balanceOf(KEEPER), 0);
        assertEq(rewards.bemAccounted(), 5049);
    }

    function test_unbookedMiningIncomeAndDirectReceiptsCannotBeClaimed() public {
        _queueReward(10000);
        _donate(10000);
        uint256 calls = mining.claimCalls();
        vm.prank(KEEPER);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        IPoolVault(address(pool)).claimFor(ALICE);

        assertEq(mining.claimCalls(), calls);
        assertEq(mining.unreported(key), 10000);
        assertEq(rewards.accBemPerShare(), 0);
        assertEq(rewards.bemAccounted(), 0);
        assertEq(rewards.bemOwed(ALICE), 0);
        assertEq(rewards.lastClaimAt(ALICE), 0);
        assertEq(bem.balanceOf(address(pool)), 10000);
        assertEq(bem.balanceOf(ALICE), 0);
        assertEq(bem.balanceOf(TREASURY), 0);

        rewards.harvest();
        assertEq(_claimFor(OTHER_KEEPER, ALICE), 9702);
        assertEq(bem.balanceOf(ALICE), 9702);
        assertEq(bem.balanceOf(TREASURY), 200);
        assertEq(bem.balanceOf(KEEPER), 0);
    }

    function _claimFor(address caller, address beneficiary) private returns (uint256 amount) {
        vm.prank(caller);
        amount = IPoolVault(address(pool)).claimFor(beneficiary);
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
        bytes32 salt = keccak256("permissionless-claims-market-registration");
        vm.prank(OWNER);
        timelock.schedule(address(poolFactory), 0, registration, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(poolFactory), 0, registration, bytes32(0), salt);
        assertEq(poolFactory.shareMarket(), registeredMarket);
    }
}
