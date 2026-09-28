// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AtomicDeployment} from "../../src/AtomicDeployment.sol";
import {FreshPoolFactory} from "../../src/FreshPoolFactory.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract PreviousMachineRegistryFixture {
    mapping(bytes32 => address) private reserved;
    bool public creationPaused;
    uint256 public poolCount;

    function setPaused(bool value) external { creationPaused = value; }
    function setPoolCount(uint256 value) external { poolCount = value; }

    function machinePool(address circuits, uint256 circuitId) external view returns (address) {
        return reserved[keccak256(abi.encode(circuits, circuitId))];
    }

    function reserve(address circuits, uint256 circuitId, address pool) external {
        reserved[keccak256(abi.encode(circuits, circuitId))] = pool;
    }
}

contract FreshPoolFactoryTest is Test {
    address private constant OLD_POOL = 0x575F3D44aE9cFfF5A5584E7F1dbE056f3e63d792;
    address private constant ALICE = address(0xa11ce);
    address private constant BOB = address(0xb0b);

    FreshPoolFactory private factory;
    PreviousMachineRegistryFixture private previous;
    PreviousMachineRegistryFixture private first;

    function setUp() public {
        vm.chainId(56);
        vm.warp(1_800_000_000);
        address firstAddress = 0xcB24E7F96D81037086A268d6ea63c53f91D412A2;
        address oldAddress = 0x2995B10d19056c8C24C57b281C22562a603C571F;
        bytes memory mockCode = address(new PreviousMachineRegistryFixture()).code;
        vm.etch(firstAddress, mockCode);
        vm.etch(oldAddress, mockCode);
        first = PreviousMachineRegistryFixture(firstAddress);
        previous = PreviousMachineRegistryFixture(oldAddress);
        first.setPaused(true);
        previous.setPaused(true);

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

    function test_previousFactoryReservationBlocksFreshPoolButDifferentMachineWorks() public {
        IPoolVault.PoolParams memory p = _params(13043);
        previous.reserve(p.circuits, p.circuitId, OLD_POOL);
        vm.expectRevert(
            abi.encodeWithSelector(PoolFactory.MachineAlreadyReserved.selector, p.circuits, p.circuitId, OLD_POOL)
        );
        factory.createPool(p);
        assertEq(factory.poolCount(), 0);

        p.circuitId++;
        address freshPool = factory.createPool(p);
        assertTrue(factory.isPool(freshPool));
        assertEq(factory.machinePool(p.circuits, p.circuitId), freshPool);
        assertEq(factory.poolCount(), 1);
    }

    function test_existingMainnetNftCannotBeReregisteredIfOldGetterReturnsZero() public {
        IPoolVault.PoolParams memory p = _params(13043);
        assertEq(previous.machinePool(p.circuits, p.circuitId), address(0));
        vm.expectRevert(
            abi.encodeWithSelector(PoolFactory.MachineAlreadyReserved.selector, p.circuits, p.circuitId, OLD_POOL)
        );
        factory.createPool(p);
    }

    function test_previousAlternativeReservationBlocksClaimAfterFunding() public {
        IPoolVault.PoolParams memory p = _params(20000);
        PoolVault pool = PoolVault(payable(factory.createPool(p)));
        uint256 alternative = p.circuitId + 1;
        previous.reserve(p.circuits, alternative, OLD_POOL);
        vm.deal(ALICE, 1 ether);
        vm.deal(BOB, 1 ether);
        vm.prank(ALICE);
        pool.deposit{value: 0.99 ether}(99);
        vm.prank(BOB);
        pool.deposit{value: 0.01 ether}(1);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funded));

        vm.prank(address(pool));
        vm.expectRevert(abi.encodeWithSelector(PoolFactory.MachineAlreadyReserved.selector, p.circuits, alternative, OLD_POOL));
        factory.claimMachine(p.circuits, alternative);
        assertEq(factory.machinePool(p.circuits, alternative), address(0));
    }

    function test_previousRegistryReadFailureFailsClosed() public {
        IPoolVault.PoolParams memory p = _params(30000);
        vm.etch(address(previous), "");
        vm.expectRevert();
        factory.createPool(p);
        assertEq(factory.poolCount(), 0);
    }

    function test_openOrNonemptyFirstFactoryBlocksNewReservations() public {
        IPoolVault.PoolParams memory p = _params(30001);
        first.setPaused(false);
        vm.expectRevert(FreshPoolFactory.PreviousFactoryStillOpen.selector);
        factory.createPool(p);
        first.setPaused(true);
        first.setPoolCount(1);
        vm.expectRevert(FreshPoolFactory.PreviousFactoryStillOpen.selector);
        factory.createPool(p);
        assertEq(factory.poolCount(), 0);
    }

    function test_previousFactoryMustStayPaused() public {
        IPoolVault.PoolParams memory p = _params(30002);
        previous.setPaused(false);
        vm.expectRevert(FreshPoolFactory.PreviousFactoryStillOpen.selector);
        factory.createPool(p);
        assertEq(factory.poolCount(), 0);
    }

    function test_freshFactoryCannotBeginHistoricalBackfill() public {
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
