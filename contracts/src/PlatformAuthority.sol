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

    bytes32 public constant ACTION_TYPEHASH =
        keccak256("Action(bytes32 kind,address target,bytes32 paramsHash,uint256 nonce,uint256 deadline)");
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
        if (first == address(0) || second == address(0) || first == second || first == gasWallet || second == gasWallet)
        {
            revert InvalidAddress();
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
            REVIEW_SALE, market, keccak256(abi.encode(pool, proposalId, priceWei, approved)), nonce, deadline, signature
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
            REVIEW_CHILD_SALE, portfolio, keccak256(abi.encode(proposalId, approved)), nonce, deadline, signature
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
            keccak256(abi.encode(pool, priceWei, observedAt, digest)),
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
        bool allowed;
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
        _authorize(APPROVED_OPERATION, target, keccak256(data), nonce, deadline, signature);
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
            BUY_BUDGET_OFFICIAL, portfolio, keccak256(abi.encode(child, listingId, maxCost)), nonce, deadline, signature
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
            keccak256(abi.encode(child, keccak256(encodedOrder), maxCost)),
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
        if (next <= previous || next - previous > type(uint64).max) revert InvalidAction();
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
            keccak256(abi.encode(markets, pools, recipient)),
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
        bytes32 paramsHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) private {
        address signer = ECDSA.recover(_actionDigest(kind, target, paramsHash, nonce, deadline), signature);
        _authorizeFor(kind, target, paramsHash, signer, nonce, deadline, signature);
    }

    function _authorizeFor(
        bytes32 kind,
        address target,
        bytes32 paramsHash,
        address signer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) private {
        if (msg.sender != gasWallet && msg.sender != signer) revert Unauthorized();
        if (block.timestamp > deadline || nonce != nonces[signer]) revert InvalidSignature();
        if (signer != administratorOne && signer != administratorTwo) revert InvalidSignature();
        if (ECDSA.recover(_actionDigest(kind, target, paramsHash, nonce, deadline), signature) != signer) {
            revert InvalidSignature();
        }
        nonces[signer] = nonce + 1;
        emit AdminAction(signer, kind, target, nonce);
    }

    function _actionDigest(bytes32 kind, address target, bytes32 paramsHash, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(ACTION_TYPEHASH, kind, target, paramsHash, nonce, deadline)));
    }
}
