// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {IShareMarket, IShareMarketFactory, IShareMarketPool} from "./interfaces/IShareMarket.sol";
import {PoolSaleState} from "./PoolSaleState.sol";

interface IReviewedPool {
    function getProposal(uint256 proposalId) external view returns (PoolSaleState.Proposal memory);
    function activeProposalId() external view returns (uint256);
    function nextProposalId() external view returns (uint256);
}

interface IDesignatedSubscriberFactory {
    function designatedSubscriber(address pool) external view returns (address);
}

interface IRegisteredPortfolioFactory {
    function legacyFactory() external view returns (address);
    function isPool(address portfolio) external view returns (bool);
}

interface IReviewedPortfolio {
    function OFFICIAL_FACTORY() external view returns (address);
    function childSaleReview(uint256 proposalId) external view returns (uint8);
    function proposals(uint256 proposalId)
        external
        view
        returns (
            address child,
            uint256 price,
            uint256 referencePrice,
            uint64 referenceAt,
            uint64 endsAt,
            uint16 memberCount,
            uint16 yesMembers,
            uint16 yesShares,
            bool executed
        );
}

interface IAutomaticSaleReferenceAuthority {
    function coreFactory() external view returns (address);
    function gasWallet() external view returns (address);
}

/// @notice BNB orders for integer shares, locked in each seller's PoolVault account.
/// @dev No ERC-20 custody or daily administration. Upgrades require the fixed Factory timelock.
contract ShareMarket is UUPSUpgradeable, ReentrancyGuardUpgradeable, IShareMarket {
    // feeBps is the legacy seller fee. A separate getter marks the upgraded
    // buyer-fee implementation so callers cannot send a buyer fee to an old proxy.
    uint16 public constant feeBps = 100;
    uint16 public constant buyerFeeBps = 100;
    uint256 public constant MINIMUM_UPGRADE_DELAY = 48 hours;
    uint256 public constant ORDER_DURATION = 7 days;
    // With 1% fees rounded down per fill, this floor keeps both fees nonzero.
    uint256 private constant MIN_PRICE_PER_UNIT = 0.00001 ether;

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
        mapping(address => SaleReference) saleReferences;
        mapping(address => mapping(uint256 => SaleReview)) saleReviews;
    }

    /// @custom:storage-location erc7201:tapeout.storage.ShareMarket.BudgetFactories
    struct BudgetFactoryStorage {
        mapping(address => bool) trusted;
        bool bootstrapComplete;
    }

    struct SaleReference {
        uint128 marketPriceWei;
        uint64 observedAt;
        bytes32 sourceDigest;
    }

    struct SaleReview {
        uint128 priceWei;
        uint8 status;
    }

    error InvalidSaleReference();
    event SaleReferenceUpdated(address indexed pool, uint256 marketPriceWei, uint64 observedAt, bytes32 sourceDigest);
    event SaleReviewed(
        address indexed pool, uint256 indexed proposalId, uint128 priceWei, bool approved, address indexed operator
    );
    event BudgetFactoryTrustChanged(address indexed budgetFactory, bool trusted);

    // keccak256(abi.encode(uint256(keccak256("tapeout.storage.ShareMarket")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MARKET_STORAGE_LOCATION =
        0xdc32f7bcb40b3d9a2ce544bcf40b4e14e3c57b64d5c4c2258289bd394f08cf00;
    // keccak256(abi.encode(uint256(keccak256("tapeout.storage.ShareMarket.BudgetFactories")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant BUDGET_FACTORY_STORAGE_LOCATION =
        0x9d989f24ce882a033d4af40b7a8c18dabf40f7ff64f9daf3687be7c89c33d500;

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
        if (pricePerUnit < MIN_PRICE_PER_UNIT) revert InvalidPrice();
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
        // Historical sub-floor orders remain cancellable/expirable, but cannot
        // trade after the upgrade because their per-fill fees can round to zero.
        if (order.pricePerUnit < MIN_PRICE_PER_UNIT) revert InvalidPrice();
        uint256 gross = amount * order.pricePerUnit;
        // Each side's fee rounds down per fill.
        uint256 sellerFee = gross / 100;
        uint256 buyerFee = gross / 100;
        if (gross > type(uint256).max - buyerFee || msg.value != gross + buyerFee) revert PaymentMismatch();
        address feeRecipient = IShareMarketPool(order.pool).treasury();
        if (feeRecipient == address(0)) revert InvalidAddress();
        order.remaining -= amount;
        if (order.remaining == 0) order.active = false;
        _creditBnb(s, order.seller, gross - sellerFee);
        _creditBnb(s, feeRecipient, sellerFee + buyerFee);
        // The Vault settles old-owner rewards before moving the locked shares.
        // Any state/settlement/holding-limit failure rolls back the whole fill.
        IShareMarketPool(order.pool).transferLocked(order.seller, msg.sender, amount);
        // Keep the legacy OrderFilled topic/meaning so historical indexers can
        // replay old and new fills. The additional buyer fee has its own event.
        emit OrderFilled(orderId, msg.sender, amount, gross, sellerFee);
        emit BuyerFeeCharged(orderId, msg.sender, feeRecipient, buyerFee);
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

    /// @notice Bind the integrated deployment's budget Factory in the same atomic genesis transaction.
    /// @dev The coordinator must be the CREATE nonce-3 creator of this market's
    /// core Factory. Its CREATE nonce-5 budget Factory must already exist and
    /// point back to that core Factory. A separate deployment cannot self-register.
    function bootstrapBudgetFactory() external {
        MarketStorage storage s = _marketStorage();
        BudgetFactoryStorage storage b = _budgetFactoryStorage();
        address predictedCore = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", msg.sender, hex"03")))));
        address budgetFactory = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", msg.sender, hex"05")))));
        if (
            b.bootstrapComplete || predictedCore != s.factory || budgetFactory.code.length == 0
                || IRegisteredPortfolioFactory(budgetFactory).legacyFactory() != s.factory
        ) revert InvalidSaleReference();
        b.bootstrapComplete = true;
        b.trusted[budgetFactory] = true;
        emit BudgetFactoryTrustChanged(budgetFactory, true);
    }

    /// @notice Only the 48-hour Timelock may authorize a registered portfolio factory.
    /// @dev A separate namespace leaves every existing market storage slot unchanged.
    function setBudgetFactoryTrust(address budgetFactory, bool trusted) external {
        MarketStorage storage s = _marketStorage();
        if (msg.sender != s.timelock) revert Unauthorized();
        if (budgetFactory == address(0)) revert InvalidSaleReference();
        if (
            trusted
                && (budgetFactory.code.length == 0
                    || IRegisteredPortfolioFactory(budgetFactory).legacyFactory() != s.factory)
        ) {
            revert InvalidSaleReference();
        }
        _budgetFactoryStorage().trusted[budgetFactory] = trusted;
        emit BudgetFactoryTrustChanged(budgetFactory, trusted);
    }

    function budgetFactoryTrusted(address budgetFactory) external view returns (bool) {
        return _budgetFactoryStorage().trusted[budgetFactory];
    }

    /// @notice This implementation supports a reference-only backend publisher.
    function automaticSaleReferenceVersion() external pure returns (uint256) {
        return 1;
    }

    /// @notice The existing authority's gas wallet can only publish Firsto references.
    /// @dev A gas-wallet or operator rotation takes effect immediately. An EOA
    /// operator or another factory's authority enables no automatic publisher.
    function saleReferencePublisher() public view returns (address) {
        address boundFactory = _marketStorage().factory;
        address authority = IShareMarketFactory(boundFactory).operator();
        if (authority.code.length == 0) return address(0);
        try IAutomaticSaleReferenceAuthority(authority).coreFactory() returns (address coreFactory) {
            if (coreFactory != boundFactory) return address(0);
        } catch {
            return address(0);
        }
        try IAutomaticSaleReferenceAuthority(authority).gasWallet() returns (address publisher) {
            return publisher;
        } catch {
            return address(0);
        }
    }

    /// @notice Publishes a backend Firsto reference without an administrator signature.
    /// @dev This entry grants no review, acquisition, fee or treasury authority.
    function publishSaleReference(address pool, uint128 marketPriceWei, uint64 observedAt, bytes32 sourceDigest)
        external
    {
        if (msg.sender != saleReferencePublisher()) revert Unauthorized();
        MarketStorage storage s = _marketStorage();
        if (observedAt < s.saleReferences[pool].observedAt) revert InvalidSaleReference();
        _setSaleReference(s, pool, marketPriceWei, observedAt, sourceDigest);
    }

    /// @notice Operator attests Firsto reference daily price × verified daily BEM for one miner.
    /// @dev The digest identifies evidence, but BSC cannot independently verify a website API.
    function setSaleReference(address pool, uint128 marketPriceWei, uint64 observedAt, bytes32 sourceDigest) external {
        MarketStorage storage s = _marketStorage();
        if (msg.sender != IShareMarketFactory(s.factory).operator()) revert Unauthorized();
        _setSaleReference(s, pool, marketPriceWei, observedAt, sourceDigest);
    }

    function _setSaleReference(
        MarketStorage storage s,
        address pool,
        uint128 marketPriceWei,
        uint64 observedAt,
        bytes32 sourceDigest
    ) private {
        if (
            !IShareMarketFactory(s.factory).isPool(pool) || marketPriceWei == 0 || sourceDigest == bytes32(0)
                || observedAt > block.timestamp || block.timestamp - observedAt > 5 minutes
        ) revert InvalidSaleReference();
        s.saleReferences[pool] = SaleReference(marketPriceWei, observedAt, sourceDigest);
        emit SaleReferenceUpdated(pool, marketPriceWei, observedAt, sourceDigest);
    }

    function saleReference(address pool)
        external
        view
        returns (uint128 marketPriceWei, uint64 observedAt, bytes32 sourceDigest)
    {
        SaleReference storage quote = _marketStorage().saleReferences[pool];
        return (quote.marketPriceWei, quote.observedAt, quote.sourceDigest);
    }

    /// @notice Records human review for the price bound to a current sale proposal.
    /// @dev The vault implementation defines the discount that requires review.
    /// @dev Rejection is final only for an existing, current proposal. Neither
    /// approval nor rejection may reserve a future proposal ID.
    function reviewSale(address pool, uint256 proposalId, uint128 priceWei, bool approved) external {
        MarketStorage storage s = _marketStorage();
        if (msg.sender != IShareMarketFactory(s.factory).operator()) revert Unauthorized();
        if (
            !IShareMarketFactory(s.factory).isPool(pool) || proposalId == 0 || priceWei == 0
                || s.saleReviews[pool][proposalId].status == 2
        ) {
            revert InvalidSaleReference();
        }
        _requireCurrentProposal(pool, proposalId, priceWei);
        s.saleReviews[pool][proposalId] = SaleReview(priceWei, approved ? 1 : 2);
        emit SaleReviewed(pool, proposalId, priceWei, approved, msg.sender);
    }

    /// @notice A registered budget project carries its one signed project review into
    /// the child's newly created proposal in the same execution transaction.
    function approveBudgetChildSale(address pool, uint256 proposalId, uint256 projectProposalId) external {
        MarketStorage storage s = _marketStorage();
        if (
            !IShareMarketFactory(s.factory).isPool(pool)
                || IDesignatedSubscriberFactory(s.factory).designatedSubscriber(pool) != msg.sender
                || s.saleReviews[pool][proposalId].status == 2
        ) revert InvalidSaleReference();
        if (msg.sender.code.length == 0) revert InvalidSaleReference();
        address budgetFactory = IReviewedPortfolio(msg.sender).OFFICIAL_FACTORY();
        if (
            !_budgetFactoryStorage().trusted[budgetFactory]
                || !IRegisteredPortfolioFactory(budgetFactory).isPool(msg.sender)
                || IRegisteredPortfolioFactory(budgetFactory).legacyFactory() != s.factory
                || IReviewedPortfolio(msg.sender).childSaleReview(projectProposalId) != 1
        ) revert InvalidSaleReference();
        // The review and child proposal bind the price; intermediate vote snapshots
        // are intentionally irrelevant to this exact child/price/execution check.
        // slither-disable-next-line unused-return
        (address child, uint256 price,,,,,,, bool executed) =
            IReviewedPortfolio(msg.sender).proposals(projectProposalId);
        if (child != pool || !executed || price == 0 || price > type(uint128).max) revert InvalidSaleReference();
        _requireCurrentProposal(pool, proposalId, uint128(price));
        s.saleReviews[pool][proposalId] = SaleReview(uint128(price), 1);
        emit SaleReviewed(pool, proposalId, uint128(price), true, msg.sender);
    }

    function _requireCurrentProposal(address pool, uint256 proposalId, uint128 priceWei) private view {
        if (IShareMarketPool(pool).state() != IPoolVault.State.Active) revert InvalidSaleReference();
        IReviewedPool reviewedPool = IReviewedPool(pool);
        uint256 activeId = reviewedPool.activeProposalId();
        if (proposalId == 0 || proposalId >= reviewedPool.nextProposalId() || activeId == 0 || proposalId < activeId) {
            revert InvalidSaleReference();
        }
        PoolSaleState.Proposal memory proposal = reviewedPool.getProposal(proposalId);
        PoolSaleState.Proposal memory opener = reviewedPool.getProposal(activeId);
        if (
            proposal.price != priceWei || proposal.executed || opener.executed || block.timestamp >= proposal.endsAt
                || proposal.snapshotTs != opener.snapshotTs || proposal.endsAt != opener.endsAt
        ) revert InvalidSaleReference();
    }

    function saleReview(address pool, uint256 proposalId) external view returns (uint8 status, uint128 priceWei) {
        SaleReview storage review = _marketStorage().saleReviews[pool][proposalId];
        return (review.status, review.priceWei);
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
        // The pool has exactly 100 integer shares. Available balance and order
        // remainder checks determine how many of them can actually be traded.
        if (amount == 0 || amount > 100) revert InvalidAmount();
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

    function _budgetFactoryStorage() private pure returns (BudgetFactoryStorage storage s) {
        assembly {
            s.slot := BUDGET_FACTORY_STORAGE_LOCATION
        }
    }
}
