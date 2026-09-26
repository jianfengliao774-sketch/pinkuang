// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AtomicDeployment} from "../../src/AtomicDeployment.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract SingleOwnerRejectMarket {
    error BootstrapRejected();

    function initialize(address, address) external pure {
        revert BootstrapRejected();
    }
}

contract SingleOwnerDeploymentTest is Test {
    address private constant OWNER = address(0x1111);
    address private constant STRANGER = address(0xBAD);
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    AtomicDeployment private coordinator;
    AtomicDeployment.Config private config;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.prank(OWNER);
        coordinator = new AtomicDeployment();
        config = AtomicDeployment.Config({
            ownerMultisig: OWNER,
            operator: OWNER,
            treasury: OWNER,
            vaultImplementation: address(new PoolVault(coordinator.predictedFactory())),
            factoryImplementation: address(new PoolFactory()),
            marketImplementation: address(new ShareMarket())
        });
    }

    function test_SingleEOAWalletReceivesDailyRolesButNotDirectUpgradeAuthority() public {
        AtomicDeployment.Deployment memory d = _deploy();
        PoolFactory factory = PoolFactory(d.factory);
        PoolTimelock timelock = PoolTimelock(payable(d.timelock));
        assertEq(OWNER.code.length, 0);
        assertEq(coordinator.deployer(), OWNER);
        assertEq(d.factory, coordinator.predictedFactory());
        assertTrue(coordinator.deployed());
        assertEq(factory.owner(), OWNER);
        assertEq(factory.operator(), OWNER);
        assertEq(factory.treasury(), OWNER);
        assertEq(factory.timelock(), d.timelock);
        assertEq(factory.beacon(), d.beacon);
        assertEq(factory.shareMarket(), d.shareMarket);
        assertEq(PoolBeacon(d.beacon).owner(), d.timelock);
        assertEq(PoolBeacon(d.beacon).OFFICIAL_FACTORY(), d.factory);
        assertEq(PoolBeacon(d.beacon).implementation(), config.vaultImplementation);
        assertEq(ShareMarket(d.shareMarket).factory(), d.factory);
        assertEq(ShareMarket(d.shareMarket).timelock(), d.timelock);
        assertEq(_implementation(d.factory), config.factoryImplementation);
        assertEq(_implementation(d.shareMarket), config.marketImplementation);
        assertEq(timelock.getMinDelay(), 48 hours);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), OWNER));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), OWNER));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), d.timelock));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), OWNER));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(coordinator)));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), STRANGER));

        vm.prank(OWNER);
        address pool = factory.createPool(_params());
        assertTrue(factory.isPool(pool));
        assertEq(PoolVault(payable(pool)).treasury(), OWNER);
    }

    function test_ForeignCallerCannotDeployAndOwnerCannotBeRedirected() public {
        vm.prank(STRANGER);
        vm.expectRevert(AtomicDeployment.Unauthorized.selector);
        coordinator.deploySingleOwner(config);
        config.ownerMultisig = STRANGER;
        vm.prank(OWNER);
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploySingleOwner(config);
        assertFalse(coordinator.deployed());
        assertEq(coordinator.predictedFactory().code.length, 0);
    }

    function test_RejectsZeroRolesAndPreservesLegacyMultisigRequirements() public {
        vm.prank(OWNER);
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploy(config);
        config.operator = address(0);
        vm.prank(OWNER);
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploySingleOwner(config);
        config.operator = OWNER;
        config.treasury = address(0);
        vm.prank(OWNER);
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploySingleOwner(config);
        config.treasury = OWNER;
        config.ownerMultisig = address(0);
        vm.prank(OWNER);
        vm.expectRevert(AtomicDeployment.InvalidRoles.selector);
        coordinator.deploySingleOwner(config);
    }

    function test_RejectsEmptyImplementationsAndForeignVaultBinding() public {
        address validVault = config.vaultImplementation;
        config.vaultImplementation = address(new PoolVault(STRANGER));
        vm.prank(OWNER);
        vm.expectRevert(AtomicDeployment.InvalidBinding.selector);
        coordinator.deploySingleOwner(config);
        config.vaultImplementation = validVault;
        config.marketImplementation = STRANGER;
        vm.prank(OWNER);
        vm.expectRevert(AtomicDeployment.InvalidImplementation.selector);
        coordinator.deploySingleOwner(config);
        assertFalse(coordinator.deployed());
        assertEq(coordinator.predictedFactory().code.length, 0);
    }

    function test_DeploymentAndInitializersCannotBeReplayedOrTakenOver() public {
        AtomicDeployment.Deployment memory d = _deploy();
        vm.prank(OWNER);
        vm.expectRevert(AtomicDeployment.AlreadyDeployed.selector);
        coordinator.deploySingleOwner(config);
        vm.prank(OWNER);
        vm.expectRevert(AtomicDeployment.AlreadyDeployed.selector);
        coordinator.deploy(config);
        vm.startPrank(STRANGER);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        PoolFactory(d.factory).initialize(STRANGER, STRANGER, STRANGER, d.timelock, d.beacon);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        PoolFactory(d.factory)
            .initializeDeployment(STRANGER, STRANGER, STRANGER, d.timelock, d.beacon, config.marketImplementation);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        ShareMarket(d.shareMarket).initialize(STRANGER, d.timelock);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        PoolFactory(config.factoryImplementation).initialize(STRANGER, STRANGER, STRANGER, d.timelock, d.beacon);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        PoolVault(payable(config.vaultImplementation)).initialize(STRANGER, _params(), STRANGER);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        ShareMarket(config.marketImplementation).initialize(STRANGER, d.timelock);
        vm.stopPrank();
    }

    function test_FailedGraphLeavesNoUninitializedProxyAndCanRetrySamePrediction() public {
        address predicted = coordinator.predictedFactory();
        address validMarket = config.marketImplementation;
        config.marketImplementation = address(new SingleOwnerRejectMarket());
        vm.prank(OWNER);
        vm.expectRevert(SingleOwnerRejectMarket.BootstrapRejected.selector);
        coordinator.deploySingleOwner(config);
        assertFalse(coordinator.deployed());
        assertEq(predicted.code.length, 0);
        assertEq(vm.computeCreateAddress(address(coordinator), 1).code.length, 0);
        assertEq(vm.computeCreateAddress(address(coordinator), 2).code.length, 0);
        assertEq(vm.getNonce(address(coordinator)), 1);
        config.marketImplementation = validMarket;
        assertEq(_deploy().factory, predicted);
    }

    function test_AllThreeUpgradePathsRequire48HoursAndPreserveFundedPool() public {
        AtomicDeployment.Deployment memory d = _deploy();
        vm.prank(OWNER);
        address pool = PoolFactory(d.factory).createPool(_params());
        vm.deal(STRANGER, 1 ether);
        vm.prank(STRANGER);
        PoolVault(payable(pool)).deposit{value: 0.1 ether}(10);

        address[3] memory targets = [d.factory, d.shareMarket, d.beacon];
        address[3] memory next =
            [address(new PoolFactory()), address(new ShareMarket()), address(new PoolVault(d.factory))];
        bytes[3] memory payloads = [
            abi.encodeCall(PoolFactory(d.factory).upgradeToAndCall, (next[0], bytes(""))),
            abi.encodeCall(ShareMarket(d.shareMarket).upgradeToAndCall, (next[1], bytes(""))),
            abi.encodeCall(PoolBeacon.upgradeTo, (next[2]))
        ];
        PoolTimelock timelock = PoolTimelock(payable(d.timelock));
        for (uint256 i; i < 3; ++i) {
            vm.prank(OWNER);
            (bool success,) = targets[i].call(payloads[i]);
            assertFalse(success);
            vm.prank(STRANGER);
            vm.expectRevert();
            timelock.schedule(targets[i], 0, payloads[i], bytes32(0), bytes32(i), 48 hours);
            vm.prank(OWNER);
            timelock.schedule(targets[i], 0, payloads[i], bytes32(0), bytes32(i), 48 hours);
        }
        vm.warp(block.timestamp + 48 hours - 1);
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert();
            timelock.execute(targets[i], 0, payloads[i], bytes32(0), bytes32(i));
        }
        vm.warp(block.timestamp + 1);
        for (uint256 i; i < 3; ++i) {
            vm.prank(STRANGER);
            timelock.execute(targets[i], 0, payloads[i], bytes32(0), bytes32(i));
        }
        assertEq(_implementation(d.factory), next[0]);
        assertEq(_implementation(d.shareMarket), next[1]);
        assertEq(PoolBeacon(d.beacon).implementation(), next[2]);
        assertTrue(PoolFactory(d.factory).isPool(pool));
        assertEq(PoolFactory(d.factory).owner(), OWNER);
        assertEq(ShareMarket(d.shareMarket).factory(), d.factory);
        assertEq(PoolVault(payable(pool)).balanceOf(STRANGER), 10);
        assertEq(pool.balance, 0.1 ether);
        assertEq(PoolVault(payable(pool)).factory(), d.factory);
        vm.prank(STRANGER);
        PoolVault(payable(pool)).withdrawDeposit();
        vm.prank(STRANGER);
        PoolVault(payable(pool)).withdrawBnb();
        assertEq(STRANGER.balance, 1 ether);
        assertEq(pool.balance, 0);
    }

    function test_OwnerCannotReduceSchedulingFloorEvenThroughTimelock() public {
        AtomicDeployment.Deployment memory d = _deploy();
        PoolTimelock timelock = PoolTimelock(payable(d.timelock));
        bytes memory data = abi.encodeCall(timelock.updateDelay, (0));
        vm.prank(OWNER);
        vm.expectRevert();
        timelock.updateDelay(0);
        vm.prank(OWNER);
        timelock.schedule(d.timelock, 0, data, bytes32(0), bytes32(0), 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(d.timelock, 0, data, bytes32(0), bytes32(0));
        assertEq(timelock.getMinDelay(), 48 hours);
        vm.prank(OWNER);
        vm.expectRevert();
        timelock.schedule(d.timelock, 0, data, bytes32(0), bytes32(uint256(1)), 48 hours - 1);
        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();
        vm.prank(OWNER);
        vm.expectRevert();
        timelock.grantRole(adminRole, OWNER);
    }

    function _deploy() private returns (AtomicDeployment.Deployment memory) {
        vm.prank(OWNER);
        return coordinator.deploySingleOwner(config);
    }

    function _implementation(address proxy) private view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPLEMENTATION_SLOT))));
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
