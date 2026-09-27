// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @notice Regression for the ee8c809 same-timestamp ownership/vote finding.
/// No fork or real wallets. Funding, share trades, voting and NFT handover use production entry points.
contract AuditGovernance is SaleTestBase {
    function test_oldFormatOpenProposalCannotBeVotedOrExecuted() public {
        _installOldSnapshotFixture();
        _readyForSale();
        vm.prank(ALICE);
        uint256 id = saleVault.propose(SALE_PRICE, 0, 0);
        _recordOldSnapshot(id);

        assertFalse(saleVault.proposalPassed(id));
        // An old-format opener may not create a competing candidate with the
        // unsafe timestamp-1 ownership snapshot after an upgrade.
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.ProposalActive.selector);
        saleVault.propose(SALE_PRICE, 0, 0);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        saleVault.vote(id, true);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        saleVault.executeSale(id);
        assertEq(nft.ownerOf(rewardId), address(pool));
    }

    function test_oldFormatListedProposalCannotCompleteAfterUpgradeAndCanExpire() public {
        _installOldSnapshotFixture();
        _readyForSale();
        vm.prank(ALICE);
        uint256 id = saleVault.propose(SALE_PRICE, 0, 0);
        vm.prank(ALICE);
        saleVault.vote(id, true);
        vm.prank(BOB);
        saleVault.vote(id, true);
        saleVault.executeSale(id);
        uint64 expiry = saleVault.expiresAt();
        _recordOldSnapshot(id);
        _upgradeVault(address(new PoolVault(address(poolFactory))), keccak256("restore-production-vault"));
        assertLt(block.timestamp, expiry);

        vm.deal(DAVE, SALE_PRICE);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        saleVault.completeSale{value: SALE_PRICE}();
        assertEq(nft.ownerOf(rewardId), address(pool));
        vm.warp(expiry);
        saleVault.cancelExpired();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        vm.prank(ALICE);
        uint256 replacement = saleVault.propose(SALE_PRICE, 0, 0);
        assertEq(saleVault.getProposal(replacement).snapshotTs, block.timestamp);
    }

    function test_sameTimestampBuyersVoteAndFormerHoldersCannotForceSale() public {
        // Remove test-only Vault extension; keep real storage and use an ordinary timelocked upgrade.
        _upgradeVault(address(new PoolVault(address(poolFactory))), keccak256("audit-production-implementation"));

        _transfer(BOB, CAROL, 23); // Prior holders: ALICE 49 / BOB 26 / CAROL 25.
        _readyForSale();
        vm.prank(ALICE);
        uint256 aliceOrder = shareMarket.list(address(pool), 49, 0.1 ether);
        vm.prank(BOB);
        uint256 bobOrder = shareMarket.list(address(pool), 25, 0.1 ether);
        vm.warp(block.timestamp + 1);
        uint256 transactionTimestamp = block.timestamp;

        // Two ordinary buyers fill valid orders before any proposal/freeze exists.
        vm.deal(DAVE, 10 ether);
        vm.deal(ERIN, 10 ether);
        vm.prank(DAVE);
        shareMarket.fill{value: 4.949 ether}(aliceOrder, 49);
        vm.prank(ERIN);
        shareMarket.fill{value: 2.525 ether}(bobOrder, 25);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.balanceOf(BOB), 1);
        assertEq(pool.balanceOf(DAVE) + pool.balanceOf(ERIN), 74);
        assertEq(shareMarket.bnbOwed(ALICE) + shareMarket.bnbOwed(BOB), 7.326 ether);

        // The proposal freezes the ownership created by those trades.
        vm.prank(BOB);
        uint256 id = saleVault.propose(1, 0, 0);
        assertEq(saleVault.getProposal(id).snapshotTs, transactionTimestamp);
        assertEq(saleVault.getProposal(id).snapshotMemberCount, 4);
        vm.prank(DAVE);
        saleVault.vote(id, false);
        vm.prank(ERIN);
        saleVault.vote(id, false);

        // Former holders have only 1 current share between them. The other
        // pre-trade owner cannot manufacture the 60 shares or address majority.
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        saleVault.vote(id, true);
        vm.prank(BOB);
        saleVault.vote(id, true);
        vm.prank(CAROL);
        saleVault.vote(id, true);
        assertEq(saleVault.getProposal(id).yesShares, 26);
        assertEq(saleVault.getProposal(id).yesCount, 2);
        assertFalse(saleVault.proposalPassed(id));
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        saleVault.executeSale(id);

        assertEq(block.timestamp, transactionTimestamp, "trades and proposal share one timestamp");
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertEq(nft.ownerOf(rewardId), address(pool));
        assertEq(saleVault.saleProceeds(), 0);
        emit log_named_uint("former holders' current shares", pool.balanceOf(ALICE) + pool.balanceOf(BOB));
        emit log_named_uint("former holders' effective proposal votes", saleVault.getProposal(id).yesShares);
        emit log_named_uint("buyers' payment in wei", 7.4 ether);
    }

    function _installOldSnapshotFixture() private {
        PoolVault fixture = new PoolVault(address(poolFactory));
        _upgradeVault(address(fixture), keccak256("old-snapshot-fixture"));
    }

    /// @dev Historical-state injection only. Keep the real production implementation rather than adding a
    /// storage-writing test entry point to a Vault whose runtime is near the EIP-170 deployment limit.
    function _recordOldSnapshot(uint256 id) private {
        uint48 current = saleVault.getProposal(id).snapshotTs;
        assertGt(current, 0);
        uint256 saleNamespace = 0x2f6815c6ef0fa51be4582ec22c24e8543902265d5f78fd79c749f4419f2ad600;
        // PoolSaleState.proposals is namespace slot 3; proposer occupies bytes 0..19 and snapshotTs bytes 20..25.
        bytes32 slot = keccak256(abi.encode(id, saleNamespace + 3));
        uint256 stored = uint256(vm.load(address(pool), slot));
        assertEq(uint48(stored >> 160), current, "historical fixture must match the live getter layout");
        uint256 mask = uint256(type(uint48).max) << 160;
        vm.store(address(pool), slot, bytes32((stored & ~mask) | (uint256(current - 1) << 160)));
        assertEq(saleVault.getProposal(id).snapshotTs, current - 1);
    }

    function _upgradeVault(address implementation, bytes32 salt) private {
        bytes memory upgrade = abi.encodeWithSignature("upgradeTo(address)", implementation);
        vm.prank(OWNER);
        timelock.schedule(address(beacon), 0, upgrade, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(beacon), 0, upgrade, bytes32(0), salt);
    }
}
