// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract PoolBurnTest is SaleTestBase {
    function test_allBurnEntrypointsDisabledForOperatorAndMemberBeforeAndAfterSale() public {
        _assertDisabled();
        _listSale(SALE_PRICE);
        _complete(NFT_BUYER, SALE_PRICE);
        _assertDisabled();
        assertEq(sale.burnBudget(), 0);
        assertEq(saleVault.totalBurnBnbSpent(), 0);
        assertEq(saleVault.totalBurnBem(), 0);
        assertEq(bem.balanceOf(DEAD), 0);
        assertEq(_withdraw(ALICE) + _withdraw(BOB) + _withdraw(CAROL) + _withdraw(TREASURY), 11.5 ether);
        assertEq(address(pool).balance, 0);
    }

    function test_plainBnbAndWbnbRefundAreRejected() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(pool).call{value: 1}("");
        assertFalse(ok);
        vm.deal(saleVault.WBNB(), 1 ether);
        vm.prank(saleVault.WBNB());
        (ok,) = address(pool).call{value: 1}("");
        assertFalse(ok);
    }

    function _assertDisabled() private {
        address[2] memory actors = [OPERATOR, ALICE];
        for (uint256 i = 0; i < actors.length; ++i) {
            vm.prank(actors[i]);
            vm.expectRevert(IPoolVault.BurnDisabled.selector);
            saleVault.executeBurn(0, type(uint256).max);
            vm.prank(actors[i]);
            vm.expectRevert(IPoolVault.BurnDisabled.selector);
            rewards.burnExpired(firstEpoch);
        }
    }
}
