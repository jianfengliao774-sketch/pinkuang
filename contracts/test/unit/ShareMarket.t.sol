// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ShareTransferTestBase, ShareTransferVaultHarness} from "../utils/ShareTransferTestBase.sol";
import {RewardsVaultHarness} from "../utils/RewardsTestBase.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {PoolVault} from "../../src/PoolVault.sol";

/// @dev Compatible UUPS fixture: no new storage or initializer, only a pure version getter.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract ShareMarketV2Fixture is ShareMarket {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract ShareMarketPaymentActor {
    bool public rejectBnb;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackAttempted;
    bool public callbackSucceeded;
    bytes public callbackResult;

    function setReject(bool reject) external {
        rejectBnb = reject;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    receive() external payable {
        require(!rejectBnb, "receiver rejects BNB");
        if (callbackTarget != address(0)) {
            callbackAttempted = true;
            (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
        }
    }
}

/// @dev Only used to test the registry's declared identity checks; not a tradable market.
contract ShareMarketIdentityStub {
    address public immutable factory;
    address public immutable timelock;

    constructor(address factory_, address timelock_) {
        factory = factory_;
        timelock = timelock_;
    }
}

contract ShareMarketTest is ShareTransferTestBase {
    uint256 private constant UNIT_BNB = 0.1 ether;
    bytes32 private constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant MEMBER_TOPIC = keccak256("MemberCountChanged(uint256,uint256)");

    function _list(address seller, uint256 amount, uint256 price) private returns (uint256 id) {
        vm.prank(seller);
        id = shareMarket.list(address(pool), amount, price);
    }

    function _fill(address buyer, uint256 id, uint256 amount, uint256 payment) private {
        vm.deal(buyer, buyer.balance + payment);
        vm.prank(buyer);
        shareMarket.fill{value: payment}(id, amount);
    }

    function _freshFactory() private returns (PoolFactory result) {
        PoolFactory implementation = new PoolFactory();
        result = PoolFactory(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        PoolFactory.initialize, (OWNER, OPERATOR, TREASURY, address(timelock), address(beacon))
                    )
                )
            )
        );
    }

    function _marketFor(PoolFactory factory_) private returns (ShareMarket result) {
        ShareMarket implementation = new ShareMarket();
        result = ShareMarket(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(ShareMarket.initialize, (address(factory_), address(timelock)))
                )
            )
        );
    }

    function _schedule(address target, bytes memory data, bytes32 salt) private {
        vm.prank(OWNER);
        timelock.schedule(target, 0, data, bytes32(0), salt, 48 hours);
    }

    function test_partialFillsPreserveLocksAndDeductExactlyOnePercentFromSeller() public {
        uint256 id = _list(ALICE, 20, UNIT_BNB);
        assertEq(id, 1);
        assertEq(shareMarket.nextOrderId(), 2);
        uint256 aliceBefore = ALICE.balance;
        _fill(DAVE, id, 7, 7 * UNIT_BNB);
        IShareMarket.Order memory order = shareMarket.orders(id);
        assertEq(order.seller, ALICE);
        assertEq(order.pool, address(pool));
        assertEq(order.remaining, 13);
        assertEq(order.pricePerUnit, UNIT_BNB);
        assertTrue(order.active);
        assertEq(_shareVault().lockedShares(ALICE), 13);
        assertEq(pool.balanceOf(ALICE), 42);
        assertEq(pool.balanceOf(DAVE), 7);
        assertEq(shareMarket.bnbOwed(ALICE), 0.693 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.007 ether);
        assertEq(ALICE.balance, aliceBefore, "fill records pull credit and never sends seller BNB");
        _fill(ERIN, id, 13, 13 * UNIT_BNB);
        order = shareMarket.orders(id);
        assertEq(order.remaining, 0);
        assertFalse(order.active);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(pool.balanceOf(ALICE), 29);
        assertEq(shareMarket.bnbOwed(ALICE), 1.98 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.02 ether);
        assertEq(shareMarket.totalBnbOwed(), 2 ether);
        assertEq(address(shareMarket).balance, 2 ether);
        assertEq(pool.balanceOf(address(shareMarket)), 0);
        assertEq(pool.memberCount(), 5);
        assertEq(pool.totalSupply(), 100);
    }

    function test_orderExpiryRejectsLateFillButAnyoneCanUnlockOnlyToOriginalSeller() public {
        uint256 id = _list(ALICE, 20, UNIT_BNB);
        uint64 expiry = shareMarket.orderExpiresAt(id);
        assertEq(expiry, block.timestamp + 7 days);
        vm.expectRevert(IShareMarket.OrderNotExpired.selector);
        shareMarket.expire(id);
        vm.warp(uint256(expiry) - 1);
        _fill(DAVE, id, 1, UNIT_BNB);
        assertEq(_shareVault().lockedShares(ALICE), 19);
        vm.warp(expiry);
        vm.deal(DAVE, UNIT_BNB);
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.OrderExpired.selector);
        shareMarket.fill{value: UNIT_BNB}(id, 1);
        uint256 sellerBalance = pool.balanceOf(ALICE);
        vm.prank(ERIN);
        shareMarket.expire(id);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(pool.balanceOf(ALICE), sellerBalance);
        assertEq(pool.balanceOf(ERIN), 0);
        assertEq(shareMarket.bnbOwed(ALICE), UNIT_BNB - UNIT_BNB / 100);
        vm.expectRevert(IShareMarket.InactiveOrder.selector);
        shareMarket.expire(id);
    }

    function test_votingBlocksOldOrderFillAndNewOrdersButPreservesCancellation() public {
        PoolVault vault = PoolVault(payable(address(pool)));
        vm.warp(uint256(vault.activatedAt()) + 7 days);
        uint256 id = _list(ALICE, 20, 1);
        vm.prank(BOB);
        uint256 proposal = vault.propose(5 ether, 0, 0);
        assertFalse(vault.shareTradingAllowed());
        vm.deal(DAVE, 20);
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.WrongState.selector);
        shareMarket.fill{value: 20}(id, 20);
        vm.prank(CAROL);
        vm.expectRevert(IShareMarket.WrongState.selector);
        shareMarket.list(address(pool), 1, 1);
        assertEq(shareMarket.bnbOwed(ALICE), 0);
        vm.prank(ALICE);
        shareMarket.cancel(id);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        vm.warp(vault.getProposal(proposal).endsAt);
        assertTrue(vault.shareTradingAllowed());
        _list(ALICE, 20, UNIT_BNB);
    }

    function test_legacyOrderWithoutExpiryCanOnlyBeCancelledOrExpired() public {
        uint256 id = _list(ALICE, 5, UNIT_BNB);
        bytes32 namespace = 0xdc32f7bcb40b3d9a2ce544bcf40b4e14e3c57b64d5c4c2258289bd394f08cf00;
        bytes32 expirySlot = keccak256(abi.encode(id, uint256(namespace) + 6));
        vm.store(address(shareMarket), expirySlot, bytes32(0));
        assertEq(shareMarket.orderExpiresAt(id), 0);
        vm.deal(DAVE, UNIT_BNB);
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.OrderExpired.selector);
        shareMarket.fill{value: UNIT_BNB}(id, 1);
        shareMarket.expire(id);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(pool.balanceOf(ALICE), 49);
    }

    function test_fullFillCreditsCanBeWithdrawnOnlyOnceByRecipients() public {
        uint256 id = _list(ALICE, 10, UNIT_BNB);
        _fill(DAVE, id, 10, 1 ether);
        uint256 aliceBefore = ALICE.balance;
        uint256 treasuryBefore = TREASURY.balance;
        vm.prank(ALICE);
        shareMarket.withdrawBnb();
        vm.prank(TREASURY);
        shareMarket.withdrawBnb();
        assertEq(ALICE.balance - aliceBefore, 0.99 ether);
        assertEq(TREASURY.balance - treasuryBefore, 0.01 ether);
        assertEq(shareMarket.totalBnbOwed(), 0);
        assertEq(address(shareMarket).balance, 0);
        vm.prank(ALICE);
        vm.expectRevert(IShareMarket.NothingToClaim.selector);
        shareMarket.withdrawBnb();
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.NothingToClaim.selector);
        shareMarket.withdrawBnb();
    }

    function test_feeRecipientUsesPoolSnapshotWhenFactoryTreasuryChanges() public {
        vm.prank(OWNER);
        poolFactory.setTreasury(ERIN);
        uint256 id = _list(ALICE, 10, UNIT_BNB);
        _fill(DAVE, id, 10, 1 ether);
        assertEq(pool.treasury(), TREASURY);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.01 ether);
        assertEq(shareMarket.bnbOwed(ERIN), 0);
    }

    function test_sellerAndTreasurySameAddressAccumulateRatherThanOverwrite() public {
        _transfer(ALICE, TREASURY, 10);
        uint256 id = _list(TREASURY, 10, UNIT_BNB);
        _fill(DAVE, id, 10, 1 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 1 ether);
        assertEq(shareMarket.totalBnbOwed(), 1 ether);
        uint256 before = TREASURY.balance;
        vm.prank(TREASURY);
        shareMarket.withdrawBnb();
        assertEq(TREASURY.balance - before, 1 ether);
        assertEq(address(shareMarket).balance, 0);
    }

    function test_zeroPriceOrderTransfersFreelyWithNoFeeOrBnbLiability() public {
        uint256 id = _list(ALICE, 12, 0);
        _fill(DAVE, id, 4, 0);
        _fill(ERIN, id, 8, 0);
        assertEq(pool.balanceOf(ALICE), 37);
        assertEq(pool.balanceOf(DAVE), 4);
        assertEq(pool.balanceOf(ERIN), 8);
        assertEq(shareMarket.bnbOwed(ALICE), 0);
        assertEq(shareMarket.bnbOwed(TREASURY), 0);
        assertEq(shareMarket.totalBnbOwed(), 0);
        assertFalse(shareMarket.orders(id).active);
    }

    function test_feeRoundsDownPerPartialFillAndRemainderStaysWithSeller() public {
        uint256 id = _list(ALICE, 3, 99);
        _fill(DAVE, id, 1, 99);
        assertEq(shareMarket.bnbOwed(ALICE), 99);
        assertEq(shareMarket.bnbOwed(TREASURY), 0);
        _fill(DAVE, id, 2, 198);
        assertEq(shareMarket.bnbOwed(ALICE), 296);
        assertEq(shareMarket.bnbOwed(TREASURY), 1);
        assertEq(shareMarket.totalBnbOwed(), 297);
    }

    function test_listingAndCancelDoNotTransferSharesOrCreateMemberCheckpoints() public {
        uint48 before = pool.clock();
        vm.recordLogs();
        uint256 id = _list(ALICE, 49, UNIT_BNB);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(address(shareMarket)), 0);
        assertEq(pool.memberCount(), 3);
        assertEq(_shareVault().lockedShares(ALICE), 49);
        vm.prank(ALICE);
        shareMarket.cancel(id);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        _assertNoOwnershipEvents(entries);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        vm.warp(block.timestamp + 1);
        assertEq(pool.getPastShares(ALICE, before), 49);
        assertEq(pool.getPastMemberCount(before), 3);
        assertEq(pool.getPastShares(address(shareMarket), before), 0);
    }

    function test_multipleOrdersCannotLockMoreThanSellerOwnsAndCancelFreesOnlyRemainder() public {
        uint256 first = _list(ALICE, 30, UNIT_BNB);
        uint256 second = _list(ALICE, 19, UNIT_BNB);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.InsufficientUnlockedShares.selector);
        shareMarket.list(address(pool), 1, UNIT_BNB);
        assertEq(shareMarket.nextOrderId(), 3);
        _fill(DAVE, first, 5, 5 * UNIT_BNB);
        assertEq(_shareVault().lockedShares(ALICE), 44);
        vm.prank(ALICE);
        shareMarket.cancel(first);
        assertEq(_shareVault().lockedShares(ALICE), 19);
        assertEq(shareMarket.orders(second).remaining, 19);
        assertEq(pool.balanceOf(ALICE), 44);
    }

    function test_lockedSharesRemainOwnedWhileBuyerAccumulatesPastFortyNine() public {
        uint256 aliceOrder = _list(ALICE, 20, UNIT_BNB);
        uint256 bobOrder = _list(BOB, 49, 0);
        _fill(BOB, aliceOrder, 20, 20 * UNIT_BNB);
        assertEq(pool.balanceOf(BOB), 69);
        assertEq(_shareVault().lockedShares(BOB), 49);
        assertEq(shareMarket.orders(bobOrder).remaining, 49);
        assertEq(shareMarket.orders(aliceOrder).remaining, 0);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.InsufficientUnlockedShares.selector);
        shareMarket.list(address(pool), 21, UNIT_BNB);
        _list(BOB, 20, UNIT_BNB);
        assertEq(_shareVault().lockedShares(BOB), 69);
        assertEq(shareMarket.totalBnbOwed(), 2 ether);
    }

    function test_wrongAmountWrongPaymentAndUnknownOrderAreAtomic() public {
        vm.prank(ALICE);
        vm.expectRevert(IShareMarket.InvalidAmount.selector);
        shareMarket.list(address(pool), 0, UNIT_BNB);
        vm.prank(ALICE);
        vm.expectRevert(IShareMarket.InvalidAmount.selector);
        shareMarket.list(address(pool), 101, UNIT_BNB);
        uint256 id = _list(ALICE, 10, UNIT_BNB);
        vm.deal(DAVE, 3 ether);
        vm.startPrank(DAVE);
        vm.expectRevert(IShareMarket.InvalidAmount.selector);
        shareMarket.fill(id, 0);
        vm.expectRevert(IShareMarket.InvalidAmount.selector);
        shareMarket.fill{value: 1.1 ether}(id, 11);
        vm.expectRevert(IShareMarket.PaymentMismatch.selector);
        shareMarket.fill{value: UNIT_BNB - 1}(id, 1);
        vm.expectRevert(IShareMarket.PaymentMismatch.selector);
        shareMarket.fill{value: UNIT_BNB + 1}(id, 1);
        vm.expectRevert(IShareMarket.InactiveOrder.selector);
        shareMarket.fill(999, 1);
        vm.stopPrank();
        assertEq(shareMarket.orders(id).remaining, 10);
        assertEq(_shareVault().lockedShares(ALICE), 10);
        assertEq(shareMarket.totalBnbOwed(), 0);
        assertEq(address(shareMarket).balance, 0);
    }

    function test_unregisteredMarketAndUnknownPoolCannotCreateOrders() public {
        ShareMarket impostor = _marketFor(poolFactory);
        vm.prank(ALICE);
        vm.expectRevert(IShareMarket.MarketNotRegistered.selector);
        impostor.list(address(pool), 1, 0);
        vm.prank(ALICE);
        vm.expectRevert(IShareMarket.InvalidPool.selector);
        shareMarket.list(address(0xBEEF), 1, 0);
        vm.prank(ALICE);
        vm.expectRevert(IShareMarket.InvalidPool.selector);
        shareMarket.list(address(vaultImplementation), 1, 0);
        assertEq(shareMarket.nextOrderId(), 1);
    }

    function test_fundingPoolCannotListShares() public {
        IPoolVault fresh = IPoolVault(address(_createPool(defaultParams)));
        vm.prank(ALICE);
        vm.expectRevert(IShareMarket.WrongState.selector);
        shareMarket.list(address(fresh), 1, UNIT_BNB);
    }

    function test_cancelOnlySellerAndCannotRepeatOrFillCancelledOrder() public {
        uint256 id = _list(ALICE, 10, UNIT_BNB);
        vm.prank(OPERATOR);
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        shareMarket.cancel(id);
        vm.prank(OWNER);
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        shareMarket.cancel(id);
        vm.prank(ALICE);
        shareMarket.cancel(id);
        vm.prank(ALICE);
        vm.expectRevert(IShareMarket.InactiveOrder.selector);
        shareMarket.cancel(id);
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.InactiveOrder.selector);
        shareMarket.fill(id, 1);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(_shareVault().lockedShares(ALICE), 0);
    }

    function testFuzz_listedOrClosedCannotFillButCancelOnlyUnlocks(bool closed) public {
        uint256 id = _list(ALICE, 10, UNIT_BNB);
        if (closed) RewardsVaultHarness(payable(address(pool))).fixtureSetTerminalState(IPoolVault.State.Closed);
        else ShareTransferVaultHarness(payable(address(pool))).fixtureSetListed();
        vm.deal(DAVE, UNIT_BNB);
        vm.prank(DAVE);
        vm.expectRevert(IShareMarket.WrongState.selector);
        shareMarket.fill{value: UNIT_BNB}(id, 1);
        assertEq(shareMarket.orders(id).remaining, 10);
        assertEq(shareMarket.totalBnbOwed(), 0);
        vm.recordLogs();
        vm.prank(ALICE);
        shareMarket.cancel(id);
        _assertNoOwnershipEvents(vm.getRecordedLogs());
        assertEq(_shareVault().lockedShares(ALICE), 0);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(DAVE), 0);
        assertEq(pool.memberCount(), 3);
        // Listed/Closed is a lifecycle fixture here, not an implemented T1e sale.
    }

    function test_rejectingSellerCannotBlockFillAndFailedWithdrawalKeepsCredit() public {
        ShareMarketPaymentActor receiver = new ShareMarketPaymentActor();
        receiver.setReject(true);
        _transfer(ALICE, address(receiver), 10);
        uint256 id = _list(address(receiver), 10, UNIT_BNB);
        _fill(DAVE, id, 10, 1 ether);
        assertEq(shareMarket.bnbOwed(address(receiver)), 0.99 ether);
        assertEq(pool.balanceOf(DAVE), 10);
        vm.prank(address(receiver));
        vm.expectRevert(IShareMarket.TransferFailed.selector);
        shareMarket.withdrawBnb();
        assertEq(shareMarket.bnbOwed(address(receiver)), 0.99 ether);
        assertEq(shareMarket.totalBnbOwed(), 1 ether);
        receiver.setReject(false);
        vm.prank(address(receiver));
        shareMarket.withdrawBnb();
        assertEq(address(receiver).balance, 0.99 ether);
        assertEq(shareMarket.bnbOwed(address(receiver)), 0);
        assertEq(shareMarket.totalBnbOwed(), 0.01 ether);
    }

    function test_withdrawBnbCallbackCannotReenterAndGetPaidTwice() public {
        ShareMarketPaymentActor receiver = new ShareMarketPaymentActor();
        _transfer(ALICE, address(receiver), 10);
        uint256 id = _list(address(receiver), 10, UNIT_BNB);
        _fill(DAVE, id, 10, 1 ether);
        receiver.setCallback(address(shareMarket), abi.encodeCall(IShareMarket.withdrawBnb, ()));
        vm.prank(address(receiver));
        shareMarket.withdrawBnb();
        assertTrue(receiver.callbackAttempted());
        assertFalse(receiver.callbackSucceeded());
        assertEq(receiver.callbackResult(), abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        assertEq(address(receiver).balance, 0.99 ether);
        assertEq(shareMarket.bnbOwed(address(receiver)), 0);
        assertEq(shareMarket.totalBnbOwed(), 0.01 ether);
    }

    function test_miningCallbackCannotReenterFillDuringLockedTransfer() public {
        uint256 id = _list(ALICE, 10, 0);
        _queueReward(10000);
        mining.setClaimReentry(address(shareMarket), abi.encodeCall(IShareMarket.fill, (id, uint256(1))));
        _fill(DAVE, id, 3, 0);
        assertTrue(mining.reentryAttempted());
        assertFalse(mining.reentrySucceeded());
        assertEq(mining.reentryResult(), abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        assertEq(shareMarket.orders(id).remaining, 7);
        assertEq(pool.balanceOf(DAVE), 3);
        assertEq(_shareVault().lockedShares(ALICE), 7);
    }

    function test_failedFinalMiningClaimRollsBackFillBnbCreditAndLocks() public {
        uint256 id = _list(ALICE, 10, UNIT_BNB);
        _queueReward(10000);
        mining.setClaimFault(1);
        vm.deal(DAVE, 1 ether);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        shareMarket.fill{value: 1 ether}(id, 10);
        assertEq(shareMarket.orders(id).remaining, 10);
        assertTrue(shareMarket.orders(id).active);
        assertEq(_shareVault().lockedShares(ALICE), 10);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(DAVE), 0);
        assertEq(shareMarket.totalBnbOwed(), 0);
        assertEq(address(shareMarket).balance, 0);
        assertEq(DAVE.balance, 1 ether);
        assertEq(mining.unreported(key), 10000);
    }

    function test_registrationRequiresActual48HourQueueAndCannotInstantlyReplace() public {
        PoolFactory fresh = _freshFactory();
        ShareMarket candidate = _marketFor(fresh);
        bytes memory data = abi.encodeCall(PoolFactory.registerShareMarket, (address(candidate)));
        vm.prank(OWNER);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        fresh.registerShareMarket(address(candidate));
        vm.prank(OPERATOR);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        fresh.registerShareMarket(address(candidate));
        bytes32 salt = keccak256("market-registration-boundary");
        _schedule(address(fresh), data, salt);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        timelock.execute(address(fresh), 0, data, bytes32(0), salt);
        assertEq(fresh.shareMarket(), address(0));
        vm.warp(block.timestamp + 1);
        vm.prank(DAVE);
        timelock.execute(address(fresh), 0, data, bytes32(0), salt);
        assertEq(fresh.shareMarket(), address(candidate));
        ShareMarket replacement = _marketFor(fresh);
        data = abi.encodeCall(PoolFactory.registerShareMarket, (address(replacement)));
        salt = keccak256("market-address-cannot-be-replaced");
        _schedule(address(fresh), data, salt);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(PoolFactory.ShareMarketAlreadyRegistered.selector);
        timelock.execute(address(fresh), 0, data, bytes32(0), salt);
        assertEq(fresh.shareMarket(), address(candidate));
    }

    function test_registrationChecksCodeFactoryAndTimelockIdentityEvenThroughQueue() public {
        PoolFactory fresh = _freshFactory();
        address[3] memory candidates = [
            address(0xBEEF),
            address(new ShareMarketIdentityStub(address(poolFactory), address(timelock))),
            address(new ShareMarketIdentityStub(address(fresh), address(0xBAD)))
        ];
        for (uint256 i; i < candidates.length; ++i) {
            bytes memory data = abi.encodeCall(PoolFactory.registerShareMarket, (candidates[i]));
            bytes32 salt = keccak256(abi.encode("bad-market-identity", i));
            _schedule(address(fresh), data, salt);
            vm.warp(block.timestamp + 48 hours);
            vm.expectRevert(i == 0 ? PoolFactory.InvalidAddress.selector : PoolFactory.InvalidGovernance.selector);
            timelock.execute(address(fresh), 0, data, bytes32(0), salt);
            assertEq(fresh.shareMarket(), address(0));
        }
    }

    function test_marketInitializeLockedAndRejectsWrongGovernance() public {
        ShareMarket implementation = new ShareMarket();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(address(poolFactory), address(timelock));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        shareMarket.initialize(address(poolFactory), address(timelock));
        vm.expectRevert(IShareMarket.InvalidAddress.selector);
        new ERC1967Proxy(
            address(implementation), abi.encodeCall(ShareMarket.initialize, (address(0), address(timelock)))
        );
        PoolTimelock otherTimelock = new PoolTimelock(OWNER);
        vm.expectRevert(IShareMarket.InvalidGovernance.selector);
        new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(ShareMarket.initialize, (address(poolFactory), address(otherTimelock)))
        );
    }

    function test_uupsUpgradeRequiresActual48HourQueueAndPreservesOrderAndCredit() public {
        uint256 id = _list(ALICE, 10, UNIT_BNB);
        _fill(DAVE, id, 3, 3 * UNIT_BNB);
        ShareMarketV2Fixture next = new ShareMarketV2Fixture();
        vm.prank(OWNER);
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        shareMarket.upgradeToAndCall(address(next), "");
        vm.prank(OPERATOR);
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        shareMarket.upgradeToAndCall(address(next), "");
        bytes memory data = abi.encodeCall(shareMarket.upgradeToAndCall, (address(next), bytes("")));
        bytes32 salt = keccak256("share-market-v2");
        _schedule(address(shareMarket), data, salt);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        timelock.execute(address(shareMarket), 0, data, bytes32(0), salt);
        vm.warp(block.timestamp + 1);
        timelock.execute(address(shareMarket), 0, data, bytes32(0), salt);
        assertEq(ShareMarketV2Fixture(address(shareMarket)).version(), 2);
        assertEq(shareMarket.factory(), address(poolFactory));
        assertEq(shareMarket.timelock(), address(timelock));
        assertEq(poolFactory.shareMarket(), address(shareMarket));
        assertEq(shareMarket.nextOrderId(), 2);
        IShareMarket.Order memory order = shareMarket.orders(id);
        assertEq(order.seller, ALICE);
        assertEq(order.pool, address(pool));
        assertEq(order.remaining, 7);
        assertEq(order.pricePerUnit, UNIT_BNB);
        assertTrue(order.active);
        assertEq(_shareVault().lockedShares(ALICE), 7);
        assertEq(shareMarket.bnbOwed(ALICE), 0.297 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.003 ether);
        assertEq(shareMarket.totalBnbOwed(), 0.3 ether);
        _fill(ERIN, id, 7, 7 * UNIT_BNB);
        assertFalse(shareMarket.orders(id).active);
        assertEq(shareMarket.bnbOwed(ALICE), 0.99 ether);
    }

    function _assertNoOwnershipEvents(Vm.Log[] memory entries) private view {
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].emitter != address(pool) || entries[i].topics.length == 0) continue;
            assertTrue(entries[i].topics[0] != TRANSFER_TOPIC, "locking cannot transfer beneficial shares");
            assertTrue(entries[i].topics[0] != MEMBER_TOPIC, "locking cannot change membership");
        }
    }
}
