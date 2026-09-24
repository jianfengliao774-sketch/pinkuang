// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @dev Adds only a pure version getter; reuses the inherited initializer and needs no second initialization.
/// Existing pool storage preservation is exercised by the real timelock governance tests below.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract PoolVaultV2Fixture is PoolVault {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @dev Adds only a pure version getter; reuses the inherited initializer and needs no second initialization.
/// Factory registry and governance storage preservation are exercised by the timelock tests below.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract PoolFactoryV2Fixture is PoolFactory {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract PoolGovernanceTest is Test {
    address internal constant MULTISIG = address(0x100);
    address internal constant OPERATOR = address(0x200);
    address internal constant TREASURY = address(0x300);
    address internal constant STRANGER = address(0x400);
    uint256 internal constant DELAY = 48 hours;
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    PoolTimelock internal timelock;
    PoolBeacon internal beacon;
    PoolFactory internal factory;
    PoolFactory internal factoryImplementation;
    PoolVault internal vaultImplementation;

    function setUp() public {
        vm.warp(1_000_000);
        timelock = new PoolTimelock(MULTISIG);
        vaultImplementation = new PoolVault();
        beacon = new PoolBeacon(address(vaultImplementation), address(timelock));
        factoryImplementation = new PoolFactory();
        factory = PoolFactory(
            address(
                new ERC1967Proxy(
                    address(factoryImplementation),
                    _initializer(MULTISIG, OPERATOR, TREASURY, address(timelock), address(beacon))
                )
            )
        );
    }

    function test_GovernanceRolesAndNoDeployerAdmin() public view {
        assertEq(factory.owner(), MULTISIG);
        assertEq(factory.operator(), OPERATOR);
        assertEq(factory.treasury(), TREASURY);
        assertEq(factory.timelock(), address(timelock));
        assertEq(factory.beacon(), address(beacon));
        assertEq(beacon.owner(), address(timelock));
        assertEq(timelock.getMinDelay(), DELAY);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), MULTISIG));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), MULTISIG));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), MULTISIG));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), OPERATOR));
    }

    function test_InitializeIsAtomicAndCannotBeRepeated() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        factory.initialize(MULTISIG, OPERATOR, TREASURY, address(timelock), address(beacon));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        factoryImplementation.initialize(MULTISIG, OPERATOR, TREASURY, address(timelock), address(beacon));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vaultImplementation.initialize(address(factory), _params(), TREASURY);
    }

    function test_InitializationRejectsMissingRolesAndUnprotectedGovernance() public {
        vm.expectRevert(PoolFactory.InvalidAddress.selector);
        new ERC1967Proxy(
            address(factoryImplementation),
            _initializer(address(0), OPERATOR, TREASURY, address(timelock), address(beacon))
        );
        vm.expectRevert(PoolFactory.InvalidAddress.selector);
        new ERC1967Proxy(
            address(factoryImplementation),
            _initializer(MULTISIG, address(0), TREASURY, address(timelock), address(beacon))
        );
        vm.expectRevert(PoolFactory.InvalidAddress.selector);
        new ERC1967Proxy(
            address(factoryImplementation),
            _initializer(MULTISIG, OPERATOR, address(0), address(timelock), address(beacon))
        );
        vm.expectRevert(PoolFactory.InvalidGovernance.selector);
        new ERC1967Proxy(
            address(factoryImplementation), _initializer(MULTISIG, OPERATOR, TREASURY, STRANGER, address(beacon))
        );

        address[] memory nobody = new address[](0);
        TimelockController shortDelay = new TimelockController(1, nobody, nobody, address(0));
        UpgradeableBeacon wrongOwner = new UpgradeableBeacon(address(vaultImplementation), MULTISIG);
        vm.expectRevert(PoolFactory.InvalidGovernance.selector);
        new ERC1967Proxy(
            address(factoryImplementation),
            _initializer(MULTISIG, OPERATOR, TREASURY, address(shortDelay), address(beacon))
        );
        vm.expectRevert(PoolFactory.InvalidGovernance.selector);
        new ERC1967Proxy(
            address(factoryImplementation),
            _initializer(MULTISIG, OPERATOR, TREASURY, address(timelock), address(wrongOwner))
        );
        vm.expectRevert(PoolBeacon.InvalidTimelock.selector);
        new PoolBeacon(address(vaultImplementation), address(shortDelay));
        vm.expectRevert(PoolTimelock.InvalidMultisig.selector);
        new PoolTimelock(address(0));
    }

    function test_CreatePoolRegistryAndTreasurySnapshot() public {
        IPoolVault.PoolParams memory params = _params();
        vm.prank(OPERATOR);
        address first = factory.createPool(params);
        assertTrue(factory.isPool(first));
        assertEq(factory.poolCount(), 1);
        assertEq(factory.allPools(0), first);
        assertEq(PoolVault(payable(first)).factory(), address(factory));
        assertEq(PoolVault(payable(first)).treasury(), TREASURY);
        assertEq(PoolVault(payable(first)).params().circuitId, params.circuitId);
        assertEq(PoolVault(payable(first)).params().targetRaise, params.targetRaise);
        vm.prank(MULTISIG);
        factory.setTreasury(STRANGER);
        vm.prank(OPERATOR);
        address second = factory.createPool(params);
        assertEq(PoolVault(payable(first)).treasury(), TREASURY);
        assertEq(PoolVault(payable(second)).treasury(), STRANGER);
        assertEq(factory.poolCount(), 2);
        assertEq(factory.allPools(1), second);
    }

    function test_DailyAdminDoesNotGiveOperatorOwnerPowers() public {
        vm.prank(STRANGER);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        factory.createPool(_params());
        vm.prank(OPERATOR);
        vm.expectRevert();
        factory.setOperator(STRANGER);
        vm.prank(OPERATOR);
        vm.expectRevert();
        factory.setTreasury(STRANGER);
        vm.prank(OPERATOR);
        vm.expectRevert();
        factory.pauseCreation(true);
        vm.prank(MULTISIG);
        factory.pauseCreation(true);
        vm.prank(OPERATOR);
        vm.expectRevert(PoolFactory.CreationPaused.selector);
        factory.createPool(_params());
        vm.prank(MULTISIG);
        factory.pauseCreation(false);
        vm.prank(MULTISIG);
        factory.setOperator(STRANGER);
        vm.prank(OPERATOR);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        factory.createPool(_params());
        vm.prank(STRANGER);
        assertTrue(factory.isPool(factory.createPool(_params())));
        vm.prank(MULTISIG);
        vm.expectRevert(PoolFactory.InvalidAddress.selector);
        factory.setOperator(address(0));
        vm.prank(MULTISIG);
        vm.expectRevert(PoolFactory.InvalidAddress.selector);
        factory.setTreasury(address(0));
    }

    function test_CreateRejectsInvalidEconomicAndTimingParameters() public {
        IPoolVault.PoolParams memory p = _params();
        p.targetRaise = 0;
        _rejected(p, IPoolVault.InvalidParameters.selector);
        p = _params();
        p.targetRaise += 1;
        _rejected(p, IPoolVault.FundingTargetNotDivisible.selector);
        p = _params();
        p.priceCap = 0;
        _rejected(p, IPoolVault.OverPriceCap.selector);
        p = _params();
        p.priceCap = p.targetRaise + 1;
        _rejected(p, IPoolVault.OverPriceCap.selector);
        p = _params();
        p.circuits = STRANGER;
        _rejected(p, IPoolVault.WrongCircuit.selector);
        p = _params();
        p.fundingDeadline = uint64(block.timestamp);
        _rejected(p, IPoolVault.InvalidParameters.selector);
        p = _params();
        p.purchaseDeadline = p.fundingDeadline;
        _rejected(p, IPoolVault.InvalidParameters.selector);
        p = _params();
        p.directSeller = STRANGER;
        _rejected(p, IPoolVault.InvalidParameters.selector);
        p = _params();
        p.directPrice = 1;
        _rejected(p, IPoolVault.InvalidParameters.selector);
        p = _params();
        p.directSeller = STRANGER;
        p.directPrice = p.priceCap + 1;
        _rejected(p, IPoolVault.OverPriceCap.selector);
        assertEq(factory.poolCount(), 0);
    }

    function test_CreateBothWhitelistedCircuitTypesAndDirectSale() public {
        IPoolVault.PoolParams memory p = _params();
        p.directSeller = STRANGER;
        p.directPrice = p.priceCap;
        vm.prank(OPERATOR);
        factory.createPool(p);
        p.circuits = factory.BEHEMOTH_CIRCUITS();
        vm.prank(OPERATOR);
        factory.createPool(p);
        assertEq(factory.poolCount(), 2);
    }

    function test_FactoryUpgradeRequiresRealTimelockQueueAndPreservesRegistry() public {
        vm.prank(OPERATOR);
        address pool = factory.createPool(_params());
        PoolFactoryV2Fixture next = new PoolFactoryV2Fixture();
        vm.prank(MULTISIG);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        factory.upgradeToAndCall(address(next), "");
        vm.prank(OPERATOR);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        factory.upgradeToAndCall(address(next), "");
        bytes memory data = abi.encodeCall(factory.upgradeToAndCall, (address(next), bytes("")));
        bytes32 salt = keccak256("factory-v2");
        _schedule(address(factory), data, salt);
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert();
        timelock.execute(address(factory), 0, data, bytes32(0), salt);
        assertEq(
            address(uint160(uint256(vm.load(address(factory), IMPLEMENTATION_SLOT)))), address(factoryImplementation)
        );
        vm.warp(block.timestamp + 1);
        vm.prank(STRANGER);
        timelock.execute(address(factory), 0, data, bytes32(0), salt);
        assertEq(PoolFactoryV2Fixture(address(factory)).version(), 2);
        assertEq(factory.owner(), MULTISIG);
        assertEq(factory.operator(), OPERATOR);
        assertEq(factory.timelock(), address(timelock));
        assertEq(factory.beacon(), address(beacon));
        assertEq(factory.allPools(0), pool);
        assertTrue(factory.isPool(pool));
        vm.expectRevert();
        timelock.execute(address(factory), 0, data, bytes32(0), salt);
    }

    function test_BeaconUpgradeChangesAllPoolsOnlyAfter48Hours() public {
        vm.prank(OPERATOR);
        address first = factory.createPool(_params());
        IPoolVault.PoolParams memory p = _params();
        p.circuitId++;
        vm.prank(OPERATOR);
        address second = factory.createPool(p);
        vm.deal(STRANGER, 0.25 ether);
        vm.prank(STRANGER);
        PoolVault(payable(first)).deposit{value: 0.2 ether}(20);
        vm.deal(MULTISIG, 0.05 ether);
        vm.prank(MULTISIG);
        PoolVault(payable(first)).deposit{value: 0.05 ether}(5);
        vm.prank(MULTISIG);
        PoolVault(payable(first)).withdrawDeposit();
        vm.deal(OPERATOR, 0.07 ether);
        vm.prank(OPERATOR);
        PoolVault(payable(second)).deposit{value: 0.07 ether}(7);
        PoolVaultV2Fixture next = new PoolVaultV2Fixture();
        vm.prank(MULTISIG);
        vm.expectRevert();
        beacon.upgradeTo(address(next));
        vm.prank(OPERATOR);
        vm.expectRevert();
        beacon.upgradeTo(address(next));
        bytes memory data = abi.encodeCall(beacon.upgradeTo, (address(next)));
        bytes32 salt = keccak256("beacon-v2");
        _schedule(address(beacon), data, salt);
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert();
        timelock.execute(address(beacon), 0, data, bytes32(0), salt);
        assertEq(beacon.implementation(), address(vaultImplementation));
        vm.warp(block.timestamp + 1);
        vm.prank(STRANGER);
        timelock.execute(address(beacon), 0, data, bytes32(0), salt);
        assertEq(PoolVaultV2Fixture(payable(first)).version(), 2);
        assertEq(PoolVaultV2Fixture(payable(second)).version(), 2);
        assertEq(PoolVault(payable(first)).params().circuitId, p.circuitId - 1);
        assertEq(PoolVault(payable(second)).params().circuitId, p.circuitId);
        assertEq(PoolVault(payable(first)).treasury(), TREASURY);
        assertEq(PoolVault(payable(second)).factory(), address(factory));
        assertEq(PoolVault(payable(first)).balanceOf(STRANGER), 20);
        assertEq(PoolVault(payable(first)).totalSupply(), 20);
        assertEq(PoolVault(payable(first)).contributedWei(STRANGER), 0.2 ether);
        assertEq(PoolVault(payable(first)).bnbOwed(MULTISIG), 0.05 ether);
        assertEq(PoolVault(payable(first)).totalBnbOwed(), 0.05 ether);
        assertEq(PoolVault(payable(first)).totalRaised(), 0.2 ether);
        assertEq(PoolVault(payable(first)).memberCount(), 1);
        assertEq(first.balance, 0.25 ether);
        assertEq(PoolVault(payable(second)).balanceOf(OPERATOR), 7);
        assertEq(second.balance, 0.07 ether);
        PoolVault(payable(first)).finalizeFailure();
        assertEq(PoolVault(payable(first)).bnbOwed(STRANGER), 0.2 ether);
        vm.prank(MULTISIG);
        PoolVault(payable(first)).withdrawBnb();
        assertEq(MULTISIG.balance, 0.05 ether);
    }

    function test_TimelockDelayCannotBeReducedBelow48Hours() public {
        bytes memory data = abi.encodeCall(timelock.updateDelay, (0));
        bytes32 salt = keccak256("configured-delay-zero");
        vm.prank(MULTISIG);
        vm.expectRevert();
        timelock.updateDelay(0);
        _schedule(address(timelock), data, salt);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(timelock), 0, data, bytes32(0), salt);
        assertEq(timelock.getMinDelay(), DELAY, "Configured zero never removes the scheduling floor");
        vm.prank(MULTISIG);
        vm.expectRevert();
        timelock.schedule(address(factory), 0, "", bytes32(0), keccak256("too-soon"), 0);
    }

    function test_TimelockProposeCancelAndPublicExecuteBoundaries() public {
        bytes memory data = abi.encodeCall(factory.pauseCreation, (true));
        bytes32 salt = keccak256("cancelled-operation");
        vm.prank(STRANGER);
        vm.expectRevert();
        timelock.schedule(address(factory), 0, data, bytes32(0), salt, DELAY);
        _schedule(address(factory), data, salt);
        bytes32 operation = timelock.hashOperation(address(factory), 0, data, bytes32(0), salt);
        vm.prank(OPERATOR);
        vm.expectRevert();
        timelock.cancel(operation);
        vm.prank(MULTISIG);
        timelock.cancel(operation);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        timelock.execute(address(factory), 0, data, bytes32(0), salt);
        assertFalse(factory.creationPaused());
    }

    function test_BeaconOwnershipCannotMigrateEvenThroughTimelock() public {
        bytes memory data = abi.encodeCall(beacon.transferOwnership, (MULTISIG));
        bytes32 salt = keccak256("forbidden-beacon-owner");
        _schedule(address(beacon), data, salt);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(PoolBeacon.BeaconOwnershipFixed.selector);
        timelock.execute(address(beacon), 0, data, bytes32(0), salt);
        assertEq(beacon.owner(), address(timelock));
        data = abi.encodeCall(beacon.renounceOwnership, ());
        salt = keccak256("forbidden-beacon-renounce");
        _schedule(address(beacon), data, salt);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(PoolBeacon.BeaconOwnershipFixed.selector);
        timelock.execute(address(beacon), 0, data, bytes32(0), salt);
        assertEq(beacon.owner(), address(timelock));
    }

    function _initializer(address owner_, address operator_, address treasury_, address timelock_, address beacon_)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(PoolFactory.initialize, (owner_, operator_, treasury_, timelock_, beacon_));
    }

    function _params() internal view returns (IPoolVault.PoolParams memory p) {
        p = IPoolVault.PoolParams({
            circuits: 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C,
            circuitId: 400,
            targetRaise: 1 ether,
            priceCap: 0.9 ether,
            directSeller: address(0),
            directPrice: 0,
            fundingDeadline: uint64(block.timestamp + 1 days),
            purchaseDeadline: uint64(block.timestamp + 4 days)
        });
    }

    function _rejected(IPoolVault.PoolParams memory p, bytes4 selector) internal {
        vm.prank(OPERATOR);
        vm.expectRevert(selector);
        factory.createPool(p);
    }

    function _schedule(address target, bytes memory data, bytes32 salt) internal {
        vm.prank(MULTISIG);
        timelock.schedule(target, 0, data, bytes32(0), salt, DELAY);
    }
}
