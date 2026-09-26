// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IWbnb} from "../../src/interfaces/IPancakeBurnRouter.sol";
import {Addresses} from "../../script/Addresses.sol";

/// @notice Disabled burn ABI against real BEM/WBNB balances at the reviewed BSC block.
/// @dev Only local native funding/impersonation is used. No protocol code, storage or ERC20 balance is replaced.
contract PoolBurnForkTest is Test {
    uint256 private constant FORK_BLOCK = 123728000;
    uint256 private constant TOKEN_ID = 16210;
    uint256 private constant TARGET = 0.02 ether;
    uint256 private constant PURCHASE_PRICE = 0.01 ether;
    uint256 private constant SALE_PRICE = 0.05 ether + 17;
    uint256 private constant INPUT = 0.0002 ether;
    uint256 private constant OLD_WBNB = 0.00001 ether;
    address private constant ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address private constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address private constant SELLER = 0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744;
    address private constant OWNER = address(0x1111);
    address private constant OPERATOR = address(0x2222);
    address private constant TREASURY = address(0x3333);
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);
    address private constant BUYER = address(0xB0A7);
    IERC20 private constant BEM = IERC20(Addresses.BEM);
    IERC721 private constant NFT = IERC721(Addresses.TAPEOUT_CIRCUITS);
    IERC20 private constant WRAPPED = IERC20(WBNB);
    PoolVault private vault;

    function setUp() public {
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires pinned BSC fork");
        assertEq(NFT.ownerOf(TOKEN_ID), SELLER);
        PoolTimelock timelock = new PoolTimelock(OWNER);
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        PoolBeacon beacon = new PoolBeacon(address(new PoolVault(predictedFactory)), address(timelock));
        PoolFactory factory = PoolFactory(
            address(
                new ERC1967Proxy(
                    address(new PoolFactory()),
                    abi.encodeCall(
                        PoolFactory.initialize, (OWNER, OPERATOR, TREASURY, address(timelock), address(beacon))
                    )
                )
            )
        );
        IPoolVault.PoolParams memory p = IPoolVault.PoolParams({
            circuits: Addresses.TAPEOUT_CIRCUITS,
            circuitId: TOKEN_ID,
            targetRaise: TARGET,
            priceCap: PURCHASE_PRICE,
            directSeller: SELLER,
            directPrice: PURCHASE_PRICE,
            fundingDeadline: uint64(block.timestamp + 1 days),
            purchaseDeadline: uint64(block.timestamp + 2 days)
        });
        vm.prank(OPERATOR);
        vault = PoolVault(payable(factory.createPool(p)));
        _deposit(ALICE, 49);
        _deposit(BOB, 49);
        _deposit(CAROL, 2);
        vm.startPrank(SELLER);
        NFT.approve(address(vault), TOKEN_ID);
        vault.sellToPool();
        vm.stopPrank();
        vm.warp(block.timestamp + 7 days);
        vm.prank(ALICE);
        uint256 proposal = vault.propose(SALE_PRICE, 0, 0);
        vm.prank(ALICE);
        vault.vote(proposal, true);
        vm.prank(BOB);
        vault.vote(proposal, true);
        vault.executeSale(proposal);
        vm.deal(BUYER, SALE_PRICE);
        vm.prank(BUYER);
        vault.completeSale{value: SALE_PRICE}();
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Closed));
        assertEq(NFT.ownerOf(TOKEN_ID), BUYER);
        assertEq(vault.burnBudget(), 0);
        assertGt(BEM.balanceOf(address(vault)), 0, "sale must leave real final mining rewards for old holders");
        _donations();
    }

    function test_Fork_BurnEntrypointsRejectAndPreserveAllReserves() public {
        uint256 reserved = vault.totalBnbOwed();
        uint256 bnb = address(vault).balance;
        uint256 bem = BEM.balanceOf(address(vault));
        uint256 dead = BEM.balanceOf(Addresses.BURN_SINK);
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.BurnDisabled.selector);
        vault.executeBurn(0, type(uint256).max);
        vm.expectRevert(IPoolVault.BurnDisabled.selector);
        vault.burnExpired(0);
        assertEq(vault.totalBnbOwed(), reserved);
        assertEq(address(vault).balance, bnb);
        assertEq(BEM.balanceOf(address(vault)), bem);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK), dead);
        assertEq(WRAPPED.allowance(address(vault), ROUTER), 0);
    }

    function _deposit(address member, uint8 shares) private {
        uint256 contribution = uint256(shares) * (TARGET / 100);
        vm.deal(member, contribution);
        vm.prank(member);
        vault.deposit{value: contribution}(shares);
    }

    function _donations() private {
        vm.deal(address(vault), address(vault).balance + 0.0003 ether);
        vm.deal(address(this), OLD_WBNB);
        IWbnb(WBNB).deposit{value: OLD_WBNB}();
        assertTrue(WRAPPED.transfer(address(vault), OLD_WBNB));
        vm.prank(SELLER);
        assertTrue(BEM.transfer(address(vault), 17));
    }
}
