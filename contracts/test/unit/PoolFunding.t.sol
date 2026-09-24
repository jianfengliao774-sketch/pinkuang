// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract ReenteringFundingRecipient {
    IFundingVault internal immutable vault;
    bool public callbackSeen;
    bool public reentrySucceeded;

    constructor(IFundingVault vault_) {
        vault = vault_;
    }

    function takeRefund() external {
        vault.withdrawBnb();
    }

    receive() external payable {
        callbackSeen = true;
        (reentrySucceeded,) = address(vault).call(abi.encodeCall(IPoolVault.withdrawBnb, ()));
    }
}

contract RejectingFundingRecipient {
    IFundingVault internal immutable vault;

    constructor(IFundingVault vault_) {
        vault = vault_;
    }

    function takeRefund() external {
        vault.withdrawBnb();
    }

    receive() external payable {
        revert("reject BNB");
    }
}

contract FundingTestToken is ERC20 {
    constructor() ERC20("Subscription test token", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PoolFundingTest is FundingTestBase {
    event Deposited(address indexed user, uint8 shares, uint256 amount, uint256 totalRaised);
    event DepositWithdrawn(address indexed user, uint8 shares, uint256 amount);
    event Funded(uint256 totalRaised, uint256 totalShares, uint256 memberCount);
    event Failed(uint8 reason);
    event BnbWithdrawn(address indexed user, uint256 amount);

    function test_initialStateAndAssetBindings() public view {
        _stateIs(IPoolVault.State.Funding);
        assertEq(pool.decimals(), 0);
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.totalRaised(), 0);
        assertEq(pool.unitPriceWei(), UNIT_PRICE);
        assertEq(pool.factory(), address(poolFactory));
        assertEq(pool.treasury(), TREASURY);
        assertEq(pool.asset(), address(0));
        assertEq(pool.assetDecimals(), 18);
        assertEq(pool.params().targetRaise, 6.5 ether);
        assertEq(pool.memberCount(), 0);
        assertFalse(pool.refundsRecorded());
    }

    function test_depositOneAndFortyNineShares() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit Deposited(ALICE, 1, UNIT_PRICE, UNIT_PRICE);
        _deposit(pool, ALICE, 1);
        _deposit(pool, BOB, 49);
        assertEq(pool.shareOf(ALICE), 1);
        assertEq(pool.shareOf(BOB), 49);
        assertEq(pool.contributedWei(ALICE), UNIT_PRICE);
        assertEq(pool.contributedWei(BOB), 49 * UNIT_PRICE);
        assertEq(pool.totalRaised(), 50 * UNIT_PRICE);
        assertEq(pool.memberCount(), 2);
    }

    function test_zeroAndFiftySharesRejected() public {
        vm.expectRevert(IPoolVault.InvalidShareCount.selector);
        pool.deposit(0);
        vm.deal(ALICE, 50 * UNIT_PRICE);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.ShareOutOfRange.selector);
        pool.deposit{value: 50 * UNIT_PRICE}(50);
    }

    function test_cumulativeShareCapAndRepeatMembership() public {
        _deposit(pool, ALICE, 20);
        _deposit(pool, ALICE, 29);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.activeMembers().length, 1);
        vm.deal(ALICE, UNIT_PRICE);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.ShareOutOfRange.selector);
        pool.deposit{value: UNIT_PRICE}(1);
        assertEq(pool.shareOf(ALICE), 49);
    }

    function testFuzz_paymentMustMatchExactIntegerShares(uint8 shares, uint96 mismatch) public {
        shares = uint8(bound(shares, 1, 49));
        uint256 wanted = uint256(shares) * UNIT_PRICE;
        uint256 sent = bound(uint256(mismatch), 0, 100 ether);
        vm.assume(sent != wanted);
        vm.deal(ALICE, sent);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.PaymentMismatch.selector);
        pool.deposit{value: sent}(shares);
        assertEq(pool.totalRaised(), 0);
    }

    function test_nonCanonicalUint8AbiCannotMintFractionalShares() public {
        vm.deal(ALICE, 1 ether);
        // Decimal values have no uint8 ABI encoding. A scaled "1.6" value is
        // rejected by the ABI decoder, rather than being truncated into shares.
        bytes memory data = abi.encodePacked(IPoolVault.deposit.selector, abi.encode(uint256(16e17)));
        vm.prank(ALICE);
        (bool ok,) = address(pool).call{value: 1 ether}(data);
        assertFalse(ok);
        assertEq(pool.totalSupply(), 0);
        assertEq(address(pool).balance, 0);
    }

    function test_overRemainingSharesRejectedThenLastShareCompletes() public {
        _deposit(pool, ALICE, 49);
        _deposit(pool, BOB, 49);
        _deposit(pool, CAROL, 1);
        address david = address(0xDA71D);
        vm.deal(david, 2 * UNIT_PRICE);
        vm.prank(david);
        vm.expectRevert(IPoolVault.ExceedsTarget.selector);
        pool.deposit{value: 2 * UNIT_PRICE}(2);
        _deposit(pool, david, 1);
        _stateIs(IPoolVault.State.Funded);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.totalRaised(), defaultParams.targetRaise);
        assertEq(pool.memberCount(), 4);
    }

    function test_threeMembersFortyNineFortyNineTwoFundExactly() public {
        _deposit(pool, ALICE, 49);
        _deposit(pool, BOB, 49);
        vm.expectEmit(false, false, false, true, address(pool));
        emit Funded(defaultParams.targetRaise, 100, 3);
        _deposit(pool, CAROL, 2);
        _stateIs(IPoolVault.State.Funded);
        assertEq(pool.memberCount(), 3);
        assertEq(address(pool).balance, 6.5 ether);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.withdrawDeposit();
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.deposit(1);
    }

    function test_depositBeforeDeadlineButRejectAtDeadlineAndAfter() public {
        vm.warp(defaultParams.fundingDeadline - 1);
        _deposit(pool, ALICE, 1);
        vm.warp(defaultParams.fundingDeadline);
        vm.deal(BOB, UNIT_PRICE);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        pool.deposit{value: UNIT_PRICE}(1);
        vm.warp(defaultParams.fundingDeadline + 1);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        pool.deposit{value: UNIT_PRICE}(1);
    }

    function test_withdrawDepositIsPullAndRemovesCurrentMember() public {
        _deposit(pool, ALICE, 49);
        _deposit(pool, BOB, 1);
        uint256 before = ALICE.balance;
        vm.expectEmit(true, false, false, true, address(pool));
        emit DepositWithdrawn(ALICE, 49, 3.185 ether);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        assertEq(ALICE.balance, before, "voluntary withdrawal first credits pull balance");
        assertEq(pool.bnbOwed(ALICE), 3.185 ether);
        assertEq(pool.contributedWei(ALICE), 0);
        assertEq(pool.totalRaised(), UNIT_PRICE);
        assertEq(pool.totalSupply(), 1);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.activeMembers()[0], BOB);
        vm.expectEmit(true, false, false, true, address(pool));
        emit BnbWithdrawn(ALICE, 3.185 ether);
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - before, 3.185 ether);
        assertEq(pool.bnbOwed(ALICE), 0);
    }

    function test_withdrawDepositAfterDeadlineBeforeFinalizationRemainsAvailable() public {
        _deposit(pool, ALICE, 7);
        vm.warp(defaultParams.fundingDeadline);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.bnbOwed(ALICE), 7 * UNIT_PRICE);
        pool.finalizeFailure();
        assertEq(pool.bnbOwed(ALICE), 7 * UNIT_PRICE);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.withdrawDeposit();
    }

    function test_redepositDoesNotOverwritePriorPullCreditOrDuplicateRefund() public {
        _deposit(pool, ALICE, 10);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        _deposit(pool, ALICE, 20);
        assertEq(pool.memberCount(), 1);
        assertEq(pool.contributedWei(ALICE), 20 * UNIT_PRICE);
        assertEq(pool.bnbOwed(ALICE), 10 * UNIT_PRICE);
        vm.warp(defaultParams.fundingDeadline);
        pool.finalizeFailure();
        assertEq(pool.bnbOwed(ALICE), 30 * UNIT_PRICE);
        assertEq(pool.contributedWei(ALICE), 0);
        assertEq(pool.shareOf(ALICE), 20, "failure keeps historical shares frozen");
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(address(pool).balance, 0);
    }

    function test_fundingTimeoutCreditsActualContributionsOnly() public {
        _deposit(pool, ALICE, 49);
        _deposit(pool, BOB, 1);
        vm.warp(defaultParams.fundingDeadline);
        vm.expectEmit(false, false, false, true, address(pool));
        emit Failed(0);
        pool.finalizeFailure();
        _stateIs(IPoolVault.State.Refunding);
        assertTrue(pool.refundsRecorded());
        assertEq(pool.bnbOwed(ALICE), 3.185 ether);
        assertEq(pool.bnbOwed(BOB), UNIT_PRICE);
        assertEq(pool.contributedWei(ALICE), 0);
        assertEq(pool.contributedWei(BOB), 0);
        assertEq(pool.totalRaised(), 50 * UNIT_PRICE, "historical raised amount retained on failure");
    }

    function test_purchaseTimeoutAndExactDeadline() public {
        _fundPool();
        vm.warp(defaultParams.purchaseDeadline - 1);
        vm.expectRevert(IPoolVault.DeadlineNotReached.selector);
        pool.finalizeFailure();
        vm.warp(defaultParams.purchaseDeadline);
        vm.expectEmit(false, false, false, true, address(pool));
        emit Failed(1);
        pool.finalizeFailure();
        _stateIs(IPoolVault.State.Refunding);
        assertEq(pool.bnbOwed(ALICE), 49 * UNIT_PRICE);
        assertEq(pool.bnbOwed(BOB), 49 * UNIT_PRICE);
        assertEq(pool.bnbOwed(CAROL), 2 * UNIT_PRICE);
        assertEq(pool.totalSupply(), 100);
    }

    function test_finalizeBeforeFundingDeadlineAndRepeatedFinalizeRejected() public {
        _deposit(pool, ALICE, 1);
        vm.warp(defaultParams.fundingDeadline - 1);
        vm.expectRevert(IPoolVault.DeadlineNotReached.selector);
        pool.finalizeFailure();
        vm.warp(defaultParams.fundingDeadline);
        pool.finalizeFailure();
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.finalizeFailure();
        assertEq(pool.bnbOwed(ALICE), UNIT_PRICE);
    }

    function test_repeatedWithdrawAndNonMemberCannotTakeOthersBnb() public {
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.NotMember.selector);
        pool.withdrawDeposit();
        _deposit(pool, ALICE, 2);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        pool.withdrawBnb();
        vm.prank(ALICE);
        pool.withdrawBnb();
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        pool.withdrawBnb();
    }

    function test_refundHasNoBemClaimIntervalOrExpiry() public {
        _deposit(pool, ALICE, 1);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        vm.prank(ALICE);
        pool.withdrawBnb();
        _deposit(pool, ALICE, 2);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        vm.prank(ALICE);
        pool.withdrawBnb();
        _deposit(pool, ALICE, 3);
        vm.warp(defaultParams.fundingDeadline);
        pool.finalizeFailure();
        vm.warp(block.timestamp + 365 days);
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(address(pool).balance, 0);
    }

    function test_erc20TransfersAndApprovalsCannotReplaceBnbSubscription() public {
        FundingTestToken token = new FundingTestToken();
        token.mint(ALICE, 100 ether);
        vm.startPrank(ALICE);
        token.approve(address(pool), 100 ether);
        token.transfer(address(pool), 100 ether);
        vm.expectRevert(IPoolVault.PaymentMismatch.selector);
        pool.deposit(1);
        vm.stopPrank();
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.totalRaised(), 0);
        assertEq(token.balanceOf(address(pool)), 100 ether);
    }

    function test_plainBnbTransferCannotSubscribe() public {
        vm.deal(ALICE, UNIT_PRICE);
        vm.prank(ALICE);
        (bool ok,) = address(pool).call{value: UNIT_PRICE}("");
        assertFalse(ok);
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.totalRaised(), 0);
        assertEq(address(pool).balance, 0);
    }

    function test_pauseOnlyDepositsAndDoesNotBlockWithdrawalOrFailure() public {
        _deposit(pool, ALICE, 3);
        _deposit(pool, BOB, 2);
        vm.prank(OPERATOR);
        pool.setDepositPaused(true);
        assertTrue(pool.depositPaused());
        vm.expectRevert(IPoolVault.DepositPaused.selector);
        pool.deposit(1);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        vm.prank(ALICE);
        pool.withdrawBnb();
        vm.warp(defaultParams.fundingDeadline);
        pool.finalizeFailure();
        vm.prank(BOB);
        pool.withdrawBnb();
        assertEq(address(pool).balance, 0);
    }

    function test_pauseRequiresOperatorAndResumeRestoresDeposits() public {
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        pool.setDepositPaused(true);
        vm.prank(OWNER);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        pool.setDepositPaused(true);
        vm.prank(OPERATOR);
        pool.setDepositPaused(true);
        vm.prank(OPERATOR);
        pool.setDepositPaused(false);
        _deposit(pool, ALICE, 1);
        assertEq(pool.totalSupply(), 1);
    }

    function test_operatorReplacementRevokesOldAuthorityInExistingPool() public {
        address replacement = address(0x12345);
        vm.prank(OWNER);
        poolFactory.setOperator(replacement);
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        pool.setDepositPaused(true);
        vm.prank(replacement);
        pool.setDepositPaused(true);
        assertTrue(pool.depositPaused());
    }

    function test_assetOwedExposesOnlyNativeBnbLiability() public {
        _deposit(pool, ALICE, 4);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        assertEq(pool.assetOwed(address(0), ALICE), 4 * UNIT_PRICE);
        assertEq(pool.totalBnbOwed(), 4 * UNIT_PRICE);
        vm.expectRevert(IPoolVault.UnsupportedSubscriptionAsset.selector);
        pool.assetOwed(address(0x55), ALICE);
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(pool.totalBnbOwed(), 0);
    }

    function test_shareTransferAndTransferFromRejectedBeforeActive() public {
        _deposit(pool, ALICE, 2);
        vm.startPrank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.transfer(BOB, 1);
        pool.approve(BOB, 1);
        vm.stopPrank();
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.transferFrom(ALICE, BOB, 1);
        assertEq(pool.shareOf(ALICE), 2);
        assertEq(pool.shareOf(BOB), 0);
    }

    function test_checkpointTracksMembershipAndSameTimestampFinalState() public {
        uint48 first = pool.clock();
        _deposit(pool, ALICE, 1);
        _deposit(pool, ALICE, 2);
        _deposit(pool, BOB, 1);
        vm.warp(block.timestamp + 1);
        assertEq(pool.getPastShares(ALICE, first), 3);
        assertEq(pool.getPastShares(BOB, first), 1);
        assertEq(pool.getPastMemberCount(first), 2);
        uint48 second = pool.clock();
        vm.prank(ALICE);
        pool.withdrawDeposit();
        vm.warp(block.timestamp + 1);
        assertEq(pool.getPastShares(ALICE, second), 0);
        assertEq(pool.getPastMemberCount(second), 1);
        assertEq(pool.getPastShares(ALICE, first), 3);
        assertEq(pool.getPastMemberCount(first), 2);
        _deposit(pool, ALICE, 1);
        assertEq(pool.memberCount(), 2);
        assertEq(pool.activeMembers().length, 2);
    }

    function test_currentAndFutureCheckpointLookupsReject() public {
        uint48 nowTs = pool.clock();
        vm.expectRevert(IPoolVault.FutureLookup.selector);
        pool.getPastShares(ALICE, nowTs);
        vm.expectRevert(IPoolVault.FutureLookup.selector);
        pool.getPastMemberCount(nowTs + 1);
        assertEq(pool.getPastShares(ALICE, nowTs - 1), 0);
        assertEq(pool.getPastMemberCount(nowTs - 1), 0);
    }

    function test_failedBnbTransferRestoresPullCredit() public {
        RejectingFundingRecipient recipient = new RejectingFundingRecipient(pool);
        _deposit(pool, address(recipient), 3);
        vm.prank(address(recipient));
        pool.withdrawDeposit();
        uint256 balanceBefore = address(pool).balance;
        vm.expectRevert(IPoolVault.TransferFailed.selector);
        recipient.takeRefund();
        assertEq(pool.bnbOwed(address(recipient)), 3 * UNIT_PRICE);
        assertEq(address(pool).balance, balanceBefore);
    }

    function test_bnbCallbackCannotWithdrawTwice() public {
        ReenteringFundingRecipient recipient = new ReenteringFundingRecipient(pool);
        _deposit(pool, address(recipient), 3);
        vm.prank(address(recipient));
        pool.withdrawDeposit();
        recipient.takeRefund();
        assertTrue(recipient.callbackSeen());
        assertFalse(recipient.reentrySucceeded());
        assertEq(address(recipient).balance, 3 * UNIT_PRICE);
        assertEq(pool.bnbOwed(address(recipient)), 0);
        assertEq(address(pool).balance, 0);
    }

    function test_oneHundredMemberFailureHasBoundedGasAndConservesBnb() public {
        for (uint256 i; i < 100; ++i) {
            _deposit(pool, address(uint160(0x10000 + i)), 1);
        }
        assertEq(pool.memberCount(), 100);
        vm.warp(defaultParams.purchaseDeadline);
        uint256 gasBefore = gasleft();
        pool.finalizeFailure();
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("finalizeFailure 100 members gas", gasUsed);
        assertLt(gasUsed, 8_000_000, "bounded accounting must fit a conservative transaction budget");
        uint256 owed;
        for (uint256 i; i < 100; ++i) {
            address actor = address(uint160(0x10000 + i));
            owed += pool.bnbOwed(actor);
            assertEq(pool.contributedWei(actor), 0);
        }
        assertEq(owed, defaultParams.targetRaise);
        assertEq(address(pool).balance, owed);
    }
}
