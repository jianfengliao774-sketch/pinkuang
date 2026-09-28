// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {LegacyMachineFactory} from "../utils/LegacyMachineFactory.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract MachineRegistryTest is FundingTestBase {
    function _expectReserved() private {
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolFactory.MachineAlreadyReserved.selector,
                defaultParams.circuits,
                defaultParams.circuitId,
                address(pool)
            )
        );
        vm.prank(OPERATOR);
    }

    function test_allFourCreateEntriesAtomicallyRejectSameMachine() public {
        _expectReserved();
        poolFactory.createPool(defaultParams);
        _expectReserved();
        poolFactory.createPoolWithExpiry(defaultParams, false);
        IPoolVault.FlexiblePurchaseConfig memory terms;
        _expectReserved();
        poolFactory.createFlexiblePool(defaultParams, terms);
        _expectReserved();
        poolFactory.createFlexiblePoolChecked(defaultParams, terms, 1, 1);
        assertEq(poolFactory.poolCount(), 1);
        assertEq(poolFactory.machinePool(defaultParams.circuits, defaultParams.circuitId), address(pool));
    }

    function test_sameTokenIdDifferentCollectionsAndDistinctIdsDoNotCollide() public {
        IPoolVault.PoolParams memory p = defaultParams;
        p.circuits = Addresses.BEHEMOTH_CIRCUITS;
        IFundingVault otherCollection = _createPool(p);
        assertEq(poolFactory.machinePool(p.circuits, p.circuitId), address(otherCollection));
        p.circuits = defaultParams.circuits;
        p.circuitId += 1;
        IFundingVault otherId = _createPool(p);
        assertEq(poolFactory.machinePool(p.circuits, p.circuitId), address(otherId));
        assertEq(poolFactory.poolCount(), 3);
    }

    function test_invalidConfigurationRevertsReservationAndRegistration() public {
        IPoolVault.PoolParams memory p = defaultParams;
        p.circuitId += 1;
        IPoolVault.FlexiblePurchaseConfig memory invalid;
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        poolFactory.createFlexiblePool(p, invalid);
        assertEq(poolFactory.machinePool(p.circuits, p.circuitId), address(0));
        assertEq(poolFactory.poolCount(), 1);
        _createPool(p);
        assertEq(poolFactory.poolCount(), 2);
    }

    function test_onlyRegisteredFundedPoolCanClaimAndCannotTakeAnotherReservation() public {
        uint256 id = defaultParams.circuitId + 1;
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        poolFactory.claimMachine(defaultParams.circuits, id);
        vm.prank(address(pool));
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        poolFactory.claimMachine(defaultParams.circuits, id);
        IPoolVault.PoolParams memory p = defaultParams;
        p.circuitId = id;
        IFundingVault other = _createPool(p);
        _fundPool();
        vm.prank(address(pool));
        vm.expectRevert(
            abi.encodeWithSelector(PoolFactory.MachineAlreadyReserved.selector, p.circuits, id, address(other))
        );
        poolFactory.claimMachine(p.circuits, id);
        vm.prank(address(pool));
        poolFactory.claimMachine(p.circuits, id + 1);
        vm.prank(address(pool));
        poolFactory.claimMachine(p.circuits, id + 1);
        assertEq(poolFactory.machinePool(p.circuits, id + 1), address(pool));
        vm.prank(address(pool));
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        poolFactory.claimMachine(Addresses.BEHEMOTH_CIRCUITS, id + 2);
    }

    function test_permanentReservationSurvivesRefundAndDeniesReinitialization() public {
        _deposit(pool, ALICE, 37);
        vm.warp(defaultParams.fundingDeadline);
        pool.finalizeFailure();
        defaultParams.fundingDeadline = uint64(block.timestamp + 1 days);
        defaultParams.purchaseDeadline = uint64(block.timestamp + 2 days);
        _expectReserved();
        poolFactory.createPool(defaultParams);
        vm.prank(address(timelock));
        vm.expectRevert(PoolFactory.MachineRegistryAlreadyInitialized.selector);
        poolFactory.beginMachineRegistryMigration();
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(pool.bnbOwed(ALICE), 0);
    }
}

