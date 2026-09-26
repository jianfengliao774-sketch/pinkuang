// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {AtomicDeployment} from "../../src/AtomicDeployment.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolLens} from "../../src/PoolLens.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @dev Configuration fixture only. This is not a multisig authorization implementation.
contract DeploymentMultisigFixture {
    uint256 private threshold;
    address[] private owners;

    constructor(uint256 threshold_, address[] memory owners_) {
        threshold = threshold_;
        owners = owners_;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }
}

contract FakeFactoryCloneAttack {
    function clone(address beacon, address claimedFactory, IPoolVault.PoolParams calldata params, address treasury)
        external
        returns (address)
    {
        return
            address(new BeaconProxy(beacon, abi.encodeCall(IPoolVault.initialize, (claimedFactory, params, treasury))));
    }
}

contract RejectDeploymentMarket {
    error BootstrapRejected();

    function initialize(address, address) external pure {
        revert BootstrapRejected();
    }
}

contract AtomicDeploymentTest is Test {
    address private constant OPERATOR = address(0x200);
    address private constant ATTACKER = address(0xBAD);
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    AtomicDeployment private coordinator;
    AtomicDeployment.Config private config;

    function setUp() public {
        vm.warp(1_800_000_000);
        coordinator = new AtomicDeployment();
        config.ownerMultisig = address(new DeploymentMultisigFixture(2, _owners(3)));
        config.operator = OPERATOR;
        config.treasury = config.ownerMultisig;
        config.vaultImplementation = address(new PoolVault(coordinator.predictedFactory()));
        config.factoryImplementation = address(new PoolFactory());
        config.marketImplementation = address(new ShareMarket());
    }

    function test_AtomicGraphIsInitializedWithCorrectRolesAndNoDeployerAuthority() public {
        address predicted = coordinator.predictedFactory();
        assertEq(predicted.code.length, 0);
        AtomicDeployment.Deployment memory d = coordinator.deploy(config);
        assertEq(d.factory, predicted);
        assertTrue(coordinator.deployed());
        PoolFactory factory = PoolFactory(d.factory);
        PoolTimelock timelock = PoolTimelock(payable(d.timelock));
        assertEq(factory.owner(), config.ownerMultisig);
        assertEq(factory.operator(), OPERATOR);
        assertEq(factory.treasury(), config.treasury);
        assertEq(factory.beacon(), d.beacon);
        assertEq(factory.timelock(), d.timelock);
        assertEq(factory.shareMarket(), d.shareMarket);
        assertGt(factory.lens().code.length, 0);
        assertEq(PoolLens(factory.lens()).factory(), d.factory);
        assertEq(PoolBeacon(d.beacon).implementation(), config.vaultImplementation);
        assertEq(PoolBeacon(d.beacon).owner(), d.timelock);
        assertEq(ShareMarket(d.shareMarket).factory(), d.factory);
        assertEq(ShareMarket(d.shareMarket).timelock(), d.timelock);
        assertEq(ShareMarket(d.shareMarket).nextOrderId(), 1);
        assertEq(timelock.getMinDelay(), 48 hours);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), config.ownerMultisig));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), config.ownerMultisig));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), d.timelock));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(coordinator)));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), OPERATOR));
        assertEq(_implementation(d.factory), config.factoryImplementation);
        assertEq(_implementation(d.shareMarket), config.marketImplementation);

        vm.prank(OPERATOR);
        address pool = factory.createPool(_params());
        assertTrue(factory.isPool(pool));
        assertEq(PoolVault(payable(pool)).OFFICIAL_FACTORY(), d.factory);
        assertEq(PoolVault(payable(pool)).factory(), d.factory);
        vm.deal(ATTACKER, 1 ether);
        vm.prank(ATTACKER);
        PoolVault(payable(pool)).deposit{value: 0.1 ether}(10);
        assertEq(PoolVault(payable(pool)).balanceOf(ATTACKER), 10);
    }

    function test_OnlyBoundOfficialFactoryCanInitializeOfficialBeaconPool() public {
        AtomicDeployment.Deployment memory d = coordinator.deploy(config);
        FakeFactoryCloneAttack attacker = new FakeFactoryCloneAttack();
        IPoolVault.PoolParams memory params = _params();
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        attacker.clone(d.beacon, address(attacker), params, config.treasury);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        attacker.clone(d.beacon, d.factory, params, config.treasury);
        // Anyone can deploy empty proxy bytecode. Such a clone cannot become an initialized or registered pool.
        PoolVault emptyClone = PoolVault(payable(address(new BeaconProxy(d.beacon, ""))));
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        emptyClone.initialize(d.factory, params, config.treasury);
        assertFalse(PoolFactory(d.factory).isPool(address(emptyClone)));
        assertEq(emptyClone.factory(), address(0));
        assertEq(emptyClone.totalSupply(), 0);
        // Zero-initialized parameters must not permit free share minting on an empty clone.
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        emptyClone.deposit(1);
        assertEq(emptyClone.totalSupply(), 0);
    }

    function test_DeploymentAndBothInitializersCannotBeReplayedOrTakenOver() public {
        AtomicDeployment.Deployment memory d = coordinator.deploy(config);
        vm.prank(ATTACKER);
        vm.expectRevert(AtomicDeployment.Unauthorized.selector);
        coordinator.deploy(config);
        vm.expectRevert(AtomicDeployment.AlreadyDeployed.selector);
        coordinator.deploy(config);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        PoolFactory(d.factory).initialize(ATTACKER, ATTACKER, ATTACKER, d.timelock, d.beacon);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        PoolFactory(d.factory)
            .initializeDeployment(ATTACKER, ATTACKER, ATTACKER, d.timelock, d.beacon, config.marketImplementation);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        ShareMarket(d.shareMarket).initialize(ATTACKER, d.timelock);
    }

    function test_NoPublicProxySurvivesFailedBootstrapAndSamePredictionCanRetry() public {
        address predicted = coordinator.predictedFactory();
        address predictedTimelock = vm.computeCreateAddress(address(coordinator), 1);
        address predictedBeacon = vm.computeCreateAddress(address(coordinator), 2);
        address goodMarket = config.marketImplementation;
        config.marketImplementation = address(new RejectDeploymentMarket());
        vm.expectRevert(RejectDeploymentMarket.BootstrapRejected.selector);
        coordinator.deploy(config);
        assertFalse(coordinator.deployed());
        assertEq(predicted.code.length, 0);
        assertEq(predictedTimelock.code.length, 0);
        assertEq(predictedBeacon.code.length, 0);
        assertEq(vm.getNonce(address(coordinator)), 1);
        config.marketImplementation = goodMarket;
        AtomicDeployment.Deployment memory d = coordinator.deploy(config);
        assertEq(d.factory, predicted);
    }

    function test_ImplementationsCannotBeInitializedBeforeDeployment() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        PoolFactory(config.factoryImplementation).initialize(ATTACKER, ATTACKER, ATTACKER, ATTACKER, ATTACKER);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        PoolVault(payable(config.vaultImplementation)).initialize(ATTACKER, _params(), ATTACKER);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        ShareMarket(config.marketImplementation).initialize(ATTACKER, ATTACKER);
    }

    function test_RejectsForeignFactoryBindingAndEmptyImplementation() public {
        address validVault = config.vaultImplementation;
        config.vaultImplementation = address(new PoolVault(ATTACKER));
        vm.expectRevert(AtomicDeployment.InvalidBinding.selector);
        coordinator.deploy(config);
        assertEq(coordinator.predictedFactory().code.length, 0);
        config.vaultImplementation = validVault;
        config.marketImplementation = ATTACKER;
        vm.expectRevert(AtomicDeployment.InvalidImplementation.selector);
        coordinator.deploy(config);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        new PoolVault(address(0));
    }

    function test_RejectsUnseparatedOrMissingProductionRoles() public {
        address owner = config.ownerMultisig;
        config.operator = owner;
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploy(config);
        config.operator = address(0);
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploy(config);
        config.operator = OPERATOR;
        config.ownerMultisig = ATTACKER;
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploy(config);
        config.ownerMultisig = owner;
        config.treasury = ATTACKER;
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploy(config);
        config.treasury = OPERATOR;
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploy(config);
    }

    function test_RejectsInvalidOwnerMultisigConfiguration() public {
        config.ownerMultisig = address(new DeploymentMultisigFixture(1, _owners(3)));
        vm.expectRevert(AtomicDeployment.InvalidMultisig.selector);
        coordinator.deploy(config);
        config.ownerMultisig = address(new DeploymentMultisigFixture(2, _owners(4)));
        vm.expectRevert(AtomicDeployment.InvalidMultisig.selector);
        coordinator.deploy(config);
        address[] memory owners = _owners(3);
        owners[2] = owners[1];
        config.ownerMultisig = address(new DeploymentMultisigFixture(2, owners));
        vm.expectRevert(AtomicDeployment.InvalidMultisig.selector);
        coordinator.deploy(config);
        owners[2] = address(0);
        config.ownerMultisig = address(new DeploymentMultisigFixture(2, owners));
        vm.expectRevert(AtomicDeployment.InvalidMultisig.selector);
        coordinator.deploy(config);
    }

    function test_SeparateTreasuryMultisigCanUseDifferentValidThreshold() public {
        config.treasury = address(new DeploymentMultisigFixture(3, _owners(5)));
        AtomicDeployment.Deployment memory d = coordinator.deploy(config);
        assertEq(PoolFactory(d.factory).treasury(), config.treasury);
    }

    function test_RejectsInvalidTreasuryMultisigThreshold() public {
        config.treasury = address(new DeploymentMultisigFixture(0, _owners(3)));
        vm.expectRevert(AtomicDeployment.InvalidMultisig.selector);
        coordinator.deploy(config);
        config.treasury = address(new DeploymentMultisigFixture(4, _owners(3)));
        vm.expectRevert(AtomicDeployment.InvalidMultisig.selector);
        coordinator.deploy(config);
    }

    function test_BootstrapMarketCannotBeReplacedByOwnerOperatorOrLaterTimelock() public {
        AtomicDeployment.Deployment memory d = coordinator.deploy(config);
        PoolFactory factory = PoolFactory(d.factory);
        vm.prank(config.ownerMultisig);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        factory.registerShareMarket(ATTACKER);
        vm.prank(OPERATOR);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        factory.registerShareMarket(ATTACKER);
        bytes memory data = abi.encodeCall(PoolFactory.registerShareMarket, (ATTACKER));
        PoolTimelock timelock = PoolTimelock(payable(d.timelock));
        bytes32 salt = keccak256("cannot replace bootstrap registry");
        vm.prank(config.ownerMultisig);
        timelock.schedule(d.factory, 0, data, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(PoolFactory.ShareMarketAlreadyRegistered.selector);
        timelock.execute(d.factory, 0, data, bytes32(0), salt);
        assertEq(factory.shareMarket(), d.shareMarket);
    }

    function test_AtomicMarketUpgradeStillRequiresFull48HourTimelock() public {
        AtomicDeployment.Deployment memory d = coordinator.deploy(config);
        ShareMarket next = new ShareMarket();
        ShareMarket market = ShareMarket(d.shareMarket);
        vm.prank(config.ownerMultisig);
        vm.expectRevert();
        market.upgradeToAndCall(address(next), "");
        bytes memory data = abi.encodeCall(market.upgradeToAndCall, (address(next), bytes("")));
        bytes32 salt = keccak256("bootstrap market upgrade");
        PoolTimelock timelock = PoolTimelock(payable(d.timelock));
        vm.prank(config.ownerMultisig);
        timelock.schedule(d.shareMarket, 0, data, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        timelock.execute(d.shareMarket, 0, data, bytes32(0), salt);
        assertEq(_implementation(d.shareMarket), config.marketImplementation);
        vm.warp(block.timestamp + 1);
        timelock.execute(d.shareMarket, 0, data, bytes32(0), salt);
        assertEq(_implementation(d.shareMarket), address(next));
        assertEq(market.factory(), d.factory);
        assertEq(market.timelock(), d.timelock);
    }

    function test_BeaconRejectsWrongFactoryOrMissingBindingEvenAfterTimelock() public {
        AtomicDeployment.Deployment memory d = coordinator.deploy(config);
        PoolBeacon beacon = PoolBeacon(d.beacon);
        assertEq(beacon.OFFICIAL_FACTORY(), d.factory);
        address wrongBinding = address(new PoolVault(ATTACKER));
        _rejectBeaconUpgrade(d, wrongBinding, keccak256("wrong immutable factory"));
        _rejectBeaconUpgrade(d, config.factoryImplementation, keccak256("missing factory getter"));
        assertEq(beacon.implementation(), config.vaultImplementation);
    }

    function test_BeaconAcceptsBoundUpgradeOnlyAfter48Hours() public {
        AtomicDeployment.Deployment memory d = coordinator.deploy(config);
        address next = address(new PoolVault(d.factory));
        PoolBeacon beacon = PoolBeacon(d.beacon);
        bytes memory data = abi.encodeCall(PoolBeacon.upgradeTo, (next));
        bytes32 salt = keccak256("same factory upgrade");
        PoolTimelock timelock = PoolTimelock(payable(d.timelock));
        vm.prank(config.ownerMultisig);
        vm.expectRevert();
        beacon.upgradeTo(next);
        vm.prank(config.ownerMultisig);
        timelock.schedule(d.beacon, 0, data, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        timelock.execute(d.beacon, 0, data, bytes32(0), salt);
        vm.warp(block.timestamp + 1);
        timelock.execute(d.beacon, 0, data, bytes32(0), salt);
        assertEq(beacon.implementation(), next);
        vm.prank(OPERATOR);
        address pool = PoolFactory(d.factory).createPool(_params());
        assertEq(PoolVault(payable(pool)).factory(), d.factory);
    }

    function _rejectBeaconUpgrade(AtomicDeployment.Deployment memory d, address candidate, bytes32 salt) private {
        bytes memory data = abi.encodeCall(PoolBeacon.upgradeTo, (candidate));
        PoolTimelock timelock = PoolTimelock(payable(d.timelock));
        vm.prank(config.ownerMultisig);
        timelock.schedule(d.beacon, 0, data, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(PoolBeacon.InvalidFactoryBinding.selector);
        timelock.execute(d.beacon, 0, data, bytes32(0), salt);
    }

    function test_ProductionCoordinatorAndImplementationsFitProtocolCodeLimits() public view {
        assertLe(address(coordinator).code.length, 24_576);
        assertLe(type(AtomicDeployment).creationCode.length, 49_152);
        assertLe(config.vaultImplementation.code.length, 24_576);
        assertLe(config.factoryImplementation.code.length, 24_576);
        assertLe(config.marketImplementation.code.length, 24_576);
        assertLe(type(PoolVault).creationCode.length + 32, 49_152);
        assertLe(type(PoolFactory).creationCode.length, 49_152);
        assertLe(type(ShareMarket).creationCode.length, 49_152);
    }

    function _implementation(address proxy) private view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPLEMENTATION_SLOT))));
    }

    function _owners(uint256 count) private pure returns (address[] memory result) {
        result = new address[](count);
        for (uint256 i; i < count; ++i) {
            result[i] = address(uint160(0x1000 + i));
        }
    }

    function _params() private view returns (IPoolVault.PoolParams memory) {
        return IPoolVault.PoolParams({
            circuits: 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C,
            circuitId: 16210,
            targetRaise: 1 ether,
            priceCap: 0.9 ether,
            directSeller: address(0),
            directPrice: 0,
            fundingDeadline: uint64(block.timestamp + 7 days),
            purchaseDeadline: uint64(block.timestamp + 10 days)
        });
    }
}
