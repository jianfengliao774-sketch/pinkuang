// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolSaleState} from "../../src/PoolSaleState.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";

/// @dev Independent ownership ledger. Snapshot weights come from the handler's
/// last completed second, never from Vault checkpoints, proposal records or votes.
/// Every transfer, market fill, proposal and vote uses a production entry point.
contract PoolVotingHandler is Test {
    uint256 private constant MAX_PROPOSALS = 16;
    PoolVault public immutable vault;
    ShareMarket public immutable market;
    address[6] public actors;
    uint256[6] public balances;
    uint256[6] public completedSecondBalances;
    uint256[6] public lastProposed;
    uint256 public proposalCount;
    uint256 public successfulTransfers;
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

    constructor(PoolVault vault_, ShareMarket market_, address[6] memory actors_) {
        vault = vault_;
        market = market_;
        actors = actors_;
        // FundingTestBase buys the NFT with these original beneficial holdings.
        balances = [uint256(49), 49, 2, 0, 0, 0];
        completedSecondBalances = balances;
    }

    function advanceTime(uint256 seed) public {
        uint256 mode = seed % 6;
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
        }
        // A zero-time step must NOT move the independent snapshot forward.
        if (delta == 0) return;
        completedSecondBalances = balances;
        vm.warp(block.timestamp + delta);
    }

    function moveShares(uint256 fromSeed, uint256 toSeed, uint256 amountSeed, uint256 routeSeed) public {
        uint256 from = fromSeed % 6;
        uint256 to = toSeed % 6;
        if (from == to || balances[from] == 0 || balances[to] == 49) return;
        uint256 maximum = balances[from] < 49 - balances[to] ? balances[from] : 49 - balances[to];
        uint256 amount = bound(amountSeed, 1, maximum);
        uint256 route = routeSeed % 3;
        if (route == 0) {
            vm.prank(actors[from]);
            assertTrue(vault.transfer(actors[to], amount));
        } else if (route == 1) {
            vm.prank(actors[from]);
            vault.approve(address(this), amount);
            assertTrue(vault.transferFrom(actors[from], actors[to], amount));
        } else {
            // Zero-price orders exercise the real lock/fill path without inventing
            // BNB credits in this voting-focused ownership model.
            vm.prank(actors[from]);
            uint256 orderId = market.list(address(vault), amount, 0);
            vm.prank(actors[to]);
            market.fill(orderId, amount);
        }
        balances[from] -= amount;
        balances[to] += amount;
        ++successfulTransfers;
    }

    function propose(uint256 actorSeed, uint256 price) public {
        if (proposalCount == MAX_PROPOSALS) return;
        uint256 actor = actorSeed % 6;
        bool eligible = balances[actor] != 0;
        if (lastProposed[actor] != 0 && block.timestamp - lastProposed[actor] < 7 days) eligible = false;
        if (proposalCount != 0 && block.timestamp < proposals[proposalCount].proposedAt + 1 days) eligible = false;
        vm.prank(actors[actor]);
        (bool ok, bytes memory result) = address(vault).call(abi.encodeCall(PoolVault.propose, (price, price, 0)));
        assertEq(ok, eligible, "proposal eligibility differs from independent model");
        if (!ok) {
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
        p.weights = completedSecondBalances;
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
            assertLe(balances[a], 49);
            total += balances[a];
            if (balances[a] != 0) ++currentMembers;
        }
        assertEq(total, 100);
        assertEq(vault.memberCount(), currentMembers);
        assertEq(vault.totalSupply(), 100);
        assertEq(vault.balanceOf(address(market)), 0);
        assertEq(vault.activeProposalId(), proposalCount);
        assertEq(vault.nextProposalId(), proposalCount + 1);
        for (uint256 id = 1; id <= proposalCount; ++id) {
            GhostProposal storage expected = proposals[id];
            PoolSaleState.Proposal memory actual = vault.getProposal(id);
            uint256 members;
            uint256 shares;
            for (uint256 a; a < 6; ++a) {
                if (expected.weights[a] != 0) ++members;
                shares += expected.weights[a];
                assertEq(vault.getPastShares(actors[a], actual.snapshotTs), expected.weights[a]);
            }
            assertEq(shares, 100);
            assertEq(actual.snapshotMemberCount, members);
            assertEq(actual.snapshotTotalShares, shares);
            assertEq(actual.snapshotTs, expected.proposedAt - 1);
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
            assertEq(vault.proposalPassed(id), yesMembers > members / 2 && yesShares >= 51);
        }
    }
}

contract PoolVotingInvariantTest is ShareTransferTestBase {
    PoolVotingHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.warp(uint256(PoolVault(payable(address(pool))).activatedAt()) + 7 days);
        address[6] memory actors = [ALICE, BOB, CAROL, DAVE, ERIN, FRANK];
        handler = new PoolVotingHandler(PoolVault(payable(address(pool))), shareMarket, actors);

        // Non-vacuous seed: same-second exit/new-holder, repeat and negative votes,
        // transferFrom and market fill, an exact expiry, and a replacement proposal.
        handler.propose(0, 5 ether);
        handler.moveShares(0, 3, 49, 0);
        handler.vote(0, 1, true);
        handler.vote(3, 1, true);
        handler.vote(0, 1, false);
        handler.vote(2, 1, false);
        handler.propose(1, 6 ether);
        handler.moveShares(1, 4, 10, 1);
        handler.moveShares(4, 5, 5, 2);
        handler.advanceTime(5);
        handler.moveShares(1, 0, 1, 0);
        handler.advanceTime(0); // A same-second reentry must not add a sixth snapshot member.
        handler.vote(1, 1, true);
        handler.propose(3, 6 ether);
        handler.vote(3, 2, true);
        handler.vote(4, 2, true);
        handler.vote(5, 2, true); // Three of five owners, 59 shares: preserve a positive historical result.
        assertTrue(PoolVault(payable(address(pool))).proposalPassed(2));

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
        assertGe(handler.successfulTransfers(), 4);
        assertGe(handler.proposalCount(), 2);
    }

    function invariant_noDuplicateVotesOrReassignedHistoricalWeight() public view {
        handler.assertVotesAndMajorities();
        assertGe(handler.successfulVotes(), 5);
        assertGe(handler.rejectedVotes(), 3);
        assertGe(handler.rejectedProposals(), 1);
    }
}
