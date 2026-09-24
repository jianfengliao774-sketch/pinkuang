// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IFundingVault} from "../utils/FundingTestBase.sol";

/// @notice Regression for audit #5: infrastructure must never become an inaccessible member.
contract AuditShareRecipientTest is ShareTransferTestBase {
    function testFuzz_transferRejectsPoolAndFactoryWithoutConsumingOldRewards(bool toFactory) public {
        address recipient = toFactory ? address(poolFactory) : address(pool);
        _queueReward(10000);
        uint256 claimCalls = mining.claimCalls();
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.InvalidShareRecipient.selector);
        pool.transfer(recipient, 1);
        assertEq(mining.claimCalls(), claimCalls);
        _assertUnchanged(recipient);
        _transfer(ALICE, DAVE, 1);
        assertEq(rewards.claimable(ALICE), 4655);
        assertEq(rewards.claimable(DAVE), 0);
    }

    function testFuzz_transferFromRejectsPoolAndFactoryAndPreservesAllowance(bool toFactory) public {
        address recipient = toFactory ? address(poolFactory) : address(pool);
        vm.prank(ALICE);
        pool.approve(FRANK, 1);
        vm.prank(FRANK);
        vm.expectRevert(IPoolVault.InvalidShareRecipient.selector);
        pool.transferFrom(ALICE, recipient, 1);
        assertEq(pool.allowance(ALICE, FRANK), 1);
        _assertUnchanged(recipient);
    }

    function testFuzz_marketFillRejectsPoolAndFactoryAndPreservesOrderAndPayment(bool toFactory) public {
        address recipient = toFactory ? address(poolFactory) : address(pool);
        vm.prank(ALICE);
        uint256 order = shareMarket.list(address(pool), 1, 1 ether);
        vm.deal(recipient, recipient.balance + 1 ether);
        uint256 beforeBalance = recipient.balance;
        vm.prank(recipient);
        vm.expectRevert(IPoolVault.InvalidShareRecipient.selector);
        shareMarket.fill{value: 1 ether}(order, 1);
        assertEq(recipient.balance, beforeBalance);
        assertEq(shareMarket.totalBnbOwed(), 0);
        assertTrue(shareMarket.orders(order).active);
        assertEq(_shareVault().lockedShares(ALICE), 1);
        _assertUnchanged(recipient);
    }

    function testFuzz_subscriptionCannotMintToPoolOrFactory(bool toFactory) public {
        defaultParams.circuitId += 1;
        IFundingVault funding = _createPool(defaultParams);
        address recipient = toFactory ? address(poolFactory) : address(funding);
        uint256 price = funding.unitPriceWei();
        vm.deal(recipient, price);
        vm.prank(recipient);
        vm.expectRevert(IPoolVault.InvalidShareRecipient.selector);
        funding.deposit{value: price}(1);
        assertEq(funding.totalSupply(), 0);
        assertEq(funding.totalRaised(), 0);
        assertEq(funding.memberCount(), 0);
        assertEq(funding.contributedWei(recipient), 0);
        assertEq(recipient.balance, price);
    }

    function _assertUnchanged(address recipient) private view {
        assertEq(pool.balanceOf(recipient), 0);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.memberCount(), 3);
        assertEq(pool.totalSupply(), 100);
        assertEq(rewards.claimable(recipient), 0);
        assertEq(pool.bnbOwed(recipient), 0);
    }
}
