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
import {BudgetPortfolioFactory} from "../../src/BudgetPortfolioFactory.sol";
import {BudgetPortfolioVault} from "../../src/BudgetPortfolioVault.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";

contract RejectPortfolioBootstrap {
    error Rejected();

    function initializeDeployment(address, address, address, address, address, address, address) external pure {
        revert Rejected();
    }
}

contract IntegratedDeploymentTest is Test {
    AtomicDeployment private coordinator;
    AtomicDeployment.IntegratedConfig private config;

    function setUp() public {
        coordinator = new AtomicDeployment();
        config.core = AtomicDeployment.Config({
            ownerMultisig: address(this),
            operator: address(this),
            treasury: address(this),
            vaultImplementation: address(new PoolVault(coordinator.predictedFactory())),
            factoryImplementation: address(new PoolFactory()),
            marketImplementation: address(new ShareMarket())
        });
        config.portfolioFactoryImplementation = address(new BudgetPortfolioFactory());
        config.portfolioVaultImplementation = address(new BudgetPortfolioVault(coordinator.predictedPortfolioFactory()));
    }

    function test_BothGraphsShareGovernanceWithSeparateFactoryBindingsAndMarkets() public {
        (AtomicDeployment.Deployment memory core, AtomicDeployment.PortfolioDeployment memory p) =
            coordinator.deployIntegratedSingleOwner(config);
        assertEq(core.factory, coordinator.predictedFactory());
        assertEq(p.factory, coordinator.predictedPortfolioFactory());
        assertEq(p.beacon, vm.computeCreateAddress(address(coordinator), 4));
        assertEq(p.shareMarket, vm.computeCreateAddress(p.factory, 1));
        assertNotEq(p.factory, core.factory);
        assertNotEq(p.shareMarket, core.shareMarket);
        BudgetPortfolioFactory pf = BudgetPortfolioFactory(p.factory);
        assertEq(pf.owner(), address(this));
        assertEq(pf.operator(), address(this));
        assertEq(pf.treasury(), address(this));
        assertEq(pf.timelock(), core.timelock);
        assertEq(pf.legacyFactory(), core.factory);
        assertEq(pf.beacon(), p.beacon);
        assertEq(pf.shareMarket(), p.shareMarket);
        assertEq(pf.portfolioCount(), 0);
        assertEq(PoolBeacon(p.beacon).owner(), core.timelock);
        assertEq(PoolBeacon(p.beacon).implementation(), config.portfolioVaultImplementation);
        assertEq(PoolBeacon(p.beacon).OFFICIAL_FACTORY(), p.factory);
        assertEq(ShareMarket(p.shareMarket).factory(), p.factory);
        assertEq(ShareMarket(p.shareMarket).timelock(), core.timelock);
        assertEq(ShareMarket(p.shareMarket).buyerFeeBps(), 100);
        assertTrue(ShareMarket(core.shareMarket).budgetFactoryTrusted(p.factory));
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        ShareMarket(core.shareMarket).bootstrapBudgetFactory();
        assertEq(PoolTimelock(payable(core.timelock)).getMinDelay(), 48 hours);
        assertEq(PoolFactory(core.factory).poolCount(), 0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        pf.initializeDeployment(
            address(this),
            address(this),
            address(this),
            core.timelock,
            p.beacon,
            core.factory,
            config.core.marketImplementation
        );
        vm.expectRevert(AtomicDeployment.AlreadyDeployed.selector);
        coordinator.deployIntegratedSingleOwner(config);
        address nextFactory = address(new BudgetPortfolioFactory());
        vm.expectRevert();
        pf.upgradeToAndCall(nextFactory, "");
        vm.expectRevert();
        PoolBeacon(p.beacon).upgradeTo(config.portfolioVaultImplementation);
    }

    function test_BudgetInitializationFailureRollsBackCoreAndAllowsSameAddressRetry() public {
        address valid = config.portfolioFactoryImplementation;
        config.portfolioFactoryImplementation = address(new RejectPortfolioBootstrap());
        vm.expectRevert(RejectPortfolioBootstrap.Rejected.selector);
        coordinator.deployIntegratedSingleOwner(config);
        assertFalse(coordinator.deployed());
        assertEq(vm.getNonce(address(coordinator)), 1);
        for (uint64 nonce = 1; nonce <= 5; nonce++) {
            assertEq(vm.computeCreateAddress(address(coordinator), nonce).code.length, 0);
        }
        config.portfolioFactoryImplementation = valid;
        (, AtomicDeployment.PortfolioDeployment memory p) = coordinator.deployIntegratedSingleOwner(config);
        assertEq(p.factory, coordinator.predictedPortfolioFactory());
    }

    function test_BudgetFactoryTrustChangeRequiresTheFortyEightHourTimelock() public {
        (AtomicDeployment.Deployment memory core, AtomicDeployment.PortfolioDeployment memory p) =
            coordinator.deployIntegratedSingleOwner(config);
        ShareMarket market = ShareMarket(core.shareMarket);
        PoolTimelock timelock = PoolTimelock(payable(core.timelock));
        bytes memory change = abi.encodeCall(ShareMarket.setBudgetFactoryTrust, (p.factory, false));
        bytes32 salt = keccak256("revoke-budget-factory");

        vm.expectRevert(IShareMarket.Unauthorized.selector);
        market.setBudgetFactoryTrust(p.factory, false);
        timelock.schedule(address(market), 0, change, bytes32(0), salt, 48 hours);
        vm.expectRevert();
        timelock.execute(address(market), 0, change, bytes32(0), salt);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(market), 0, change, bytes32(0), salt);
        assertFalse(market.budgetFactoryTrusted(p.factory));
    }

    function test_WrongPortfolioBindingAndUnauthorizedCallerCannotCreateEitherGraph() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(AtomicDeployment.Unauthorized.selector);
        coordinator.deployIntegratedSingleOwner(config);
        config.portfolioVaultImplementation = address(new BudgetPortfolioVault(coordinator.predictedFactory()));
        vm.expectRevert(AtomicDeployment.InvalidBinding.selector);
        coordinator.deployIntegratedSingleOwner(config);
        assertFalse(coordinator.deployed());
        assertEq(coordinator.predictedFactory().code.length, 0);
        assertEq(coordinator.predictedPortfolioFactory().code.length, 0);
    }
}
