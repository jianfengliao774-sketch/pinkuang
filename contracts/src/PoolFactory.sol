// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPoolVault, IPoolFactoryRoles} from "./interfaces/IPoolVault.sol";
import {IShareMarket} from "./interfaces/IShareMarket.sol";
import {PoolLens} from "./PoolLens.sol";

interface IRegisteredShareMarket {
    function factory() external view returns (address);
    function timelock() external view returns (address);
}

/// @notice Creates independently funded BNB pools. Daily administration and upgrade authority are separate.
contract PoolFactory is OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, IPoolFactoryRoles {
    uint256 public constant TOTAL_SHARES = 100;
    uint256 public constant MINIMUM_UPGRADE_DELAY = 48 hours;
    address public constant TAPEOUT_CIRCUITS = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address public constant BEHEMOTH_CIRCUITS = 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C;

    /// @custom:storage-location erc7201:tapeout.storage.PoolFactory
    struct FactoryStorage {
        address operator;
        address treasury;
        address timelock;
        address beacon;
        bool creationPaused;
        mapping(address => bool) isPool;
        address[] allPools;
        address shareMarket;
        address lens;
    }

    // keccak256(abi.encode(uint256(keccak256("tapeout.storage.PoolFactory")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FACTORY_STORAGE = 0x7df0f2776085c7e815f62ac029a5c2187a970116ca74c4ab435eb122a2a16a00;

    error InvalidAddress();
    error InvalidGovernance();
    error Unauthorized();
    error CreationPaused();
    error ShareMarketAlreadyRegistered();
    error ReferenceMinerChanged();

    event PoolCreated(
        address indexed pool,
        address indexed circuits,
        uint256 indexed circuitId,
        uint256 targetRaise,
        uint256 priceCap,
        address treasury
    );
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);
    event CreationPauseChanged(bool paused);
    event ShareMarketRegistered(address indexed market);
    event LensCreated(address indexed lens);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address ownerMultisig, address operator_, address treasury_, address timelock_, address beacon_)
        external
        initializer
    {
        _initializeFactory(ownerMultisig, operator_, treasury_, timelock_, beacon_);
    }

    /// @notice Atomic bootstrap only: create and register the market before the new deployment is returned.
    /// @dev The proxy must already have code, so the coordinator creates it and calls this in the same transaction.
    /// Later registry changes remain subject to registerShareMarket's timelock and one-time binding.
    function initializeDeployment(
        address ownerMultisig,
        address operator_,
        address treasury_,
        address timelock_,
        address beacon_,
        address marketImplementation
    ) external initializer {
        _initializeFactory(ownerMultisig, operator_, treasury_, timelock_, beacon_);
        if (marketImplementation.code.length == 0) revert InvalidAddress();
        address market = address(
            new ERC1967Proxy(marketImplementation, abi.encodeCall(IShareMarket.initialize, (address(this), timelock_)))
        );
        _registerShareMarket(_factoryStorage(), market);
    }

    function _initializeFactory(
        address ownerMultisig,
        address operator_,
        address treasury_,
        address timelock_,
        address beacon_
    ) private onlyInitializing {
        if (ownerMultisig == address(0) || operator_ == address(0) || treasury_ == address(0)) {
            revert InvalidAddress();
        }
        if (timelock_.code.length == 0 || beacon_.code.length == 0) revert InvalidGovernance();
        if (
            TimelockController(payable(timelock_)).getMinDelay() < MINIMUM_UPGRADE_DELAY
                || UpgradeableBeacon(beacon_).owner() != timelock_
        ) revert InvalidGovernance();
        __Ownable_init(ownerMultisig);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        FactoryStorage storage $ = _factoryStorage();
        $.operator = operator_;
        $.treasury = treasury_;
        $.timelock = timelock_;
        $.beacon = beacon_;
        _ensureLens($);
    }

    function createPool(IPoolVault.PoolParams calldata params) external nonReentrant returns (address pool) {
        return _createPool(params, true);
    }

    function createPoolWithExpiry(IPoolVault.PoolParams calldata params, bool expiryEnabled)
        external
        nonReentrant
        returns (address pool)
    {
        return _createPool(params, expiryEnabled);
    }

    /// @notice Creates an opt-in verified-capacity pool and locks all selection terms before returning.
    function createFlexiblePool(
        IPoolVault.PoolParams calldata params,
        IPoolVault.FlexiblePurchaseConfig calldata config
    ) external nonReentrant returns (address pool) {
        return _createFlexiblePool(params, config);
    }

    /// @notice Reject a reference miner that changed after the operator reviewed its quoted identity and weight.
    function createFlexiblePoolChecked(
        IPoolVault.PoolParams calldata params,
        IPoolVault.FlexiblePurchaseConfig calldata config,
        uint32 expectedTaskId,
        uint128 expectedReferenceWeight
    ) external nonReentrant returns (address pool) {
        pool = _createFlexiblePool(params, config);
        (bool initialized, uint32 taskId) = IPoolVault(pool).purchaseModel();
        if (
            !initialized || taskId != expectedTaskId || expectedReferenceWeight == 0
                || IPoolVault(pool).purchaseReferenceWeight() != expectedReferenceWeight
        ) revert ReferenceMinerChanged();
    }

    function _createFlexiblePool(
        IPoolVault.PoolParams calldata params,
        IPoolVault.FlexiblePurchaseConfig calldata config
    ) private returns (address pool) {
        pool = _createPool(params, true);
        IPoolVault(pool).configureFlexiblePurchase(config);
    }

    /// @notice Permissionless, one-time creation for initialized factories upgraded from a pre-Lens implementation.
    function ensureLens() external nonReentrant returns (address) {
        FactoryStorage storage s = _factoryStorage();
        if (s.beacon == address(0) || s.timelock == address(0)) revert InvalidGovernance();
        return _ensureLens(s);
    }

    function _ensureLens(FactoryStorage storage s) private returns (address) {
        if (s.lens == address(0)) {
            s.lens = address(new PoolLens(address(this)));
            emit LensCreated(s.lens);
        }
        return s.lens;
    }

    function lens() external view returns (address) {
        return _factoryStorage().lens;
    }

    function _createPool(IPoolVault.PoolParams calldata params, bool expiryEnabled) private returns (address pool) {
        FactoryStorage storage $ = _factoryStorage();
        if (msg.sender != $.operator) revert Unauthorized();
        if ($.creationPaused) revert CreationPaused();
        _validateParams(params);
        pool = address(
            new BeaconProxy($.beacon, abi.encodeCall(IPoolVault.initialize, (address(this), params, $.treasury)))
        );
        IPoolVault(pool).configureExpiry(expiryEnabled);
        $.isPool[pool] = true;
        $.allPools.push(pool);
        emit PoolCreated(pool, params.circuits, params.circuitId, params.targetRaise, params.priceCap, $.treasury);
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert InvalidAddress();
        FactoryStorage storage $ = _factoryStorage();
        emit OperatorChanged($.operator, operator_);
        $.operator = operator_;
    }

    /// @notice Updates the treasury for future pools; existing pool parameters stay fixed.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidAddress();
        FactoryStorage storage $ = _factoryStorage();
        emit TreasuryChanged($.treasury, treasury_);
        $.treasury = treasury_;
    }

    function pauseCreation(bool paused) external onlyOwner {
        _factoryStorage().creationPaused = paused;
        emit CreationPauseChanged(paused);
    }

    function operator() external view returns (address) {
        return _factoryStorage().operator;
    }

    /// @notice Bind one fixed UUPS market proxy through the same 48-hour governance as code upgrades.
    /// Replacing its address could strand existing locks, so later changes upgrade that proxy instead.
    function registerShareMarket(address market) external nonReentrant {
        FactoryStorage storage s = _factoryStorage();
        if (msg.sender != s.timelock) revert Unauthorized();
        _registerShareMarket(s, market);
    }

    function _registerShareMarket(FactoryStorage storage s, address market) private {
        if (s.shareMarket != address(0)) revert ShareMarketAlreadyRegistered();
        if (market.code.length == 0) revert InvalidAddress();
        if (
            IRegisteredShareMarket(market).factory() != address(this)
                || IRegisteredShareMarket(market).timelock() != s.timelock
        ) revert InvalidGovernance();
        s.shareMarket = market;
        emit ShareMarketRegistered(market);
    }

    function shareMarket() external view returns (address) {
        return _factoryStorage().shareMarket;
    }

    function treasury() external view returns (address) {
        return _factoryStorage().treasury;
    }

    function timelock() external view returns (address) {
        return _factoryStorage().timelock;
    }

    function beacon() external view returns (address) {
        return _factoryStorage().beacon;
    }

    function creationPaused() external view returns (bool) {
        return _factoryStorage().creationPaused;
    }

    function isPool(address pool) external view returns (bool) {
        return _factoryStorage().isPool[pool];
    }

    function allPools(uint256 index) external view returns (address) {
        return _factoryStorage().allPools[index];
    }

    function poolCount() external view returns (uint256) {
        return _factoryStorage().allPools.length;
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != _factoryStorage().timelock) revert Unauthorized();
    }

    function _validateParams(IPoolVault.PoolParams calldata params) private view {
        if (params.circuits != TAPEOUT_CIRCUITS && params.circuits != BEHEMOTH_CIRCUITS) {
            revert IPoolVault.WrongCircuit();
        }
        if (params.targetRaise == 0) revert IPoolVault.InvalidParameters();
        if (params.targetRaise % TOTAL_SHARES != 0) revert IPoolVault.FundingTargetNotDivisible();
        if (params.priceCap == 0 || params.priceCap > params.targetRaise) revert IPoolVault.OverPriceCap();
        if (params.fundingDeadline <= block.timestamp || params.purchaseDeadline <= params.fundingDeadline) {
            revert IPoolVault.InvalidParameters();
        }
        if ((params.directSeller == address(0)) != (params.directPrice == 0)) revert IPoolVault.InvalidParameters();
        if (params.directPrice > params.priceCap) revert IPoolVault.OverPriceCap();
    }

    function _factoryStorage() private pure returns (FactoryStorage storage $) {
        bytes32 slot = FACTORY_STORAGE;
        assembly { $.slot := slot }
    }
}
