// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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

interface IBurnForkPoolState {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool);
    function fee() external view returns (uint24);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice Real Router, WBNB, BEM and BeaconProxy refund path at the reviewed BSC block.
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
    IBurnForkPoolState private constant SWAP_POOL = IBurnForkPoolState(Addresses.PANCAKE_V3_BEM_WBNB_POOL);
    PoolVault private vault;

    function setUp() public {
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires pinned BSC fork");
        assertEq(NFT.ownerOf(TOKEN_ID), SELLER);
        assertEq(SWAP_POOL.token0(), Addresses.BEM);
        assertEq(SWAP_POOL.token1(), WBNB);
        assertEq(SWAP_POOL.fee(), 10_000);
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
        assertEq(vault.burnBudget(), SALE_PRICE / 50);
        assertGt(BEM.balanceOf(address(vault)), 0, "sale must leave real final mining rewards for old holders");
        _donations();
    }

    function test_Fork_ActualSwapBurnOnlyNewBemAndPreserveAllMemberAssets() public {
        bytes32 protectedBefore = _protectedDigest();
        uint256 bnbBefore = address(vault).balance;
        uint256 bemBefore = BEM.balanceOf(address(vault));
        uint256 deadBefore = BEM.balanceOf(Addresses.BURN_SINK);
        uint256 supplyBefore = BEM.totalSupply();
        uint256 expectedSpent = ROUTER.balance >= INPUT ? 0 : INPUT;
        uint256 minimum = _minimumOut(INPUT);
        vm.prank(OPERATOR);
        (uint256 spent, uint256 burned) = vault.executeBurn(minimum, INPUT);
        assertEq(spent, expectedSpent);
        assertGt(burned, 0);
        assertGe(burned, minimum);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK) - deadBefore, burned);
        assertEq(BEM.balanceOf(address(vault)), bemBefore);
        assertEq(BEM.totalSupply(), supplyBefore, "DEX burn does not mint or harvest any new mining BEM");
        assertEq(address(vault).balance, bnbBefore - spent);
        assertEq(WRAPPED.balanceOf(address(vault)), OLD_WBNB);
        assertEq(WRAPPED.allowance(address(vault), ROUTER), 0);
        assertEq(vault.burnBudget(), SALE_PRICE / 50 - spent);
        assertEq(vault.totalBurnBnbSpent(), spent);
        assertEq(vault.totalBurnBem(), burned);
        assertEq(_protectedDigest(), protectedBefore);
        emit log_named_uint("actual budget BNB spent (wei)", spent);
        emit log_named_uint("minimum BEM output (8-decimal atoms)", minimum);
        emit log_named_uint("actual newly bought and burned BEM (atoms)", burned);
    }

    function test_Fork_PrefundedRouterRefundsWrappedInputThroughActualBeaconProxy2300GasReceive() public {
        vm.deal(ROUTER, ROUTER.balance + 3 * INPUT);
        uint256 routerBefore = ROUTER.balance;
        uint256 bnbBefore = address(vault).balance;
        uint256 bemBefore = BEM.balanceOf(address(vault));
        uint256 deadBefore = BEM.balanceOf(Addresses.BURN_SINK);
        bytes32 protectedBefore = _protectedDigest();
        uint256 minimum = _minimumOut(INPUT);
        vm.prank(OPERATOR);
        (uint256 spent, uint256 burned) = vault.executeBurn(minimum, INPUT);
        assertEq(spent, 0, "SmartRouter pays from its pre-existing native balance before pulling WBNB");
        assertGt(burned, 0);
        assertEq(ROUTER.balance, routerBefore - INPUT, "unused Router native funds must not be swept");
        assertEq(address(vault).balance, bnbBefore, "real WBNB.transfer refund must reach the real BeaconProxy");
        assertEq(WRAPPED.balanceOf(address(vault)), OLD_WBNB);
        assertEq(WRAPPED.allowance(address(vault), ROUTER), 0);
        assertEq(BEM.balanceOf(address(vault)), bemBefore);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK) - deadBefore, burned);
        assertEq(vault.burnBudget(), SALE_PRICE / 50);
        assertEq(vault.totalBurnBnbSpent(), 0);
        assertEq(vault.totalBurnBem(), burned);
        assertEq(_protectedDigest(), protectedBefore);
        emit log_named_uint("prefunded Router BNB retained (wei)", ROUTER.balance);
        emit log_named_uint("full WBNB input refunded into BeaconProxy (wei)", INPUT);
        emit log_named_uint("actual BEM burned with zero Vault budget spend (atoms)", burned);
    }

    function test_Fork_ExcessiveMinimumRollsBackRouterAndVaultAssetAccounting() public {
        bytes32 protectedBefore = _protectedDigest();
        uint256 bnbBefore = address(vault).balance;
        uint256 routerBefore = ROUTER.balance;
        uint256 bemBefore = BEM.balanceOf(address(vault));
        uint256 deadBefore = BEM.balanceOf(Addresses.BURN_SINK);
        vm.prank(OPERATOR);
        vm.expectRevert();
        vault.executeBurn(type(uint256).max, INPUT);
        assertEq(address(vault).balance, bnbBefore);
        assertEq(ROUTER.balance, routerBefore);
        assertEq(BEM.balanceOf(address(vault)), bemBefore);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK), deadBefore);
        assertEq(WRAPPED.balanceOf(address(vault)), OLD_WBNB);
        assertEq(WRAPPED.allowance(address(vault), ROUTER), 0);
        assertEq(vault.burnBudget(), SALE_PRICE / 50);
        assertEq(vault.totalBurnBnbSpent(), 0);
        assertEq(vault.totalBurnBem(), 0);
        assertEq(_protectedDigest(), protectedBefore);
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

    function _minimumOut(uint256 bnbAmount) private view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = SWAP_POOL.slot0();
        uint256 ratioX128 = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 64);
        uint256 spot = Math.mulDiv(bnbAmount, 1 << 128, ratioX128);
        // 1% fee then 1% additional headroom against instantaneous spot; not a slippage measurement.
        return Math.mulDiv(Math.mulDiv(spot, 99, 100), 99, 100);
    }

    function _protectedDigest() private view returns (bytes32) {
        bytes32 members = keccak256(
            abi.encode(
                vault.totalBnbOwed(),
                vault.bnbOwed(ALICE),
                vault.bnbOwed(BOB),
                vault.bnbOwed(CAROL),
                vault.bnbOwed(TREASURY),
                vault.saleOutstandingWei(),
                vault.saleRemainder(),
                vault.surplusRemainder()
            )
        );
        uint32 epoch = uint32(block.timestamp / 1 days);
        return keccak256(
            abi.encode(
                members,
                vault.bemAccounted(),
                vault.accBemPerShare(),
                vault.epochNet(epoch),
                vault.epochPaid(epoch),
                vault.epochBurned(epoch),
                vault.claimable(ALICE),
                vault.claimable(BOB),
                vault.claimable(CAROL),
                NFT.ownerOf(TOKEN_ID)
            )
        );
    }
}
