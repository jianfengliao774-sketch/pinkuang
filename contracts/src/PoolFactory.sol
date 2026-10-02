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
import {IPoolMachineRegistry} from "./interfaces/IPoolMachineRegistry.sol";
import {PurchaseValidation} from "./libraries/PurchaseValidation.sol";

interface IRegisteredShareMarket {
    function factory() external view returns (address);
    function timelock() external view returns (address);
}

interface IRegisteredMachinePool {
    function factory() external view returns (address);
    function state() external view returns (IPoolVault.State);
    function params() external view returns (IPoolVault.PoolParams memory);
    // Only the first two static return words are needed; the immutable configuration follows them in the Vault ABI.
    function flexiblePurchase() external view returns (bool enabled, uint256 referenceCircuitId);
}

/// @notice Creates independently funded BNB pools. Daily administration and upgrade authority are separate.
contract PoolFactory is
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    IPoolFactoryRoles,
    IPoolMachineRegistry
{
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

    /// @custom:storage-location erc7201:tapeout.storage.MachineRegistry
    struct MachineRegistryStorage {
        mapping(bytes32 => address) reservedPool;
        uint256 cursor;
        uint256 cutoff;
        bool initialized;
        bool ready;
        mapping(address => address) subscriber;
    }

    bytes32 private constant MACHINE_REGISTRY_STORAGE =
        0x60e70afb8561fb6d429dcda00c251d00b381c8125601af08d424ce9f2b4cc800;

    error InvalidAddress();
    error InvalidGovernance();
    error Unauthorized();
    error CreationPaused();
    error ShareMarketAlreadyRegistered();
    error ReferenceMinerChanged();
    error MachineRegistryNotReady();
    error MachineRegistryAlreadyInitialized();
    error MachineAlreadyReserved(address circuits, uint256 circuitId, address pool);
    error InvalidMigrationBatch();

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
    event MachineReserved(address indexed circuits, uint256 indexed circuitId, address indexed pool);
    event MachineRegistryMigrationStarted(uint256 cutoff);
    event MachineRegistryMigrationProgress(uint256 cursor, uint256 cutoff, bool ready);

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
        // Fresh deployments have no historical pools. Upgraded factories default to not ready instead.
        MachineRegistryStorage storage registry = _machineRegistry();
        registry.initialized = true;
        registry.ready = true;
        _ensureLens($);
    }

    function createPool(IPoolVault.PoolParams calldata params) external nonReentrant returns (address pool) {
        return _createPool(params, true);
    }

    /// @notice Reserve a child miner while allowing only its budget project to subscribe.
    function createBudgetChildPool(IPoolVault.PoolParams calldata params, address subscriber)
        external
        nonReentrant
        returns (address pool)
    {
        if (subscriber == address(0)) revert InvalidAddress();
        pool = _createPool(params, true);
        _machineRegistry().subscriber[pool] = subscriber;
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
        _requireMachineRegistryReady();
        address existing = machinePool(params.circuits, params.circuitId);
        if (existing != address(0)) revert MachineAlreadyReserved(params.circuits, params.circuitId, existing);
        pool = address(
            new BeaconProxy($.beacon, abi.encodeCall(IPoolVault.initialize, (address(this), params, $.treasury)))
        );
        _reserveMachine(params.circuits, params.circuitId, pool);
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

    /// @notice Capability for creating another project after a completed machine sale.
    function soldMachineReuseVersion() external pure returns (uint8) {
        return 1;
    }

    /// @notice One live project per machine. Completed sales release custody without erasing the old pool.
    /// @dev A closed pool that still owns the NFT remains reserved; refunds never release this reservation.
    function machinePool(address circuits, uint256 circuitId) public view returns (address pool) {
        pool = _machineRegistry().reservedPool[keccak256(abi.encode(circuits, circuitId))];
        return PurchaseValidation.liveMachineReservation(circuits, circuitId, pool);
    }

    function designatedSubscriber(address pool) external view returns (address) {
        return _machineRegistry().subscriber[pool];
    }

    function machineRegistryStatus()
        external
        view
        returns (bool initialized, bool ready, uint256 cursor, uint256 cutoff)
    {
        MachineRegistryStorage storage s = _machineRegistry();
        return (s.initialized, s.ready, s.cursor, s.cutoff);
    }

    /// @notice Registered Funded pools reserve an acquired alternative atomically with their guarded purchase.
    /// @dev The fixed Vault implementation enforces selection quality and price before calling this entry.
    function claimMachine(address circuits, uint256 circuitId) external nonReentrant {
        _requireMachineRegistryReady();
        IPoolVault.PoolParams memory p = _registeredPoolParams(msg.sender);
        if (IRegisteredMachinePool(msg.sender).state() != IPoolVault.State.Funded) revert Unauthorized();
        if (p.circuits != circuits || machinePool(p.circuits, p.circuitId) != msg.sender) revert Unauthorized();
        _reserveMachine(circuits, circuitId, msg.sender);
    }

    /// @notice Include this call with Factory and Beacon upgrades in one timelock batch.
    /// Existing registries cannot be cleared or reinitialized, including by the timelock.
    function beginMachineRegistryMigration() external virtual {
        if (msg.sender != _factoryStorage().timelock) revert Unauthorized();
        MachineRegistryStorage storage s = _machineRegistry();
        if (s.initialized) revert MachineRegistryAlreadyInitialized();
        s.initialized = true;
        s.cutoff = _factoryStorage().allPools.length;
        s.ready = s.cutoff == 0;
        emit MachineRegistryMigrationStarted(s.cutoff);
        emit MachineRegistryMigrationProgress(0, s.cutoff, s.ready);
    }

    /// @notice Bounded, permissionless backfill from the factory's own registry; no caller-provided pool list.
    /// Conflicting historical pools revert with the exact occupied key and cannot silently overwrite it.
    function migrateMachineRegistry(uint256 maxPools) external virtual nonReentrant {
        MachineRegistryStorage storage s = _machineRegistry();
        if (!s.initialized) revert MachineRegistryNotReady();
        if (maxPools == 0 || maxPools > 64) revert InvalidMigrationBatch();
        if (s.ready) return;
        FactoryStorage storage f = _factoryStorage();
        if (f.allPools.length != s.cutoff) revert MachineRegistryNotReady();
        uint256 end = s.cursor + maxPools;
        if (end > s.cutoff) end = s.cutoff;
        while (s.cursor < end) {
            address pool = f.allPools[s.cursor];
            IPoolVault.PoolParams memory p = _registeredPoolParams(pool);
            if (p.circuits != TAPEOUT_CIRCUITS && p.circuits != BEHEMOTH_CIRCUITS) revert IPoolVault.WrongCircuit();
            _reserveMachine(p.circuits, p.circuitId, pool);
            (bool enabled, uint256 referenceId) = IRegisteredMachinePool(pool).flexiblePurchase();
            if (enabled) _reserveMachine(p.circuits, referenceId, pool);
            // cursor < end <= cutoff, so this increment cannot wrap.
            unchecked {
                ++s.cursor;
            }
        }
        s.ready = s.cursor == s.cutoff;
        emit MachineRegistryMigrationProgress(s.cursor, s.cutoff, s.ready);
    }

    function _reserveMachine(address circuits, uint256 circuitId, address pool) private {
        _beforeReserveMachine(circuits, circuitId);
        bytes32 key = keccak256(abi.encode(circuits, circuitId));
        MachineRegistryStorage storage s = _machineRegistry();
        address existing = s.reservedPool[key];
        if (existing == pool) return;
        if (existing != address(0) && machinePool(circuits, circuitId) != address(0)) {
            revert MachineAlreadyReserved(circuits, circuitId, existing);
        }
        s.reservedPool[key] = pool;
        emit MachineReserved(circuits, circuitId, pool);
    }

    function _beforeReserveMachine(address, uint256) internal view virtual {}

    function _registeredPoolParams(address pool) private view returns (IPoolVault.PoolParams memory) {
        if (!_factoryStorage().isPool[pool]) {
            revert Unauthorized();
        }
        return IRegisteredMachinePool(pool).params();
    }

    function _requireMachineRegistryReady() private view {
        if (!_machineRegistry().ready) revert MachineRegistryNotReady();
    }

    function _machineRegistry() private pure returns (MachineRegistryStorage storage s) {
        bytes32 slot = MACHINE_REGISTRY_STORAGE;
        assembly { s.slot := slot }
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != _factoryStorage().timelock) revert Unauthorized();
    }

    function _validateParams(IPoolVault.PoolParams calldata params) private view {
        PurchaseValidation.validatePoolParams(params, TAPEOUT_CIRCUITS, BEHEMOTH_CIRCUITS, TOTAL_SHARES);
    }

    function _factoryStorage() private pure returns (FactoryStorage storage $) {
        bytes32 slot = FACTORY_STORAGE;
        assembly { $.slot := slot }
    }
}
