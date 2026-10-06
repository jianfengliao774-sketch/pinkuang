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
import {IFirstoBatchAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {ITapeoutMining} from "../../src/interfaces/ITapeoutMining.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IFirstoBatchForkHash is IFirstoBatchAskExchange {
    function hashBatchAsk(BatchAsk calldata batch) external view returns (bytes32);
    function hashAskLeaf(AskLeaf calldata leaf) external pure returns (bytes32);
}

/// @notice Real-protocol rehearsal of a public batch leaf immediately before its historical fill.
/// @dev Requires BSC 125506634 archive state. No skip, etch, store, mockCall or replacement pin.
/// A successful receipt proves this protocol path at the historical state, not current order availability.
contract FirstoBatchPoolForkTest is Test {
    uint256 private constant FORK_BLOCK = 125506634;
    uint256 private constant TOKEN_ID = 5181;
    uint256 private constant PRICE = 1373777280000000000;
    uint256 private constant FEE = 13737772800000000;
    uint256 private constant COST = PRICE + FEE;
    uint256 private constant TARGET = 1.4 ether;
    address private constant SELLER = 0xc0f78ED17FbfE0737cb8863658414B6Ad71690Ee;
    address private constant EXCHANGE = 0x3F58C9cbce933c76158B2A29B0d612c46546Dc43;
    bytes32 private constant PINNED_RUNTIME = 0x84072ba0b149f0cb72a8d1be49797ba293206d931407eeb2a25eeaf9f28db0b0;
    bytes32 private constant ORDER_HASH = 0xab09e1749a642c928066ebae251fcfb3fc3bb6ef5942037651b2d7fe519157b3;
    bytes32 private constant LEAF_HASH = 0x5a23c69e0ed3c5003fe13515c246131e48a35e80efd816499a293ac44cf526f4;
    uint256 private constant NONCE = 51939345424450335059231712094048785691860111569030802050811607960725786164819;
    IERC721 private constant NFT = IERC721(Addresses.TAPEOUT_CIRCUITS);
    IERC20 private constant BEM = IERC20(Addresses.BEM);
    ITapeoutMining private constant MINING = ITapeoutMining(Addresses.MINING);
    IFirstoBatchForkHash private constant FIRSTO = IFirstoBatchForkHash(EXCHANGE);
    address private constant OWNER = address(0x1111);
    address private constant OPERATOR = address(0x2222);
    address private constant TREASURY = address(0x3333);
    address private constant ALICE = address(0xA11CE);
    PoolFactory private factory;
    PoolVault private pool;
    bytes32 private minerKey;

    function setUp() public {
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires BSC 125506634 archive fork");
        assertEq(EXCHANGE.codehash, PINNED_RUNTIME, "unverified Firsto batch runtime: no trusted fork proof");
        assertEq(NFT.ownerOf(TOKEN_ID), SELLER, "historical owner changed");
        assertTrue(NFT.getApproved(TOKEN_ID) == EXCHANGE || NFT.isApprovedForAll(SELLER, EXCHANGE));
        assertEq(FIRSTO.factory(), 0x68224F668083c29e9800Be2a646d42d18cedF7e2);
        assertFalse(FIRSTO.paused());
        assertEq(FIRSTO.BATCH_ASK_SCHEMA_VERSION(), 1);
        assertEq(FIRSTO.hashBatchAsk(_batch()), ORDER_HASH, "historical batch digest mismatch");
        assertEq(FIRSTO.hashAskLeaf(_leaf()), LEAF_HASH, "historical leaf hash mismatch");
        assertFalse(FIRSTO.batchCancelled(SELLER, NONCE));
        assertFalse(FIRSTO.isAskLeafInvalidated(SELLER, NONCE, 0));
        minerKey = MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        _assertRealQuality();
        PoolTimelock timelock = new PoolTimelock(OWNER);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        PoolVault implementation = new PoolVault(predicted);
        PoolBeacon beacon = new PoolBeacon(address(implementation), address(timelock));
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
        IPoolVault.PoolParams memory params = IPoolVault.PoolParams({
            circuits: Addresses.TAPEOUT_CIRCUITS,
            circuitId: TOKEN_ID,
            targetRaise: TARGET,
            priceCap: COST,
            directSeller: address(0),
            directPrice: 0,
            fundingDeadline: uint64(block.timestamp + 1 days),
            purchaseDeadline: uint64(block.timestamp + 2 days)
        });
        vm.prank(OPERATOR);
        pool = PoolVault(payable(factory.createPool(params)));
        vm.deal(ALICE, TARGET);
        vm.prank(ALICE);
        pool.deposit{value: TARGET}(100);
    }

    function test_Fork_RealBatchLeafSettlesSellerAndDeliversOnlyExactNftToActualPool() public {
        assertEq(pool.firstoBatchPurchaseVersion(), 1);
        uint256 sellerBemBefore = BEM.balanceOf(SELLER);
        uint256 sellerBnbBefore = SELLER.balance;
        uint256 pendingBefore = MINING.pending(minerKey);
        uint256 bemSupplyBefore = BEM.totalSupply();
        bytes memory order = abi.encode(_batch(), _leaf(), new bytes32[](0), _signature());
        pool.buyFromFirsto(1, order);
        uint256 reward = BEM.balanceOf(SELLER) - sellerBemBefore;
        assertGe(reward, pendingBefore);
        assertEq(BEM.totalSupply() - bemSupplyBefore, reward);
        assertEq(BEM.balanceOf(address(pool)), 0);
        assertEq(SELLER.balance - sellerBnbBefore, PRICE);
        assertEq(pool.purchaseCost(), COST);
        assertEq(address(pool).balance, TARGET - COST);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertEq(NFT.ownerOf(TOKEN_ID), address(pool));
        assertEq(MINING.pending(minerKey), 0);
        assertEq(factory.machinePool(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID), address(pool));
        assertTrue(FIRSTO.isAskLeafInvalidated(SELLER, NONCE, 0));
        assertFalse(FIRSTO.batchCancelled(SELLER, NONCE));
        assertEq(pool.bnbOwed(ALICE), TARGET - COST);
        _assertRealQuality();
        emit log_named_bytes32("public historical batch digest", ORDER_HASH);
        emit log_named_uint("actual pool gross spend", COST);
    }

    function _assertRealQuality() private view {
        ITapeoutMining.Miner memory miner = MINING.getMiner(minerKey);
        assertEq(miner.circuits, Addresses.TAPEOUT_CIRCUITS);
        assertEq(miner.circuitId, TOKEN_ID);
        assertEq(miner.status, 1);
        assertFalse(miner.optimal);
        assertEq(miner.unverWeight, 0);
        assertGe(miner.verifWeight, 1);
    }

    function _batch() private pure returns (IFirstoBatchAskExchange.BatchAsk memory) {
        return IFirstoBatchAskExchange.BatchAsk(SELLER, LEAF_HASH, NONCE, 1793627133, SELLER, 100, 1, 1);
    }

    function _leaf() private pure returns (IFirstoBatchAskExchange.AskLeaf memory) {
        return IFirstoBatchAskExchange.AskLeaf(
            SELLER, Addresses.TAPEOUT_CIRCUITS, TOKEN_ID, uint128(PRICE), SELLER, 100, 1, NONCE, 0, 1
        );
    }

    function _signature() private pure returns (bytes memory) {
        return hex"d30fd48dbb6f84e9144bc25d2ed19869f6c6b1a9a8a2144cf341e9eae24954f251e957b85d68d27eab6463f78bf8ea9b8c6766fba37659b41994ea15275b55081b";
    }
}
