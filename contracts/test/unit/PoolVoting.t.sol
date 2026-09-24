// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {RewardsVaultHarness} from "../utils/RewardsTestBase.sol";
import {IFundingVault} from "../utils/FundingTestBase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolSaleState} from "../../src/PoolSaleState.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @dev Voting only. Acquisition and share-market registration use the real entry points.
/// No sale execution, sale proceeds or synthetic voting/checkpoint storage is used.
contract PoolVotingTest is ShareTransferTestBase {
    PoolVault internal voting;

    event SaleProposed(
        uint256 indexed proposalId,
        address indexed proposer,
        uint256 price,
        uint256 refPrice,
        uint64 refAt,
        uint64 endsAt
    );
    event SaleSnapshotRecorded(uint256 indexed proposalId, uint48 snapshotTs, uint256 members, uint256 shares);
    event Voted(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);

    function setUp() public override {
        super.setUp();
        voting = PoolVault(payable(address(pool)));
        _transfer(BOB, CAROL, 23); // 49 / 26 / 25 beneficial owners.
    }

    function test_acquisitionSevenDayBoundaryAndProposalSnapshot() public {
        uint64 acquired = voting.activatedAt();
        vm.warp(uint256(acquired) + 7 days - 1);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.DeadlineNotReached.selector);
        voting.propose(5 ether, 6 ether, 1);
        assertEq(voting.activeProposalId(), 0);
        assertEq(voting.lastProposed(ALICE), 0);
        assertEq(voting.nextProposalId(), 1);

        vm.warp(uint256(acquired) + 7 days);
        vm.expectEmit(true, true, false, true, address(pool));
        emit SaleProposed(1, ALICE, 5 ether, 6 ether, 1, uint64(block.timestamp + 1 days));
        vm.expectEmit(true, false, false, true, address(pool));
        emit SaleSnapshotRecorded(1, uint48(block.timestamp - 1), 3, 100);
        uint256 id = _propose(ALICE);
        PoolSaleState.Proposal memory p = voting.getProposal(id);
        assertEq(id, 1);
        assertEq(voting.nextProposalId(), 2);
        assertEq(voting.activeProposalId(), id);
        assertEq(voting.lastProposed(ALICE), block.timestamp);
        assertEq(p.proposer, ALICE);
        assertEq(p.snapshotTs, block.timestamp - 1);
        assertGt(p.snapshotTs, acquired);
        assertEq(p.endsAt, block.timestamp + 1 days);
        assertEq(p.snapshotMemberCount, 3);
        assertEq(p.snapshotTotalShares, 100);
        assertFalse(p.executed);
        assertFalse(voting.proposalPassed(id));
    }

    function test_twoOfThreeMembersWithFiftyOneSharesPass() public {
        _ready();
        uint256 id = _propose(ALICE);
        _vote(BOB, id, true);
        assertFalse(voting.proposalPassed(id));
        _vote(CAROL, id, true);
        _assertTally(id, 2, 51, true);
    }

    function test_fortyNineSharesAloneDoNotPass() public {
        _ready();
        uint256 id = _propose(ALICE);
        _vote(ALICE, id, true);
        _assertTally(id, 1, 49, false);
    }

    function test_exactlyHalfSharesFailEvenWithMemberMajority() public {
        _transfer(BOB, DAVE, 24);
        _transfer(BOB, ERIN, 1); // 49 / 1 / 25 / 24 / 1, five members.
        _ready();
        uint256 id = _propose(ALICE);
        assertEq(voting.getProposal(id).snapshotMemberCount, 5);
        _vote(CAROL, id, true);
        _vote(DAVE, id, true);
        _vote(ERIN, id, true);
        _assertTally(id, 3, 50, false);
        _vote(BOB, id, true);
        _assertTally(id, 4, 51, true);
    }

    function test_exactlyHalfMembersFailEvenWithShareMajority() public {
        _transfer(CAROL, DAVE, 1); // Four snapshot members.
        _ready();
        uint256 id = _propose(ALICE);
        assertEq(voting.getProposal(id).snapshotMemberCount, 4);
        _vote(ALICE, id, true);
        _vote(BOB, id, true);
        _assertTally(id, 2, 75, false);
        _vote(CAROL, id, true);
        _assertTally(id, 3, 99, true);
    }

    function test_falseVoteConsumesVoteAndCannotBeChanged() public {
        _ready();
        uint256 id = _propose(ALICE);
        vm.expectEmit(true, true, false, true, address(pool));
        emit Voted(id, BOB, false, 26);
        _vote(BOB, id, false);
        assertTrue(voting.hasVoted(id, BOB));
        _assertTally(id, 0, 0, false);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.AlreadyVoted.selector);
        voting.vote(id, true);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.AlreadyVoted.selector);
        voting.vote(id, false);
        _assertTally(id, 0, 0, false);
    }

    function test_onlyOneLiveProposalAndRejectedAttemptsDoNotSetCooldown() public {
        _ready();
        uint256 id = _propose(ALICE);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.ProposalActive.selector);
        voting.propose(1, 2, 3);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.ProposeCooldown.selector);
        voting.propose(1, 2, 3);
        assertEq(voting.lastProposed(BOB), 0);
        assertEq(voting.activeProposalId(), id);
        assertEq(voting.nextProposalId(), 2);
        PoolSaleState.Proposal memory p = voting.getProposal(id);
        assertEq(p.price, 5 ether);
        assertEq(p.refPrice, 6 ether);
        assertEq(p.refAt, 1);
    }

    function test_twentyFourHourVotingBoundaryAndExpiredProposalReplacement() public {
        _ready();
        uint256 oldId = _propose(ALICE);
        uint64 ends = voting.getProposal(oldId).endsAt;
        _vote(ALICE, oldId, true);
        vm.warp(uint256(ends) - 1);
        _vote(BOB, oldId, true);
        _assertTally(oldId, 2, 75, true);
        vm.warp(ends);
        vm.prank(CAROL);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        voting.vote(oldId, true);
        assertFalse(voting.hasVoted(oldId, CAROL));

        uint256 newId = _propose(BOB);
        assertEq(newId, oldId + 1);
        assertEq(voting.activeProposalId(), newId);
        vm.prank(CAROL);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        voting.vote(oldId, true);
        // This view reports the historic threshold result, not execution permission.
        assertTrue(voting.proposalPassed(oldId));
        assertFalse(voting.hasVoted(newId, ALICE));
        _vote(ALICE, newId, true);
        _assertTally(newId, 1, 49, false);
    }

    function test_sameProposerSevenDayBoundarySurvivesExitAndReentry() public {
        _ready();
        uint256 firstId = _propose(ALICE);
        uint64 proposedAt = voting.lastProposed(ALICE);
        vm.warp(uint256(proposedAt) + 1 days);
        _transfer(ALICE, DAVE, 49);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(voting.lastProposed(ALICE), proposedAt);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        voting.propose(1, 2, 3);
        _transfer(DAVE, ALICE, 49);
        assertEq(voting.lastProposed(ALICE), proposedAt);

        vm.warp(uint256(proposedAt) + 7 days - 1);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.ProposeCooldown.selector);
        voting.propose(1, 2, 3);
        vm.warp(uint256(proposedAt) + 7 days);
        uint256 nextId = _propose(ALICE);
        assertEq(nextId, firstId + 1);
        assertEq(voting.lastProposed(ALICE), block.timestamp);
        assertFalse(voting.proposalPassed(firstId));
    }

    function test_formerMemberVotesOriginalWeightAfterCompleteExit() public {
        _ready();
        uint256 id = _propose(ALICE);
        _transfer(BOB, DAVE, 26);
        assertEq(pool.balanceOf(BOB), 0);
        vm.expectEmit(true, true, false, true, address(pool));
        emit Voted(id, BOB, true, 26);
        _vote(BOB, id, true);
        _assertTally(id, 1, 26, false);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        voting.vote(id, true);
        _transfer(DAVE, BOB, 26);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.AlreadyVoted.selector);
        voting.vote(id, true);
        _assertTally(id, 1, 26, false);
    }

    function test_sameSecondDirectTransferCannotDuplicateSnapshotVotes() public {
        _assertSameSecondTransferVotes(0);
    }

    function test_sameSecondTransferFromCannotDuplicateSnapshotVotes() public {
        _assertSameSecondTransferVotes(1);
    }

    function test_sameSecondMarketFillCannotDuplicateSnapshotVotes() public {
        _assertSameSecondTransferVotes(2);
    }

    function test_currentNewMemberCanProposeButHasNoSameSecondHistoricalVote() public {
        _ready();
        uint256 timestamp = block.timestamp;
        _transfer(ALICE, DAVE, 10);
        uint256 id = _propose(DAVE);
        PoolSaleState.Proposal memory p = voting.getProposal(id);
        assertEq(block.timestamp, timestamp);
        assertEq(p.proposer, DAVE);
        assertEq(p.snapshotMemberCount, 3);
        assertEq(pool.memberCount(), 4);
        assertEq(pool.balanceOf(DAVE), 10);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        voting.vote(id, true);
        _vote(ALICE, id, true);
        assertEq(pool.balanceOf(ALICE), 39);
        _assertTally(id, 1, 49, false);
    }

    function test_lockedSharesRetainBeneficialOwnerVoteAndCancellationDoesNotResetVote() public {
        vm.prank(ALICE);
        uint256 orderId = shareMarket.list(address(pool), 49, 0);
        _ready();
        uint256 id = _propose(BOB);
        assertEq(_shareVault().lockedShares(ALICE), 49);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(address(shareMarket)), 0);
        assertEq(voting.getProposal(id).snapshotMemberCount, 3);
        _vote(ALICE, id, true);
        _assertTally(id, 1, 49, false);
        vm.prank(address(shareMarket));
        vm.expectRevert(IPoolVault.NotMember.selector);
        voting.vote(id, true);
        vm.prank(ALICE);
        shareMarket.cancel(orderId);
        assertEq(_shareVault().lockedShares(ALICE), 0);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.AlreadyVoted.selector);
        voting.vote(id, true);
        _assertTally(id, 1, 49, false);
    }

    function test_zeroPriceAndReferenceWithFutureReferenceTimestampAreAccepted() public {
        _ready();
        vm.prank(ALICE);
        uint256 id = voting.propose(0, 0, type(uint64).max);
        PoolSaleState.Proposal memory p = voting.getProposal(id);
        assertEq(p.price, 0);
        assertEq(p.refPrice, 0);
        assertEq(p.refAt, type(uint64).max);
        _vote(BOB, id, true);
        _vote(CAROL, id, true);
        _assertTally(id, 2, 51, true);
    }

    function testFuzz_referenceAndPriceAreRecordedWithoutOracleValidation(uint256 price, uint256 refPrice, uint64 refAt)
        public
    {
        _ready();
        vm.prank(ALICE);
        uint256 id = voting.propose(price, refPrice, refAt);
        PoolSaleState.Proposal memory p = voting.getProposal(id);
        assertEq(p.price, price);
        assertEq(p.refPrice, refPrice);
        assertEq(p.refAt, refAt);
        assertEq(p.endsAt, block.timestamp + 1 days);
        assertFalse(voting.proposalPassed(id));
    }

    function test_nonMembersHaveNoPrivilegedProposalOrVoteAccess() public {
        _ready();
        address[3] memory outsiders = [OWNER, OPERATOR, DAVE];
        for (uint256 i; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(IPoolVault.NotMember.selector);
            voting.propose(0, 0, 0);
            assertEq(voting.lastProposed(outsiders[i]), 0);
        }
        uint256 id = _propose(ALICE);
        for (uint256 i; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(IPoolVault.NotMember.selector);
            voting.vote(id, true);
            assertFalse(voting.hasVoted(id, outsiders[i]));
        }
        _assertTally(id, 0, 0, false);
    }

    function test_unknownProposalViewsAndVotesRejectWithoutWritingVotes() public {
        _ready();
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        voting.getProposal(0);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        voting.proposalPassed(1);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        voting.vote(0, true);
        uint256 id = _propose(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        voting.vote(id + 1, true);
        assertFalse(voting.hasVoted(0, ALICE));
        assertFalse(voting.hasVoted(id + 1, ALICE));
        _assertTally(id, 0, 0, false);
    }

    function test_fundingFundedAndRefundingPoolsCannotProposeOrVote() public {
        defaultParams.circuitId = ++rewardId;
        IFundingVault candidate = _createPool(defaultParams);
        PoolVault candidateVoting = PoolVault(payable(address(candidate)));
        _assertWrongState(candidateVoting);
        _deposit(candidate, ALICE, 49);
        _deposit(candidate, BOB, 49);
        _deposit(candidate, CAROL, 2);
        assertEq(uint256(candidate.state()), uint256(IPoolVault.State.Funded));
        _assertWrongState(candidateVoting);
        vm.warp(defaultParams.purchaseDeadline);
        candidate.finalizeFailure();
        assertEq(uint256(candidate.state()), uint256(IPoolVault.State.Refunding));
        _assertWrongState(candidateVoting);
    }

    function test_closedLifecycleFixtureCannotVoteOrProposeButRetainsHistory() public {
        _ready();
        uint256 id = _propose(ALICE);
        _vote(BOB, id, true);
        _vote(CAROL, id, true);
        // Lifecycle-only negative test; this does not simulate or implement an NFT sale.
        RewardsVaultHarness(payable(address(pool))).fixtureSetTerminalState(IPoolVault.State.Closed);
        _assertWrongState(voting);
        assertTrue(voting.hasVoted(id, BOB));
        _assertTally(id, 2, 51, true);
        assertEq(nft.ownerOf(rewardId), address(pool), "fixture has not sold the NFT");
    }

    function _ready() internal {
        vm.warp(uint256(voting.activatedAt()) + 7 days);
    }

    function _propose(address proposer) internal returns (uint256 id) {
        vm.prank(proposer);
        id = voting.propose(5 ether, 6 ether, 1);
    }

    function _vote(address voter, uint256 id, bool support) internal {
        vm.prank(voter);
        voting.vote(id, support);
    }

    function _assertTally(uint256 id, uint256 count, uint256 shares, bool passed) internal view {
        PoolSaleState.Proposal memory p = voting.getProposal(id);
        assertEq(p.yesCount, count);
        assertEq(p.yesShares, shares);
        assertEq(voting.proposalPassed(id), passed);
    }

    function _assertSameSecondTransferVotes(uint8 route) internal {
        _ready();
        uint256 timestamp = block.timestamp;
        uint256 orderId;
        if (route == 2) {
            vm.prank(ALICE);
            orderId = shareMarket.list(address(pool), 49, 0);
        }
        uint256 id = _propose(ALICE);
        if (route == 0) {
            _transfer(ALICE, DAVE, 49);
        } else if (route == 1) {
            vm.prank(ALICE);
            pool.approve(FRANK, 49);
            vm.prank(FRANK);
            assertTrue(pool.transferFrom(ALICE, DAVE, 49));
            assertEq(pool.allowance(ALICE, FRANK), 0);
        } else {
            vm.prank(DAVE);
            shareMarket.fill(orderId, 49);
            assertEq(_shareVault().lockedShares(ALICE), 0);
        }
        assertEq(block.timestamp, timestamp);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.balanceOf(DAVE), 49);
        assertEq(voting.getProposal(id).snapshotTs, timestamp - 1);
        _vote(ALICE, id, true);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        voting.vote(id, true);
        assertFalse(voting.hasVoted(id, DAVE));
        _vote(BOB, id, true);
        _assertTally(id, 2, 75, true);
    }

    function _assertWrongState(PoolVault candidate) internal {
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        candidate.propose(0, 0, 0);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        candidate.vote(1, true);
    }
}
