// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

interface IAuthorityCoreOperations {
    function createPool(IPoolVault.PoolParams calldata params) external returns (address);
    function createPoolWithExpiry(IPoolVault.PoolParams calldata params, bool enabled) external returns (address);
    function createBudgetChildPool(IPoolVault.PoolParams calldata params, address subscriber) external returns (address);
    function createFlexiblePool(
        IPoolVault.PoolParams calldata params,
        IPoolVault.FlexiblePurchaseConfig calldata config
    ) external returns (address);
    function createFlexiblePoolChecked(
        IPoolVault.PoolParams calldata params,
        IPoolVault.FlexiblePurchaseConfig calldata config,
        uint32 taskId,
        uint128 weight
    ) external returns (address);
}

interface IAuthorityBudgetOperations {
    function createPortfolio(
        uint256 budget,
        uint256 absoluteCap,
        uint256 unitCap,
        uint64 fundingEnd,
        uint64 purchaseEnd
    ) external returns (address);
}

interface IAuthorityFactory {
    function timelock() external view returns (address);
    function shareMarket() external view returns (address);
    function isPool(address pool) external view returns (bool);
}

interface IAuthorityMarket {
    function reviewSale(address pool, uint256 proposalId, uint128 priceWei, bool approved) external;
    function setSaleReference(address pool, uint128 priceWei, uint64 observedAt, bytes32 digest) external;
    function bnbOwed(address account) external view returns (uint256);
    function withdrawBnb() external;
}

interface IAuthorityPool {
    function reviewChildSale(uint256 proposalId, bool approved) external;
    function treasury() external view returns (address);
    function bnbOwed(address account) external view returns (uint256);
    function withdrawBnb() external;
}

interface IAuthorityBudgetPool {
    function spentWei() external view returns (uint256);
    function buyOfficial(address child, uint256 listingId) external;
    function buyFirsto(address child, bytes calldata encodedOrder) external;
}

