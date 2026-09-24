// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
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

/// @notice Production share transfers and market fills after a real protocol acquisition.
/// @dev Local BNB funding, owner impersonation and time progression only. No protocol/token code or storage is replaced.
contract PoolShareTransferForkTest is Test {
    uint256 private constant FORK_BLOCK = 123728000;
    uint256 private constant TOKEN_ID = 16210;
    uint256 private constant RAISE = 0.02 ether;
    uint256 private constant PRICE = 0.01 ether;
    address private constant SELLER = 0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744;
    address private constant OWNER = address(0x1111);
    address private constant OPERATOR = address(0x2222);
    address private constant TREASURY = address(0x3333);
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);
    address private constant DAVE = address(0xDA7E);
    IERC721 private constant NFT = IERC721(Addresses.TAPEOUT_CIRCUITS);
    IERC20 private constant BEM = IERC20(Addresses.BEM);
    ITapeoutMining private constant MINING = ITapeoutMining(Addresses.MINING);
    bytes32 private constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant HARVEST_TOPIC = keccak256("Harvested(uint256,uint256,uint256,uint256)");

    PoolVault private vault;
    ShareMarket private shareMarket;
    bytes32 private key;
    uint256 private sellerBemAfterPurchase;

    function setUp() public {
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires pinned BSC fork");
        assertEq(NFT.ownerOf(TOKEN_ID), SELLER);
        key = MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        assertEq(MINING.getMiner(key).status, 1);
        PoolTimelock timelock = new PoolTimelock(OWNER);
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
        ShareMarket marketImplementation = new ShareMarket();
        shareMarket = ShareMarket(
            address(
                new ERC1967Proxy(
                    address(marketImplementation),
                    abi.encodeCall(ShareMarket.initialize, (address(factory), address(timelock)))
                )
            )
        );
        bytes memory registration = abi.encodeCall(PoolFactory.registerShareMarket, (address(shareMarket)));
        bytes32 salt = keccak256("fork-real-share-market-registration");
        vm.prank(OWNER);
        timelock.schedule(address(factory), 0, registration, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(factory), 0, registration, bytes32(0), salt);
        assertEq(factory.shareMarket(), address(shareMarket));

        IPoolVault.PoolParams memory p = IPoolVault.PoolParams({
            circuits: Addresses.TAPEOUT_CIRCUITS,
            circuitId: TOKEN_ID,
            targetRaise: RAISE,
            priceCap: PRICE,
            directSeller: SELLER,
            directPrice: PRICE,
            fundingDeadline: uint64(block.timestamp + 1 days),
            purchaseDeadline: uint64(block.timestamp + 2 days)
        });
        vm.prank(OPERATOR);
        vault = PoolVault(payable(factory.createPool(p)));
        _deposit(ALICE, 49);
        _deposit(BOB, 49);
        _deposit(CAROL, 2);
        uint256 before = BEM.balanceOf(SELLER);
        vm.startPrank(SELLER);
        NFT.approve(address(vault), TOKEN_ID);
        vault.sellToPool();
        vm.stopPrank();
        sellerBemAfterPurchase = BEM.balanceOf(SELLER);
        assertGt(sellerBemAfterPurchase, before);
        assertEq(BEM.balanceOf(address(vault)), 0);
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Active));
    }

    function _deposit(address member, uint8 shares) private {
        uint256 amount = uint256(shares) * RAISE / 100;
        vm.deal(member, member.balance + amount);
        vm.prank(member);
        vault.deposit{value: amount}(shares);
    }

    function test_Fork_OrdinaryTransferClaimsBeforeBalanceChangeAndPreservesOldRewardOwnership() public {
        vm.warp(block.timestamp + 1 hours);
        uint256 supplyBefore = BEM.totalSupply();
        vm.recordLogs();
        vm.prank(ALICE);
        assertTrue(vault.transfer(DAVE, 10));
        Vm.Log[] memory entries = vm.getRecordedLogs();
        uint256 gross = BEM.totalSupply() - supplyBefore;
        uint256 net = _net(gross);
        assertGt(gross, 0);
        _assertHarvestBeforeShareTransfer(entries, ALICE, DAVE, 10, gross);
        assertEq(MINING.pending(key), 0);
        assertEq(vault.balanceOf(ALICE), 39);
        assertEq(vault.balanceOf(DAVE), 10);
        assertEq(vault.claimable(ALICE), net * 49 / 100, "pre-transfer reward uses seller's old 49 shares");
        assertEq(vault.claimable(BOB), net * 49 / 100);
        assertEq(vault.claimable(CAROL), net * 2 / 100);
        assertEq(vault.claimable(DAVE), 0, "new owner cannot take old reward");
        assertEq(vault.bnbOwed(ALICE), 0.0049 ether);
        assertEq(vault.bnbOwed(DAVE), 0, "purchase surplus stays with acquisition holder");
        assertEq(vault.memberCount(), 4);
        _assertMarketNeverMember();

        vm.warp(block.timestamp + 1 hours);
        supplyBefore = BEM.totalSupply();
        vault.harvest();
        uint256 laterGross = BEM.totalSupply() - supplyBefore;
        uint256 laterNet = _net(laterGross);
        assertGt(laterGross, 0);
        assertEq(vault.claimable(DAVE), laterNet * 10 / 100);
        assertEq(vault.claimable(ALICE), (net * 49 + laterNet * 39) / 100);
        uint256 daveBefore = BEM.balanceOf(DAVE);
        vm.prank(DAVE);
        uint256 paid = vault.claim();
        assertEq(paid, laterNet * 10 / 100);
        assertEq(BEM.balanceOf(DAVE) - daveBefore, paid);
        assertEq(BEM.balanceOf(SELLER), sellerBemAfterPurchase);
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
        assertEq(MINING.getMiner(key).status, 1);
        assertEq(vault.totalSupply(), 100);
        emit log_named_uint("ordinary transfer old-holder gross BEM (atoms)", gross);
        emit log_named_uint("ordinary transfer old-holder net BEM (atoms)", net);
        emit log_named_uint("new holder first eligible later BEM (atoms)", paid);
    }

    function test_Fork_MarketFillSettlesRealRewardsAndCreditsSellerBnbMinusOnePercent() public {
        uint256 pricePerUnit = 0.003 ether;
        uint256 sellerBnbBefore = ALICE.balance;
        vm.prank(ALICE);
        uint256 id = shareMarket.list(address(vault), 20, pricePerUnit);
        assertEq(vault.lockedShares(ALICE), 20);
        assertEq(vault.balanceOf(ALICE), 49);
        assertEq(vault.memberCount(), 3);
        _assertMarketNeverMember();
        vm.warp(block.timestamp + 1 hours);
        uint256 supplyBefore = BEM.totalSupply();
        uint256 payment = 7 * pricePerUnit;
        vm.deal(DAVE, payment);
        vm.recordLogs();
        vm.prank(DAVE);
        shareMarket.fill{value: payment}(id, 7);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        uint256 gross = BEM.totalSupply() - supplyBefore;
        uint256 net = _net(gross);
        assertGt(gross, 0);
        _assertHarvestBeforeShareTransfer(entries, ALICE, DAVE, 7, gross);
        assertEq(vault.claimable(ALICE), net * 49 / 100);
        assertEq(vault.claimable(DAVE), 0);
        assertEq(vault.balanceOf(ALICE), 42);
        assertEq(vault.balanceOf(DAVE), 7);
        assertEq(vault.lockedShares(ALICE), 13);
        assertEq(shareMarket.orders(id).remaining, 13);
        assertTrue(shareMarket.orders(id).active);
        assertEq(ALICE.balance, sellerBnbBefore);
        assertEq(shareMarket.bnbOwed(ALICE), 0.02079 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.00021 ether);
        assertEq(shareMarket.totalBnbOwed(), 0.021 ether);
        assertEq(address(shareMarket).balance, payment);
        assertEq(DAVE.balance, 0, "buyer pays exactly amount times price, without extra fee");
        assertEq(vault.bnbOwed(ALICE), 0.0049 ether);
        assertEq(vault.bnbOwed(DAVE), 0);
        _assertMarketNeverMember();
        uint256 supplyAfterFill = BEM.totalSupply();
        vm.prank(ALICE);
        shareMarket.cancel(id);
        assertEq(vault.lockedShares(ALICE), 0);
        assertEq(vault.balanceOf(ALICE), 42);
        assertEq(BEM.totalSupply(), supplyAfterFill, "cancel does not change beneficial ownership or harvest");
        vm.prank(ALICE);
        shareMarket.withdrawBnb();
        assertEq(ALICE.balance - sellerBnbBefore, 0.02079 ether);
        assertEq(shareMarket.bnbOwed(ALICE), 0);
        assertEq(vault.bnbOwed(ALICE), 0.0049 ether, "share sale proceeds do not consume original purchase surplus");
        assertEq(BEM.balanceOf(SELLER), sellerBemAfterPurchase);
        assertEq(MINING.getMiner(key).status, 1);
        emit log_named_uint("share fill gross BNB (wei)", payment);
        emit log_named_uint("share fill treasury BNB fee (wei)", shareMarket.bnbOwed(TREASURY));
        emit log_named_uint("share fill old-holder net BEM (atoms)", net);
    }

    function _net(uint256 gross) private pure returns (uint256) {
        return gross - gross / 100 - gross * 4 / 100;
    }

    function _assertMarketNeverMember() private view {
        assertEq(vault.balanceOf(address(shareMarket)), 0);
        assertEq(vault.claimable(address(shareMarket)), 0);
        address[] memory members = vault.activeMembers();
        for (uint256 i; i < members.length; ++i) {
            assertTrue(members[i] != address(shareMarket));
        }
    }

    function _assertHarvestBeforeShareTransfer(
        Vm.Log[] memory entries,
        address from,
        address to,
        uint256 shares,
        uint256 gross
    ) private view {
        uint256 mintIndex = type(uint256).max;
        uint256 harvestIndex = type(uint256).max;
        uint256 transferIndex = type(uint256).max;
        for (uint256 i; i < entries.length; ++i) {
            Vm.Log memory entry = entries[i];
            if (entry.topics.length == 0) continue;
            if (
                entry.emitter == Addresses.BEM && entry.topics[0] == TRANSFER_TOPIC
                    && address(uint160(uint256(entry.topics[1]))) == address(0)
                    && address(uint160(uint256(entry.topics[2]))) == address(vault)
            ) {
                assertEq(abi.decode(entry.data, (uint256)), gross);
                mintIndex = i;
            } else if (entry.emitter == address(vault) && entry.topics[0] == HARVEST_TOPIC) {
                (uint256 recordedGross, uint256 fee, uint256 burn, uint256 net) =
                    abi.decode(entry.data, (uint256, uint256, uint256, uint256));
                assertEq(recordedGross, gross);
                assertEq(fee, gross / 100);
                assertEq(burn, gross * 4 / 100);
                assertEq(net, _net(gross));
                harvestIndex = i;
            } else if (entry.emitter == address(vault) && entry.topics[0] == TRANSFER_TOPIC) {
                assertEq(address(uint160(uint256(entry.topics[1]))), from);
                assertEq(address(uint160(uint256(entry.topics[2]))), to);
                assertEq(abi.decode(entry.data, (uint256)), shares);
                transferIndex = i;
            }
        }
        assertLt(transferIndex, entries.length, "real share transfer event missing");
        assertLt(mintIndex, harvestIndex, "actual Mining receipt must precede allocation");
        assertLt(harvestIndex, transferIndex, "old-owner revenue must be allocated before share balances change");
    }
}