contract MachineRegistryMigrationTest is FundingTestBase {
    // Exact Vault and Selection namespaces; only this historical-state fixture writes them directly.
    bytes32 private constant VAULT_SLOT = 0x91bfb6bda130bea719738fb057a72863be36ca25095a844c93b1e775e47e6d00;
    bytes32 private constant SELECTION_SLOT = 0xabb161195ab2dca5bb4a3b74cf71ac027f503287a65da4d00c8f2426b582f100;

    function setUp() public override {
        vm.warp(1_800_000_000);
        _deployLegacyFactory();
        defaultParams = IPoolVault.PoolParams({
            circuits: Addresses.TAPEOUT_CIRCUITS,
            circuitId: 16210,
            targetRaise: 100 * UNIT_PRICE,
            priceCap: 6 ether,
            directSeller: address(0),
            directPrice: 0,
            fundingDeadline: uint64(block.timestamp + 7 days),
            purchaseDeadline: uint64(block.timestamp + 10 days)
        });
        pool = _createPool(defaultParams);
    }

    function _deployLegacyFactory() private {
        timelock = new PoolTimelock(OWNER);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        vaultImplementation = new PoolVault(predicted);
        beacon = new PoolBeacon(address(vaultImplementation), address(timelock));
        LegacyMachineFactory implementation = new LegacyMachineFactory();
        poolFactory = PoolFactory(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        LegacyMachineFactory.initialize, (OWNER, OPERATOR, TREASURY, address(timelock), address(beacon))
                    )
                )
            )
        );
    }

    function _upgrade(bool beginMigration) private {
        PoolFactory next = new PoolFactory();
        bytes memory init = beginMigration ? abi.encodeCall(PoolFactory.beginMachineRegistryMigration, ()) : bytes("");
        bytes memory data = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(next), init);
        bytes32 salt = keccak256(data);
        vm.prank(OWNER);
        timelock.schedule(address(poolFactory), 0, data, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(poolFactory), 0, data, bytes32(0), salt);
    }

    function test_legacyFundedBalancesSurviveUpgradeAndCreationWaitsForFullBackfill() public {
        _fundPool();
        IPoolVault.PoolParams memory second = defaultParams;
        second.circuitId += 1;
        IFundingVault other = _createPool(second);
        _deposit(other, ALICE, 37);
        _upgrade(true);
        (bool initialized, bool ready, uint256 cursor, uint256 cutoff) = poolFactory.machineRegistryStatus();
        assertTrue(initialized);
        assertFalse(ready);
        assertEq(cursor, 0);
        assertEq(cutoff, 2);
        vm.prank(OPERATOR);
        vm.expectRevert(PoolFactory.MachineRegistryNotReady.selector);
        poolFactory.createPool(second);
        vm.prank(address(pool));
        vm.expectRevert(PoolFactory.MachineRegistryNotReady.selector);
        poolFactory.claimMachine(defaultParams.circuits, defaultParams.circuitId);
        poolFactory.migrateMachineRegistry(1);
        (, ready, cursor,) = poolFactory.machineRegistryStatus();
        assertFalse(ready);
        assertEq(cursor, 1);
        poolFactory.migrateMachineRegistry(1);
        (, ready, cursor,) = poolFactory.machineRegistryStatus();
        assertTrue(ready);
        assertEq(cursor, 2);
        assertEq(poolFactory.machinePool(defaultParams.circuits, defaultParams.circuitId), address(pool));
        assertEq(poolFactory.machinePool(second.circuits, second.circuitId), address(other));
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.totalRaised(), 100 * UNIT_PRICE);
        assertEq(other.balanceOf(ALICE), 37);
        assertEq(poolFactory.operator(), OPERATOR);
        assertEq(poolFactory.treasury(), TREASURY);
        assertEq(poolFactory.owner(), OWNER);
        assertEq(poolFactory.beacon(), address(beacon));
        poolFactory.migrateMachineRegistry(64);
        assertEq(poolFactory.poolCount(), 2);
    }

    function test_emptyLegacyFactoryUpgradeImmediatelyReadyWithoutInventedPoolList() public {
        _deployLegacyFactory();
        _upgrade(true);
        (bool initialized, bool ready, uint256 cursor, uint256 cutoff) = poolFactory.machineRegistryStatus();
        assertTrue(initialized);
        assertTrue(ready);
        assertEq(cursor, 0);
        assertEq(cutoff, 0);
        assertEq(poolFactory.poolCount(), 0);
        IFundingVault first = _createPool(defaultParams);
        assertEq(poolFactory.machinePool(defaultParams.circuits, defaultParams.circuitId), address(first));
    }

    function test_uninitializedMigrationFailsClosedButDoesNotBlockRefund() public {
        _deposit(pool, ALICE, 37);
        _upgrade(false);
        vm.expectRevert(PoolFactory.MachineRegistryNotReady.selector);
        poolFactory.migrateMachineRegistry(1);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        poolFactory.beginMachineRegistryMigration();
        vm.warp(defaultParams.fundingDeadline);
        pool.finalizeFailure();
        uint256 beforeBalance = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - beforeBalance, 37 * UNIT_PRICE);
    }

    function test_legacyDuplicateConflictStopsMigrationWithoutOverwritingEarlierPool() public {
        _createPool(defaultParams); // This exact legacy Factory permits the historical duplicate.
        _upgrade(true);
        poolFactory.migrateMachineRegistry(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolFactory.MachineAlreadyReserved.selector,
                defaultParams.circuits,
                defaultParams.circuitId,
                address(pool)
            )
        );
        poolFactory.migrateMachineRegistry(1);
        (, bool ready, uint256 cursor,) = poolFactory.machineRegistryStatus();
        assertFalse(ready);
        assertEq(cursor, 1);
        assertEq(poolFactory.machinePool(defaultParams.circuits, defaultParams.circuitId), address(pool));
    }

    function test_migrationKeepsBothOriginalAndHistoricalAcquiredAlternative() public {
        uint256 acquired = defaultParams.circuitId + 500;
        // Historical purchase shape only, not a claimed execution of old protocol code:
        // params.circuitId is the acquired machine, while the independent selection state retains its reference.
        vm.store(address(pool), bytes32(uint256(VAULT_SLOT) + 3), bytes32(acquired));
        vm.store(address(pool), SELECTION_SLOT, bytes32(uint256(1)));
        vm.store(address(pool), bytes32(uint256(SELECTION_SLOT) + 1), bytes32(defaultParams.circuitId));
        _upgrade(true);
        poolFactory.migrateMachineRegistry(1);
        assertEq(poolFactory.machinePool(defaultParams.circuits, acquired), address(pool));
        assertEq(poolFactory.machinePool(defaultParams.circuits, defaultParams.circuitId), address(pool));
        assertEq(pool.params().circuitId, acquired);
    }

    function test_migrationBatchBoundsAndOneTimeInitialization() public {
        _upgrade(true);
        vm.expectRevert(PoolFactory.InvalidMigrationBatch.selector);
        poolFactory.migrateMachineRegistry(0);
        vm.expectRevert(PoolFactory.InvalidMigrationBatch.selector);
        poolFactory.migrateMachineRegistry(65);
        vm.prank(address(timelock));
        vm.expectRevert(PoolFactory.MachineRegistryAlreadyInitialized.selector);
        poolFactory.beginMachineRegistryMigration();
        poolFactory.migrateMachineRegistry(1);
        (, bool ready,,) = poolFactory.machineRegistryStatus();
        assertTrue(ready);
    }
}
