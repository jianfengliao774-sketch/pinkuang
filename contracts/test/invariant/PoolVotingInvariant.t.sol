// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolSaleState} from "../../src/PoolSaleState.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";

/// @dev Independent ownership ledger. Snapshot weights come from the handler's
/// current ownership when proposal creation freezes transfers, never from Vault
/// checkpoints, proposal records or votes.
/// Every transfer, market fill, proposal and vote uses a production entry point.
contract PoolVotingHandler is Test {
    uint256 private constant MAX_PROPOSALS = 16;
    PoolVault public immutable vault;
    ShareMarket public immutable market;
    uint256 public immutable acquisitionCost;
    address[6] public actors;
    uint256[6] public balances;
    uint256[6] public lastProposed;
    uint256 public proposalCount;
    uint256 public successfulTransfers;
    uint256[3] public rejectedTransfersByRoute;
    uint256 public successfulVotes;
    uint256 public rejectedVotes;
    uint256 public rejectedProposals;

    struct GhostProposal {
        uint256 actor;
        uint256 proposedAt;
        uint256 price;
        uint256[6] weights;
        bool[6] voted;
        bool[6] support;
    }

    mapping(uint256 => GhostProposal) internal proposals;

    constructor(PoolVault vault_, ShareMarket market_, address[6] memory actors_, uint256 acquisitionCost_) {
        vault = vault_;
        market = market_;
        actors = actors_;
        acquisitionCost = acquisitionCost_;
        // FundingTestBase buys the NFT with these original beneficial holdings.
        balances = [uint256(49), 49, 2, 0, 0, 0];
    }

    function advanceTime(uint256 seed) public {
        uint256 mode = seed % 8;
        uint256 delta;
        if (mode == 1) {
            delta = 1;
        } else if (mode == 2) {
            delta = 1 days - 1;
        } else if (mode == 3) {
            delta = 1 days;
        } else if (mode == 4) {
            delta = 7 days;
        } else if (mode == 5 && proposalCount != 0) {
            uint256 deadline = proposals[proposalCount].proposedAt + 1 days;
            if (deadline > block.timestamp) delta = deadline - block.timestamp;
        } else if ((mode == 6 || mode == 7) && proposalCount != 0) {
            uint256 nextProposalAt = proposals[proposalCount].proposedAt + 7 days;
            uint256 target = mode == 7 ? nextProposalAt - 1 : nextProposalAt;
            if (target > block.timestamp) delta = target - block.timestamp;
        }
        if (delta == 0) return;
        vm.warp(block.timestamp + delta);
    }

    function moveShares(uint256 fromSeed, uint256 toSeed, uint256 amountSeed, uint256 routeSeed) public {
        uint256 from = fromSeed % 6;
        uint256 to = toSeed % 6;
        if (from == to || balances[from] == 0 || balances[to] == 100) return;
        uint256 maximum = balances[from] < 100 - balances[to] ? balances[from] : 100 - balances[to];
        uint256 amount = bound(amountSeed, 1, maximum);
        uint256 route = routeSeed % 3;
        bool frozen = _tradingFrozen();
        bool ok;
        bytes memory result;
        if (route == 0) {
            vm.prank(actors[from]);
            (ok, result) = address(vault).call(abi.encodeCall(PoolVault.transfer, (actors[to], amount)));
        } else if (route == 1) {
            vm.prank(actors[from]);
            vault.approve(address(this), amount);
            (ok, result) =
                address(vault).call(abi.encodeCall(PoolVault.transferFrom, (actors[from], actors[to], amount)));
        } else {
            // Zero-price orders exercise the real lock/fill path without inventing
            // BNB credits in this voting-focused ownership model.
            vm.prank(actors[from]);
            (ok, result) = address(market).call(abi.encodeCall(ShareMarket.list, (address(vault), amount, 0)));
            if (ok) {
                uint256 orderId = abi.decode(result, (uint256));
                vm.prank(actors[to]);
                market.fill(orderId, amount);
                assertFalse(market.orders(orderId).active);
            }
        }
        assertEq(ok, !frozen, "share route must reject exactly during the independent voting window");
        if (frozen) {
            assertEq(bytes4(result), route == 2 ? IShareMarket.WrongState.selector : IPoolVault.ProposalActive.selector);
            assertEq(vault.balanceOf(actors[from]), balances[from]);
            assertEq(vault.balanceOf(actors[to]), balances[to]);
            assertEq(vault.lockedShares(actors[from]), 0);
            if (route == 1) assertEq(vault.allowance(actors[from], address(this)), amount);
            ++rejectedTransfersByRoute[route];
            return;
        }
        if (route < 2) assertTrue(abi.decode(result, (bool)));
        if (route == 1) assertEq(vault.allowance(actors[from], address(this)), 0);
        assertEq(vault.lockedShares(actors[from]), 0);
        balances[from] -= amount;
        balances[to] += amount;
        ++successfulTransfers;
    }

    function propose(uint256 actorSeed, uint256 price) public {
        if (proposalCount == MAX_PROPOSALS) return;
        uint256 actor = actorSeed % 6;
        bytes4 expectedError;
        if (balances[actor] == 0) {
            expectedError = IPoolVault.NotMember.selector;
        } else if (price == 0) {
            expectedError = IPoolVault.InvalidSalePrice.selector;
        } else if (_tradingFrozen()) {
            expectedError = IPoolVault.ProposalActive.selector;
        } else if (proposalCount != 0 && block.timestamp < proposals[proposalCount].proposedAt + 7 days) {
            expectedError = IPoolVault.ProposeCooldown.selector;
        } else if (lastProposed[actor] != 0 && block.timestamp - lastProposed[actor] < 7 days) {
            expectedError = IPoolVault.ProposeCooldown.selector;
        }
        vm.prank(actors[actor]);
        (bool ok, bytes memory result) = address(vault).call(abi.encodeCall(PoolVault.propose, (price, price, 0)));
        assertEq(ok, expectedError == bytes4(0), "proposal eligibility differs from independent model");
        if (!ok) {
            assertEq(bytes4(result), expectedError, "rejected proposal must preserve the expected failure boundary");
            ++rejectedProposals;
            return;
        }
        uint256 id = abi.decode(result, (uint256));
        assertEq(id, ++proposalCount);
        lastProposed[actor] = block.timestamp;
        GhostProposal storage p = proposals[id];
        p.actor = actor;
        p.proposedAt = block.timestamp;
        p.price = price;
        p.weights = balances;
    }

    function vote(uint256 actorSeed, uint256 proposalSeed, bool support) public {
        uint256 actor = actorSeed % 6;
        uint256 id = proposalSeed % (proposalCount + 2); // Includes unknown 0 and next id.
        GhostProposal storage p = proposals[id];
        bool eligible = id != 0 && id == proposalCount && block.timestamp < p.proposedAt + 1 days
            && p.weights[actor] != 0 && !p.voted[actor];
        vm.prank(actors[actor]);
        (bool ok,) = address(vault).call(abi.encodeCall(PoolVault.vote, (id, support)));
        assertEq(ok, eligible, "vote eligibility differs from independent model");
        if (!ok) {
            ++rejectedVotes;
            return;
        }
        p.voted[actor] = true;
        p.support[actor] = support;
        ++successfulVotes;
    }

    function assertOwnershipAndSnapshots() external view {
        uint256 currentMembers;
        uint256 total;
        for (uint256 a; a < 6; ++a) {
            assertEq(vault.balanceOf(actors[a]), balances[a]);
            assertEq(vault.lastProposed(actors[a]), lastProposed[a]);
            assertLe(balances[a], 100);
            total += balances[a];
            if (balances[a] != 0) ++currentMembers;
        }
        assertEq(total, 100);
        assertEq(vault.memberCount(), currentMembers);
        assertEq(vault.totalSupply(), 100);
        assertEq(vault.balanceOf(address(market)), 0);
        assertEq(vault.activeProposalId(), proposalCount);
        assertEq(vault.nextProposalId(), proposalCount + 1);
        assertEq(vault.purchaseCost(), acquisitionCost);
        assertEq(vault.shareTradingAllowed(), !_tradingFrozen());
        for (uint256 id = 1; id <= proposalCount; ++id) {
            GhostProposal storage expected = proposals[id];
            if (id > 1) assertGe(expected.proposedAt, proposals[id - 1].proposedAt + 7 days);
            PoolSaleState.Proposal memory actual = vault.getProposal(id);
            uint256 members;
            uint256 shares;
            for (uint256 a; a < 6; ++a) {
                if (expected.weights[a] != 0) ++members;
                shares += expected.weights[a];
                if (actual.snapshotTs == vault.clock()) {
                    assertEq(vault.balanceOf(actors[a]), expected.weights[a]);
                } else {
                    assertEq(vault.getPastShares(actors[a], actual.snapshotTs), expected.weights[a]);
                }
            }
            assertEq(shares, 100);
            assertEq(actual.snapshotMemberCount, members);
            assertEq(actual.snapshotTotalShares, shares);
            assertEq(actual.snapshotTs, expected.proposedAt);
            assertEq(actual.endsAt, expected.proposedAt + 1 days);
            assertEq(actual.proposer, actors[expected.actor]);
            assertEq(actual.price, expected.price);
            assertEq(actual.refPrice, expected.price);
            assertEq(actual.refAt, 0);
            assertFalse(actual.executed);
        }
    }

    function assertVotesAndMajorities() external view {
        for (uint256 id = 1; id <= proposalCount; ++id) {
            GhostProposal storage p = proposals[id];
            uint256 yesMembers;
            uint256 yesShares;
            uint256 members;
            for (uint256 a; a < 6; ++a) {
                if (p.weights[a] != 0) ++members;
                assertEq(vault.hasVoted(id, actors[a]), p.voted[a]);
                if (p.voted[a] && p.support[a]) {
                    ++yesMembers;
                    yesShares += p.weights[a];
                }
            }
            PoolSaleState.Proposal memory actual = vault.getProposal(id);
            assertEq(actual.yesCount, yesMembers);
            assertEq(actual.yesShares, yesShares);
            assertLe(yesMembers, members);
            assertLe(yesShares, 100);
            uint256 requiredShares = p.price < acquisitionCost ? 60 : 51;
            assertEq(vault.proposalPassed(id), yesMembers > members / 2 && yesShares >= requiredShares);
        }
    }

    function _tradingFrozen() private view returns (bool) {
        return proposalCount != 0 && block.timestamp < proposals[proposalCount].proposedAt + 1 days;
    }
}

