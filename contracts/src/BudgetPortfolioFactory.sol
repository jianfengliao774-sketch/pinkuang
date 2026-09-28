// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IShareMarket} from "./interfaces/IShareMarket.sol";
import {BudgetPortfolioVault} from "./BudgetPortfolioVault.sol";

interface IBudgetRegisteredMarket {
    function factory() external view returns (address);
    function timelock() external view returns (address);
}

/// @notice A separate, upgradeable factory for shared portfolios of existing single-NFT pools.
/// @dev Existing PoolFactory/PoolVault remain untouched and retain miner uniqueness.
contract BudgetPortfolioFactory is OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    uint256 public constant MINIMUM_UPGRADE_DELAY = 48 hours;

    error Unauthorized();
    error InvalidAddress();
    error InvalidGovernance();
    error MarketAlreadyRegistered();

    event PortfolioCreated(address indexed portfolio, uint256 budgetWei, uint256 absoluteCapWei, uint256 unitCapWei);
    event ShareMarketRegistered(address indexed market);
    event OperatorChanged(address indexed previous, address indexed next);
    event TreasuryChanged(address indexed previous, address indexed next);
    event CreationPauseChanged(bool paused);

    address public operator;
    address public treasury;
    address public timelock;
    address public beacon;
    address public legacyFactory;
    address public shareMarket;
    bool public creationPaused;
    mapping(address => bool) public isPool;
    address[] private portfolios;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address operator_,
        address treasury_,
        address timelock_,
        address beacon_,
        address legacyFactory_
    ) external initializer {
        _initialize(owner_, operator_, treasury_, timelock_, beacon_, legacyFactory_);
    }

    /// @notice Bootstrap the project factory and its market in one atomic initialization.
    /// @dev The initializer never yields an unregistered factory across a transaction boundary.
    function initializeDeployment(
        address owner_,
        address operator_,
        address treasury_,
        address timelock_,
        address beacon_,
        address legacyFactory_,
        address marketImplementation_
    ) external initializer {
        _initialize(owner_, operator_, treasury_, timelock_, beacon_, legacyFactory_);
        if (marketImplementation_.code.length == 0) revert InvalidAddress();
        shareMarket = address(
            new ERC1967Proxy(marketImplementation_, abi.encodeCall(IShareMarket.initialize, (address(this), timelock_)))
        );
        if (
            IBudgetRegisteredMarket(shareMarket).factory() != address(this)
                || IBudgetRegisteredMarket(shareMarket).timelock() != timelock_
        ) revert InvalidGovernance();
        emit ShareMarketRegistered(shareMarket);
    }

    function _initialize(
        address owner_,
        address operator_,
        address treasury_,
        address timelock_,
        address beacon_,
        address legacyFactory_
    ) private onlyInitializing {
        if (
            owner_ == address(0) || operator_ == address(0) || treasury_ == address(0) || timelock_.code.length == 0
                || beacon_.code.length == 0 || legacyFactory_.code.length == 0
        ) {
            revert InvalidAddress();
        }
        if (
            TimelockController(payable(timelock_)).getMinDelay() < MINIMUM_UPGRADE_DELAY
                || UpgradeableBeacon(beacon_).owner() != timelock_
                || BudgetPortfolioVault(payable(UpgradeableBeacon(beacon_).implementation())).OFFICIAL_FACTORY()
                    != address(this)
        ) {
            revert InvalidGovernance();
        }
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        operator = operator_;
        treasury = treasury_;
        timelock = timelock_;
        beacon = beacon_;
        legacyFactory = legacyFactory_;
    }

    function createPortfolio(
        uint256 budgetWei,
        uint256 absoluteCapWei,
        uint256 unitCapWei,
        uint64 fundingDeadline,
        uint64 purchaseDeadline
    ) external nonReentrant returns (address portfolio) {
        if (msg.sender != operator) revert Unauthorized();
        if (creationPaused || shareMarket == address(0)) revert InvalidGovernance();
        BudgetPortfolioVault.Config memory config = BudgetPortfolioVault.Config({
            legacyFactory: legacyFactory,
            treasury: treasury,
            budgetWei: budgetWei,
            absoluteCapWei: absoluteCapWei,
            unitCapWei: unitCapWei,
            fundingDeadline: fundingDeadline,
            purchaseDeadline: purchaseDeadline
        });
        portfolio =
            address(new BeaconProxy(beacon, abi.encodeCall(BudgetPortfolioVault.initialize, (address(this), config))));
        isPool[portfolio] = true;
        portfolios.push(portfolio);
        emit PortfolioCreated(portfolio, budgetWei, absoluteCapWei, unitCapWei);
    }

    function setOperator(address next) external onlyOwner {
        if (next == address(0)) revert InvalidAddress();
        emit OperatorChanged(operator, next);
        operator = next;
    }

    /// @notice Changes the fee recipient of future projects. Existing portfolios keep their immutable treasury.
    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert InvalidAddress();
        emit TreasuryChanged(treasury, next);
        treasury = next;
    }

    function pauseCreation(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPauseChanged(paused);
    }

    function registerShareMarket(address market) external nonReentrant {
        if (msg.sender != timelock) revert Unauthorized();
        if (shareMarket != address(0)) revert MarketAlreadyRegistered();
        if (
            market.code.length == 0 || IBudgetRegisteredMarket(market).factory() != address(this)
                || IBudgetRegisteredMarket(market).timelock() != timelock
        ) revert InvalidGovernance();
        shareMarket = market;
        emit ShareMarketRegistered(market);
    }

    function portfolioCount() external view returns (uint256) {
        return portfolios.length;
    }

    function portfolioAt(uint256 index) external view returns (address) {
        return portfolios[index];
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != timelock) revert Unauthorized();
    }
}
