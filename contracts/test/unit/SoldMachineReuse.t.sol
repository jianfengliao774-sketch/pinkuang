// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {IFundingVault} from "../utils/FundingTestBase.sol";
import {FirstoSignedAskMock} from "../utils/FirstoMocks.sol";
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {FreshPoolFactory} from "../../src/FreshPoolFactory.sol";

contract SoldMachineReuseTest is SaleTestBase {
    function test_reuseCapabilityIsInheritedByFreshFactory() public {
        assertEq(poolFactory.soldMachineReuseVersion(), 1);
        assertEq((new FreshPoolFactory()).soldMachineReuseVersion(), 1);
    }

    function _newParams() private view returns (IPoolVault.PoolParams memory p) {
        p = pool.params();
        p.fundingDeadline = uint64(block.timestamp + 7 days);
        p.purchaseDeadline = uint64(block.timestamp + 10 days);
    }

    function _expectOccupied(address occupied) private {
        vm.expectRevert(
            abi.encodeWithSelector(PoolFactory.MachineAlreadyReserved.selector, address(nft), rewardId, occupied)
        );
        vm.prank(OPERATOR);
    }

    function _sell(bool nativeSite) private {
        _queueReward(10_000);
        _listSale(SALE_PRICE);
        if (nativeSite) {
            (IFirstoSignedAskExchange.SignedAsk memory ask,, bool active) = saleVault.nativeFirstoAsk();
            assertTrue(active);
            vm.deal(NFT_BUYER, SALE_PRICE);
            vm.prank(NFT_BUYER);
            IFirstoSignedAskExchange(FIRSTO).fillSignedAsk{value: SALE_PRICE}(ask, new bytes(65), NFT_BUYER);
        } else {
            _complete(NFT_BUYER, SALE_PRICE);
        }
        _stateIs(IPoolVault.State.Closed);
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
    }

    function testFuzz_completedNativeOrControlledSaleAllowsNewProjectWithoutMovingOldClaims(bool nativeSite) public {
        _sell(nativeSite);
        uint256 oldCount = poolFactory.poolCount();
        uint256 oldShares = pool.balanceOf(ALICE);
        uint256 oldBnb = pool.bnbOwed(ALICE);
        uint256 oldBem = rewards.claimable(ALICE);
        assertGt(oldBnb, 0);
        assertGt(oldBem, 0);
        assertEq(poolFactory.machinePool(address(nft), rewardId), address(0));

        IPoolVault.PoolParams memory p = _newParams();
        IFundingVault replacement = _createPool(p);
        assertTrue(poolFactory.isPool(address(pool)));
        assertTrue(poolFactory.isPool(address(replacement)));
        assertEq(poolFactory.poolCount(), oldCount + 1);
        assertEq(poolFactory.allPools(oldCount), address(replacement));
        assertEq(poolFactory.machinePool(address(nft), rewardId), address(replacement));
        assertEq(uint256(replacement.state()), uint256(IPoolVault.State.Funding));
        assertEq(pool.balanceOf(ALICE), oldShares);
        assertEq(pool.bnbOwed(ALICE), oldBnb);
        assertEq(rewards.claimable(ALICE), oldBem);
        assertEq(sale.saleBuyer(), NFT_BUYER);
        assertEq(sale.saleProceeds(), SALE_PRICE);

        _deposit(replacement, ALICE, 1);
        uint256 newBalance = address(replacement).balance;
        assertEq(replacement.balanceOf(ALICE), 1);
        assertEq(_withdraw(ALICE), oldBnb);
        assertEq(_claim(ALICE), oldBem);
        assertEq(address(replacement).balance, newBalance);
        assertEq(replacement.balanceOf(ALICE), 1);
        assertEq(poolFactory.machinePool(address(nft), rewardId), address(replacement));
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
        _stateIs(IPoolVault.State.Closed);
        _expectOccupied(address(replacement));
        poolFactory.createPool(p);
    }

    function test_activeListedAndExpiredListingCannotCreateOverlappingProjects() public {
        IPoolVault.PoolParams memory p = _newParams();
        _expectOccupied(address(pool));
        poolFactory.createPool(p);
        _listSale(SALE_PRICE);
        p = _newParams();
        _expectOccupied(address(pool));
        poolFactory.createPool(p);
        vm.warp(sale.expiresAt());
        sale.cancelExpired();
        p = _newParams();
        _expectOccupied(address(pool));
        poolFactory.createPool(p);
        assertEq(poolFactory.machinePool(address(nft), rewardId), address(pool));
    }

    function test_failedNativePayoutDoesNotReleaseMachineForASecondProject() public {
        _listSale(SALE_PRICE);
        (IFirstoSignedAskExchange.SignedAsk memory ask,,) = saleVault.nativeFirstoAsk();
        FirstoSignedAskMock(FIRSTO).setFault(8);
        vm.deal(NFT_BUYER, SALE_PRICE);
        vm.prank(NFT_BUYER);
        vm.expectRevert();
        IFirstoSignedAskExchange(FIRSTO).fillSignedAsk{value: SALE_PRICE}(ask, new bytes(65), NFT_BUYER);
        _stateIs(IPoolVault.State.Listed);
        assertEq(nft.ownerOf(rewardId), address(pool));
        IPoolVault.PoolParams memory p = _newParams();
        _expectOccupied(address(pool));
        poolFactory.createPool(p);
    }

    function test_closedPoolThatRegainsNftCustodyCannotReserveItInAnotherProject() public {
        _sell(true);
        vm.prank(NFT_BUYER);
        nft.transferFrom(NFT_BUYER, address(pool), rewardId);
        assertEq(poolFactory.machinePool(address(nft), rewardId), address(pool));
        IPoolVault.PoolParams memory p = _newParams();
        _expectOccupied(address(pool));
        poolFactory.createPool(p);
    }

    function test_budgetChildUsesTheSameReservationAndPreservesTheOldRegisteredPool() public {
        IPoolVault.PoolParams memory p = _newParams();
        _expectOccupied(address(pool));
        poolFactory.createBudgetChildPool(p, BOB);
        _sell(true);
        p = _newParams();
        vm.prank(OPERATOR);
        address replacement = poolFactory.createBudgetChildPool(p, BOB);
        assertTrue(poolFactory.isPool(address(pool)));
        assertTrue(poolFactory.isPool(replacement));
        assertEq(poolFactory.designatedSubscriber(replacement), BOB);
        assertEq(poolFactory.designatedSubscriber(address(pool)), address(0));
        assertEq(poolFactory.machinePool(address(nft), rewardId), replacement);
        _stateIs(IPoolVault.State.Closed);
        _expectOccupied(replacement);
        poolFactory.createBudgetChildPool(p, CAROL);
        _expectOccupied(replacement);
        poolFactory.createPool(p);
    }
}
