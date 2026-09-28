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
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IPurchaseForkVault {
    function deposit(uint8 shares) external payable;
    function buyFromMarket(uint256 listingId) external;
    function sellToPool() external;
    function withdrawBnb() external;
    function state() external view returns (IPoolVault.State);
    function purchaseCost() external view returns (uint256);
    function activatedAt() external view returns (uint64);
    function surplusPerShareWei() external view returns (uint256);
    function surplusRemainder() external view returns (uint256);
    function bnbOwed(address member) external view returns (uint256);
    function totalBnbOwed() external view returns (uint256);
    function balanceOf(address member) external view returns (uint256);
}

interface IPurchaseForkMarket {
    function list(address circuits, uint256 tokenId, uint96 price) external returns (uint256);
    function listingView(uint256 id)
        external
        view
        returns (address seller, address circuits, uint256 tokenId, uint96 price, uint16 feeBps, bool valid);
}

interface IPurchaseForkMining {
    struct Miner {
        address circuits;
        uint64 circuitId;
        uint32 taskId;
        uint32 gateCount;
        uint32 stateCount;
        uint32 depth;
        uint64 area;
        uint32 mult;
        uint64 since;
        uint8 status;
        address registrant;
        uint32 nandBurn;
        uint32 latchBurn;
        uint64 bstar;
        uint64 bonus;
        bool optimal;
        uint64 commitBlock;
        uint64 firstUnusedId;
        uint64 stopBlock;
        uint128 verifWeight;
        uint128 unverWeight;
        uint256 debt;
    }

    function minerKey(address circuits, uint256 tokenId) external view returns (bytes32);
    function getMiner(bytes32 key) external view returns (Miner memory);
    function pending(bytes32 key) external view returns (uint256);
    function claim(bytes32 key) external;
}

