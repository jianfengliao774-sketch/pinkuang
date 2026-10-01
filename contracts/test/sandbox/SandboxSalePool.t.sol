// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {PoolSaleState} from "../../src/PoolSaleState.sol";
import {SandboxSalePool} from "../../sandbox/SandboxSalePool.sol";
import {SandboxSaleGovernance} from "../../sandbox/SandboxSaleGovernance.sol";

contract WrappedSandboxDeploy {
    function create(address owner, address[] memory members, uint8[] memory shares, uint128 cost)
        external returns (SandboxSalePool)
    {
        return new SandboxSalePool(owner, members, shares, cost);
    }
}

contract RejectingSandboxBuyer {
    function buy(SandboxSalePool pool, uint256 id, uint256 price) external payable {
        pool.completeSimulatedSale{value: msg.value}(id, price);
    }
}

contract ReenteringSandboxBuyer is IERC721Receiver {
    SandboxSalePool private target;
    function buy(SandboxSalePool pool, uint256 id, uint256 price) external payable {
        target = pool;
        pool.completeSimulatedSale{value: msg.value}(id, price);
    }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        target.withdrawBnb();
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract ReenteringSandboxHolder {
    SandboxSalePool private target;
    function withdraw(SandboxSalePool pool) external { target = pool; pool.withdrawBnb(); }
    receive() external payable { target.withdrawBnb(); }
}

contract ForceSandboxBnb {
    constructor(address payable pool) payable { selfdestruct(pool); }
}

contract SandboxSalePoolTest is Test {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);
    address private constant BUYER = address(0xB0A);
    address private constant OTHER = address(0x07E);
    uint128 private constant COST = 0.00001 ether;
    SandboxSalePool private pool;
    uint256 private started;

    function setUp() public {
        vm.chainId(56);
        vm.warp(1_000_000);
        started = block.timestamp;
        pool = new SandboxSalePool(ALICE, _members(), _shares(), COST);
        vm.deal(BUYER, 1 ether);
        vm.deal(address(this), 1 ether);
    }

    function _members() private pure returns (address[] memory a) {
        a = new address[](3); a[0] = ALICE; a[1] = BOB; a[2] = CAROL;
    }
    function _shares() private pure returns (uint8[] memory a) {
        a = new uint8[](3); a[0] = 49; a[1] = 26; a[2] = 25;
    }
    function _proposal(uint256 price) private returns (uint256 id) {
        vm.warp(started + 60);
        vm.prank(ALICE); id = pool.propose(price, COST, uint64(started));
    }
    function _pass(uint256 id) private {
        vm.prank(BOB); pool.vote(id, true);
        vm.prank(CAROL); pool.vote(id, true);
        assertTrue(pool.proposalPassed(id));
    }
    function _list(uint256 price) private returns (uint256 id) {
        id = _proposal(price); _pass(id);
        if (price < COST) { vm.prank(ALICE); pool.reviewSale(address(pool), id, uint128(price), true); }
        pool.executeSale(id);
    }
    function _complete(uint256 price) private {
        uint256 id = _list(price);
        vm.prank(BUYER); pool.completeSimulatedSale{value: price}(id, price);
    }
    function _assertState(IPoolVault.State expected) private view {
        assertEq(uint256(pool.state()), uint256(expected));
    }

    function testSetupHasFixedMockNftExactly100SharesAndNoConstructionPayment() public view {
        assertEq(pool.owner(), ALICE); assertEq(pool.operator(), ALICE); assertEq(pool.treasury(), ALICE);
        assertEq(pool.factory(), address(pool)); assertEq(pool.shareMarket(), address(pool));
        assertTrue(pool.simulationOnly()); assertEq(pool.totalSupply(), 100); assertEq(pool.decimals(), 0);
        assertEq(pool.memberCount(), 3); assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.purchaseCost(), COST); assertEq(address(pool).balance, 0);
        assertEq(IERC721(pool.simulatedNft()).ownerOf(1), address(pool));
        assertEq(pool.firstProposalAt(), started + 60);
        _assertState(IPoolVault.State.Active);
    }
    function testWrappedCreateStillBindsTheExplicitDeploymentWallet() public {
        WrappedSandboxDeploy wrapper = new WrappedSandboxDeploy();
        SandboxSalePool wrapped = wrapper.create(ALICE, _members(), _shares(), COST);
        assertEq(wrapped.owner(), ALICE); assertEq(wrapped.treasury(), ALICE);
        vm.prank(address(wrapper)); vm.expectRevert(SandboxSalePool.Unauthorized.selector);
        wrapped.setSaleReference(address(wrapped), COST, uint64(block.timestamp), bytes32(uint256(1)));
        vm.prank(ALICE); wrapped.setSaleReference(address(wrapped), COST, uint64(block.timestamp), bytes32(uint256(1)));
    }
    function testSetupRejectsWrongChainOrOwner() public {
        vm.chainId(97); vm.expectRevert(SandboxSalePool.InvalidSetup.selector);
        new SandboxSalePool(ALICE, _members(), _shares(), COST);
        vm.chainId(56); vm.expectRevert(SandboxSalePool.InvalidSetup.selector);
        new SandboxSalePool(address(0), _members(), _shares(), COST);
    }
    function testSetupRejectsDuplicateAndIncorrectShareSupply() public {
        address[] memory members = _members(); members[2] = ALICE;
        vm.expectRevert(SandboxSalePool.InvalidSetup.selector);
        new SandboxSalePool(ALICE, members, _shares(), COST);
        uint8[] memory shares = _shares(); shares[0] = 48;
        vm.expectRevert(SandboxSalePool.InvalidSetup.selector);
        new SandboxSalePool(ALICE, _members(), shares, COST);
    }
    function testSetupRejectsZeroMemberZeroSharesOrArrayMismatch() public {
        address[] memory members = _members(); members[1] = address(0);
        vm.expectRevert(SandboxSalePool.InvalidSetup.selector);
        new SandboxSalePool(ALICE, members, _shares(), COST);
        uint8[] memory shares = _shares(); shares[1] = 0;
        vm.expectRevert(SandboxSalePool.InvalidSetup.selector);
        new SandboxSalePool(ALICE, _members(), shares, COST);
        vm.expectRevert(SandboxSalePool.InvalidSetup.selector);
        new SandboxSalePool(ALICE, _members(), new uint8[](2), COST);
    }
    function testSmallValueCapAppliesToCostQuoteAndProposal() public {
        uint128 tooMuch = uint128(pool.MAX_SIMULATED_SALE_PRICE() + 1);
        vm.expectRevert(SandboxSalePool.InvalidSetup.selector);
        new SandboxSalePool(ALICE, _members(), _shares(), tooMuch);
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.InvalidReference.selector);
        pool.setSaleReference(address(pool), tooMuch, uint64(started), bytes32(uint256(1)));
        vm.warp(started + 60); vm.prank(ALICE); vm.expectRevert(IPoolVault.InvalidSalePrice.selector);
        pool.propose(tooMuch, COST, uint64(started));
        uint256 maximum = pool.MAX_SIMULATED_SALE_PRICE();
        vm.prank(ALICE); pool.propose(maximum, COST, uint64(started));
    }
    function testHoldBoundaryIs60SecondsAndZeroPriceNeverFreezes() public {
        vm.warp(started + 59); vm.prank(ALICE); vm.expectRevert(IPoolVault.DeadlineNotReached.selector);
        pool.propose(COST, COST, uint64(started));
        vm.warp(started + 60); vm.prank(ALICE); vm.expectRevert(IPoolVault.InvalidSalePrice.selector);
        pool.propose(0, COST, uint64(started));
        assertEq(pool.activeProposalId(), 0);
        vm.prank(ALICE); uint256 id = pool.propose(COST, COST, uint64(started));
        assertEq(id, 1); assertEq(pool.getProposal(id).endsAt, started + 360);
    }
    function testNonHolderCannotProposeOrVote() public {
        vm.warp(started + 60); vm.prank(OTHER); vm.expectRevert(IPoolVault.NotMember.selector);
        pool.propose(COST, COST, uint64(started));
        uint256 id = _proposal(COST);
        vm.prank(OTHER); vm.expectRevert(IPoolVault.NotMember.selector); pool.vote(id, true);
    }
    function testStrictDoubleMajorityRequiresBothAddressAndShareMajorities() public {
        uint256 id = _proposal(COST);
        vm.prank(ALICE); pool.vote(id, true); assertFalse(pool.proposalPassed(id));
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector); pool.executeSale(id);
        vm.prank(BOB); pool.vote(id, true); assertTrue(pool.proposalPassed(id));
        assertEq(pool.getProposal(id).yesCount, 2); assertEq(pool.getProposal(id).yesShares, 75);
    }
    function testExactlyHalfTheSharesDoesNotPassEvenWithTwoOfThreeHolders() public {
        uint8[] memory shares = _shares(); shares[0] = 50; shares[1] = 25;
        pool = new SandboxSalePool(ALICE, _members(), shares, COST);
        uint256 id = _proposal(COST);
        vm.prank(BOB); pool.vote(id, true); vm.prank(CAROL); pool.vote(id, true);
        assertFalse(pool.proposalPassed(id));
    }
    function testSingleAddressCannotPassEvenWithShareMajority() public {
        uint8[] memory shares = _shares(); shares[0] = 51; shares[1] = 24;
        pool = new SandboxSalePool(ALICE, _members(), shares, COST);
        uint256 id = _proposal(COST);
        vm.prank(ALICE); pool.vote(id, true); assertFalse(pool.proposalPassed(id));
    }
    function testCandidateSharesSnapshotDeadlineAndCannotDoubleVote() public {
        uint256 opener = _proposal(COST);
        vm.warp(started + 61); vm.prank(BOB); uint256 candidate = pool.propose(COST + 1, COST, uint64(started));
        PoolSaleState.Proposal memory p = pool.getProposal(candidate);
        assertEq(p.snapshotTs, pool.getProposal(opener).snapshotTs);
        assertEq(p.endsAt, pool.getProposal(opener).endsAt); assertEq(p.snapshotMemberCount, 3);
        vm.prank(BOB); pool.vote(candidate, true);
        vm.prank(BOB); vm.expectRevert(IPoolVault.AlreadyVoted.selector); pool.vote(candidate, false);
        assertTrue(pool.hasVoted(candidate, BOB)); assertFalse(pool.hasVoted(opener, BOB));
    }
    function testProposalFreezesDirectAndApprovedShareTransfersUntilDeadline() public {
        vm.prank(ALICE); pool.approve(OTHER, 49);
        _proposal(COST);
        vm.prank(ALICE); vm.expectRevert(IPoolVault.ProposalActive.selector); pool.transfer(OTHER, 1);
        vm.prank(OTHER); vm.expectRevert(IPoolVault.ProposalActive.selector); pool.transferFrom(ALICE, OTHER, 1);
        vm.warp(started + 360); vm.prank(ALICE); pool.transfer(OTHER, 1);
        assertEq(pool.memberCount(), 4); assertEq(pool.balanceOf(OTHER), 1);
    }
    function testShareTransferBeforeSnapshotUpdatesMembersAndVotingWeights() public {
        vm.prank(ALICE); pool.transfer(OTHER, 49); assertEq(pool.memberCount(), 3);
        vm.warp(started + 60); vm.prank(OTHER); uint256 id = pool.propose(COST, COST, uint64(started));
        vm.prank(ALICE); vm.expectRevert(IPoolVault.NotMember.selector); pool.vote(id, true);
        vm.prank(OTHER); pool.vote(id, true); assertEq(pool.getProposal(id).yesShares, 49);
    }
    function testVoteAndExecutionExpireExactlyAt300Seconds() public {
        uint256 id = _proposal(COST); _pass(id); vm.warp(started + 360);
        vm.prank(ALICE); vm.expectRevert(IPoolVault.DeadlinePassed.selector); pool.vote(id, true);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector); pool.executeSale(id);
    }
    function testNewRoundAfterVoteDeadlineCannotReuseOldProposal() public {
        uint256 id = _proposal(COST); _pass(id); vm.warp(started + 360);
        vm.prank(ALICE); uint256 next = pool.propose(COST, COST, uint64(started));
        assertEq(next, 2); assertEq(pool.activeProposalId(), 2); assertEq(pool.getProposal(next).endsAt, started + 660);
        vm.expectRevert(IPoolVault.InvalidProposal.selector); pool.executeSale(id);
    }
    function testProposerCooldownRemains60SecondsInsideSameRound() public {
        _proposal(COST); vm.warp(started + 119);
        vm.prank(ALICE); vm.expectRevert(SandboxSaleGovernance.ProposeCooldown.selector);
        pool.propose(COST, COST, uint64(started));
        vm.warp(started + 120); vm.prank(ALICE); uint256 id = pool.propose(COST, COST, uint64(started));
        assertEq(id, 2); assertEq(pool.getProposal(id).endsAt, started + 360);
    }
    function testOnlyExplicitOwnerCanSetFreshNonzeroReference() public {
        vm.prank(BOB); vm.expectRevert(SandboxSalePool.Unauthorized.selector);
        pool.setSaleReference(address(pool), COST, uint64(started), bytes32(uint256(1)));
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.InvalidReference.selector);
        pool.setSaleReference(address(pool), COST, uint64(started + 1), bytes32(uint256(1)));
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.InvalidReference.selector);
        pool.setSaleReference(address(pool), COST, uint64(started), bytes32(0));
        vm.warp(started + 301); vm.prank(ALICE); vm.expectRevert(SandboxSalePool.InvalidReference.selector);
        pool.setSaleReference(address(pool), COST, uint64(started), bytes32(uint256(1)));
        vm.prank(ALICE); pool.setSaleReference(address(pool), COST, uint64(started + 1), bytes32(uint256(1)));
    }
    function testFreshMarketReferenceNotProposalInputControlsLowPriceReview() public {
        uint256 id = _proposal(COST - 1); _pass(id);
        vm.expectRevert(SandboxSaleGovernance.SaleNotApproved.selector); pool.executeSale(id);
        vm.prank(ALICE); pool.reviewSale(address(pool), id, COST - 1, true);
        pool.executeSale(id); _assertState(IPoolVault.State.Listed);
    }
    function testReviewCannotApproveAnotherPoolFutureProposalWrongPriceOrAnotherWallet() public {
        uint256 id = _proposal(COST - 1);
        vm.prank(BOB); vm.expectRevert(SandboxSalePool.Unauthorized.selector);
        pool.reviewSale(address(pool), id, COST - 1, true);
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.InvalidReview.selector);
        pool.reviewSale(address(pool), id + 1, COST - 1, true);
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.InvalidReview.selector);
        pool.reviewSale(address(pool), id, COST, true);
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.InvalidReview.selector);
        pool.reviewSale(OTHER, id, COST - 1, true);
    }
    function testRejectedReviewIsFinalAndDeadlineClosesReview() public {
        uint256 id = _proposal(COST - 1); _pass(id);
        vm.prank(ALICE); pool.reviewSale(address(pool), id, COST - 1, false);
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.InvalidReview.selector);
        pool.reviewSale(address(pool), id, COST - 1, true);
        vm.expectRevert(SandboxSaleGovernance.SaleNotApproved.selector); pool.executeSale(id);
        vm.warp(started + 360); vm.prank(ALICE); vm.expectRevert(SandboxSalePool.InvalidReview.selector);
        pool.reviewSale(address(pool), id, COST - 1, true);
    }
    function testStaleInitialReferenceRequiresOwnerUpdateEvenIfVotePassed() public {
        vm.warp(started + 901); vm.prank(ALICE); uint256 id = pool.propose(COST, COST, uint64(started)); _pass(id);
        vm.expectRevert(SandboxSaleGovernance.SaleNotApproved.selector); pool.executeSale(id);
        vm.prank(ALICE); pool.setSaleReference(address(pool), COST, uint64(block.timestamp), bytes32(uint256(1)));
        pool.executeSale(id);
    }
    function testPassedVoteExecutesImmediatelyWithoutWaitingForWindowEnd() public {
        uint256 id = _list(COST); assertEq(block.timestamp, started + 60);
        assertLt(block.timestamp, pool.getProposal(id).endsAt);
        assertEq(pool.listedAt(), started + 60); assertEq(pool.expiresAt(), started + 960);
        assertEq(pool.salePrice(), COST); assertEq(pool.listedProposalId(), id);
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.WrongState.selector); pool.transfer(OTHER, 1);
    }
    function testListingCancelBoundary900SecondsAndHistoryNeverExecutesTwice() public {
        uint256 id = _list(COST); vm.warp(started + 959);
        vm.expectRevert(IPoolVault.DeadlineNotReached.selector); pool.cancelExpired();
        vm.warp(started + 960); pool.cancelExpired(); _assertState(IPoolVault.State.Active);
        assertEq(pool.listedProposalId(), 0); assertEq(pool.salePrice(), 0);
        vm.expectRevert(IPoolVault.InvalidProposal.selector); pool.executeSale(id);
        vm.prank(ALICE); uint256 next = pool.propose(COST, COST, uint64(started)); assertEq(next, 2);
    }
    function testPaymentRequiresExactListingIdPriceAndValue() public {
        uint256 id = _list(COST);
        vm.prank(BUYER); vm.expectRevert(IPoolVault.InvalidProposal.selector); pool.completeSimulatedSale{value: COST}(id + 1, COST);
        vm.prank(BUYER); vm.expectRevert(SandboxSalePool.PaymentMismatch.selector); pool.completeSimulatedSale{value: COST}(id, COST + 1);
        vm.prank(BUYER); vm.expectRevert(SandboxSalePool.PaymentMismatch.selector); pool.completeSimulatedSale{value: COST - 1}(id, COST);
        _assertState(IPoolVault.State.Listed); assertEq(address(pool).balance, 0);
        assertEq(IERC721(pool.simulatedNft()).ownerOf(1), address(pool));
    }
    function testListingCannotCompleteAtExpiry() public {
        uint256 id = _list(COST); vm.warp(pool.expiresAt());
        vm.prank(BUYER); vm.expectRevert(IPoolVault.DeadlinePassed.selector); pool.completeSimulatedSale{value: COST}(id, COST);
        _assertState(IPoolVault.State.Listed);
    }
    function testSimulatedSaleTransfersOnlyMockNftAndPreservesAllSaleWei() public {
        _complete(COST + 17); uint256 gross = COST + 17; uint256 fee = gross / 100; uint256 net = gross - fee;
        _assertState(IPoolVault.State.Closed); assertEq(IERC721(pool.simulatedNft()).ownerOf(1), BUYER);
        assertEq(pool.saleBuyer(), BUYER); assertEq(pool.saleProceeds(), gross); assertEq(pool.completedAt(), started + 60);
        assertEq(pool.bnbOwed(ALICE), fee); assertEq(pool.totalBnbOwed(), fee);
        assertEq(pool.pendingSaleProceeds(ALICE), net / 100 * 49);
        assertEq(pool.pendingSaleProceeds(BOB), net / 100 * 26);
        assertEq(pool.pendingSaleProceeds(CAROL), net / 100 * 25 + net % 100);
        assertEq(pool.pendingSaleProceeds(ALICE) + pool.pendingSaleProceeds(BOB) + pool.pendingSaleProceeds(CAROL) + fee, gross);
        assertEq(address(pool).balance, gross);
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.WrongState.selector); pool.transfer(OTHER, 1);
    }
    function testWithdrawMaterializesAndPaysInOneTransactionAndOwnerCannotDrainOthers() public {
        _complete(COST + 17); uint256 gross = COST + 17;
        uint256 aliceDue = pool.pendingSaleProceeds(ALICE) + pool.bnbOwed(ALICE);
        uint256 bobDue = pool.pendingSaleProceeds(BOB); uint256 carolDue = pool.pendingSaleProceeds(CAROL);
        uint256 before = ALICE.balance; vm.prank(ALICE); pool.withdrawBnb(); assertEq(ALICE.balance - before, aliceDue);
        assertEq(pool.bnbOwed(ALICE), 0); assertEq(pool.pendingSaleProceeds(ALICE), 0);
        assertEq(address(pool).balance, gross - aliceDue);
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.NothingToWithdraw.selector); pool.withdrawBnb();
        vm.prank(OTHER); vm.expectRevert(SandboxSalePool.NothingToWithdraw.selector); pool.withdrawBnb();
        before = BOB.balance; vm.prank(BOB); pool.withdrawBnb(); assertEq(BOB.balance - before, bobDue);
        before = CAROL.balance; vm.prank(CAROL); pool.withdrawBnb(); assertEq(CAROL.balance - before, carolDue);
        assertEq(address(pool).balance, 0); assertEq(pool.totalBnbOwed(), 0);
    }
    function testSecondBuyerCannotRepeatTheSale() public {
        _complete(COST); vm.deal(OTHER, COST);
        vm.prank(OTHER); vm.expectRevert(SandboxSalePool.WrongState.selector); pool.completeSimulatedSale{value: COST}(1, COST);
        assertEq(pool.saleBuyer(), BUYER); assertEq(IERC721(pool.simulatedNft()).ownerOf(1), BUYER);
    }
    function testBadNftReceiverRollsBackPaymentAccountingAndOwnership() public {
        uint256 id = _list(COST); RejectingSandboxBuyer bad = new RejectingSandboxBuyer();
        vm.expectRevert(); bad.buy{value: COST}(pool, id, COST);
        _assertState(IPoolVault.State.Listed); assertEq(pool.saleBuyer(), address(0)); assertEq(pool.totalBnbOwed(), 0);
        assertEq(address(pool).balance, 0); assertEq(IERC721(pool.simulatedNft()).ownerOf(1), address(pool));
    }
    function testNftCallbackCannotReenterWithdrawalAndFailedSaleIsAtomic() public {
        uint256 id = _list(COST); ReenteringSandboxBuyer bad = new ReenteringSandboxBuyer();
        vm.expectRevert(); bad.buy{value: COST}(pool, id, COST);
        _assertState(IPoolVault.State.Listed); assertEq(address(pool).balance, 0); assertEq(pool.saleBuyer(), address(0));
    }
    function testRejectedHolderPayoutCannotConsumeEntitlement() public {
        ReenteringSandboxHolder bad = new ReenteringSandboxHolder();
        vm.prank(CAROL); pool.transfer(address(bad), 25);
        uint256 id = _proposal(COST);
        vm.prank(ALICE); pool.vote(id, true); vm.prank(BOB); pool.vote(id, true); pool.executeSale(id);
        vm.prank(BUYER); pool.completeSimulatedSale{value: COST}(id, COST);
        uint256 pending = pool.pendingSaleProceeds(address(bad));
        vm.expectRevert(SandboxSalePool.TransferFailed.selector); bad.withdraw(pool);
        assertEq(pool.pendingSaleProceeds(address(bad)), pending); assertEq(pool.bnbOwed(address(bad)), 0);
    }
    function testUnsolicitedPaymentsAndForcedBnbDoNotCreateOwnerEntitlement() public {
        (bool ok,) = address(pool).call{value: 1}(""); assertFalse(ok);
        new ForceSandboxBnb{value: 17}(payable(address(pool)));
        assertEq(address(pool).balance, 17);
        vm.prank(ALICE); vm.expectRevert(SandboxSalePool.NothingToWithdraw.selector); pool.withdrawBnb();
    }
    function testMockNftHasNoExternalMintAndOwnerCannotMoveIt() public {
        address nft = pool.simulatedNft();
        vm.prank(ALICE);
        (bool ok,) = nft.call(abi.encodeWithSignature("mint(address,uint256)", ALICE, 2));
        assertFalse(ok);
        vm.prank(ALICE); vm.expectRevert(); IERC721(nft).transferFrom(address(pool), ALICE, 1);
    }
    function testFuzz_allMemberPayoutsAndPlatformFeeEqualExactPayment(uint128 rawPrice) public {
        uint256 price = bound(rawPrice, COST, pool.MAX_SIMULATED_SALE_PRICE()); _complete(price);
        uint256 aliceDue = pool.pendingSaleProceeds(ALICE) + pool.bnbOwed(ALICE);
        uint256 bobDue = pool.pendingSaleProceeds(BOB); uint256 carolDue = pool.pendingSaleProceeds(CAROL);
        assertEq(aliceDue + bobDue + carolDue, price);
        vm.prank(CAROL); pool.withdrawBnb(); vm.prank(ALICE); pool.withdrawBnb(); vm.prank(BOB); pool.withdrawBnb();
        assertEq(address(pool).balance, 0); assertEq(pool.totalBnbOwed(), 0);
    }
}
