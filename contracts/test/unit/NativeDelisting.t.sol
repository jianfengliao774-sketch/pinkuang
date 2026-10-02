// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {FirstoSignedAskMock} from "../utils/FirstoMocks.sol";
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";

contract NativeDelistingTest is SaleTestBase {
    struct Round {
        uint256 id;
        address proposer;
        uint256 listedProposalId;
        uint48 snapshotTs;
        uint64 expiresAt;
        uint256 members;
        uint256 yesCount;
        uint256 yesShares;
        uint256 noCount;
        uint256 noShares;
        bool executed;
        bool voted;
    }

    function _round(uint256 id, address reader) private returns (Round memory r) {
        vm.prank(reader);
        (bool ok, bytes memory result) =
            address(saleVault).staticcall(abi.encodeWithSignature("delistingProposal(uint256)", id));
        assertTrue(ok);
        r = abi.decode(result, (Round));
    }

    function _start(uint256 proposal) private returns (uint256 id) {
        vm.prank(ALICE);
        id = saleVault.delist(0, 0, proposal, false);
    }

    function _vote(uint256 id, uint256 proposal, address who, bool support) private {
        vm.prank(who);
        saleVault.delist(1, id, proposal, support);
    }

    function test_votedDelistRevokesNonceAndImmediatelyOpensDistinctSaleRound() public {
        uint256 oldProposal = _listSale(SALE_PRICE);
        (IFirstoSignedAskExchange.SignedAsk memory ask, bytes32 oldHash,) = saleVault.nativeFirstoAsk();
        uint256 id = _start(oldProposal);
        Round memory r = _round(0, ALICE);
        assertEq(r.id, id);
        assertEq(r.listedProposalId, oldProposal);
        assertEq(r.members, 3);
        assertEq(r.expiresAt, ask.expiry);
        _vote(id, oldProposal, ALICE, true);
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        saleVault.delist(2, id, oldProposal, false);
        _vote(id, oldProposal, CAROL, true);
        r = _round(id, CAROL);
        assertEq(r.yesCount, 2);
        assertEq(r.yesShares, 51);
        assertTrue(r.voted);
        saleVault.delist(2, id, oldProposal, false);
        assertTrue(_round(id, ALICE).executed);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertEq(saleVault.activeProposalId(), 0);
        assertEq(saleVault.listedProposalId(), 0);
        assertEq(saleVault.lastProposed(ALICE), 0);
        assertEq(nft.getApproved(rewardId), address(0));
        assertTrue(FirstoSignedAskMock(FIRSTO).isSignedAskNonceInvalidated(address(pool), ask.nonce));
        assertEq(saleVault.isValidSignature(oldHash, new bytes(65)), bytes4(0xffffffff));
        // No time advance: both seven-day round and personal cooldown are waived
        // exactly for the newly opened round after this successful removal.
        uint256 newId = _passSaleProposal(SALE_PRICE);
        assertGt(newId, oldProposal);
        assertEq(saleVault.lastProposed(ALICE), block.timestamp);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.ProposeCooldown.selector);
        saleVault.propose(SALE_PRICE, 0, 0);
        sale.executeSale(newId);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        saleVault.delist(2, id, oldProposal, false);
        assertEq(saleVault.listedProposalId(), newId);
        assertEq(saleVault.isValidSignature(oldHash, new bytes(65)), bytes4(0xffffffff));
    }

    function test_expiredListingImmediatelyReopensAndOldRoundCannotAct() public {
        uint256 proposal = _listSale(SALE_PRICE);
        uint256 id = _start(proposal);
        vm.warp(sale.expiresAt());
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        saleVault.delist(1, id, proposal, true);
        sale.cancelExpired();
        assertEq(saleVault.lastProposed(ALICE), 0);
        uint256 fresh = _passSaleProposal(SALE_PRICE);
        assertGt(fresh, proposal);
        assertEq(_round(0, ALICE).id, 0);
        sale.executeSale(fresh);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        saleVault.delist(2, id, proposal, false);
    }

    function test_exactHalfSharesCannotPassEvenWithAddressMajorityAndVotesAreSingleUse() public {
        vm.prank(CAROL);
        pool.transfer(BOB, 1); // 49/50/1; Alice+Carol: 2/3 addresses but 50/100 shares.
        uint256 proposal = _listSale(SALE_PRICE);
        uint256 id = _start(proposal);
        _vote(id, proposal, ALICE, true);
        _vote(id, proposal, CAROL, true);
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        saleVault.delist(2, id, proposal, false);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.AlreadyVoted.selector);
        saleVault.delist(1, id, proposal, false);
        _vote(id, proposal, BOB, false);
        Round memory r = _round(id, BOB);
        assertEq(r.yesShares, 50);
        assertEq(r.noShares, 50);
        assertEq(r.noCount, 1);
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        saleVault.delist(2, id, proposal, false);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
    }

    function test_exactHalfAddressesCannotPassEvenWithShareMajority() public {
        vm.prank(CAROL);
        pool.transfer(ALICE, 2); // 51/49; one of two addresses is not a majority.
        uint256 proposal = _listSale(SALE_PRICE);
        uint256 id = _start(proposal);
        _vote(id, proposal, ALICE, true);
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        saleVault.delist(2, id, proposal, false);
        _vote(id, proposal, BOB, true);
        saleVault.delist(2, id, proposal, false);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
    }

    function test_nativeOrControlledFillWinsAgainstOpenDelistingRound() public {
        uint256 proposal = _listSale(SALE_PRICE);
        uint256 id = _start(proposal);
        _vote(id, proposal, ALICE, true);
        _vote(id, proposal, CAROL, true);
        (IFirstoSignedAskExchange.SignedAsk memory ask,,) = saleVault.nativeFirstoAsk();
        vm.deal(NFT_BUYER, SALE_PRICE);
        vm.prank(NFT_BUYER);
        IFirstoSignedAskExchange(FIRSTO).fillSignedAsk{value: SALE_PRICE}(ask, new bytes(65), NFT_BUYER);
        vm.expectRevert(IPoolVault.WrongState.selector);
        saleVault.delist(2, id, proposal, false);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Closed));
        assertEq(sale.saleBuyer(), NFT_BUYER);
        assertFalse(_round(id, ALICE).executed);
    }

    function test_onlyCurrentListedRoundMembersCanStartOrVoteAndArgumentsAreBound() public {
        uint256 proposal = _listSale(SALE_PRICE);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        saleVault.delist(0, 0, proposal, false);
        uint256 id = _start(proposal);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        saleVault.delist(0, 0, proposal, false);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        saleVault.delist(1, id, proposal, true);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        saleVault.delist(1, id, proposal + 1, true);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        saleVault.delist(1, id + 1, proposal, true);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        saleVault.delist(3, id, proposal, true);
    }
}
