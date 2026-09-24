// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {BurnMockWbnb, BurnMockRouter} from "../utils/BurnMocks.sol";
import {BurnOperations} from "../../src/libraries/BurnOperations.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

interface IBurnVault {
    function executeSale(uint256 proposalId) external;
    function completeSale() external payable;
    function executeBurn(uint256 minOut, uint256 maxIn) external returns (uint256 spent, uint256 burned);
    function burnBudget() external view returns (uint256);
    function totalBurnBnbSpent() external view returns (uint256);
    function totalBurnBem() external view returns (uint256);
    function saleRemainder() external view returns (uint256);
    function saleOutstandingWei() external view returns (uint256);
}

/// @dev Real Factory/BeaconProxy purchase, voting and completeSale; swap endpoints are unit mocks.
contract PoolBurnTest is ShareTransferTestBase {
    address private constant ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address private constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    uint256 private constant SALE_PRICE = 5 ether + 17;
    uint256 private constant OUT = 3e8;
    uint256 private constant INPUT = 0.04 ether;
    uint256 private constant OLD_WBNB = 0.007 ether;
    BurnMockWbnb private wrapped;
    BurnMockRouter private router;
    IBurnVault private burnVault;

    event BurnExecuted(uint256 bnbSpent, uint256 bemBurned);

    function setUp() public override {
        super.setUp();
        vm.etch(WBNB, address(new BurnMockWbnb()).code);
        vm.etch(ROUTER, address(new BurnMockRouter()).code);
        wrapped = BurnMockWbnb(WBNB);
        router = BurnMockRouter(ROUTER);
        burnVault = IBurnVault(address(pool));
        router.configure(type(uint256).max, OUT, OUT);
    }

    function test_fullInputBurnPreservesEveryOtherAssetAndLiability() public {
        _close(SALE_PRICE);
        _donations();
        bytes32 protectedBefore = _protectedDigest();
        uint256 bnbBefore = address(pool).balance;
        uint256 bemBefore = bem.balanceOf(address(pool));
        uint256 deadBefore = bem.balanceOf(DEAD);
        vm.expectEmit(false, false, false, true, address(pool));
        emit BurnExecuted(INPUT, OUT);
        (uint256 spent, uint256 burned) = _burn(OUT, INPUT);
        assertEq(spent, INPUT);
        assertEq(burned, OUT);
        assertEq(bem.balanceOf(DEAD) - deadBefore, OUT);
        assertEq(bem.balanceOf(address(pool)), bemBefore);
        assertEq(address(pool).balance, bnbBefore - INPUT);
        assertEq(wrapped.balanceOf(address(pool)), OLD_WBNB);
        assertEq(wrapped.allowance(address(pool), ROUTER), 0);
        assertEq(router.lastInput(), INPUT);
        assertEq(router.lastMinimum(), OUT);
        assertEq(burnVault.burnBudget(), SALE_PRICE / 50 - INPUT);
        assertEq(burnVault.totalBurnBnbSpent(), INPUT);
        assertEq(burnVault.totalBurnBem(), OUT);
        assertEq(_protectedDigest(), protectedBefore);
    }

    function test_maxInOnlyBoundsThisCallAndCannotSpendMoreThanBudget() public {
        _close(SALE_PRICE);
        (uint256 spent,) = _burn(1, type(uint256).max);
        assertEq(spent, SALE_PRICE / 50);
        assertEq(router.lastInput(), SALE_PRICE / 50);
        assertEq(burnVault.burnBudget(), 0);
        vm.prank(OPERATOR);
        vm.expectRevert(BurnOperations.NothingToBurn.selector);
        burnVault.executeBurn(0, 1);
    }

    function test_partialInputRefundUses2300GasProxyReceiveAndRetainsOldWbnb() public {
        _close(SALE_PRICE);
        _donations();
        router.configure(0.01 ether, OUT, OUT);
        uint256 bnbBefore = address(pool).balance;
        bytes32 protectedBefore = _protectedDigest();
        (uint256 spent,) = _burn(1, INPUT);
        assertEq(spent, 0.01 ether);
        assertEq(wrapped.lastWithdrawal(), 0.03 ether);
        assertEq(address(pool).balance, bnbBefore - spent);
        assertEq(wrapped.balanceOf(address(pool)), OLD_WBNB);
        assertEq(burnVault.burnBudget(), SALE_PRICE / 50 - spent);
        assertEq(_protectedDigest(), protectedBefore);
        assertEq(wrapped.allowance(address(pool), ROUTER), 0);
        // Another refund proves the temporary receive authorization was cleared normally.
        _burn(1, INPUT);
        assertEq(burnVault.totalBurnBnbSpent(), 0.02 ether);
    }

    function test_zeroActualSpendStillBurnsOutputAndRestoresEntireBudget() public {
        _close(SALE_PRICE);
        _donations();
        router.configure(0, OUT, OUT);
        uint256 bnbBefore = address(pool).balance;
        bytes32 protectedBefore = _protectedDigest();
        (uint256 spent, uint256 burned) = _burn(1, INPUT);
        assertEq(spent, 0);
        assertEq(burned, OUT);
        assertEq(burnVault.burnBudget(), SALE_PRICE / 50);
        assertEq(burnVault.totalBurnBnbSpent(), 0);
        assertEq(burnVault.totalBurnBem(), OUT);
        assertEq(wrapped.lastWithdrawal(), INPUT);
        assertEq(wrapped.balanceOf(address(pool)), OLD_WBNB);
        assertEq(address(pool).balance, bnbBefore);
        assertEq(_protectedDigest(), protectedBefore);
    }

    function test_zeroMinOutAllowedWithPositiveActualOutput() public {
        _close(SALE_PRICE);
        (, uint256 burned) = _burn(0, INPUT);
        assertEq(burned, OUT);
        assertEq(router.lastMinimum(), 0);
    }

    function test_memberAndTreasuryWithdrawalsBeforeBurnLeaveBudgetBacked() public {
        _close(SALE_PRICE);
        vm.prank(ALICE);
        pool.withdrawBnb();
        vm.prank(TREASURY);
        pool.withdrawBnb();
        assertEq(pool.bnbOwed(ALICE), 0);
        assertEq(pool.bnbOwed(TREASURY), 0);
        bytes32 protectedBefore = _protectedDigest();
        _burn(1, INPUT);
        assertEq(_protectedDigest(), protectedBefore);
        uint256 bobOwed = pool.bnbOwed(BOB);
        uint256 beforeBalance = BOB.balance;
        vm.prank(BOB);
        pool.withdrawBnb();
        assertEq(BOB.balance - beforeBalance, bobOwed);
        assertGe(address(pool).balance, pool.totalBnbOwed() + burnVault.burnBudget() + burnVault.saleRemainder());
    }

    function testFuzz_partialPullBudgetConservation(uint256 maximum, uint256 pulled) public {
        _close(SALE_PRICE);
        _donations();
        uint256 initialBudget = burnVault.burnBudget();
        maximum = bound(maximum, 1, initialBudget * 2);
        uint256 approved = maximum < initialBudget ? maximum : initialBudget;
        pulled = bound(pulled, 0, approved);
        router.configure(pulled, OUT, OUT);
        uint256 bnbBefore = address(pool).balance;
        bytes32 protectedBefore = _protectedDigest();
        (uint256 spent, uint256 burned) = _burn(0, maximum);
        assertEq(spent, pulled);
        assertEq(burned, OUT);
        assertEq(burnVault.burnBudget() + burnVault.totalBurnBnbSpent(), initialBudget);
        assertEq(address(pool).balance, bnbBefore - spent);
        assertEq(wrapped.balanceOf(address(pool)), OLD_WBNB);
        assertEq(wrapped.allowance(address(pool), ROUTER), 0);
        assertEq(_protectedDigest(), protectedBefore);
    }

    function test_zeroMaxInAndZeroBudgetRejectWithoutRouterCall() public {
        _close(0);
        _expectAtomicFailure(0, INPUT, BurnOperations.NothingToBurn.selector);
        _expectAtomicFailure(0, 0, BurnOperations.NothingToBurn.selector);
        assertEq(router.calls(), 0);
    }

    function test_zeroMaxInWithFundedBudgetRejects() public {
        _close(SALE_PRICE);
        _expectAtomicFailure(0, 0, BurnOperations.NothingToBurn.selector);
    }

    function test_onlyCurrentOperatorInClosedCanExecute() public {
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.WrongState.selector);
        burnVault.executeBurn(1, INPUT);
        _close(SALE_PRICE);
        address[3] memory callers = [OWNER, ALICE, DAVE];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(IPoolVault.Unauthorized.selector);
            burnVault.executeBurn(1, INPUT);
        }
        vm.prank(OWNER);
        poolFactory.setOperator(DAVE);
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        burnVault.executeBurn(1, INPUT);
        vm.prank(DAVE);
        burnVault.executeBurn(1, INPUT);
        assertEq(burnVault.totalBurnBnbSpent(), INPUT);
    }

    function test_outputBelowMinimumRevertsAllPaymentsAndAccounting() public {
        _close(SALE_PRICE);
        _expectAtomicFailure(OUT + 1, INPUT, BurnOperations.BurnOutputMismatch.selector);
    }

    function test_wrongReportedOutputRevertsAllPaymentsAndAccounting() public {
        _close(SALE_PRICE);
        router.configure(type(uint256).max, OUT, OUT + 1);
        _expectAtomicFailure(1, INPUT, BurnOperations.BurnOutputMismatch.selector);
    }

    function test_zeroOutputRejectsEvenWhenMinimumIsZero() public {
        _close(SALE_PRICE);
        router.configure(type(uint256).max, 0, 0);
        _expectAtomicFailure(0, INPUT, BurnOperations.BurnOutputMismatch.selector);
    }

    function test_routerCannotPullMoreThanExactAllowance() public {
        _close(SALE_PRICE);
        _donations();
        router.configure(INPUT + 1, OUT, OUT);
        bytes32 beforeDigest = _allDigest();
        vm.prank(OPERATOR);
        vm.expectRevert();
        burnVault.executeBurn(1, INPUT);
        assertEq(_allDigest(), beforeDigest);
    }

    function test_routerCannotConsumeDonatedOldWbnb() public {
        _close(SALE_PRICE);
        _donations();
        router.setFault(1);
        _expectAtomicFailure(1, INPUT, BurnOperations.BurnAccountingMismatch.selector);
    }

    function test_routerCannotInflateWrappedRefundBeyondThisInput() public {
        _close(SALE_PRICE);
        router.setFault(2);
        _expectAtomicFailure(1, INPUT, BurnOperations.BurnAccountingMismatch.selector);
    }

    function test_wrongDepositMintAmountRevertsAtomically() public {
        _close(SALE_PRICE);
        wrapped.setFault(1);
        _expectAtomicFailure(1, INPUT, BurnOperations.BurnAccountingMismatch.selector);
    }

    function test_missingNativeRefundRevertsAtomically() public {
        _close(SALE_PRICE);
        router.configure(0, OUT, OUT);
        wrapped.setFault(2);
        _expectAtomicFailure(1, INPUT, BurnOperations.BurnAccountingMismatch.selector);
    }

    function test_wrongNativeRefundAmountFailsReceiveAndRollsBack() public {
        _close(SALE_PRICE);
        router.configure(0, OUT, OUT);
        wrapped.setFault(3);
        bytes32 beforeDigest = _allDigest();
        vm.prank(OPERATOR);
        vm.expectRevert();
        burnVault.executeBurn(1, INPUT);
        assertEq(_allDigest(), beforeDigest);
    }

    function test_deadTransferFailureRollsBackBudgetSwapAndAllBalances() public {
        _close(SALE_PRICE);
        bem.rejectRecipient(DEAD);
        bytes32 beforeDigest = _allDigest();
        vm.prank(OPERATOR);
        vm.expectRevert("injected BEM transfer failure");
        burnVault.executeBurn(1, INPUT);
        assertEq(_allDigest(), beforeDigest);
    }

    function test_privilegedRouterCallbackCannotReenterBurn() public {
        _close(SALE_PRICE);
        vm.prank(OWNER);
        poolFactory.setOperator(ROUTER);
        router.setReentry(abi.encodeCall(IBurnVault.executeBurn, (0, INPUT)));
        vm.prank(ROUTER);
        burnVault.executeBurn(1, INPUT);
        assertTrue(router.reentryAttempted());
        assertFalse(router.reentrySucceeded());
        assertEq(bytes4(router.reentryResult()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(router.calls(), 1);
        assertEq(burnVault.totalBurnBnbSpent(), INPUT);
    }

    function test_privilegedBemCallbackCannotReenterBurn() public {
        _close(SALE_PRICE);
        vm.prank(OWNER);
        poolFactory.setOperator(address(bem));
        bem.setTransferReentry(address(pool), abi.encodeCall(IBurnVault.executeBurn, (0, INPUT)));
        vm.prank(address(bem));
        burnVault.executeBurn(1, INPUT);
        assertTrue(bem.reentryAttempted());
        assertFalse(bem.reentrySucceeded());
        assertEq(bytes4(bem.reentryResult()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(burnVault.totalBurnBem(), OUT);
    }

    function test_plainBnbAndUnsolicitedWbnbSenderRefundRemainRejected() public {
        _close(SALE_PRICE);
        vm.deal(DAVE, 1);
        vm.prank(DAVE);
        (bool success,) = address(pool).call{value: 1}("");
        assertFalse(success);
        vm.deal(WBNB, 1);
        vm.prank(WBNB);
        (success,) = address(pool).call{value: 1}("");
        assertFalse(success);
        vm.prank(WBNB);
        (success,) = address(pool).call("");
        assertFalse(success);
    }

    function _close(uint256 price) private {
        vm.warp(block.timestamp + 7 days);
        _harvestReward(10_000_001);
        vm.prank(ALICE);
        uint256 id = pool.propose(price, 0, 0);
        vm.prank(ALICE);
        pool.vote(id, true);
        vm.prank(BOB);
        pool.vote(id, true);
        burnVault.executeSale(id);
        vm.deal(DAVE, price);
        vm.prank(DAVE);
        burnVault.completeSale{value: price}();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Closed));
        assertEq(burnVault.burnBudget(), price / 50);
    }

    function _donations() private {
        vm.deal(address(pool), address(pool).balance + 0.123 ether);
        wrapped.mint(address(pool), OLD_WBNB);
        bem.mint(address(pool), 71);
    }

    function _burn(uint256 minimum, uint256 maximum) private returns (uint256, uint256) {
        vm.prank(OPERATOR);
        return burnVault.executeBurn(minimum, maximum);
    }

    function _expectAtomicFailure(uint256 minimum, uint256 maximum, bytes4 errorSelector) private {
        bytes32 beforeDigest = _allDigest();
        vm.prank(OPERATOR);
        vm.expectRevert(errorSelector);
        burnVault.executeBurn(minimum, maximum);
        assertEq(_allDigest(), beforeDigest);
    }

    function _protectedDigest() private view returns (bytes32) {
        bytes32 bnbDigest = keccak256(
            abi.encode(
                pool.totalBnbOwed(),
                pool.bnbOwed(ALICE),
                pool.bnbOwed(BOB),
                pool.bnbOwed(CAROL),
                pool.bnbOwed(TREASURY),
                burnVault.saleOutstandingWei(),
                burnVault.saleRemainder(),
                PoolVault(payable(address(pool))).surplusRemainder()
            )
        );
        return keccak256(
            abi.encode(
                bnbDigest,
                rewards.bemAccounted(),
                rewards.accBemPerShare(),
                rewards.epochNet(_epoch()),
                rewards.epochPaid(_epoch()),
                rewards.epochBurned(_epoch()),
                rewards.claimable(ALICE),
                rewards.claimable(BOB),
                rewards.claimable(CAROL)
            )
        );
    }

    function _allDigest() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                _protectedDigest(),
                address(pool).balance,
                wrapped.balanceOf(address(pool)),
                wrapped.balanceOf(ROUTER),
                wrapped.allowance(address(pool), ROUTER),
                bem.balanceOf(address(pool)),
                bem.balanceOf(DEAD),
                burnVault.burnBudget(),
                burnVault.totalBurnBnbSpent(),
                burnVault.totalBurnBem(),
                router.calls()
            )
        );
    }
}
