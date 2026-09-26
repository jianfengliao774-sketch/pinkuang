// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {IShareMarket, IShareMarketFactory, IShareMarketPool} from "./interfaces/IShareMarket.sol";

/// @notice BNB orders for integer shares, locked in each seller's PoolVault account.
/// @dev No ERC-20 custody or daily administration. Upgrades require the fixed Factory timelock.
contract ShareMarket is UUPSUpgradeable, ReentrancyGuardUpgradeable, IShareMarket {
    uint16 public constant feeBps = 100;
    uint256 public constant MINIMUM_UPGRADE_DELAY = 48 hours;
    uint256 public constant ORDER_DURATION = 7 days;

    /// @custom:storage-location erc7201:tapeout.storage.ShareMarket
    struct MarketStorage {
        address factory;
        address timelock;
        uint256 nextOrderId;
        mapping(uint256 => Order) orders;
        mapping(address => uint256) bnbOwed;
        uint256 totalBnbOwed;
        // Zero-expiry legacy orders can be cancelled but cannot be filled after upgrade.
        mapping(uint256 => uint64) orderExpiries;
    }

    // keccak256(abi.encode(uint256(keccak256("tapeout.storage.ShareMarket")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MARKET_STORAGE_LOCATION =
        0xdc32f7bcb40b3d9a2ce544bcf40b4e14e3c57b64d5c4c2258289bd394f08cf00;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address factory_, address timelock_) external initializer {
        if (factory_.code.length == 0 || timelock_.code.length == 0) revert InvalidAddress();
        if (
            IShareMarketFactory(factory_).timelock() != timelock_
                || TimelockController(payable(timelock_)).getMinDelay() < MINIMUM_UPGRADE_DELAY
        ) revert InvalidGovernance();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        MarketStorage storage s = _marketStorage();
        s.factory = factory_;
        s.timelock = timelock_;
        s.nextOrderId = 1;
    }

    function list(address pool, uint256 amount, uint256 pricePerUnit) external nonReentrant returns (uint256 orderId) {
        _requireAmount(amount);
        MarketStorage storage s = _marketStorage();
        _requireTradablePool(s, pool);
        orderId = s.nextOrderId++;
        s.orders[orderId] = Order(msg.sender, pool, amount, pricePerUnit, true);
        uint64 expiresAt = SafeCast.toUint64(block.timestamp + ORDER_DURATION);
        s.orderExpiries[orderId] = expiresAt;
        // Vault validates the seller's currently unlocked balance. Listing does
        // not transfer tokens, establish allowances, or change beneficial ownership.
        IShareMarketPool(pool).lock(msg.sender, amount);
        emit OrderListed(orderId, msg.sender, pool, amount, pricePerUnit);
        emit OrderExpirySet(orderId, expiresAt);
    }

    function fill(uint256 orderId, uint256 amount) external payable nonReentrant {
        _requireAmount(amount);
        MarketStorage storage s = _marketStorage();
        Order storage order = _activeOrder(s, orderId);
        if (s.orderExpiries[orderId] == 0 || block.timestamp >= s.orderExpiries[orderId]) revert OrderExpired();
        if (amount > order.remaining) revert InvalidAmount();
        _requireTradablePool(s, order.pool);
        uint256 gross = amount * order.pricePerUnit;
        if (msg.value != gross) revert PaymentMismatch();
        // The specification sets no minimum price. Zero-price orders transfer
        // with zero BNB and zero fee. All integer fee rounding stays with seller.
        uint256 fee = gross / 100;
        address feeRecipient = IShareMarketPool(order.pool).treasury();
        if (feeRecipient == address(0)) revert InvalidAddress();
        order.remaining -= amount;
        if (order.remaining == 0) order.active = false;
        _creditBnb(s, order.seller, gross - fee);
        _creditBnb(s, feeRecipient, fee);
        // The Vault settles old-owner rewards before moving the locked shares.
        // Any state/settlement/holding-limit failure rolls back the whole fill.
        IShareMarketPool(order.pool).transferLocked(order.seller, msg.sender, amount);
        emit OrderFilled(orderId, msg.sender, amount, gross, fee);
    }

    function cancel(uint256 orderId) external nonReentrant {
        MarketStorage storage s = _marketStorage();
        Order storage order = _activeOrder(s, orderId);
        if (msg.sender != order.seller) revert Unauthorized();
        _cancel(orderId, order);
    }

    /// @notice Anyone may unlock an expired order; all shares remain with its original seller.
    function expire(uint256 orderId) external nonReentrant {
        MarketStorage storage s = _marketStorage();
        Order storage order = _activeOrder(s, orderId);
        if (s.orderExpiries[orderId] != 0 && block.timestamp < s.orderExpiries[orderId]) revert OrderNotExpired();
        _cancel(orderId, order);
    }

    function _cancel(uint256 orderId, Order storage order) private {
        uint256 remaining = order.remaining;
        order.remaining = 0;
        order.active = false;
        // Unlock changes no balances or voting checkpoints. It remains available
        // in Listed/Closed, where fills and ordinary share transfers are frozen.
        IShareMarketPool(order.pool).unlock(order.seller, remaining);
        emit OrderCancelled(orderId, order.seller, remaining);
    }

    function withdrawBnb() external nonReentrant {
        MarketStorage storage s = _marketStorage();
        uint256 amount = s.bnbOwed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        s.bnbOwed[msg.sender] = 0;
        s.totalBnbOwed -= amount;
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit BnbWithdrawn(msg.sender, amount);
    }

    function factory() external view returns (address) {
        return _marketStorage().factory;
    }

    function timelock() external view returns (address) {
        return _marketStorage().timelock;
    }

    function nextOrderId() external view returns (uint256) {
        return _marketStorage().nextOrderId;
    }

    function orders(uint256 orderId) external view returns (Order memory) {
        return _marketStorage().orders[orderId];
    }

    function orderExpiresAt(uint256 orderId) external view returns (uint64) {
        return _marketStorage().orderExpiries[orderId];
    }

    function bnbOwed(address user) external view returns (uint256) {
        return _marketStorage().bnbOwed[user];
    }

    function totalBnbOwed() external view returns (uint256) {
        return _marketStorage().totalBnbOwed;
    }

    function _requireAmount(uint256 amount) private pure {
        if (amount == 0 || amount > 49) revert InvalidAmount();
    }

    function _requireTradablePool(MarketStorage storage s, address pool) private view {
        IShareMarketFactory registry = IShareMarketFactory(s.factory);
        if (registry.shareMarket() != address(this)) revert MarketNotRegistered();
        if (!registry.isPool(pool) || pool.code.length == 0) revert InvalidPool();
        if (IShareMarketPool(pool).state() != IPoolVault.State.Active) revert WrongState();
        if (!IShareMarketPool(pool).shareTradingAllowed()) revert WrongState();
    }

    function _activeOrder(MarketStorage storage s, uint256 orderId) private view returns (Order storage order) {
        order = s.orders[orderId];
        if (!order.active) revert InactiveOrder();
    }

    function _creditBnb(MarketStorage storage s, address user, uint256 amount) private {
        s.bnbOwed[user] += amount;
        s.totalBnbOwed += amount;
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != _marketStorage().timelock) revert Unauthorized();
    }

    function _marketStorage() private pure returns (MarketStorage storage s) {
        assembly {
            s.slot := MARKET_STORAGE_LOCATION
        }
    }
}
