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

/// @notice Real-protocol PoolVault rehearsal of public open leaf #6128 at a fixed independently observed block.
/// @dev Requires BSC 126091631 archive state. No skip, etch, store, mockCall or replacement pin.
/// A successful receipt proves this protocol path at the historical state, not current order availability.
contract FirstoBatchCurrentPoolForkTest is Test {
    uint256 private constant FORK_BLOCK = 126091631;
    uint256 private constant TOKEN_ID = 6128;
    uint256 private constant PRICE = 69120000000000000;
    uint256 private constant FEE = 691200000000000;
    uint256 private constant COST = PRICE + FEE;
    uint256 private constant TARGET = 0.08 ether;
    address private constant SELLER = 0xd18B9615388AfACf2c95282980c6B84A235a32a8;
    address private constant EXCHANGE = 0x3F58C9cbce933c76158B2A29B0d612c46546Dc43;
    bytes32 private constant PINNED_RUNTIME = 0x84072ba0b149f0cb72a8d1be49797ba293206d931407eeb2a25eeaf9f28db0b0;
    bytes32 private constant ORDER_HASH = 0x245c3ed9094b1d3baaa0dc3b25386e68dde7fce70ee4e2e083f619037c256b8a;
    bytes32 private constant LEAF_HASH = 0xf34f0fb6f87aa11280f04aa902ffdc7234164eaeca718feaa0f4711be744646d;
    uint256 private constant NONCE = 84401227532017725412678825523758959580807581363968801816301191791258068690163;
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
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires BSC 126091631 archive fork");
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
        bytes memory order = abi.encode(_batch(), _leaf(), _proof(), _signature());
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
        return IFirstoBatchAskExchange.BatchAsk(
            SELLER,
            0xacae6e55455fadf077abfa70912bc9f702e00358d921ea9ef9efb0f265d47bf2,
            NONCE,
            1793860381,
            SELLER,
            100,
            1,
            1
        );
    }

    function _leaf() private pure returns (IFirstoBatchAskExchange.AskLeaf memory) {
        return IFirstoBatchAskExchange.AskLeaf(
            SELLER, Addresses.TAPEOUT_CIRCUITS, TOKEN_ID, uint128(PRICE), SELLER, 100, 1, NONCE, 0, 1
        );
    }

    function _proof() private pure returns (bytes32[] memory result) {
        result = new bytes32[](4);
        result[0] = 0x3fbe9d8953dc2c8a04944a962921a49f7dcc2b1471486e8638637ab0f804dbf1;
        result[1] = 0x92f547f8782ea7020f4582a5a86f7b442aa38c2cc2322a9c86f441b8fa3dcbaf;
        result[2] = 0x342f8c425704b6a7fd4375218a13246098503ba15d373272295b04d07d88b55c;
        result[3] = 0x1c8fbab930ffbdaec3a404e770e5147d1b6c7fcf3a38e5e5718e94f39431782c;
    }

    function _signature() private pure returns (bytes memory) {
        return hex"d9aae0d04436086d1c503ba87d4056903322076a32bcbde212caec1b2305b5c33769066504c18ceda0ebe80c20deb97e2ab3f263083202d170e397a1319c66f41c";
    }
}
