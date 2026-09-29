// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AtomicDeployment} from "../../src/AtomicDeployment.sol";
import {FreshPoolFactory} from "../../src/FreshPoolFactory.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract FreshPoolFactoryTest is Test {
    FreshPoolFactory private factory;

    function setUp() public {
        vm.chainId(56);
        vm.warp(1_800_000_000);
        AtomicDeployment coordinator = new AtomicDeployment();
        AtomicDeployment.Config memory config = AtomicDeployment.Config({
            ownerMultisig: address(this),
            operator: address(this),
            treasury: address(this),
            vaultImplementation: address(new PoolVault(coordinator.predictedFactory())),
            factoryImplementation: address(new FreshPoolFactory()),
            marketImplementation: address(new ShareMarket())
        });
        factory = FreshPoolFactory(coordinator.deploySingleOwner(config).factory);
    }

    function test_newDeploymentDoesNotReadPreviousFactories() public {
        // Neither previous Factory exists on this chain. Creation still works.
        IPoolVault.PoolParams memory p = _params(13043);
        address pool = factory.createPool(p);
        assertEq(factory.machinePool(p.circuits, p.circuitId), pool);
        assertEq(factory.poolCount(), 1);
    }

    function test_newFactoryStillRejectsDuplicateMachineWithinItsRegistry() public {
        IPoolVault.PoolParams memory p = _params(13043);
        address pool = factory.createPool(p);
        vm.expectRevert(
            abi.encodeWithSelector(PoolFactory.MachineAlreadyReserved.selector, p.circuits, p.circuitId, pool)
        );
        factory.createPool(p);
    }

    function test_newFactoryCannotBeginHistoricalBackfill() public {
        vm.expectRevert(PoolFactory.MachineRegistryAlreadyInitialized.selector);
        factory.beginMachineRegistryMigration();
        vm.expectRevert(PoolFactory.MachineRegistryAlreadyInitialized.selector);
        factory.migrateMachineRegistry(1);
    }

    function _params(uint256 circuitId) private view returns (IPoolVault.PoolParams memory) {
        return IPoolVault.PoolParams({
            circuits: factory.TAPEOUT_CIRCUITS(),
            circuitId: circuitId,
            targetRaise: 1 ether,
            priceCap: 0.9 ether,
            directSeller: address(0),
            directPrice: 0,
            fundingDeadline: uint64(block.timestamp + 1 days),
            purchaseDeadline: uint64(block.timestamp + 3 days)
        });
    }
}