/// @notice Timelock-owned operator and fee recipient for both BEMine factories.
/// @dev The relayer pays gas but cannot approve a discounted sale or redirect fees without an admin signature.
contract PlatformAuthority is Ownable, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct PoolOperation {
        bytes32 operationHash;
        IPoolVault.PoolParams params;
        bool expiryEnabled;
        address subscriber;
        IPoolVault.FlexiblePurchaseConfig config;
        uint32 expectedTaskId;
        uint128 expectedReferenceWeight;
    }

    bytes32 public constant REVIEW_SALE_TYPEHASH = keccak256(
        "ReviewSale(address market,address pool,uint256 proposalId,uint128 priceWei,bool approved,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant REVIEW_CHILD_SALE_TYPEHASH =
        keccak256("ReviewChildSale(address portfolio,uint256 proposalId,bool approved,uint256 nonce,uint256 deadline)");
    bytes32 public constant SALE_REFERENCE_TYPEHASH = keccak256(
        "SaleReference(address market,address pool,uint128 priceWei,uint64 observedAt,bytes32 digest,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant CLAIM_FEES_TYPEHASH =
        keccak256("ClaimFees(address[] markets,address[] pools,address recipient,uint256 nonce,uint256 deadline)");
    bytes32 public constant BUY_BUDGET_OFFICIAL_TYPEHASH = keccak256(
        "BuyBudgetOfficial(address portfolio,address child,uint256 listingId,uint256 maxCost,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant BUY_BUDGET_FIRSTO_TYPEHASH = keccak256(
        "BuyBudgetFirsto(address portfolio,address child,bytes32 orderHash,uint256 maxCost,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant POOL_PARAMS_TYPEHASH = keccak256(
        "PoolParams(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline)"
    );
    bytes32 public constant FLEXIBLE_CONFIG_TYPEHASH = keccak256(
        "FlexibleConfig(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)"
    );
    bytes32 public constant CREATE_POOL_TYPEHASH = keccak256(
        "CreatePool(address factory,string operation,PoolParams params,bool expiryEnabled,address subscriber,FlexibleConfig config,uint32 expectedTaskId,uint128 expectedReferenceWeight,uint256 nonce,uint256 deadline)FlexibleConfig(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)PoolParams(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline)"
    );
    bytes32 public constant CREATE_PORTFOLIO_TYPEHASH = keccak256(
        "CreatePortfolio(address factory,uint256 budgetWei,uint256 absoluteCapWei,uint256 unitCapWei,uint64 fundingDeadline,uint64 purchaseDeadline,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant DEPOSIT_PAUSE_TYPEHASH =
        keccak256("DepositPause(address pool,bool paused,uint256 nonce,uint256 deadline)");
    bytes32 public constant RECLAIM_TYPEHASH =
        keccak256("Reclaim(address pool,bytes32 workId,uint256 nonce,uint256 deadline)");
    bytes32 public constant REVIEW_SALE = keccak256("REVIEW_SALE");
    bytes32 public constant REVIEW_CHILD_SALE = keccak256("REVIEW_CHILD_SALE");
    bytes32 public constant SALE_REFERENCE = keccak256("SALE_REFERENCE");
    bytes32 public constant CLAIM_FEES = keccak256("CLAIM_FEES");
    bytes32 public constant APPROVED_OPERATION = keccak256("APPROVED_OPERATION");
    bytes32 public constant BUY_BUDGET_OFFICIAL = keccak256("BUY_BUDGET_OFFICIAL");
    bytes32 public constant BUY_BUDGET_FIRSTO = keccak256("BUY_BUDGET_FIRSTO");
    address public constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;

    address public immutable coreFactory;
    address public immutable budgetFactory;
    address public administratorOne;
    address public administratorTwo;
    address public gasWallet;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => bool) public reviewFinalized;
    mapping(address => bool) public retiredAdministrators;

    error Unauthorized();
    error InvalidAddress();
    error InvalidTarget();
    error InvalidAction();
    error InvalidSignature();
    error TransferFailed();
    error OverMaxCost();

    event AdministratorsChanged(address indexed first, address indexed second);
    event GasWalletChanged(address indexed previous, address indexed next);
    event AdminAction(address indexed administrator, bytes32 indexed kind, address indexed target, uint256 nonce);
    event FeesClaimed(address indexed administrator, uint256 bnbAmount, uint256 bemAmount);
    event NonceInvalidated(address indexed administrator, uint256 previous, uint256 next);

    constructor(address coreFactory_, address budgetFactory_, address first, address second, address gasWallet_)
        Ownable(IAuthorityFactory(coreFactory_).timelock())
        EIP712("BEMine Platform Authority", "1")
    {
        if (coreFactory_.code.length == 0 || budgetFactory_.code.length == 0) revert InvalidAddress();
        if (
            IAuthorityFactory(coreFactory_).timelock() == address(0)
                || IAuthorityFactory(coreFactory_).timelock() != IAuthorityFactory(budgetFactory_).timelock()
        ) revert InvalidAddress();
        coreFactory = coreFactory_;
        budgetFactory = budgetFactory_;
        _setAdministrators(first, second);
        _setGasWallet(gasWallet_);
    }

    receive() external payable {}

    function setAdministrators(address first, address second) external onlyOwner {
        _setAdministrators(first, second);
    }

    function setGasWallet(address next) external onlyOwner {
        _setGasWallet(next);
    }

    function _setAdministrators(address first, address second) private {
        if (
            first == address(0) || second == address(0) || first == second || first == gasWallet || second == gasWallet
                || retiredAdministrators[first] || retiredAdministrators[second]
        ) {
            revert InvalidAddress();
        }
        address previousFirst = administratorOne;
        address previousSecond = administratorTwo;
        // A removed signer can have unexpired signatures at arbitrary future nonces.
        // Retiring the address prevents those signatures from reviving on reappointment.
        if (previousFirst != address(0) && previousFirst != first && previousFirst != second) {
            retiredAdministrators[previousFirst] = true;
        }
        if (previousSecond != address(0) && previousSecond != first && previousSecond != second) {
            retiredAdministrators[previousSecond] = true;
        }
        administratorOne = first;
        administratorTwo = second;
        emit AdministratorsChanged(first, second);
    }

    function _setGasWallet(address next) private {
        if (next == address(0) || next == administratorOne || next == administratorTwo) revert InvalidAddress();
        emit GasWalletChanged(gasWallet, next);
        gasWallet = next;
    }

    function reviewSale(
        address market,
        address pool,
        uint256 proposalId,
        uint128 priceWei,
        bool approved,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (market != IAuthorityFactory(coreFactory).shareMarket() || !IAuthorityFactory(coreFactory).isPool(pool)) {
            revert InvalidTarget();
        }
        // A mistaken approval price may be corrected before execution. A later
        // rejection remains final in ShareMarket, regardless of who approved.
        bytes32 reviewKey = keccak256(abi.encode(REVIEW_SALE, market, pool, proposalId, priceWei, approved));
        if (reviewFinalized[reviewKey]) revert InvalidAction();
        _authorize(
            REVIEW_SALE,
            market,
            keccak256(abi.encode(REVIEW_SALE_TYPEHASH, market, pool, proposalId, priceWei, approved, nonce, deadline)),
            nonce,
            deadline,
            signature
        );
        reviewFinalized[reviewKey] = true;
        IAuthorityMarket(market).reviewSale(pool, proposalId, priceWei, approved);
    }

    function reviewChildSale(
        address portfolio,
        uint256 proposalId,
        bool approved,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (!IAuthorityFactory(budgetFactory).isPool(portfolio)) revert InvalidTarget();
        bytes32 reviewKey = keccak256(abi.encode(REVIEW_CHILD_SALE, portfolio, proposalId, approved));
        if (reviewFinalized[reviewKey]) revert InvalidAction();
        _authorize(
            REVIEW_CHILD_SALE,
            portfolio,
            keccak256(abi.encode(REVIEW_CHILD_SALE_TYPEHASH, portfolio, proposalId, approved, nonce, deadline)),
            nonce,
            deadline,
            signature
        );
        reviewFinalized[reviewKey] = true;
        IAuthorityPool(portfolio).reviewChildSale(proposalId, approved);
    }

    function setSaleReference(
        address market,
        address pool,
        uint128 priceWei,
        uint64 observedAt,
        bytes32 digest,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (market != IAuthorityFactory(coreFactory).shareMarket() || !IAuthorityFactory(coreFactory).isPool(pool)) {
            revert InvalidTarget();
        }
        _authorize(
            SALE_REFERENCE,
            market,
            keccak256(abi.encode(SALE_REFERENCE_TYPEHASH, market, pool, priceWei, observedAt, digest, nonce, deadline)),
            nonce,
            deadline,
            signature
        );
        IAuthorityMarket(market).setSaleReference(pool, priceWei, observedAt, digest);
    }

    /// @notice Routine mining calls may be relayed without an admin signature.
    function executeOperation(address target, bytes calldata data) external nonReentrant returns (bytes memory result) {
        if (msg.sender != gasWallet) revert Unauthorized();
        if (data.length < 4) revert InvalidAction();
        bytes4 selector = bytes4(data[:4]);
        if (!IAuthorityFactory(coreFactory).isPool(target) || selector != bytes4(keccak256("mine(bytes)"))) {
            revert InvalidAction();
        }
        // Reclaim stops mining. It must be signed by an administrator below;
        // the hot Gas key alone may only arm or start a miner.
        if (_miningSelector(data) == bytes4(keccak256("reclaim(bytes32)"))) revert InvalidAction();
        return _callTarget(target, data);
    }

    /// @notice A signed exact calldata payload is required for project/child creation, a deposit pause, or reclaim.
    function executeApprovedOperation(
        address target,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant returns (bytes memory result) {
        if (data.length < 4) revert InvalidAction();
        bytes4 selector = bytes4(data[:4]);
        bool allowed = false;
        if (target == coreFactory) {
            allowed = selector == IAuthorityCoreOperations.createPool.selector
                || selector == IAuthorityCoreOperations.createPoolWithExpiry.selector
                || selector == IAuthorityCoreOperations.createBudgetChildPool.selector
                || selector == IAuthorityCoreOperations.createFlexiblePool.selector
                || selector == IAuthorityCoreOperations.createFlexiblePoolChecked.selector;
        } else if (target == budgetFactory) {
            allowed = selector == IAuthorityBudgetOperations.createPortfolio.selector;
        } else if (IAuthorityFactory(coreFactory).isPool(target)) {
            allowed = selector == bytes4(keccak256("setDepositPaused(bool)"))
                || selector == bytes4(keccak256("mine(bytes)"))
                && _miningSelector(data) == bytes4(keccak256("reclaim(bytes32)"));
        }
        if (!allowed) revert InvalidAction();
        _authorize(
            APPROVED_OPERATION,
            target,
            _approvedOperationHash(target, data, nonce, deadline),
            nonce,
            deadline,
            signature
        );
        return _callTarget(target, data);
    }

    /// @notice The gas wallet can pay for a budget purchase only within one signed exact listing and cost ceiling.
    function buyBudgetOfficial(
        address portfolio,
        address child,
        uint256 listingId,
        uint256 maxCost,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant returns (uint256 cost) {
        if (!IAuthorityFactory(budgetFactory).isPool(portfolio) || maxCost == 0) revert InvalidTarget();
        _authorize(
            BUY_BUDGET_OFFICIAL,
            portfolio,
            keccak256(abi.encode(BUY_BUDGET_OFFICIAL_TYPEHASH, portfolio, child, listingId, maxCost, nonce, deadline)),
            nonce,
            deadline,
            signature
        );
        IAuthorityBudgetPool project = IAuthorityBudgetPool(portfolio);
        uint256 spentBefore = project.spentWei();
        project.buyOfficial(child, listingId);
        cost = project.spentWei() - spentBefore;
        if (cost == 0 || cost > maxCost) revert OverMaxCost();
    }

    /// @notice The signed order hash binds all Firsto fields, while maxCost limits actual on-chain spend.
    function buyBudgetFirsto(
        address portfolio,
        address child,
        bytes calldata encodedOrder,
        uint256 maxCost,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant returns (uint256 cost) {
        if (!IAuthorityFactory(budgetFactory).isPool(portfolio) || maxCost == 0 || encodedOrder.length == 0) {
            revert InvalidTarget();
        }
        _authorize(
            BUY_BUDGET_FIRSTO,
            portfolio,
            keccak256(
                abi.encode(
                    BUY_BUDGET_FIRSTO_TYPEHASH, portfolio, child, keccak256(encodedOrder), maxCost, nonce, deadline
                )
            ),
            nonce,
            deadline,
            signature
        );
        IAuthorityBudgetPool project = IAuthorityBudgetPool(portfolio);
        uint256 spentBefore = project.spentWei();
        project.buyFirsto(child, encodedOrder);
        cost = project.spentWei() - spentBefore;
        if (cost == 0 || cost > maxCost) revert OverMaxCost();
    }

    /// @notice An administrator can revoke all of their outstanding signatures without the gas wallet.
    function invalidateNonce(uint256 next) external {
        if (msg.sender != administratorOne && msg.sender != administratorTwo) revert Unauthorized();
        uint256 previous = nonces[msg.sender];
        // Do not let one erroneous maximum-value entry permanently exhaust
        // this administrator's nonce space.
        if (next <= previous || next == type(uint256).max || next - previous > type(uint64).max) {
            revert InvalidAction();
        }
        nonces[msg.sender] = next;
        emit NonceInvalidated(msg.sender, previous, next);
    }

    function _callTarget(address target, bytes calldata data) private returns (bytes memory result) {
        (bool success, bytes memory response) = target.call(data);
        if (!success) assembly { revert(add(response, 32), mload(response)) }
        return response;
    }

    function _miningSelector(bytes calldata data) private pure returns (bytes4 selector) {
        bytes memory inner = abi.decode(data[4:], (bytes));
        if (inner.length < 4) revert InvalidAction();
        assembly { selector := mload(add(inner, 32)) }
    }

    function _approvedOperationHash(address target, bytes calldata data, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        bytes4 selector = bytes4(data[:4]);
        if (target == budgetFactory) {
            (uint256 budgetWei, uint256 absoluteCapWei, uint256 unitCapWei, uint64 fundingEnd, uint64 purchaseEnd) =
                abi.decode(data[4:], (uint256, uint256, uint256, uint64, uint64));
            if (
                keccak256(data)
                    != keccak256(
                        abi.encodeWithSelector(selector, budgetWei, absoluteCapWei, unitCapWei, fundingEnd, purchaseEnd)
                    )
            ) revert InvalidAction();
            return keccak256(
                abi.encode(
                    CREATE_PORTFOLIO_TYPEHASH,
                    target,
                    budgetWei,
                    absoluteCapWei,
                    unitCapWei,
                    fundingEnd,
                    purchaseEnd,
                    nonce,
                    deadline
                )
            );
        }
        if (target != coreFactory) {
            if (selector == bytes4(keccak256("setDepositPaused(bool)"))) {
                bool paused = abi.decode(data[4:], (bool));
                if (keccak256(data) != keccak256(abi.encodeWithSelector(selector, paused))) revert InvalidAction();
                return keccak256(abi.encode(DEPOSIT_PAUSE_TYPEHASH, target, paused, nonce, deadline));
            }
            bytes memory inner = abi.decode(data[4:], (bytes));
            if (inner.length != 36 || _miningSelector(data) != bytes4(keccak256("reclaim(bytes32)"))) {
                revert InvalidAction();
            }
            bytes32 workId;
            assembly { workId := mload(add(inner, 36)) }
            if (
                keccak256(data)
                    != keccak256(
                        abi.encodeWithSelector(
                            selector, abi.encodeWithSelector(bytes4(keccak256("reclaim(bytes32)")), workId)
                        )
                    )
            ) revert InvalidAction();
            return keccak256(abi.encode(RECLAIM_TYPEHASH, target, workId, nonce, deadline));
        }

        PoolOperation memory op;
        op.expiryEnabled = true;
        if (selector == IAuthorityCoreOperations.createPool.selector) {
            op.operationHash = keccak256("createPool");
            op.params = abi.decode(data[4:], (IPoolVault.PoolParams));
        } else if (selector == IAuthorityCoreOperations.createPoolWithExpiry.selector) {
            op.operationHash = keccak256("createPoolWithExpiry");
            (op.params, op.expiryEnabled) = abi.decode(data[4:], (IPoolVault.PoolParams, bool));
        } else if (selector == IAuthorityCoreOperations.createBudgetChildPool.selector) {
            op.operationHash = keccak256("createBudgetChildPool");
            (op.params, op.subscriber) = abi.decode(data[4:], (IPoolVault.PoolParams, address));
        } else if (selector == IAuthorityCoreOperations.createFlexiblePool.selector) {
            op.operationHash = keccak256("createFlexiblePool");
            (op.params, op.config) = abi.decode(data[4:], (IPoolVault.PoolParams, IPoolVault.FlexiblePurchaseConfig));
        } else if (selector == IAuthorityCoreOperations.createFlexiblePoolChecked.selector) {
            op.operationHash = keccak256("createFlexiblePoolChecked");
            (op.params, op.config, op.expectedTaskId, op.expectedReferenceWeight) =
                abi.decode(data[4:], (IPoolVault.PoolParams, IPoolVault.FlexiblePurchaseConfig, uint32, uint128));
        } else {
            revert InvalidAction();
        }
        bytes memory canonical;
        if (selector == IAuthorityCoreOperations.createPool.selector) {
            canonical = abi.encodeWithSelector(selector, op.params);
        } else if (selector == IAuthorityCoreOperations.createPoolWithExpiry.selector) {
            canonical = abi.encodeWithSelector(selector, op.params, op.expiryEnabled);
        } else if (selector == IAuthorityCoreOperations.createBudgetChildPool.selector) {
            canonical = abi.encodeWithSelector(selector, op.params, op.subscriber);
        } else if (selector == IAuthorityCoreOperations.createFlexiblePool.selector) {
            canonical = abi.encodeWithSelector(selector, op.params, op.config);
        } else {
            canonical =
                abi.encodeWithSelector(selector, op.params, op.config, op.expectedTaskId, op.expectedReferenceWeight);
        }
        if (keccak256(data) != keccak256(canonical)) revert InvalidAction();
        return keccak256(
            abi.encode(
                CREATE_POOL_TYPEHASH,
                target,
                op.operationHash,
                _poolParamsHash(op.params),
                op.expiryEnabled,
                op.subscriber,
                _flexibleConfigHash(op.config),
                op.expectedTaskId,
                op.expectedReferenceWeight,
                nonce,
                deadline
            )
        );
    }

    function _poolParamsHash(IPoolVault.PoolParams memory p) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POOL_PARAMS_TYPEHASH,
                p.circuits,
                p.circuitId,
                p.targetRaise,
                p.priceCap,
                p.directSeller,
                p.directPrice,
                p.fundingDeadline,
                p.purchaseDeadline
            )
        );
    }

    function _flexibleConfigHash(IPoolVault.FlexiblePurchaseConfig memory c) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                FLEXIBLE_CONFIG_TYPEHASH,
                c.minVerifiedWeight,
                c.referencePriceWei,
                c.targetDailyYieldAtomic,
                c.extraBps,
                c.referenceObservedAt,
                c.referenceBlock,
                c.referenceDigest
            )
        );
    }

    /// @notice The first administrator to execute a signed claim receives all fees then available.
    function claimFees(
        address[] calldata markets,
        address[] calldata pools,
        address recipient,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (recipient != administratorOne && recipient != administratorTwo) revert InvalidAddress();
        _authorizeFor(
            CLAIM_FEES,
            address(this),
            keccak256(
                abi.encode(
                    CLAIM_FEES_TYPEHASH,
                    keccak256(abi.encodePacked(markets)),
                    keccak256(abi.encodePacked(pools)),
                    recipient,
                    nonce,
                    deadline
                )
            ),
            recipient,
            nonce,
            deadline,
            signature
        );
        for (uint256 i; i < markets.length; ++i) {
            address market = markets[i];
            if (
                market != IAuthorityFactory(coreFactory).shareMarket()
                    && market != IAuthorityFactory(budgetFactory).shareMarket()
            ) revert InvalidTarget();
            if (IAuthorityMarket(market).bnbOwed(address(this)) != 0) IAuthorityMarket(market).withdrawBnb();
        }
        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            if (
                (!IAuthorityFactory(coreFactory).isPool(pool) && !IAuthorityFactory(budgetFactory).isPool(pool))
                    || IAuthorityPool(pool).treasury() != address(this)
            ) revert InvalidTarget();
            if (IAuthorityPool(pool).bnbOwed(address(this)) != 0) IAuthorityPool(pool).withdrawBnb();
        }
        uint256 bnbAmount = address(this).balance;
        uint256 bemAmount = IERC20(BEM).balanceOf(address(this));
        if (bnbAmount != 0) {
            (bool success,) = recipient.call{value: bnbAmount}("");
            if (!success) revert TransferFailed();
        }
        if (bemAmount != 0) IERC20(BEM).safeTransfer(recipient, bemAmount);
        emit FeesClaimed(recipient, bnbAmount, bemAmount);
    }

    function _authorize(
        bytes32 kind,
        address target,
        bytes32 structHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) private {
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        _authorizeFor(kind, target, structHash, signer, nonce, deadline, signature);
    }

    function _authorizeFor(
        bytes32 kind,
        address target,
        bytes32 structHash,
        address signer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) private {
        if (msg.sender != gasWallet && msg.sender != signer) revert Unauthorized();
        if (block.timestamp > deadline || nonce != nonces[signer]) revert InvalidSignature();
        if (signer != administratorOne && signer != administratorTwo) revert InvalidSignature();
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != signer) {
            revert InvalidSignature();
        }
        nonces[signer] = nonce + 1;
        emit AdminAction(signer, kind, target, nonce);
    }
}
