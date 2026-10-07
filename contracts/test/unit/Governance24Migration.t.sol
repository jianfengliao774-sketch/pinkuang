// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AtomicDeployment} from "../../src/AtomicDeployment.sol";
import {FreshPoolFactory} from "../../src/FreshPoolFactory.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {BudgetPortfolioFactory} from "../../src/BudgetPortfolioFactory.sol";
import {BudgetPortfolioVault} from "../../src/BudgetPortfolioVault.sol";
import {PlatformAuthority} from "../../src/PlatformAuthority.sol";
import {PoolTimelock24} from "../../src/PoolTimelock24.sol";
import {Governance24Beacon} from "../../src/Governance24Beacon.sol";
import {Governance24Dispatcher} from "../../src/Governance24Dispatcher.sol";
import {Governance24FreshPoolFactory} from "../../src/Governance24FreshPoolFactory.sol";
import {Governance24BudgetPortfolioFactory} from "../../src/Governance24BudgetPortfolioFactory.sol";
import {Governance24ShareMarket} from "../../src/Governance24ShareMarket.sol";
import {Governance24Validation} from "../../src/libraries/Governance24Validation.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";
import {Addresses} from "../../script/Addresses.sol";
import {PurchaseMockNft, PurchaseMockBem, PurchaseMockMining, PurchaseMockMarket} from "../utils/PurchaseMocks.sol";

/// @dev Test-only logic used briefly to demonstrate both delegatecall boundaries without writing pool state.
contract Governance24ContextProbe {
    address public immutable OFFICIAL_FACTORY;

    constructor(address factory_) {
        OFFICIAL_FACTORY = factory_;
    }

    function probe() external payable returns (address pool, address caller, uint256 value) {
        return (address(this), msg.sender, msg.value);
    }
}

