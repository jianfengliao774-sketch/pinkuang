// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase, ShareTransferVaultHarness} from "../utils/ShareTransferTestBase.sol";
import {RewardsVaultHarness} from "../utils/RewardsTestBase.sol";
import {IFundingVault} from "../utils/FundingTestBase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolSaleState} from "../../src/PoolSaleState.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";
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
        emit SaleSnapshotRecorded(1, uint48(block.timestamp), 3, 100);
        uint256 id = _propose(ALICE);
        PoolSaleState.Proposal memory p = voting.getProposal(id);
        assertEq(id, 1);
        assertEq(voting.nextProposalId(), 2);
        assertEq(voting.activeProposalId(), id);
        assertEq(voting.lastProposed(ALICE), block.timestamp);
        assertEq(p.proposer, ALICE);
        assertEq(p.snapshotTs, block.timestamp);
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
        vm.expectRevert(IPoolVault.ProposalActive.selector);
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

        vm.prank(BOB);
        vm.expectRevert(IPoolVault.ProposeCooldown.selector);
        voting.propose(5 ether, 6 ether, 1);
        assertTrue(voting.shareTradingAllowed());
        vm.warp(uint256(ends) + 6 days);
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

    function test_openVotePreventsExitingAndKeepsSnapshotVotingRights() public {
        _ready();
        uint256 id = _propose(ALICE);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.ProposalActive.selector);
        pool.transfer(DAVE, 26);
        assertEq(pool.balanceOf(BOB), 26);
        assertEq(pool.balanceOf(DAVE), 0);
        _vote(BOB, id, true);
        _assertTally(id, 1, 26, false);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        voting.vote(id, true);
    }

    function test_openVotePreventsAcquiringAdditionalVotingShares() public {
        _ready();
        uint256 id = _propose(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.ProposalActive.selector);
        pool.transfer(BOB, 23);
        assertEq(pool.balanceOf(BOB), 26);
        _vote(BOB, id, true);
        _assertTally(id, 1, 26, false);
        _vote(ALICE, id, true);
        _assertTally(id, 2, 75, true);
    }

    function test_sameSecondMemberExitUpdatesSnapshotMajorityThreshold() public {
        _transfer(CAROL, DAVE, 1); // Four owners before the same-second exit.
        _ready();
        _transfer(DAVE, BOB, 1); // Three current owners, in the proposal timestamp.
        uint256 id = _propose(ALICE);
        assertEq(pool.memberCount(), 3);
        assertEq(voting.getProposal(id).snapshotMemberCount, 3);
        _vote(ALICE, id, true);
        _vote(BOB, id, true);
        _assertTally(id, 2, 76, true);
        assertEq(pool.balanceOf(DAVE), 0);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        voting.vote(id, true);
    }

    function test_replacementProposalRefreshesSnapshotAndDoesNotInheritOldVotes() public {
        _ready();
        uint256 oldId = _propose(ALICE);
        _vote(ALICE, oldId, true);
        _vote(BOB, oldId, false);
        vm.warp(voting.getProposal(oldId).endsAt);
        _transfer(ALICE, DAVE, 49);
        vm.warp(uint256(voting.getProposal(oldId).endsAt) + 6 days);
        uint256 newId = _propose(BOB);
        assertGt(voting.getProposal(newId).snapshotTs, voting.getProposal(oldId).snapshotTs);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.balanceOf(DAVE), 49);
        vm.warp(block.timestamp + 1); // Public historical getters require a completed timestamp.
        assertEq(pool.getPastShares(ALICE, voting.getProposal(newId).snapshotTs), 0);
        assertEq(pool.getPastShares(DAVE, voting.getProposal(newId).snapshotTs), 49);
        assertFalse(voting.hasVoted(newId, BOB));
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        voting.vote(newId, true);
        _vote(DAVE, newId, true);
        _vote(BOB, newId, true); // A previous proposal's false vote imposes no restriction here.
        _assertTally(newId, 2, 75, true);
        _assertTally(oldId, 1, 49, false);
        assertTrue(voting.hasVoted(oldId, ALICE));
        assertTrue(voting.hasVoted(oldId, BOB));
        assertFalse(voting.hasVoted(newId, ALICE));
    }

    function test_miningCallbackCannotProposeDuringShareTransfer() public {
        _transfer(CAROL, address(mining), 1);
        _ready();
        mining.setClaimReentry(address(pool), abi.encodeCall(IPoolVault.propose, (5 ether, 6 ether, 1)));
        _transfer(ALICE, DAVE, 1);
        _assertGovernanceReentryBlocked();
        assertEq(voting.activeProposalId(), 0);
        assertEq(voting.nextProposalId(), 1);
        assertEq(voting.lastProposed(address(mining)), 0);
        // The caller is eligible outside the callback: the rejection was the reentrancy guard.
        uint256 id = _propose(address(mining));
        assertEq(id, 1);
        assertEq(voting.getProposal(id).proposer, address(mining));
    }

    function test_miningCallbackCannotVoteDuringHarvest() public {
        _transfer(CAROL, address(mining), 1);
        _ready();
        uint256 id = _propose(ALICE);
        mining.setClaimReentry(address(pool), abi.encodeCall(IPoolVault.vote, (id, true)));
        voting.harvest();
        _assertGovernanceReentryBlocked();
        assertFalse(voting.hasVoted(id, address(mining)));
        _assertTally(id, 0, 0, false);
        // Proves this callback sender has genuine historical voting eligibility.
        _vote(address(mining), id, true);
        _assertTally(id, 1, 1, false);
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

    function test_currentNewMemberCanProposeAndVoteAfterSameSecondTransfer() public {
        _ready();
        uint256 timestamp = block.timestamp;
        _transfer(ALICE, DAVE, 10);
        uint256 id = _propose(DAVE);
        PoolSaleState.Proposal memory p = voting.getProposal(id);
        assertEq(block.timestamp, timestamp);
        assertEq(p.proposer, DAVE);
        assertEq(p.snapshotMemberCount, 4);
        assertEq(pool.memberCount(), 4);
        assertEq(pool.balanceOf(DAVE), 10);
        _vote(DAVE, id, true);
        _vote(ALICE, id, true);
        assertEq(pool.balanceOf(ALICE), 39);
        _assertTally(id, 2, 49, false);
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

    function test_zeroSalePriceRejectedWithoutConsumingProposalOrCooldown() public {
        _ready();
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.InvalidSalePrice.selector);
        voting.propose(0, 0, type(uint64).max);
        assertEq(voting.activeProposalId(), 0);
        assertEq(voting.lastProposed(ALICE), 0);
    }

    function test_discountBelowActualCostNeedsAtLeastSixtyShares() public {
        _transfer(BOB, CAROL, 15); // 49/11/40; two of three addresses and exactly 60 shares.
        _ready();
        uint256 discountedPrice = voting.purchaseCost() - 1;
        vm.prank(ALICE);
        uint256 id = voting.propose(discountedPrice, 0, 0);
        _vote(ALICE, id, true);
        assertFalse(voting.proposalPassed(id));
        _vote(BOB, id, true);
        _assertTally(id, 2, 60, true);
        voting.executeSale(id);
        assertEq(uint256(voting.state()), uint256(IPoolVault.State.Listed));
    }

    function test_saleAtActualCostRetainsSimpleShareMajorityThreshold() public {
        _ready();
        uint256 purchaseCost = voting.purchaseCost();
        vm.prank(ALICE);
        uint256 id = voting.propose(purchaseCost, type(uint256).max, type(uint64).max);
        _vote(BOB, id, true);
        _vote(CAROL, id, true);
        _assertTally(id, 2, 51, true);
        voting.executeSale(id);
        assertEq(uint256(voting.state()), uint256(IPoolVault.State.Listed));
    }

    function test_sevenMinorityAddressesCannotRotateProposalsToKeepTradingFrozen() public {
        address[7] memory minority;
        for (uint256 i; i < minority.length; ++i) {
            minority[i] = address(uint160(0xF100 + i));
            _transfer(CAROL, minority[i], 1);
        }
        _ready();
        uint256 firstAt = block.timestamp;
        vm.prank(minority[0]);
        uint256 firstId = voting.propose(1, 0, 0);
        assertFalse(voting.shareTradingAllowed());
        vm.prank(minority[1]);
        vm.expectRevert(IPoolVault.ProposalActive.selector);
        voting.propose(1, 0, 0);
        for (uint256 day = 1; day < 7; ++day) {
            vm.warp(firstAt + day * 1 days);
            vm.prank(minority[day]);
            vm.expectRevert(IPoolVault.ProposeCooldown.selector);
            voting.propose(1, 0, 0);
            assertEq(voting.activeProposalId(), firstId);
            assertEq(voting.lastProposed(minority[day]), 0);
            assertTrue(voting.shareTradingAllowed());
            _transfer(ALICE, BOB, 1);
        }
        // Market orders and fills also work during the pool-wide cooldown, after the one-day vote ends.
        vm.prank(BOB);
        uint256 orderId = shareMarket.list(address(pool), 1, 1);
        vm.deal(DAVE, 1);
        vm.prank(DAVE);
        shareMarket.fill{value: 1}(orderId, 1);
        assertEq(pool.balanceOf(DAVE), 1);
        vm.warp(firstAt + 7 days - 1);
        vm.prank(minority[1]);
        vm.expectRevert(IPoolVault.ProposeCooldown.selector);
        voting.propose(1, 0, 0);
        vm.warp(firstAt + 7 days);
        vm.prank(minority[1]);
        uint256 nextId = voting.propose(1, 0, 0);
        assertEq(nextId, firstId + 1);
        assertFalse(voting.shareTradingAllowed());
        vm.warp(firstAt + 8 days);
        assertTrue(voting.shareTradingAllowed());
    }

    function testFuzz_discountWithFiftyOneThroughFiftyNineSharesCannotExecute(uint8 yesShares) public {
        yesShares = uint8(bound(yesShares, 51, 59));
        _transfer(BOB, CAROL, 26 - (yesShares - 49));
        _ready();
        vm.prank(ALICE);
        // An arbitrary displayed reference cannot weaken the on-chain cost floor.
        uint256 id = voting.propose(1, type(uint256).max, type(uint64).max);
        _vote(ALICE, id, true);
        _vote(BOB, id, true);
        _assertTally(id, 2, yesShares, false);
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        voting.executeSale(id);
        assertEq(uint256(voting.state()), uint256(IPoolVault.State.Active));
    }

    function testFuzz_referenceAndPriceAreRecordedWithoutOracleValidation(uint256 price, uint256 refPrice, uint64 refAt)
        public
    {
        price = bound(price, 1, type(uint256).max);
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

    function test_listedLifecycleFixtureRejectsProposalsAndVotesWithoutChangingHistory() public {
        _ready();
        uint256 id = _propose(ALICE);
        _vote(ALICE, id, true);
        bytes32 proposalBefore = keccak256(abi.encode(voting.getProposal(id)));
        // Lifecycle-only negative test; no listing or NFT-sale implementation is implied.
        ShareTransferVaultHarness(payable(address(pool))).fixtureSetListed();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.WrongState.selector);
        voting.propose(1, 2, 3);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.WrongState.selector);
        voting.vote(id, true);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.WrongState.selector);
        voting.vote(id, false);
        assertEq(keccak256(abi.encode(voting.getProposal(id))), proposalBefore);
        assertEq(voting.activeProposalId(), id);
        assertEq(voting.nextProposalId(), id + 1);
        assertEq(voting.lastProposed(BOB), 0);
        assertFalse(voting.hasVoted(id, BOB));
        assertTrue(voting.hasVoted(id, ALICE));
        assertEq(nft.ownerOf(rewardId), address(pool));
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
            vm.prank(ALICE);
            vm.expectRevert(IPoolVault.ProposalActive.selector);
            pool.transfer(DAVE, 49);
        } else if (route == 1) {
            vm.prank(ALICE);
            pool.approve(FRANK, 49);
            vm.prank(FRANK);
            vm.expectRevert(IPoolVault.ProposalActive.selector);
            pool.transferFrom(ALICE, DAVE, 49);
            assertEq(pool.allowance(ALICE, FRANK), 49);
        } else {
            vm.prank(DAVE);
            vm.expectRevert(IShareMarket.WrongState.selector);
            shareMarket.fill(orderId, 49);
            assertEq(_shareVault().lockedShares(ALICE), 49);
        }
        assertEq(block.timestamp, timestamp);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.balanceOf(DAVE), 0);
        assertEq(voting.getProposal(id).snapshotTs, timestamp);
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

    function _assertGovernanceReentryBlocked() internal view {
        assertTrue(mining.reentryAttempted());
        assertFalse(mining.reentrySucceeded());
        assertEq(mining.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
    }
}
