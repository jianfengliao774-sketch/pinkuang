// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPoolVault} from "./IPoolVault.sol";

interface IShareMarket {
    struct Order {
        address seller;
        address pool;
        uint256 remaining;
        uint256 pricePerUnit;
        bool active;
    }

    error InvalidAddress();
    error InvalidGovernance();
    error Unauthorized();
    error MarketNotRegistered();
    error InvalidPool();
    error WrongState();
    error InvalidAmount();
    error InactiveOrder();
    error PaymentMismatch();
    error NothingToClaim();
    error TransferFailed();
    error OrderExpired();
    error OrderNotExpired();

    event OrderListed(
        uint256 indexed orderId, address indexed seller, address indexed pool, uint256 amount, uint256 pricePerUnit
    );
    event OrderFilled(uint256 indexed orderId, address indexed buyer, uint256 amount, uint256 gross, uint256 fee);
    event OrderCancelled(uint256 indexed orderId, address indexed seller, uint256 remaining);
    event BnbWithdrawn(address indexed user, uint256 amount);
    event OrderExpirySet(uint256 indexed orderId, uint64 expiresAt);

    function initialize(address factory_, address timelock_) external;
    function list(address pool, uint256 amount, uint256 pricePerUnit) external returns (uint256 orderId);
    function fill(uint256 orderId, uint256 amount) external payable;
    function cancel(uint256 orderId) external;
    function expire(uint256 orderId) external;
    function withdrawBnb() external;
    function factory() external view returns (address);
    function timelock() external view returns (address);
    function nextOrderId() external view returns (uint256);
    function orders(uint256 orderId) external view returns (Order memory);
    function orderExpiresAt(uint256 orderId) external view returns (uint64);
    function bnbOwed(address user) external view returns (uint256);
    function totalBnbOwed() external view returns (uint256);
}

interface IShareMarketFactory {
    function timelock() external view returns (address);
    function shareMarket() external view returns (address);
    function isPool(address pool) external view returns (bool);
}

interface IShareMarketPool {
    function state() external view returns (IPoolVault.State);
    function shareTradingAllowed() external view returns (bool);
    function treasury() external view returns (address);
    function lock(address seller, uint256 amount) external;
    function unlock(address seller, uint256 amount) external;
    function transferLocked(address seller, address buyer, uint256 amount) external;
}
