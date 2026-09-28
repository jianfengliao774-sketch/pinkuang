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

    event AdministratorsChanged(address indexed first, address indexed second);
    event GasWalletChanged(address indexed previous, address indexed next);
    event AdminAction(address indexed administrator, bytes32 indexed kind, address indexed target, uint256 nonce);
    event FeesClaimed(address indexed administrator, uint256 bnbAmount, uint256 bemAmount);

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
        bytes32 reviewKey = keccak256(abi.encode(REVIEW_SALE, market, pool, proposalId));
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
        bytes32 reviewKey = keccak256(abi.encode(REVIEW_CHILD_SALE, portfolio, proposalId));
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

    /// @notice Only routine operator calls may be relayed without an admin signature.
    function executeOperation(address target, bytes calldata data) external nonReentrant returns (bytes memory result) {
        if (msg.sender != gasWallet) revert Unauthorized();
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
            allowed =
                selector == bytes4(keccak256("mine(bytes)")) || selector == bytes4(keccak256("setDepositPaused(bool)"));
        } else if (IAuthorityFactory(budgetFactory).isPool(target)) {
            allowed = selector == bytes4(keccak256("buyOfficial(address,uint256)"))
                || selector == bytes4(keccak256("buyFirsto(address,bytes)"));
        }
        if (!allowed) revert InvalidAction();
        (bool success, bytes memory response) = target.call(data);
        if (!success) assembly { revert(add(response, 32), mload(response)) }
        return response;
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
        if (msg.sender != gasWallet) revert Unauthorized();
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
