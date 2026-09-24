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
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {ITapeoutMining} from "../../src/interfaces/ITapeoutMining.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IAuditMiningStop {
    function stop(bytes32 key) external;
}

/// @notice Real protocol fork regression with explicitly labelled non-active-state simulations.
/// @dev Status-override tests are not natural revocations. The stop test impersonates the owner only locally;
/// production Vault/operator still has no stop entry point. No protocol code or BEM balance is replaced.
contract AuditMiningSettlementForkTest is Test {
    uint256 private constant TOKEN_ID = 16210;
    uint256 private constant PRICE = 0.01 ether;
    uint256 private constant SALE_PRICE = 0.02 ether;
    address private constant SELLER = 0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744;
    address private constant OWNER = address(0x1111);
    address private constant OPERATOR = address(0x2222);
    address private constant TREASURY = address(0x3333);
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);
    address private constant DAVE = address(0xDA7E);
    address private constant BUYER = address(0xB0A7);
    IERC721 private constant NFT = IERC721(Addresses.TAPEOUT_CIRCUITS);
    IERC20 private constant BEM = IERC20(Addresses.BEM);
    ITapeoutMining private constant MINING = ITapeoutMining(Addresses.MINING);
    PoolVault private vault;
    ShareMarket private market;
    bytes32 private key;

    function setUp() public {
        require(block.chainid == 56 && block.number == 123728000, "requires pinned BSC fork");
        key = MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        assertEq(MINING.getMiner(key).status, 1);
        PoolTimelock timelock = new PoolTimelock(OWNER);
        // Exactly these four consecutive CREATEs bind the implementation to its canonical Factory.
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        PoolVault implementation = new PoolVault(predictedFactory);
        PoolBeacon beacon = new PoolBeacon(address(implementation), address(timelock));
        PoolFactory factoryImplementation = new PoolFactory();
        PoolFactory factory = PoolFactory(
            address(
                new ERC1967Proxy(
                    address(factoryImplementation),
                    abi.encodeCall(
                        PoolFactory.initialize, (OWNER, OPERATOR, TREASURY, address(timelock), address(beacon))
                    )
                )
            )
        );
        assertEq(address(factory), predictedFactory);
        market = ShareMarket(
            address(
                new ERC1967Proxy(
                    address(new ShareMarket()),
                    abi.encodeCall(ShareMarket.initialize, (address(factory), address(timelock)))
                )
            )
        );
        bytes memory registration = abi.encodeCall(PoolFactory.registerShareMarket, (address(market)));
        vm.prank(OWNER);
        timelock.schedule(address(factory), 0, registration, bytes32(0), bytes32(0), 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(factory), 0, registration, bytes32(0), bytes32(0));
        vm.prank(OPERATOR);
        vault = PoolVault(
            payable(factory.createPool(
                    IPoolVault.PoolParams({
                        circuits: Addresses.TAPEOUT_CIRCUITS,
                        circuitId: TOKEN_ID,
                        targetRaise: 2 * PRICE,
                        priceCap: PRICE,
                        directSeller: SELLER,
                        directPrice: PRICE,
                        fundingDeadline: uint64(block.timestamp + 1 days),
                        purchaseDeadline: uint64(block.timestamp + 2 days)
                    })
                ))
        );
        _deposit(ALICE, 49);
        _deposit(BOB, 49);
        _deposit(CAROL, 2);
        vm.startPrank(SELLER);
        NFT.approve(address(vault), TOKEN_ID);
        vault.sellToPool();
        vm.stopPrank();
        vm.warp(block.timestamp + 7 days);
        vault.harvest();
        assertGt(vault.bemAccounted(), 0);
    }

    function test_Fork_StateOverrideStatus0AllowsSharesMarketAndWholeNftSale() public {
        _setStatus(0);
        _assertExit();
    }

    function test_Fork_StateOverrideStatus2AllowsSharesMarketAndWholeNftSale() public {
        _setStatus(2);
        _assertExit();
    }

    function test_Fork_StateOverrideStatus3AllowsSharesMarketAndWholeNftSale() public {
        _setStatus(3);
        _assertExit();
    }

    function test_Fork_LocalOwnerImpersonatedStopTransitionAllowsExitWithoutStorageOverride() public {
        vm.prank(address(vault));
        IAuditMiningStop(Addresses.MINING).stop(key);
        assertEq(MINING.getMiner(key).status, 3);
        emit log("local owner impersonation called real stop; production operator still cannot call stop");
        _assertExit();
    }

    function test_Fork_StateOverrideUnknownStatusRejectsZeroSettlement() public {
        _setStatus(255);
        assertEq(MINING.pending(key), 0);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        vault.transfer(DAVE, 1);
        assertEq(vault.balanceOf(ALICE), 49);
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
    }

    function _assertExit() private {
        assertEq(MINING.pending(key), 0);
        vm.prank(address(vault));
        vm.expectRevert(bytes4(0x5f9bb3be));
        MINING.claim(key);
        uint256 accountedBefore = vault.bemAccounted();
        uint256 supplyBefore = BEM.totalSupply();
        uint256 oldAliceClaim = vault.claimable(ALICE);
        vm.prank(ALICE);
        assertTrue(vault.transfer(DAVE, 1));
        assertEq(vault.claimable(ALICE), oldAliceClaim);
        assertEq(vault.claimable(DAVE), 0);
        vm.prank(ALICE);
        uint256 order = market.list(address(vault), 2, 0);
        vm.prank(DAVE);
        market.fill(order, 2);
        assertEq(vault.balanceOf(DAVE), 3);
        vm.warp(block.timestamp + 1);
        vm.prank(ALICE);
        uint256 proposal = vault.propose(SALE_PRICE, 0, 0);
        address[4] memory voters = [ALICE, BOB, CAROL, DAVE];
        for (uint256 i; i < voters.length; ++i) {
            vm.prank(voters[i]);
            vault.vote(proposal, true);
        }
        vault.executeSale(proposal);
        vm.deal(BUYER, SALE_PRICE);
        vm.prank(BUYER);
        vault.completeSale{value: SALE_PRICE}();
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Closed));
        assertEq(NFT.ownerOf(TOKEN_ID), BUYER);
        assertEq(BEM.totalSupply(), supplyBefore, "zero settlement never fabricates a successful reward claim");
        assertEq(vault.bemAccounted(), accountedBefore);
        assertEq(vault.claimable(ALICE), oldAliceClaim);
        uint256 beforeBalance = BEM.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.claim();
        assertEq(BEM.balanceOf(ALICE) - beforeBalance, oldAliceClaim);
        uint256 owed = vault.bnbOwed(ALICE);
        uint256 nativeBefore = ALICE.balance;
        vm.prank(ALICE);
        vault.withdrawBnb();
        assertEq(ALICE.balance - nativeBefore, owed);
        emit log_named_uint("old-holder BEM paid after safe zero settlement (atoms)", oldAliceClaim);
        emit log_named_uint("old-holder BNB exit proceeds (wei)", owed);
    }

    function _setStatus(uint8 status) private {
        ITapeoutMining.Miner memory expected = MINING.getMiner(key);
        bytes32 word = bytes32(uint256(keccak256(abi.encode(key, uint256(8)))) + 2);
        uint256 beforeWord = uint256(vm.load(Addresses.MINING, word));
        assertEq(uint8(beforeWord), 1);
        vm.store(Addresses.MINING, word, bytes32((beforeWord & ~uint256(0xff)) | status));
        expected.status = status;
        assertEq(keccak256(abi.encode(MINING.getMiner(key))), keccak256(abi.encode(expected)));
        emit log_named_uint("artificial status-byte override, not natural revocation", status);
    }

    function _deposit(address member, uint8 shares) private {
        uint256 amount = uint256(shares) * (2 * PRICE / 100);
        vm.deal(member, amount);
        vm.prank(member);
        vault.deposit{value: amount}(shares);
    }
}