contract PoolVotingInvariantTest is ShareTransferTestBase {
    PoolVotingHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.warp(uint256(PoolVault(payable(address(pool))).activatedAt()) + 7 days);
        address[6] memory actors = [ALICE, BOB, CAROL, DAVE, ERIN, FRANK];
        handler = new PoolVotingHandler(PoolVault(payable(address(pool))), shareMarket, actors, REWARD_PRICE);

        // Non-vacuous seed: a same-second exit precedes the proposal snapshot;
        // all three ownership routes then fail, including an already-listed market order.
        vm.prank(BOB);
        uint256 priorOrder = shareMarket.list(address(pool), 10, 0);
        handler.moveShares(0, 3, 49, 0);
        handler.propose(1, 5 ether);
        handler.vote(0, 1, true);
        handler.vote(3, 1, true);
        handler.vote(0, 1, false);
        handler.vote(2, 1, false);
        handler.vote(1, 1, true);
        handler.propose(3, 6 ether);
        handler.moveShares(3, 4, 10, 0);
        handler.moveShares(3, 4, 10, 1);
        handler.moveShares(3, 4, 10, 2);
        vm.prank(ERIN);
        vm.expectRevert(IShareMarket.WrongState.selector);
        shareMarket.fill(priorOrder, 1);
        assertEq(shareMarket.orders(priorOrder).remaining, 10);
        assertEq(PoolVault(payable(address(pool))).lockedShares(BOB), 10);
        vm.prank(BOB);
        shareMarket.cancel(priorOrder);

        // Voting expires after one day; ownership routes work during the remaining six-day cooldown.
        handler.advanceTime(5);
        handler.moveShares(3, 0, 1, 0);
        handler.moveShares(1, 4, 10, 1);
        handler.moveShares(4, 5, 5, 2);
        handler.moveShares(0, 3, 1, 0);
        handler.advanceTime(0); // A same-second reentry must not add a sixth snapshot member.
        handler.vote(1, 1, true);
        handler.propose(3, 6 ether);
        handler.advanceTime(7); // Last second of the pool-wide cooldown still rejects a different proposer.
        handler.propose(4, 6 ether);
        handler.advanceTime(6);
        handler.propose(3, 6 ether);
        handler.vote(3, 2, true);
        handler.vote(4, 2, true);
        handler.vote(5, 2, true); // Three of five owners, 59 shares: preserve a positive historical result.
        assertTrue(PoolVault(payable(address(pool))).proposalPassed(2));

        // The same 59-share majority cannot authorize a discount below the actual acquisition cost.
        handler.advanceTime(6);
        handler.propose(1, 1);
        handler.vote(3, 3, true);
        handler.vote(4, 3, true);
        handler.vote(5, 3, true);
        assertFalse(PoolVault(payable(address(pool))).proposalPassed(3));
        handler.vote(2, 3, true);
        assertTrue(PoolVault(payable(address(pool))).proposalPassed(3));
        handler.propose(3, 0); // Invalid prices cannot allocate an id or change a cooldown.

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = PoolVotingHandler.moveShares.selector;
        selectors[1] = PoolVotingHandler.advanceTime.selector;
        selectors[2] = PoolVotingHandler.propose.selector;
        selectors[3] = PoolVotingHandler.vote.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_snapshotOwnershipSurvivesArbitraryShareMovesAndProposalReplacement() public view {
        handler.assertOwnershipAndSnapshots();
        assertGe(handler.successfulTransfers(), 5);
        assertGe(handler.proposalCount(), 3);
        for (uint256 route; route < 3; ++route) {
            assertGe(handler.rejectedTransfersByRoute(route), 1);
        }
    }

    function invariant_noDuplicateVotesOrReassignedHistoricalWeight() public view {
        handler.assertVotesAndMajorities();
        assertGe(handler.successfulVotes(), 10);
        assertGe(handler.rejectedVotes(), 3);
        assertGe(handler.rejectedProposals(), 4);
    }
}