/// @notice Full local graph migration using real funding, acquisition, BEM, share locks and UUPS governance.
/// @dev No fork, RPC, real signature, wallet, deployment or protocol action occurs here.
contract Governance24MigrationTest is Test {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant BUYER = address(0xB017);
    address private constant SELLER = address(0x5E11E2);
    address private constant ADMIN_ONE = address(0xA01);
    address private constant ADMIN_TWO = address(0xA02);
    address private constant GAS_WALLET = address(0x6A5);
    bytes32 private constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    PoolFactory private core;
    BudgetPortfolioFactory private portfolioFactory;
    ShareMarket private coreMarket;
    ShareMarket private portfolioMarket;
    PoolBeacon private coreLegacyBeacon;
    PoolBeacon private portfolioLegacyBeacon;
    PoolTimelock private oldLock;
    PoolTimelock24 private nextLock;
    PlatformAuthority private authority;
    PoolVault private singlePool;
    PoolVault private child;
    BudgetPortfolioVault private portfolio;
    PurchaseMockNft private nft;
    PurchaseMockBem private bem;
    PurchaseMockMining private mining;
    PurchaseMockMarket private nftMarket;
    Governance24Beacon private coreSecondary;
    Governance24Beacon private portfolioSecondary;
    Governance24Dispatcher private coreDispatcher;
    Governance24Dispatcher private portfolioDispatcher;
    Governance24FreshPoolFactory private coreCandidate;
    Governance24BudgetPortfolioFactory private portfolioCandidate;
    Governance24ShareMarket private marketCandidate;
    uint256 private coreOrder;
    uint256 private portfolioOrder;
    bytes32 private migratedSalt = keccak256("atomic-governance24");

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(56);
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        bem = PurchaseMockBem(Addresses.BEM);
        mining = PurchaseMockMining(payable(Addresses.MINING));
        nftMarket = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);
        AtomicDeployment coordinator = new AtomicDeployment();
        AtomicDeployment.IntegratedConfig memory config;
        config.core = AtomicDeployment.Config({
            ownerMultisig: address(this),
            operator: address(this),
            treasury: address(this),
            vaultImplementation: address(new PoolVault(coordinator.predictedFactory())),
            factoryImplementation: address(new FreshPoolFactory()),
            marketImplementation: address(new ShareMarket())
        });
        config.portfolioFactoryImplementation = address(new BudgetPortfolioFactory());
        config.portfolioVaultImplementation = address(new BudgetPortfolioVault(coordinator.predictedPortfolioFactory()));
        (AtomicDeployment.Deployment memory c, AtomicDeployment.PortfolioDeployment memory p) =
            coordinator.deployIntegratedSingleOwner(config);
        core = PoolFactory(c.factory);
        portfolioFactory = BudgetPortfolioFactory(p.factory);
        oldLock = PoolTimelock(payable(c.timelock));
        coreLegacyBeacon = PoolBeacon(c.beacon);
        portfolioLegacyBeacon = PoolBeacon(p.beacon);
        coreMarket = ShareMarket(c.shareMarket);
        portfolioMarket = ShareMarket(p.shareMarket);
        authority = new PlatformAuthority(c.factory, p.factory, ADMIN_ONE, ADMIN_TWO, GAS_WALLET);
        vm.prank(ADMIN_ONE);
        authority.invalidateNonce(7);
        _populateBusinessState();

        nextLock = new PoolTimelock24(address(this));
        coreSecondary = new Governance24Beacon(address(new PoolVault(c.factory)), address(nextLock));
        portfolioSecondary = new Governance24Beacon(address(new BudgetPortfolioVault(p.factory)), address(nextLock));
        coreDispatcher = new Governance24Dispatcher(c.factory, address(coreSecondary));
        portfolioDispatcher = new Governance24Dispatcher(p.factory, address(portfolioSecondary));
        coreCandidate = new Governance24FreshPoolFactory();
        portfolioCandidate = new Governance24BudgetPortfolioFactory();
        marketCandidate = new Governance24ShareMarket();
    }

    function _params(uint256 id) private view returns (IPoolVault.PoolParams memory) {
        return IPoolVault.PoolParams({
            circuits: address(nft),
            circuitId: id,
            targetRaise: 6.5 ether,
            priceCap: 6 ether,
            directSeller: address(0),
            directPrice: 0,
            fundingDeadline: uint64(block.timestamp + 7 days),
            purchaseDeadline: uint64(block.timestamp + 10 days)
        });
    }

    function _listing(uint256 id) private returns (uint256) {
        mining.configure(address(nft), id, 0, 0);
        vm.prank(SELLER);
        nft.approve(address(nftMarket), id);
        return nftMarket.createListing(SELLER, address(nft), id, 5 ether);
    }

    function _populateBusinessState() private {
        nft.mint(SELLER, 101);
        singlePool = PoolVault(payable(core.createPool(_params(101))));
        vm.deal(ALICE, 20 ether);
        vm.deal(BOB, 20 ether);
        vm.prank(ALICE);
        singlePool.deposit{value: 3.9 ether}(60);
        vm.prank(BOB);
        singlePool.deposit{value: 2.6 ether}(40);
        singlePool.buyFromMarket(_listing(101));
        mining.configure(address(nft), 101, 0, 100 * 1e8);
        singlePool.harvest();
        portfolio = BudgetPortfolioVault(
            payable(portfolioFactory.createPortfolio(
                    13 ether, 6 ether, 3 ether, uint64(block.timestamp + 7 days), uint64(block.timestamp + 10 days)
                ))
        );
        vm.prank(ALICE);
        portfolio.deposit{value: 7.8 ether}(60);
        vm.prank(BOB);
        portfolio.deposit{value: 5.2 ether}(40);
        nft.mint(SELLER, 102);
        child = PoolVault(payable(core.createBudgetChildPool(_params(102), address(portfolio))));
        portfolio.buyOfficial(address(child), _listing(102));
        mining.configure(address(nft), 102, 0, 200 * 1e8);
        portfolio.collectChildBem(address(child));
        vm.warp(portfolio.purchaseDeadline());
        portfolio.finalizeAcquisition();
        vm.prank(ALICE);
        coreOrder = coreMarket.list(address(singlePool), 20, 0.1 ether);
        vm.deal(BUYER, 1.01 ether);
        vm.prank(BUYER);
        coreMarket.fill{value: 1.01 ether}(coreOrder, 10);
        vm.prank(BOB);
        portfolioOrder = portfolioMarket.list(address(portfolio), 20, 0.1 ether);
        vm.deal(BUYER, 1.01 ether);
        vm.prank(BUYER);
        portfolioMarket.fill{value: 1.01 ether}(portfolioOrder, 10);
    }

    function _batch()
        private
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](7);
        values = new uint256[](7);
        payloads = new bytes[](7);
        targets[0] = address(coreLegacyBeacon);
        targets[1] = address(portfolioLegacyBeacon);
        targets[2] = address(core);
        targets[3] = address(portfolioFactory);
        targets[4] = address(coreMarket);
        targets[5] = address(portfolioMarket);
        targets[6] = address(authority);
        payloads[0] = abi.encodeCall(PoolBeacon.upgradeTo, (address(coreDispatcher)));
        payloads[1] = abi.encodeCall(PoolBeacon.upgradeTo, (address(portfolioDispatcher)));
        payloads[2] = abi.encodeCall(
            UUPSUpgradeable.upgradeToAndCall,
            (
                address(coreCandidate),
                abi.encodeCall(coreCandidate.migrateGovernance24, (address(oldLock), address(nextLock)))
            )
        );
        payloads[3] = abi.encodeCall(
            UUPSUpgradeable.upgradeToAndCall,
            (
                address(portfolioCandidate),
                abi.encodeCall(portfolioCandidate.migrateGovernance24, (address(oldLock), address(nextLock)))
            )
        );
        bytes memory migrateMarket =
            abi.encodeCall(marketCandidate.migrateGovernance24, (address(oldLock), address(nextLock)));
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(marketCandidate), migrateMarket));
        payloads[5] = payloads[4];
        payloads[6] = abi.encodeCall(Ownable.transferOwnership, (address(nextLock)));
    }

    function _migrate() private {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _batch();
        oldLock.scheduleBatch(targets, values, payloads, bytes32(0), migratedSalt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        oldLock.executeBatch(targets, values, payloads, bytes32(0), migratedSalt);
    }

    function _stateDigest() private view returns (bytes32) {
        return keccak256(abi.encode(_registryDigest(), _poolDigest(), _projectDigest(), _marketDigest(), _roleDigest()));
    }

    function _registryDigest() private view returns (bytes32) {
        bytes memory data = abi.encode(core.operator(), core.treasury(), core.beacon(), core.lens(), core.shareMarket());
        data = abi.encode(data, core.poolCount(), core.allPools(0), core.allPools(1));
        data = abi.encode(data, core.isPool(address(singlePool)), core.isPool(address(child)));
        data = abi.encode(
            data,
            core.machinePool(address(nft), 101),
            core.machinePool(address(nft), 102),
            core.designatedSubscriber(address(child))
        );
        (bool initialized, bool ready, uint256 cursor, uint256 cutoff) = core.machineRegistryStatus();
        data = abi.encode(data, initialized, ready, cursor, cutoff);
        data = abi.encode(data, portfolioFactory.operator(), portfolioFactory.treasury(), portfolioFactory.beacon());
        data = abi.encode(data, portfolioFactory.legacyFactory(), portfolioFactory.shareMarket());
        return keccak256(
            abi.encode(
                data,
                portfolioFactory.portfolioCount(),
                portfolioFactory.portfolioAt(0),
                portfolioFactory.isPool(address(portfolio))
            )
        );
    }

    function _poolDigest() private view returns (bytes32) {
        bytes memory data =
            abi.encode(singlePool.factory(), singlePool.treasury(), singlePool.params(), singlePool.state());
        data = abi.encode(data, singlePool.totalRaised(), singlePool.balanceOf(ALICE), singlePool.balanceOf(BOB));
        data = abi.encode(data, singlePool.balanceOf(BUYER), singlePool.totalSupply(), singlePool.lockedShares(ALICE));
        data = abi.encode(data, singlePool.claimable(ALICE), singlePool.claimable(BOB), singlePool.bnbOwed(ALICE));
        return keccak256(
            abi.encode(
                data,
                singlePool.bnbOwed(BOB),
                singlePool.bemAccounted(),
                address(singlePool).balance,
                bem.balanceOf(address(singlePool)),
                nft.ownerOf(101)
            )
        );
    }

    function _projectDigest() private view returns (bytes32) {
        bytes memory data = abi.encode(
            portfolio.legacyFactory(),
            portfolio.treasury(),
            portfolio.budgetWei(),
            portfolio.spentWei(),
            portfolio.state()
        );
        data = abi.encode(
            data,
            portfolio.balanceOf(ALICE),
            portfolio.balanceOf(BOB),
            portfolio.balanceOf(BUYER),
            portfolio.totalSupply()
        );
        data = abi.encode(data, portfolio.lockedShares(BOB), portfolio.childCount(), portfolio.childAt(0));
        (address collection, uint256 id, uint256 cost, bool official, bool sold) = portfolio.childInfo(address(child));
        data = abi.encode(data, collection, id, cost, official, sold);
        data = abi.encode(data, portfolio.claimableBem(ALICE), portfolio.claimableBem(BOB), portfolio.totalBnbOwed());
        data = abi.encode(
            data, portfolio.bnbOwed(address(this)), address(portfolio).balance, bem.balanceOf(address(portfolio))
        );
        return keccak256(abi.encode(data, child.balanceOf(address(portfolio)), nft.ownerOf(102)));
    }

    function _marketDigest() private view returns (bytes32) {
        bytes memory data =
            abi.encode(coreMarket.orders(coreOrder), coreMarket.orderExpiresAt(coreOrder), coreMarket.nextOrderId());
        data = abi.encode(data, coreMarket.bnbOwed(ALICE), coreMarket.totalBnbOwed(), address(coreMarket).balance);
        data = abi.encode(
            data, coreMarket.budgetFactoryTrusted(address(portfolioFactory)), portfolioMarket.orders(portfolioOrder)
        );
        return keccak256(
            abi.encode(
                data,
                portfolioMarket.orderExpiresAt(portfolioOrder),
                portfolioMarket.nextOrderId(),
                portfolioMarket.bnbOwed(BOB),
                portfolioMarket.totalBnbOwed(),
                address(portfolioMarket).balance
            )
        );
    }

    function _roleDigest() private view returns (bytes32) {
        bytes memory data = abi.encode(
            authority.coreFactory(),
            authority.budgetFactory(),
            authority.administratorOne(),
            authority.administratorTwo()
        );
        return
            keccak256(abi.encode(data, authority.gasWallet(), authority.nonces(ADMIN_ONE), authority.nonces(ADMIN_TWO)));
    }

    function test_AtomicMigrationPreservesExistingAssetsClaimsSharesOrdersRegistriesAndRoles() public {
        bytes32 beforeState = _stateDigest();
        _migrate();
        assertEq(_stateDigest(), beforeState, "migration may only change governance fields and implementation pointers");
        assertEq(core.timelock(), address(nextLock));
        assertEq(portfolioFactory.timelock(), address(nextLock));
        assertEq(coreMarket.timelock(), address(nextLock));
        assertEq(portfolioMarket.timelock(), address(nextLock));
        assertEq(core.owner(), address(nextLock));
        assertEq(portfolioFactory.owner(), address(nextLock));
        assertEq(authority.owner(), address(nextLock));
        assertEq(coreLegacyBeacon.owner(), address(oldLock));
        assertEq(portfolioLegacyBeacon.owner(), address(oldLock));
        assertEq(coreSecondary.owner(), address(nextLock));
        assertEq(portfolioSecondary.owner(), address(nextLock));
        assertEq(singlePool.firstoBatchPurchaseVersion(), 1, "latest core BatchAsk route survives routing");
        vm.prank(ALICE);
        coreMarket.cancel(coreOrder);
        uint256 owed = coreMarket.bnbOwed(ALICE);
        vm.prank(ALICE);
        coreMarket.withdrawBnb();
        assertEq(coreMarket.bnbOwed(ALICE), 0);
        assertGe(ALICE.balance, owed);
        uint256 pendingBem = singlePool.claimable(BOB);
        uint256 balanceBefore = bem.balanceOf(BOB);
        vm.prank(BOB);
        singlePool.claim();
        assertEq(bem.balanceOf(BOB) - balanceBefore, pendingBem);
        vm.prank(BOB);
        portfolioMarket.cancel(portfolioOrder);
        pendingBem = portfolio.claimableBem(BOB);
        balanceBefore = bem.balanceOf(BOB);
        vm.prank(BOB);
        portfolio.claimBem();
        assertEq(bem.balanceOf(BOB) - balanceBefore, pendingBem);
    }

    function test_FirstMigrationCannotScheduleBelow48HoursAndExecutesOnlyAfter48() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _batch();
        vm.expectRevert(
            abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, 24 hours, 48 hours)
        );
        oldLock.scheduleBatch(targets, values, payloads, bytes32(0), migratedSalt, 24 hours);
        oldLock.scheduleBatch(targets, values, payloads, bytes32(0), migratedSalt, 48 hours);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        oldLock.executeBatch(targets, values, payloads, bytes32(0), migratedSalt);
        assertEq(core.timelock(), address(oldLock));
        vm.warp(block.timestamp + 1);
        oldLock.executeBatch(targets, values, payloads, bytes32(0), migratedSalt);
        assertEq(core.timelock(), address(nextLock));
    }

    function test_LastActionFailureRollsBackBothRoutesAllFourUupsAndFactoryOwners() public {
        bytes32 beforeState = _stateDigest();
        bytes32 beforeCoreImplementation = vm.load(address(core), IMPL_SLOT);
        bytes32 beforeMarketImplementation = vm.load(address(coreMarket), IMPL_SLOT);
        address beforeBeaconImplementation = coreLegacyBeacon.implementation();
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _batch();
        payloads[6] = abi.encodeCall(Ownable.transferOwnership, (address(0)));
        oldLock.scheduleBatch(targets, values, payloads, bytes32(0), migratedSalt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        oldLock.executeBatch(targets, values, payloads, bytes32(0), migratedSalt);
        assertEq(_stateDigest(), beforeState);
        assertEq(vm.load(address(core), IMPL_SLOT), beforeCoreImplementation);
        assertEq(vm.load(address(coreMarket), IMPL_SLOT), beforeMarketImplementation);
        assertEq(coreLegacyBeacon.implementation(), beforeBeaconImplementation);
        assertEq(core.timelock(), address(oldLock));
        assertEq(portfolioFactory.timelock(), address(oldLock));
        assertEq(coreMarket.timelock(), address(oldLock));
        assertEq(portfolioMarket.timelock(), address(oldLock));
        assertEq(core.owner(), address(this));
        assertEq(portfolioFactory.owner(), address(this));
        assertEq(authority.owner(), address(oldLock));
    }

    function test_UnauthorizedAndInvalidMigrationRevertWithoutChangingProxy() public {
        bytes32 previousImplementation = vm.load(address(core), IMPL_SLOT);
        bytes memory migration =
            abi.encodeCall(coreCandidate.migrateGovernance24, (address(oldLock), address(nextLock)));
        vm.prank(ALICE);
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        core.upgradeToAndCall(address(coreCandidate), migration);
        vm.prank(address(oldLock));
        vm.expectRevert(Governance24Validation.InvalidGovernance24.selector);
        core.upgradeToAndCall(
            address(coreCandidate), abi.encodeCall(coreCandidate.migrateGovernance24, (ALICE, address(nextLock)))
        );
        PoolTimelock24 wrongProposer = new PoolTimelock24(ALICE);
        vm.prank(address(oldLock));
        vm.expectRevert(Governance24Validation.InvalidGovernance24.selector);
        core.upgradeToAndCall(
            address(coreCandidate),
            abi.encodeCall(coreCandidate.migrateGovernance24, (address(oldLock), address(wrongProposer)))
        );
        assertEq(vm.load(address(core), IMPL_SLOT), previousImplementation);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        coreCandidate.migrateGovernance24(address(oldLock), address(nextLock));
    }

    function test_FutureBusinessUpgradesAndAdministrationUse24HoursAndPreserveDelegateContext() public {
        _migrate();
        Governance24ContextProbe probe = new Governance24ContextProbe(address(core));
        bytes memory update = abi.encodeCall(Governance24Beacon.upgradeTo, (address(probe)));
        bytes32 salt = keccak256("24-hour-vault-logic");
        vm.expectRevert(
            abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, 24 hours - 1, 24 hours)
        );
        nextLock.schedule(address(coreSecondary), 0, update, bytes32(0), salt, 24 hours - 1);
        vm.prank(ALICE);
        vm.expectRevert();
        nextLock.schedule(address(coreSecondary), 0, update, bytes32(0), salt, 24 hours);
        vm.prank(ALICE);
        vm.expectRevert();
        coreSecondary.upgradeTo(address(probe));
        nextLock.schedule(address(coreSecondary), 0, update, bytes32(0), salt, 24 hours);
        vm.warp(block.timestamp + 24 hours - 1);
        vm.expectRevert();
        nextLock.execute(address(coreSecondary), 0, update, bytes32(0), salt);
        vm.warp(block.timestamp + 1);
        // Open execution: a third party can execute the unchanged reviewed payload.
        vm.prank(ALICE);
        nextLock.execute(address(coreSecondary), 0, update, bytes32(0), salt);
        vm.prank(BOB);
        (address forwardedPool, address forwardedCaller, uint256 forwardedValue) =
            Governance24ContextProbe(address(singlePool)).probe();
        assertEq(forwardedPool, address(singlePool));
        assertEq(forwardedCaller, BOB);
        assertEq(forwardedValue, 0);
        vm.expectRevert(Governance24Dispatcher.DirectCall.selector);
        Governance24ContextProbe(address(coreDispatcher)).probe();
        vm.prank(ALICE);
        vm.expectRevert();
        core.pauseCreation(true);
        bytes memory pause = abi.encodeCall(PoolFactory.pauseCreation, (true));
        nextLock.schedule(address(core), 0, pause, bytes32(0), salt, 24 hours);
        vm.warp(block.timestamp + 24 hours);
        nextLock.execute(address(core), 0, pause, bytes32(0), salt);
        assertTrue(core.creationPaused());
        assertEq(oldLock.getMinDelay(), 48 hours, "legacy beacon recovery still uses the original floor");
    }

    function test_Hard24HourFloorCannotBeRemovedAndBeaconBindingOwnershipStayFixed() public {
        bytes memory lowerDelay = abi.encodeCall(TimelockController.updateDelay, (0));
        bytes32 salt = keccak256("attempt-lower-floor");
        nextLock.schedule(address(nextLock), 0, lowerDelay, bytes32(0), salt, 24 hours);
        vm.warp(block.timestamp + 24 hours);
        nextLock.execute(address(nextLock), 0, lowerDelay, bytes32(0), salt);
        assertEq(nextLock.getMinDelay(), 24 hours);
        assertFalse(nextLock.hasRole(nextLock.DEFAULT_ADMIN_ROLE(), address(this)));
        assertTrue(nextLock.hasRole(nextLock.DEFAULT_ADMIN_ROLE(), address(nextLock)));
        vm.expectRevert(Governance24Beacon.BeaconOwnershipFixed.selector);
        coreSecondary.transferOwnership(ALICE);
        vm.expectRevert(Governance24Beacon.BeaconOwnershipFixed.selector);
        coreSecondary.renounceOwnership();
        Governance24ContextProbe wrongFactory = new Governance24ContextProbe(address(portfolioFactory));
        vm.prank(address(nextLock));
        vm.expectRevert(Governance24Beacon.InvalidFactoryBinding.selector);
        coreSecondary.upgradeTo(address(wrongFactory));
        vm.expectRevert(Governance24Dispatcher.InvalidFactoryBinding.selector);
        new Governance24Dispatcher(address(core), address(portfolioSecondary));
        vm.expectRevert(Governance24Validation.InvalidGovernance24.selector);
        new Governance24Beacon(address(singlePool), address(oldLock));
    }

    function test_NewPoolsKeepLegacyBeaconAddressAndUse24HourBusinessRoute() public {
        _migrate();
        nft.mint(SELLER, 103);
        PoolVault fresh = PoolVault(payable(core.createPool(_params(103))));
        assertEq(fresh.factory(), address(core));
        assertEq(fresh.OFFICIAL_FACTORY(), address(core));
        assertEq(fresh.firstoBatchPurchaseVersion(), 1);
        vm.deal(ALICE, 0.65 ether);
        vm.prank(ALICE);
        fresh.deposit{value: 0.65 ether}(10);
        assertEq(fresh.balanceOf(ALICE), 10);
        assertEq(core.beacon(), address(coreLegacyBeacon));
        assertEq(core.machinePool(address(nft), 103), address(fresh));
        BudgetPortfolioVault freshPortfolio = BudgetPortfolioVault(
            payable(portfolioFactory.createPortfolio(
                    1 ether, 1 ether, 1 ether, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days)
                ))
        );
        assertEq(freshPortfolio.OFFICIAL_FACTORY(), address(portfolioFactory));
        vm.deal(BOB, 0.1 ether);
        vm.prank(BOB);
        freshPortfolio.deposit{value: 0.1 ether}(10);
        assertEq(freshPortfolio.balanceOf(BOB), 10);
        assertEq(portfolioFactory.beacon(), address(portfolioLegacyBeacon));
    }

    function test_AllFourUupsBothVaultRoutesAndAuthorityRemainGovernableAfter24Hours() public {
        _migrate();
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _batch();
        Governance24ContextProbe coreProbe = new Governance24ContextProbe(address(core));
        Governance24ContextProbe portfolioProbe = new Governance24ContextProbe(address(portfolioFactory));
        targets[0] = address(coreSecondary);
        targets[1] = address(portfolioSecondary);
        payloads[0] = abi.encodeCall(Governance24Beacon.upgradeTo, (address(coreProbe)));
        payloads[1] = abi.encodeCall(Governance24Beacon.upgradeTo, (address(portfolioProbe)));
        address nextCore = address(new Governance24FreshPoolFactory());
        address nextPortfolioFactory = address(new Governance24BudgetPortfolioFactory());
        address nextMarket = address(new Governance24ShareMarket());
        payloads[2] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (nextCore, bytes("")));
        payloads[3] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (nextPortfolioFactory, bytes("")));
        payloads[4] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (nextMarket, bytes("")));
        payloads[5] = payloads[4];
        address nextGasWallet = address(0x6A52);
        payloads[6] = abi.encodeCall(PlatformAuthority.setGasWallet, (nextGasWallet));
        bytes32 salt = keccak256("all-future-business-governance");
        nextLock.scheduleBatch(targets, values, payloads, bytes32(0), salt, 24 hours);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(BOB);
        nextLock.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertEq(address(uint160(uint256(vm.load(address(core), IMPL_SLOT)))), nextCore);
        assertEq(address(uint160(uint256(vm.load(address(portfolioFactory), IMPL_SLOT)))), nextPortfolioFactory);
        assertEq(address(uint160(uint256(vm.load(address(coreMarket), IMPL_SLOT)))), nextMarket);
        assertEq(address(uint160(uint256(vm.load(address(portfolioMarket), IMPL_SLOT)))), nextMarket);
        assertEq(authority.gasWallet(), nextGasWallet);
        assertEq(authority.nonces(ADMIN_ONE), 7);
        vm.prank(ALICE);
        (address forwardedPool, address forwardedCaller,) = Governance24ContextProbe(address(portfolio)).probe();
        assertEq(forwardedPool, address(portfolio));
        assertEq(forwardedCaller, ALICE);
        vm.prank(address(oldLock));
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        core.upgradeToAndCall(address(coreCandidate), "");
        vm.prank(address(nextLock));
        vm.expectRevert(Governance24Validation.InvalidGovernance24.selector);
        Governance24FreshPoolFactory(address(core)).migrateGovernance24(address(nextLock), address(oldLock));
    }

    function test_LegacyBeaconRecoveryStillRequires48HoursAndPreservesPoolStorage() public {
        address legacyVault = coreLegacyBeacon.implementation();
        _migrate();
        bytes32 beforePool = _poolDigest();
        bytes memory recovery = abi.encodeCall(PoolBeacon.upgradeTo, (legacyVault));
        bytes32 salt = keccak256("legacy-48-hour-recovery");
        vm.expectRevert();
        oldLock.schedule(address(coreLegacyBeacon), 0, recovery, bytes32(0), salt, 24 hours);
        oldLock.schedule(address(coreLegacyBeacon), 0, recovery, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        oldLock.execute(address(coreLegacyBeacon), 0, recovery, bytes32(0), salt);
        assertEq(coreLegacyBeacon.implementation(), legacyVault);
        assertEq(_poolDigest(), beforePool);
        assertEq(core.timelock(), address(nextLock));
        assertEq(core.owner(), address(nextLock));
    }

    receive() external payable {}
}
