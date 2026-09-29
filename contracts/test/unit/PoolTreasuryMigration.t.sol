// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract PoolTreasuryMigrationTest is ShareTransferTestBase {
    address private constant NEXT_TREASURY = address(0x8888);

    function test_timelockMigrationSettlesOldRewardsAndPreservesPreviouslyBookedFees() public {
        PoolVault vault = PoolVault(payable(address(pool)));
        assertEq(vault.treasury(), TREASURY);

        vm.prank(ALICE);
        uint256 oldOrder = shareMarket.list(address(pool), 1, 0.01 ether);
        vm.deal(DAVE, 1 ether);
        vm.prank(DAVE);
        shareMarket.fill{value: 0.0101 ether}(oldOrder, 1);
        uint256 oldCredit = shareMarket.bnbOwed(TREASURY);
        assertEq(oldCredit, 0.0002 ether);

        _queueReward(10_000);
        bytes memory migration = abi.encodeCall(PoolVault.migrateTreasury, (TREASURY, NEXT_TREASURY));
        bytes32 salt = keccak256("existing-pool-treasury-migration");
        vm.prank(OWNER);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        vault.migrateTreasury(TREASURY, NEXT_TREASURY);
        vm.prank(OWNER);
        timelock.schedule(address(pool), 0, migration, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);

        mining.setClaimFault(1);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        timelock.execute(address(pool), 0, migration, bytes32(0), salt);
        assertEq(vault.treasury(), TREASURY);

        mining.setClaimFault(0);
        timelock.execute(address(pool), 0, migration, bytes32(0), salt);
        assertEq(vault.treasury(), NEXT_TREASURY);
        assertEq(bem.balanceOf(TREASURY), 100);
        assertEq(bem.balanceOf(NEXT_TREASURY), 0);
        assertEq(shareMarket.bnbOwed(TREASURY), oldCredit);

        vm.prank(BOB);
        uint256 nextOrder = shareMarket.list(address(pool), 1, 0.01 ether);
        vm.deal(ERIN, 1 ether);
        vm.prank(ERIN);
        shareMarket.fill{value: 0.0101 ether}(nextOrder, 1);
        assertEq(shareMarket.bnbOwed(TREASURY), oldCredit);
        assertEq(shareMarket.bnbOwed(NEXT_TREASURY), 0.0002 ether);

        vm.prank(address(timelock));
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        vault.migrateTreasury(TREASURY, address(0x9999));
    }
}
