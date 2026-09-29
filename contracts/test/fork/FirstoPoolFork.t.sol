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
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {ITapeoutMining} from "../../src/interfaces/ITapeoutMining.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IFirstoPoolForkVault is IPoolVault {
    function state() external view returns (IPoolVault.State);
    function purchaseCost() external view returns (uint256);
    function bnbOwed(address) external view returns (uint256);
    function totalBnbOwed() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Separate fixed-block Firsto integration; not the older protocol-fork baseline.
/// @dev Run with --match-path test/fork/FirstoPoolFork.t.sol --fork-block-number 124308679.
/// Only newly deployed local project contracts, contributor BNB (vm.deal), and caller
/// impersonation are simulated. Real NFT, Mining, BEM, Firsto code/state and the public
/// seller signature are used as observed. No new signature, vm.etch, vm.store or broadcast.
contract FirstoPoolForkTest is Test {
    uint256 private constant FORK_BLOCK = 124308679;
    uint256 private constant TOKEN_ID = 5788;
    uint256 private constant PRICE = 0.05 ether;
    uint256 private constant FEE = 0.0005 ether;
    uint256 private constant COST = PRICE + FEE;
    uint256 private constant TARGET = 0.06 ether;
    address private constant SELLER = 0xB88F7608e5f325c0276324F2e35363934BcC91d6;
    address private constant EXCHANGE = 0x33423244F9a5bF81b12B1a018aF6F4e079B97f29;
    address private constant OWNER = address(0x1111);
    address private constant OPERATOR = address(0x2222);
    address private constant TREASURY = address(0x3333);
    address private constant ALICE = address(0xA11CE);
    address private constant EXECUTOR = address(0xBEEFF00D);
    bytes32 private constant ORDER_HASH = 0xa4c40235430a5fe37c3ac563104236cb99ce1a71293542162e4f650a82f7eeaa;
    bytes32 private constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant SETTLED_TOPIC =
        keccak256("RewardSettledBeforeTransfer(address,uint256,address,uint256,bytes32)");
    bytes32 private constant FIRSTO_TOPIC =
        keccak256("FirstoPurchased(address,bytes32,uint256,uint256,uint256,uint256)");
    IERC721 private constant NFT = IERC721(Addresses.TAPEOUT_CIRCUITS);
    IERC20 private constant BEM = IERC20(Addresses.BEM);
    ITapeoutMining private constant MINING = ITapeoutMining(Addresses.MINING);
    IFirstoSignedAskExchange private constant FIRSTO = IFirstoSignedAskExchange(EXCHANGE);

    PoolFactory private factory;
    IFirstoPoolForkVault private pool;
    bytes32 private key;

    function setUp() public {
        // Existing run-fork.mjs deliberately pins 123728000. Do not forge this
        // later order into that baseline or silently test it on another block.
        if (block.number == 123728000) {
            emit log("FirstoPoolFork requires its separate BSC 124308679 fixture command");
            vm.skip(true);
            return;
        }
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires Firsto fixed-block BSC fork");
        assertEq(block.timestamp, 1790501240, "fixture timestamp changed");
        assertEq(NFT.ownerOf(TOKEN_ID), SELLER, "fixture owner changed");
        assertEq(NFT.getApproved(TOKEN_ID), EXCHANGE, "fixture approval changed");
        key = MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        _assertRealActiveQuality();
        assertEq(MINING.pending(key), 28313, "fixture pending changed");
        assertFalse(FIRSTO.isSignedAskNonceInvalidated(SELLER, _ask().nonce));

        PoolTimelock timelock = new PoolTimelock(OWNER);
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        PoolVault implementation = new PoolVault(predictedFactory);
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
        pool = IFirstoPoolForkVault(factory.createPool(params));
        vm.deal(ALICE, TARGET);
        vm.prank(ALICE);
        pool.deposit{value: TARGET}(100);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funded));
        assertEq(pool.balanceOf(ALICE), 100);
    }

    function test_Fork_RealSignedAskSettlesSellerThenDeliversToActualPool() public {
        uint256 sellerBemBefore = BEM.balanceOf(SELLER);
        uint256 sellerBnbBefore = SELLER.balance;
        uint256 poolBnbBefore = address(pool).balance;
        uint256 supplyBefore = BEM.totalSupply();
        uint256 pendingBefore = MINING.pending(key);
        bytes memory order = abi.encode(_ask(), _signature());
        vm.recordLogs();
        vm.prank(EXECUTOR);
        pool.buyFromFirsto(0, order);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 reward = BEM.balanceOf(SELLER) - sellerBemBefore;
        assertGe(reward, pendingBefore, "old reward not fully settled");
        assertGt(reward, 0);
        assertEq(BEM.totalSupply() - supplyBefore, reward);
        assertEq(BEM.balanceOf(address(pool)), 0, "seller rewards must not enter the pool");
        assertEq(SELLER.balance - sellerBnbBefore, PRICE);
        assertEq(poolBnbBefore - address(pool).balance, COST, "gross spend includes Firsto buyer fee");
        assertEq(pool.purchaseCost(), COST);
        assertEq(NFT.ownerOf(TOKEN_ID), address(pool));
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertEq(MINING.pending(key), 0);
        _assertRealActiveQuality();
        assertTrue(FIRSTO.isSignedAskNonceInvalidated(SELLER, _ask().nonce));
        assertEq(factory.machinePool(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID), address(pool));
        assertEq(pool.bnbOwed(ALICE), TARGET - COST);
        _assertSettlementBeforeTransfer(logs, reward);
        emit log_named_uint("fixture block", FORK_BLOCK);
        emit log_named_uint("seller pre-purchase pending (atoms)", pendingBefore);
        emit log_named_uint("seller actual BEM settlement (atoms)", reward);
        emit log_named_uint("actual Pool gross spend (wei)", COST);
        emit log_named_address("local-only actual PoolVault", address(pool));
    }

    function _assertRealActiveQuality() private view {
        ITapeoutMining.Miner memory miner = MINING.getMiner(key);
        assertEq(miner.circuits, Addresses.TAPEOUT_CIRCUITS);
        assertEq(miner.circuitId, TOKEN_ID);
        assertEq(miner.status, 1);
        assertEq(miner.taskId, 4);
        assertFalse(miner.optimal);
        assertEq(miner.verifWeight, 1);
        assertEq(miner.unverWeight, 0);
    }

    function _assertSettlementBeforeTransfer(Vm.Log[] memory logs, uint256 reward) private view {
        uint256 settled = type(uint256).max;
        uint256 transferred = type(uint256).max;
        bool firstoEvent;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (entry.topics.length == 0) continue;
            if (entry.emitter == address(pool) && entry.topics[0] == SETTLED_TOPIC) {
                assertEq(address(uint160(uint256(entry.topics[1]))), Addresses.TAPEOUT_CIRCUITS);
                assertEq(uint256(entry.topics[2]), TOKEN_ID);
                (address seller, uint256 amount, bytes32 tradeId) = abi.decode(entry.data, (address, uint256, bytes32));
                assertEq(seller, SELLER);
                assertEq(amount, reward);
                assertEq(tradeId, ORDER_HASH);
                settled = i;
            }
            if (entry.emitter == address(NFT) && entry.topics[0] == TRANSFER_TOPIC) {
                assertEq(address(uint160(uint256(entry.topics[1]))), SELLER);
                assertEq(address(uint160(uint256(entry.topics[2]))), address(pool));
                assertEq(uint256(entry.topics[3]), TOKEN_ID);
                transferred = i;
            }
            if (entry.emitter == address(pool) && entry.topics[0] == FIRSTO_TOPIC) {
                assertEq(address(uint160(uint256(entry.topics[1]))), EXCHANGE);
                assertEq(entry.topics[2], ORDER_HASH);
                assertEq(uint256(entry.topics[3]), TOKEN_ID);
                (uint256 price, uint256 fee, uint256 gross) = abi.decode(entry.data, (uint256, uint256, uint256));
                assertEq(price, PRICE);
                assertEq(fee, FEE);
                assertEq(gross, COST);
                firstoEvent = true;
            }
        }
        assertLt(settled, transferred, "seller reward must settle before NFT transfer");
        assertLt(transferred, logs.length, "NFT transfer event missing");
        assertTrue(firstoEvent, "typed order identity event missing");
    }

    function _ask() private pure returns (IFirstoSignedAskExchange.SignedAsk memory) {
        return IFirstoSignedAskExchange.SignedAsk({
            maker: SELLER,
            collection: Addresses.TAPEOUT_CIRCUITS,
            tokenId: TOKEN_ID,
            nonce: 91194853857757076373198051252334927123677906225459773215660203836142063036762,
            price: uint128(PRICE),
            expiry: 1792748154,
            payoutRecipient: SELLER,
            feeBps: 100,
            feeEpoch: 1,
            schemaVersion: 2
        });
    }

    function _signature() private pure returns (bytes memory) {
        return hex"98fee6d550ac8353fb553985bb17917bc483dc48c15698f6ed45996fb0bfcd0552b599bce63618c1b1bd8f09d0579bbe29e9c88b8cde6f257800927c074d51571c";
    }
}
