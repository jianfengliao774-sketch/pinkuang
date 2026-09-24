// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract FundingHandler is Test {
    IFundingVault public immutable pool;
    address public immutable operator;
    address[8] public actors;
    uint256 public depositedTotal;
    uint256 public paidTotal;
    uint256 public forcedBnbTotal;
    mapping(address => uint256) public depositedBy;
    mapping(address => uint256) public paidBy;

    constructor(IFundingVault pool_, address operator_) {
        pool = pool_;
        operator = operator_;
        for (uint256 i; i < 8; ++i) {
            actors[i] = address(uint160(0x70000 + i));
        }
    }

    function deposit(uint256 actorSeed, uint256 shareSeed) external {
        if (pool.state() != IPoolVault.State.Funding || pool.depositPaused()) return;
        if (block.timestamp >= pool.params().fundingDeadline) return;
        address actor = actors[actorSeed % 8];
        uint256 allowance = 49 - pool.shareOf(actor);
        uint256 remaining = 100 - pool.totalSupply();
        if (allowance > remaining) allowance = remaining;
        if (allowance == 0) return;
        uint8 shares = uint8(bound(shareSeed, 1, allowance));
        uint256 amount = uint256(shares) * pool.unitPriceWei();
        vm.deal(actor, actor.balance + amount);
        vm.prank(actor);
        pool.deposit{value: amount}(shares);
        depositedTotal += amount;
        depositedBy[actor] += amount;
    }

    function withdrawDeposit(uint256 actorSeed) external {
        if (pool.state() != IPoolVault.State.Funding) return;
        address actor = actors[actorSeed % 8];
        if (pool.shareOf(actor) == 0) return;
        vm.prank(actor);
        pool.withdrawDeposit();
    }

    function withdrawBnb(uint256 actorSeed) external {
        address actor = actors[actorSeed % 8];
        uint256 amount = pool.bnbOwed(actor);
        if (amount == 0) return;
        vm.prank(actor);
        pool.withdrawBnb();
        paidTotal += amount;
        paidBy[actor] += amount;
    }

    function advanceTime(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 0, 4 days));
    }

    function finalizeFailure() external {
        IPoolVault.State state = pool.state();
        IPoolVault.PoolParams memory p = pool.params();
        if (state == IPoolVault.State.Funding && block.timestamp < p.fundingDeadline) return;
        if (state == IPoolVault.State.Funded && block.timestamp < p.purchaseDeadline) return;
        if (state != IPoolVault.State.Funding && state != IPoolVault.State.Funded) return;
        pool.finalizeFailure();
    }

    function setPause(bool paused) external {
        vm.prank(operator);
        pool.setDepositPaused(paused);
    }

    function forceBnb(uint96 amountSeed) external {
        uint256 amount = bound(uint256(amountSeed), 0, 1 ether);
        // Models an unsolicited native balance increase, without invoking deposit.
        vm.deal(address(pool), address(pool).balance + amount);
        forcedBnbTotal += amount;
    }
}

contract PoolFundingInvariantTest is FundingTestBase {
    FundingHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new FundingHandler(pool, OPERATOR);
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = FundingHandler.deposit.selector;
        selectors[1] = FundingHandler.withdrawDeposit.selector;
        selectors[2] = FundingHandler.withdrawBnb.selector;
        selectors[3] = FundingHandler.advanceTime.selector;
        selectors[4] = FundingHandler.finalizeFailure.selector;
        selectors[5] = FundingHandler.setPause.selector;
        selectors[6] = FundingHandler.forceBnb.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_shareSupplyAndCurrentMemberIndexAgree() public view {
        uint256 supply;
        uint256 members;
        for (uint256 i; i < 8; ++i) {
            address actor = handler.actors(i);
            uint256 shares = pool.shareOf(actor);
            assertEq(shares, pool.balanceOf(actor));
            assertLe(shares, 49);
            if (shares > 0) ++members;
            supply += shares;
        }
        assertEq(supply, pool.totalSupply());
        assertLe(supply, 100);
        assertEq(members, pool.memberCount());
        address[] memory listed = pool.activeMembers();
        assertEq(listed.length, members);
        for (uint256 i; i < listed.length; ++i) {
            assertGt(pool.shareOf(listed[i]), 0);
            for (uint256 j; j < i; ++j) {
                assertTrue(listed[i] != listed[j], "duplicate active member");
            }
        }
        if (pool.state() == IPoolVault.State.Funded) {
            assertEq(supply, 100);
            assertGe(members, 3);
        }
    }

    function invariant_fundingUsesRealBnbAndRefundsRemainSolvent() public view {
        uint256 contributions;
        uint256 owed;
        for (uint256 i; i < 8; ++i) {
            address actor = handler.actors(i);
            contributions += pool.contributedWei(actor);
            owed += pool.bnbOwed(actor);
            assertLe(handler.paidBy(actor) + pool.bnbOwed(actor), handler.depositedBy(actor));
        }
        IPoolVault.State state = pool.state();
        assertEq(owed, pool.totalBnbOwed());
        uint256 liability = owed;
        if (state == IPoolVault.State.Funding || state == IPoolVault.State.Funded) {
            assertEq(pool.totalRaised(), pool.totalSupply() * pool.unitPriceWei());
            assertEq(contributions, pool.totalRaised());
            assertFalse(pool.refundsRecorded());
            liability += pool.totalRaised();
        } else {
            assertEq(uint256(state), uint256(IPoolVault.State.Refunding));
            assertEq(contributions, 0);
            assertTrue(pool.refundsRecorded());
        }
        assertGe(address(pool).balance, liability);
        assertEq(address(pool).balance + handler.paidTotal(), handler.depositedTotal() + handler.forcedBnbTotal());
    }
}
