// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {FundingTestBase} from "../utils/FundingTestBase.sol";
import {FlexibleMiningMock} from "./FlexiblePurchase.t.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolLens} from "../../src/PoolLens.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";

contract FactoryLensCreationTest is FundingTestBase {
    using stdStorage for StdStorage;

    event LensCreated(address indexed lens);
    event PoolCreated(
        address indexed pool,
        address indexed circuits,
        uint256 indexed circuitId,
        uint256 targetRaise,
        uint256 priceCap,
        address treasury
    );

    FlexibleMiningMock private mining;
    IPoolVault.FlexiblePurchaseConfig private config;

    function setUp() public override {
        super.setUp();
        vm.etch(Addresses.MINING, address(new FlexibleMiningMock()).code);
        mining = FlexibleMiningMock(Addresses.MINING);
        mining.configure(defaultParams.circuits, defaultParams.circuitId, 200, 0, false);
        defaultParams.targetRaise = 6.6 ether;
        config = IPoolVault.FlexiblePurchaseConfig({
            minVerifiedWeight: 200,
            referencePriceWei: 6 ether,
            targetDailyYieldAtomic: 15e8,
            extraBps: 1000,
            referenceObservedAt: uint64(block.timestamp),
            referenceBlock: uint64(block.number),
            referenceDigest: keccak256("checked creation reference")
        });
    }

    function test_initializationCreatesBoundLensAndPermissionlessEnsureIsIdempotent() public {
        address first = poolFactory.lens();
        assertGt(first.code.length, 0);
        assertEq(PoolLens(first).factory(), address(poolFactory));
        uint64 nonce = vm.getNonce(address(poolFactory));
        vm.prank(ALICE);
        assertEq(poolFactory.ensureLens(), first);
        vm.prank(BOB);
        assertEq(poolFactory.ensureLens(), first);
        assertEq(vm.getNonce(address(poolFactory)), nonce);
        assertEq(poolFactory.poolCount(), 1);
    }

    function test_legacyZeroLensCreatesOnceWithoutChangingPoolsOrRolesEvenWhenPaused() public {
        // Model the zero value of the appended field on an existing initialized proxy.
        // Derive its real slot from the getter instead of guessing a namespace offset.
        bytes32 slot = bytes32(stdstore.target(address(poolFactory)).sig("lens()").find());
        vm.store(address(poolFactory), slot, bytes32(0));
        assertEq(poolFactory.lens(), address(0));
        vm.prank(OWNER);
        poolFactory.pauseCreation(true);
        address expected = vm.computeCreateAddress(address(poolFactory), vm.getNonce(address(poolFactory)));
        vm.expectEmit(true, false, false, true, address(poolFactory));
        emit LensCreated(expected);
        vm.prank(CAROL);
        assertEq(poolFactory.ensureLens(), expected);
        assertEq(PoolLens(expected).factory(), address(poolFactory));
        assertEq(poolFactory.ensureLens(), expected);
        assertEq(poolFactory.poolCount(), 1);
        assertEq(poolFactory.allPools(0), address(pool));
        assertTrue(poolFactory.isPool(address(pool)));
        assertEq(poolFactory.owner(), OWNER);
        assertEq(poolFactory.operator(), OPERATOR);
        assertEq(poolFactory.treasury(), TREASURY);
        assertTrue(poolFactory.creationPaused());
    }

    function test_uninitializedProxyAndImplementationCannotCreateLens() public {
        PoolFactory implementation = new PoolFactory();
        PoolFactory empty = PoolFactory(address(new ERC1967Proxy(address(implementation), "")));
        vm.expectRevert(PoolFactory.InvalidGovernance.selector);
        empty.ensureLens();
        vm.expectRevert(PoolFactory.InvalidGovernance.selector);
        implementation.ensureLens();
        assertEq(empty.lens(), address(0));
        assertEq(implementation.lens(), address(0));
    }

    function test_checkedCreateRegistersMatchingReferenceAndEmitsRealPool() public {
        address expected = vm.computeCreateAddress(address(poolFactory), vm.getNonce(address(poolFactory)));
        vm.expectEmit(true, true, true, true, address(poolFactory));
        emit PoolCreated(expected, defaultParams.circuits, defaultParams.circuitId, 6.6 ether, 6 ether, TREASURY);
        vm.prank(OPERATOR);
        address created = poolFactory.createFlexiblePoolChecked(defaultParams, config, 7, 200);
        assertEq(created, expected);
        assertEq(poolFactory.poolCount(), 2);
        assertEq(poolFactory.allPools(1), created);
        assertTrue(poolFactory.isPool(created));
        (bool initialized, uint32 taskId) = IPoolVault(created).purchaseModel();
        assertTrue(initialized);
        assertEq(taskId, 7);
        assertEq(IPoolVault(created).purchaseReferenceWeight(), 200);
    }

    function test_changedTaskRevertsEntireCreationAndRegistry() public {
        mining.setTaskId(mining.minerKey(defaultParams.circuits, defaultParams.circuitId), 8);
        _expectCheckedRollback(7, 200, PoolFactory.ReferenceMinerChanged.selector);
    }

    function test_changedWeightRevertsEvenWhenMinimumStillMet() public {
        mining.setVerifiedWeight(mining.minerKey(defaultParams.circuits, defaultParams.circuitId), 300);
        _expectCheckedRollback(7, 200, PoolFactory.ReferenceMinerChanged.selector);
    }

    function test_zeroExpectedWeightCannotDisableReferenceCheck() public {
        _expectCheckedRollback(7, 0, PoolFactory.ReferenceMinerChanged.selector);
    }

    function test_failedFlexibleConfigurationAlsoRollsBackRegistration() public {
        config.minVerifiedWeight = 201;
        _expectCheckedRollback(7, 200, IPoolVault.MinerDoesNotMeetCriteria.selector);
    }

    function test_checkedCreateRetainsOperatorAndCreationPauseRequirements() public {
        vm.prank(ALICE);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        poolFactory.createFlexiblePoolChecked(defaultParams, config, 7, 200);
        vm.prank(OWNER);
        poolFactory.pauseCreation(true);
        _expectCheckedRollback(7, 200, PoolFactory.CreationPaused.selector);
    }

    function test_legacyFlexibleEntryRemainsOperatorOnlyAndCompatible() public {
        vm.prank(ALICE);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        poolFactory.createFlexiblePool(defaultParams, config);
        vm.prank(OPERATOR);
        address created = poolFactory.createFlexiblePool(defaultParams, config);
        assertTrue(poolFactory.isPool(created));
        assertEq(IPoolVault(created).purchaseReferenceWeight(), 200);
    }

    function _expectCheckedRollback(uint32 taskId, uint128 weight, bytes4 error) private {
        uint256 count = poolFactory.poolCount();
        uint64 nonce = vm.getNonce(address(poolFactory));
        address predicted = vm.computeCreateAddress(address(poolFactory), nonce);
        vm.prank(OPERATOR);
        vm.expectRevert(error);
        poolFactory.createFlexiblePoolChecked(defaultParams, config, taskId, weight);
        assertEq(poolFactory.poolCount(), count);
        assertEq(vm.getNonce(address(poolFactory)), nonce);
        assertFalse(poolFactory.isPool(predicted));
        assertEq(predicted.code.length, 0);
    }
}
