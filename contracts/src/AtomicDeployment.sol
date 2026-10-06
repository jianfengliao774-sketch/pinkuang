// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PoolTimelock} from "./PoolTimelock.sol";
import {PoolBeacon} from "./PoolBeacon.sol";
import {PoolFactory} from "./PoolFactory.sol";
import {IShareMarket} from "./interfaces/IShareMarket.sol";
import {PoolLens} from "./PoolLens.sol";
import {BudgetPortfolioFactory} from "./BudgetPortfolioFactory.sol";

interface IFactoryBoundVault {
    function OFFICIAL_FACTORY() external view returns (address);
}

interface IDeploymentMultisig {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice One-use deployment coordinator. Its deploy() transaction either creates the entire graph or reverts.
/// @dev Implementations and linked libraries are deployed separately and cannot initialize themselves.
/// No child is created before deploy(): CREATE nonces 1/2/3 belong to timelock/beacon/factory proxy respectively.
contract AtomicDeployment {
    struct Config {
        // Legacy field name retained for ABI compatibility; deploySingleOwner treats it as the owner wallet.
        address ownerMultisig;
        address operator;
        address treasury;
        address vaultImplementation;
        address factoryImplementation;
        address marketImplementation;
    }

    struct Deployment {
        address timelock;
        address beacon;
        address factory;
        address shareMarket;
    }

    struct IntegratedConfig {
        Config core;
        address portfolioFactoryImplementation;
        address portfolioVaultImplementation;
    }

    struct PortfolioDeployment {
        address factory;
        address beacon;
        address shareMarket;
    }

    address public immutable deployer;
    bool public deployed;
    Deployment public deployment;
    PortfolioDeployment public portfolioDeployment;

    error Unauthorized();
    error AlreadyDeployed();
    error InvalidRoles();
    error InvalidMultisig();
    error InvalidImplementation();
    error InvalidBinding();

    event DeploymentCompleted(
        address indexed factory,
        address indexed beacon,
        address indexed shareMarket,
        address timelock,
        address ownerMultisig,
        address operator,
        address treasury
    );
    event ImplementationsRecorded(
        address vault,
        bytes32 vaultCodehash,
        address factory,
        bytes32 factoryCodehash,
        address market,
        bytes32 marketCodehash
    );
    event SingleOwnerDeployment(address indexed owner, address indexed factory);
    event IntegratedDeploymentCompleted(
        address indexed factory,
        address indexed portfolioFactory,
        address indexed portfolioBeacon,
        address portfolioShareMarket,
        address timelock
    );
    event PortfolioImplementationsRecorded(
        address factory, bytes32 factoryCodehash, address vault, bytes32 vaultCodehash
    );

    constructor() {
        deployer = msg.sender;
    }

    function predictedFactory() public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"03")))));
    }

    /// @notice Nonce 4 creates the portfolio beacon; nonce 5 creates its factory proxy.
    function predictedPortfolioFactory() public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"05")))));
    }

    function deploy(Config calldata config) external returns (Deployment memory result) {
        _requireUndeployed();
        _validate(config);
        return _deploy(config);
    }

    /// @notice Explicit single-wallet bootstrap, retaining the same atomic graph and 48-hour upgrade delay.
    /// @dev The wallet that created this coordinator must remain the owner. Operator/treasury may be that wallet.
    /// This mode has no multisig protection: control and key recovery are the owner's responsibility.
    function deploySingleOwner(Config calldata config) external returns (Deployment memory result) {
        _requireUndeployed();
        if (
            config.ownerMultisig == address(0) || config.ownerMultisig != deployer || config.operator == address(0)
                || config.treasury == address(0)
        ) {
            revert InvalidRoles();
        }
        _validateImplementations(config);
        result = _deploy(config);
        emit SingleOwnerDeployment(config.ownerMultisig, result.factory);
    }

    /// @notice Atomically installs both single-miner and shared multi-miner projects under one governance graph.
    /// @dev Legacy bootstrap entry points remain for historical transaction decoding and recovery.
    function deployIntegratedSingleOwner(IntegratedConfig calldata config)
        external
        returns (Deployment memory result, PortfolioDeployment memory portfolio)
    {
        _requireUndeployed();
        if (
            config.core.ownerMultisig != deployer || config.core.operator == address(0)
                || config.core.treasury == address(0)
        ) revert InvalidRoles();
        _validateImplementations(config.core);
        if (
            config.portfolioFactoryImplementation.code.length == 0
                || config.portfolioVaultImplementation.code.length == 0
        ) revert InvalidImplementation();
        if (IFactoryBoundVault(config.portfolioVaultImplementation).OFFICIAL_FACTORY() != predictedPortfolioFactory()) {
            revert InvalidBinding();
        }
        result = _deploy(config.core);
        PoolBeacon portfolioBeacon = new PoolBeacon(config.portfolioVaultImplementation, result.timelock);
        BudgetPortfolioFactory portfolioFactory =
            BudgetPortfolioFactory(address(new ERC1967Proxy(config.portfolioFactoryImplementation, "")));
        if (address(portfolioFactory) != predictedPortfolioFactory()) revert InvalidBinding();
        portfolioFactory.initializeDeployment(
            config.core.ownerMultisig,
            config.core.operator,
            config.core.treasury,
            result.timelock,
            address(portfolioBeacon),
            result.factory,
            config.core.marketImplementation
        );
        portfolio =
            PortfolioDeployment(address(portfolioFactory), address(portfolioBeacon), portfolioFactory.shareMarket());
        // Bind the budget Factory in the core Market before this one-use
        // deployment transaction returns. A failed binding reverts the graph.
        IShareMarket(result.shareMarket).bootstrapBudgetFactory();
        if (!IShareMarket(result.shareMarket).budgetFactoryTrusted(portfolio.factory)) revert InvalidBinding();
        _verifyPortfolio(config, result, portfolio);
        portfolioDeployment = portfolio;
        emit SingleOwnerDeployment(config.core.ownerMultisig, result.factory);
        emit IntegratedDeploymentCompleted(
            result.factory, portfolio.factory, portfolio.beacon, portfolio.shareMarket, result.timelock
        );
        emit PortfolioImplementationsRecorded(
            config.portfolioFactoryImplementation,
            config.portfolioFactoryImplementation.codehash,
            config.portfolioVaultImplementation,
            config.portfolioVaultImplementation.codehash
        );
    }

    function _verifyPortfolio(
        IntegratedConfig calldata config,
        Deployment memory core,
        PortfolioDeployment memory result
    ) private view {
        BudgetPortfolioFactory factory = BudgetPortfolioFactory(result.factory);
        PoolBeacon beacon = PoolBeacon(result.beacon);
        IShareMarket market = IShareMarket(result.shareMarket);
        if (
            factory.owner() != config.core.ownerMultisig || factory.operator() != config.core.operator
                || factory.treasury() != config.core.treasury || factory.timelock() != core.timelock
                || factory.legacyFactory() != core.factory || factory.beacon() != result.beacon
                || factory.shareMarket() != result.shareMarket || beacon.owner() != core.timelock
                || beacon.implementation() != config.portfolioVaultImplementation
                || beacon.OFFICIAL_FACTORY() != result.factory || market.factory() != result.factory
                || market.timelock() != core.timelock
        ) revert InvalidBinding();
    }

    function _requireUndeployed() private view {
        if (msg.sender != deployer) revert Unauthorized();
        if (deployed) revert AlreadyDeployed();
    }

    function _deploy(Config calldata config) private returns (Deployment memory result) {
        deployed = true;

        PoolTimelock timelock = new PoolTimelock(config.ownerMultisig);
        PoolBeacon beacon = new PoolBeacon(config.vaultImplementation, address(timelock));
        // No transaction boundary or untrusted call intervenes between proxy creation and initialization.
        PoolFactory factory = PoolFactory(address(new ERC1967Proxy(config.factoryImplementation, "")));
        if (address(factory) != predictedFactory()) revert InvalidBinding();
        factory.initializeDeployment(
            config.ownerMultisig,
            config.operator,
            config.treasury,
            address(timelock),
            address(beacon),
            config.marketImplementation
        );
        result = Deployment(address(timelock), address(beacon), address(factory), factory.shareMarket());
        _verify(config, result);
        deployment = result;
        emit DeploymentCompleted(
            result.factory,
            result.beacon,
            result.shareMarket,
            result.timelock,
            config.ownerMultisig,
            config.operator,
            config.treasury
        );
        emit ImplementationsRecorded(
            config.vaultImplementation,
            config.vaultImplementation.codehash,
            config.factoryImplementation,
            config.factoryImplementation.codehash,
            config.marketImplementation,
            config.marketImplementation.codehash
        );
    }

    function _validate(Config calldata config) private view {
        if (
            config.ownerMultisig.code.length == 0 || config.operator == address(0) || config.treasury.code.length == 0
                || config.operator == config.ownerMultisig || config.operator == config.treasury
        ) revert InvalidRoles();
        _validateMultisig(config.ownerMultisig, true);
        if (config.treasury != config.ownerMultisig) _validateMultisig(config.treasury, false);
        _validateImplementations(config);
    }

    function _validateImplementations(Config calldata config) private view {
        if (
            config.vaultImplementation.code.length == 0 || config.factoryImplementation.code.length == 0
                || config.marketImplementation.code.length == 0
        ) revert InvalidImplementation();
        if (IFactoryBoundVault(config.vaultImplementation).OFFICIAL_FACTORY() != predictedFactory()) {
            revert InvalidBinding();
        }
    }

    function _validateMultisig(address account, bool requireTwoOfThree) private view {
        // Validate configuration only; the deployer must separately authenticate the chosen multisig code/address.
        IDeploymentMultisig multisig = IDeploymentMultisig(account);
        uint256 threshold = multisig.getThreshold();
        address[] memory owners = multisig.getOwners();
        if (threshold == 0 || threshold > owners.length) revert InvalidMultisig();
        if (requireTwoOfThree && (threshold != 2 || owners.length != 3)) revert InvalidMultisig();
        for (uint256 i; i < owners.length; ++i) {
            if (owners[i] == address(0)) revert InvalidMultisig();
            for (uint256 j; j < i; ++j) {
                if (owners[i] == owners[j]) revert InvalidMultisig();
            }
        }
    }

    function _verify(Config calldata config, Deployment memory result) private view {
        PoolFactory factory = PoolFactory(result.factory);
        address lens = factory.lens();
        if (lens.code.length == 0 || PoolLens(lens).factory() != result.factory) revert InvalidBinding();
        PoolTimelock timelock = PoolTimelock(payable(result.timelock));
        PoolBeacon beacon = PoolBeacon(result.beacon);
        IShareMarket market = IShareMarket(result.shareMarket);
        if (
            factory.owner() != config.ownerMultisig || factory.operator() != config.operator
                || factory.treasury() != config.treasury || factory.timelock() != result.timelock
                || factory.beacon() != result.beacon || factory.shareMarket() != result.shareMarket
                || beacon.owner() != result.timelock || beacon.implementation() != config.vaultImplementation
                || beacon.OFFICIAL_FACTORY() != result.factory || market.factory() != result.factory
                || market.timelock() != result.timelock || timelock.getMinDelay() != 48 hours
                || !timelock.hasRole(timelock.PROPOSER_ROLE(), config.ownerMultisig)
                || !timelock.hasRole(timelock.CANCELLER_ROLE(), config.ownerMultisig)
                || !timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0))
                || !timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), result.timelock)
                || timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this))
                || timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployer)
        ) revert InvalidBinding();
    }
}