/// @notice T1b production Vault integration against the real, pinned BSC protocol.
/// @dev Only native-BNB funding and original-owner impersonation are simulated locally.
/// No NFT/ERC20 balances, protocol code or protocol storage are replaced.
contract PoolPurchaseForkTest is Test {
    uint256 private constant FORK_BLOCK = 123728000;
    uint256 private constant TOKEN_ID = 16210;
    uint256 private constant TARGET_RAISE = 0.02 ether;
    uint96 private constant PRICE = 0.01 ether;
    address private constant SELLER = 0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744;
    address private constant OWNER = address(0x1111);
    address private constant OPERATOR = address(0x2222);
    address private constant TREASURY = address(0x3333);
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);

    bytes32 private constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant SETTLED_TOPIC =
        keccak256("RewardSettledBeforeTransfer(address,uint256,address,uint256,bytes32)");
    bytes32 private constant PURCHASED_TOPIC = keccak256("Purchased(uint256,uint8,uint256)");

    IERC721 private constant NFT = IERC721(Addresses.TAPEOUT_CIRCUITS);
    IERC20 private constant BEM = IERC20(Addresses.BEM);
    IPurchaseForkMining private constant MINING = IPurchaseForkMining(Addresses.MINING);
    IPurchaseForkMarket private constant MARKET = IPurchaseForkMarket(Addresses.CIRCUIT_MARKET);

    PoolFactory private factory;
    bytes32 private key;

    function setUp() public {
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires pinned BSC fork");
        assertEq(NFT.ownerOf(TOKEN_ID), SELLER, "fixture owner changed");
        key = MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        assertEq(MINING.getMiner(key).status, 1, "fixture must already be mining");
        assertGt(MINING.pending(key), 0);

        PoolTimelock timelock = new PoolTimelock(OWNER);
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        PoolVault vaultImplementation = new PoolVault(predictedFactory);
        PoolBeacon beacon = new PoolBeacon(address(vaultImplementation), address(timelock));
        PoolFactory factoryImplementation = new PoolFactory();
        factory = PoolFactory(
            address(
                new ERC1967Proxy(
                    address(factoryImplementation),
                    abi.encodeCall(
                        PoolFactory.initialize, (OWNER, OPERATOR, TREASURY, address(timelock), address(beacon))
                    )
                )
            )
        );
    }

    function test_Fork_ProductionMarketPurchaseSettlesSellerThenDeliversAndKeepsMining() public {
        IPurchaseForkVault vault = _fundedVault(false, PRICE);
        uint256 listingId = _list(PRICE);
        uint256 sellerBemBefore = BEM.balanceOf(SELLER);
        uint256 sellerBnbBefore = SELLER.balance;
        uint256 supplyBefore = BEM.totalSupply();

        vm.recordLogs();
        vm.prank(makeAddr("permissionless market executor"));
        vault.buyFromMarket(listingId);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        uint256 sellerReward = BEM.balanceOf(SELLER) - sellerBemBefore;
        assertGt(sellerReward, 0);
        assertEq(BEM.totalSupply() - supplyBefore, sellerReward);
        assertEq(BEM.balanceOf(address(vault)), 0, "old rewards must not enter the new pool");
        assertEq(SELLER.balance - sellerBnbBefore, uint256(PRICE) * 99 / 100);
        assertEq(address(vault).balance, TARGET_RAISE - PRICE);
        _assertAcquired(vault, PRICE);
        _assertHandoverEvents(entries, address(vault), sellerReward, PRICE, 0, listingId);
        (,,,,, bool valid) = MARKET.listingView(listingId);
        assertFalse(valid, "market listing must be consumed");
        _withdrawMemberSurplus(vault, PRICE);

        uint256 sellerBemAfter = BEM.balanceOf(SELLER);
        vm.warp(block.timestamp + 1 hours);
        // pending() is lazy: another real miner's claim checkpoints the global accumulator.
        MINING.claim(MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, 400));
        uint256 newReward = MINING.pending(key);
        assertGt(newReward, 0);
        MINING.claim(key); // Permissionless protocol claim; production harvest belongs to T1c.
        assertEq(BEM.balanceOf(address(vault)), newReward);
        assertEq(BEM.balanceOf(SELLER), sellerBemAfter, "post-purchase emissions belong to the Vault");
        assertEq(MINING.getMiner(key).status, 1);
        emit log_named_uint("production market purchase cost (wei)", PRICE);
        emit log_named_uint("seller BEM settled before market transfer (atoms)", sellerReward);
        emit log_named_uint("Vault new BEM after 3600 seconds (atoms)", newReward);
    }

    function test_Fork_ProductionDirectPurchaseSettlesSellerAndCreditsPullProceeds() public {
        IPurchaseForkVault vault = _fundedVault(true, PRICE);
        vm.prank(SELLER);
        NFT.approve(address(vault), TOKEN_ID);
        uint256 sellerBemBefore = BEM.balanceOf(SELLER);
        uint256 sellerBnbBefore = SELLER.balance;
        uint256 supplyBefore = BEM.totalSupply();

        vm.recordLogs();
        vm.prank(SELLER);
        vault.sellToPool();
        Vm.Log[] memory entries = vm.getRecordedLogs();

        uint256 sellerReward = BEM.balanceOf(SELLER) - sellerBemBefore;
        assertGt(sellerReward, 0);
        assertEq(BEM.totalSupply() - supplyBefore, sellerReward);
        assertEq(BEM.balanceOf(address(vault)), 0);
        assertEq(SELLER.balance, sellerBnbBefore, "direct sale records pull credit before withdrawal");
        assertEq(vault.bnbOwed(SELLER), PRICE);
        assertEq(address(vault).balance, TARGET_RAISE);
        _assertAcquired(vault, PRICE);
        _assertHandoverEvents(entries, address(vault), sellerReward, PRICE, 1, 0);
        _withdrawMemberSurplus(vault, PRICE);

        vm.prank(SELLER);
        vault.withdrawBnb();
        assertEq(SELLER.balance - sellerBnbBefore, PRICE, "direct route incurs no CircuitMarket fee");
        assertEq(vault.bnbOwed(SELLER), 0);
        assertEq(vault.totalBnbOwed(), 0);
        assertEq(address(vault).balance, 0);
        vm.prank(SELLER);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        vault.withdrawBnb();
        emit log_named_uint("production direct purchase cost (wei)", PRICE);
        emit log_named_uint("seller BEM settled before direct transfer (atoms)", sellerReward);
    }

    function test_Fork_RealMarketPurchaseRetainsOnlyExplicitSurplusRemainder() public {
        uint96 price = PRICE + 7;
        IPurchaseForkVault vault = _fundedVault(false, price);
        uint256 listingId = _list(price);
        vault.buyFromMarket(listingId);
        _assertAcquired(vault, price);
        _withdrawMemberSurplus(vault, price);
        assertEq(vault.surplusRemainder(), 93);
        assertEq(address(vault).balance, 93);
        assertEq(vault.totalBnbOwed(), 0);
    }

    function _fundedVault(bool direct, uint96 cost) private returns (IPurchaseForkVault vault) {
        IPoolVault.PoolParams memory params = IPoolVault.PoolParams({
            circuits: Addresses.TAPEOUT_CIRCUITS,
            circuitId: TOKEN_ID,
            targetRaise: TARGET_RAISE,
            priceCap: cost,
            directSeller: direct ? SELLER : address(0),
            directPrice: direct ? cost : 0,
            fundingDeadline: uint64(block.timestamp + 1 days),
            purchaseDeadline: uint64(block.timestamp + 2 days)
        });
        vm.prank(OPERATOR);
        vault = IPurchaseForkVault(factory.createPool(params));
        _deposit(vault, ALICE, 49);
        _deposit(vault, BOB, 49);
        _deposit(vault, CAROL, 2);
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Funded));
        assertEq(address(vault).balance, TARGET_RAISE);
    }

    function _deposit(IPurchaseForkVault vault, address member, uint8 shares) private {
        uint256 contribution = uint256(shares) * (TARGET_RAISE / 100);
        vm.deal(member, member.balance + contribution);
        vm.prank(member);
        vault.deposit{value: contribution}(shares);
    }

    function _list(uint96 price) private returns (uint256 id) {
        vm.startPrank(SELLER);
        NFT.approve(Addresses.CIRCUIT_MARKET, TOKEN_ID);
        id = MARKET.list(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID, price);
        vm.stopPrank();
    }

    function _assertAcquired(IPurchaseForkVault vault, uint96 cost) private view {
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Active));
        assertEq(vault.purchaseCost(), cost);
        assertEq(vault.activatedAt(), block.timestamp);
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
        assertEq(MINING.getMiner(key).status, 1, "purchase cannot stop the miner");
        assertEq(MINING.pending(key), 0);
        assertEq(vault.surplusPerShareWei(), (TARGET_RAISE - cost) / 100);
        assertEq(vault.surplusRemainder(), (TARGET_RAISE - cost) % 100);
        assertEq(vault.balanceOf(ALICE), 49);
        assertEq(vault.balanceOf(BOB), 49);
        assertEq(vault.balanceOf(CAROL), 2);
    }

    function _withdrawMemberSurplus(IPurchaseForkVault vault, uint96 cost) private {
        uint256 perShare = (TARGET_RAISE - cost) / 100;
        uint256 beforeTimestamp = block.timestamp;
        address[3] memory members = [ALICE, BOB, CAROL];
        uint8[3] memory shares = [uint8(49), uint8(49), uint8(2)];
        for (uint256 i; i < members.length; ++i) {
            uint256 expected = perShare * shares[i];
            assertEq(vault.bnbOwed(members[i]), expected);
            uint256 balanceBefore = members[i].balance;
            vm.prank(members[i]);
            vault.withdrawBnb();
            assertEq(members[i].balance - balanceBefore, expected);
            assertEq(vault.bnbOwed(members[i]), 0);
            vm.prank(members[i]);
            vm.expectRevert(IPoolVault.NothingToClaim.selector);
            vault.withdrawBnb();
        }
        assertEq(block.timestamp, beforeTimestamp, "purchase surplus is withdrawable in the same second");
    }

    function _assertHandoverEvents(
        Vm.Log[] memory entries,
        address vault,
        uint256 reward,
        uint96 cost,
        uint8 path,
        uint256 listingId
    ) private pure {
        uint256 mintIndex = type(uint256).max;
        uint256 settledIndex = type(uint256).max;
        uint256 transferIndex = type(uint256).max;
        uint256 purchasedIndex = type(uint256).max;
        for (uint256 i; i < entries.length; ++i) {
            Vm.Log memory entry = entries[i];
            if (entry.topics.length == 0) continue;
            if (entry.emitter == Addresses.BEM && entry.topics[0] == TRANSFER_TOPIC) {
                assertEq(address(uint160(uint256(entry.topics[1]))), address(0));
                assertEq(address(uint160(uint256(entry.topics[2]))), SELLER);
                assertEq(abi.decode(entry.data, (uint256)), reward);
                mintIndex = i;
            } else if (entry.emitter == vault && entry.topics[0] == SETTLED_TOPIC) {
                assertEq(address(uint160(uint256(entry.topics[1]))), Addresses.TAPEOUT_CIRCUITS);
                assertEq(uint256(entry.topics[2]), TOKEN_ID);
                (address previousOwner, uint256 bemAmount,) = abi.decode(entry.data, (address, uint256, bytes32));
                assertEq(previousOwner, SELLER);
                assertEq(bemAmount, reward);
                settledIndex = i;
            } else if (entry.emitter == Addresses.TAPEOUT_CIRCUITS && entry.topics[0] == TRANSFER_TOPIC) {
                assertEq(address(uint160(uint256(entry.topics[1]))), SELLER);
                assertEq(address(uint160(uint256(entry.topics[2]))), vault);
                assertEq(uint256(entry.topics[3]), TOKEN_ID);
                transferIndex = i;
            } else if (entry.emitter == vault && entry.topics[0] == PURCHASED_TOPIC) {
                (uint256 paid, uint8 route, uint256 listing) = abi.decode(entry.data, (uint256, uint8, uint256));
                assertEq(paid, cost);
                assertEq(route, path);
                assertEq(listing, listingId);
                purchasedIndex = i;
            }
        }
        assertLt(purchasedIndex, entries.length, "Purchased missing");
        assertLt(mintIndex, settledIndex, "seller BEM mint must precede settlement acknowledgement");
        assertLt(settledIndex, transferIndex, "reward settlement must precede NFT ownership transfer");
        assertLt(transferIndex, purchasedIndex, "NFT transfer must precede successful purchase acknowledgement");
    }
}
