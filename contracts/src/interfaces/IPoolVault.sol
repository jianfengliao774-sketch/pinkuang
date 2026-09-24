// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IPoolVault {
    enum State {
        Funding,
        Funded,
        Active,
        Listed,
        Closed,
        Refunding
    }

    struct PoolParams {
        address circuits;
        uint256 circuitId;
        uint256 targetRaise;
        uint256 priceCap;
        address directSeller;
        uint256 directPrice;
        uint64 fundingDeadline;
        uint64 purchaseDeadline;
    }

    error WrongState();
    error DeadlinePassed();
    error DeadlineNotReached();
    error ShareOutOfRange();
    error ExceedsTarget();
    error NotEnoughMembers();
    error WrongCircuit();
    error OverPriceCap();
    error NothingToClaim();
    error NotMember();
    error TransferFailed();
    error InvalidShareCount();
    error PaymentMismatch();
    error FundingTargetNotDivisible();
    error UnsupportedSubscriptionAsset();
    error Unauthorized();
    error InvalidParameters();
    error DepositPaused();
    error FutureLookup();
    error NotOwnerAfterBuy();
    error FinalRewardSettlementFailed();
    error MinerNotActive();
    error InvalidListing();
    error UnexpectedNft();
    error SelectorNotAllowed();
    error ClaimTooSoon();
    error EpochNotExpired();
    error EpochAlreadyBurned();
    error ExpiryDisabled();
    error AccountingDeficit();
    error InsufficientUnlockedShares();
    error InsufficientLockedShares();
    error MarketCannotHoldShares();

    event Deposited(address indexed user, uint8 shares, uint256 amount, uint256 totalRaised);
    event DepositWithdrawn(address indexed user, uint8 shares, uint256 amount);
    event Funded(uint256 totalRaised, uint256 totalShares, uint256 memberCount);
    event Failed(uint8 reason);
    event BnbWithdrawn(address indexed user, uint256 amount);
    event DepositPauseChanged(bool paused);
    event MemberCountChanged(uint256 previousCount, uint256 currentCount);
    event Purchased(uint256 cost, uint8 path, uint256 listingId);
    event RewardSettledBeforeTransfer(
        address indexed circuits, uint256 indexed circuitId, address previousOwner, uint256 bemAmount, bytes32 tradeId
    );
    event PurchaseSurplusSettled(address indexed user, uint256 shares, uint256 amount);
    event Harvested(uint256 gross, uint256 toPlatform, uint256 burned, uint256 toMembers);
    event BemClaimed(address indexed user, uint256 amount);
    event EpochExpiredBurned(uint32 indexed epoch, uint256 amount);
    event RewardEpochRecorded(uint32 indexed epoch, uint256 previousAcc, uint256 cumulativeAcc, uint256 net);
    event MiningCall(bytes4 indexed selector, bytes data);
    event MiningClaimFailed(bytes32 indexed key, bytes reason);
    event ExpiryConfigured(bool enabled);
    event LockedSharesChanged(address indexed member, uint256 previousLocked, uint256 currentLocked);

    function initialize(address factory, PoolParams calldata params, address treasury) external;
    function deposit(uint8 shares) external payable;
    function withdrawDeposit() external;
    function finalizeFailure() external;
    function withdrawBnb() external;
    function setDepositPaused(bool paused) external;
    function buyFromMarket(uint256 listingId) external;
    function sellToPool() external;
    function configureExpiry(bool enabled) external;
    function mine(bytes calldata data) external returns (bytes memory);
    function harvest() external returns (uint256 gross, uint256 fee, uint256 burned, uint256 net);
    function claim() external returns (uint256 amount);
    function burnExpired(uint32 epoch) external returns (uint256 amount);
    function lock(address member, uint256 amount) external;
    function unlock(address member, uint256 amount) external;
    function transferLocked(address seller, address buyer, uint256 amount) external;
    function asset() external view returns (address);
    function assetDecimals() external view returns (uint8);
    function assetOwed(address asset_, address member) external view returns (uint256);
}

interface IPoolFactoryRoles {
    function operator() external view returns (address);
    function shareMarket() external view returns (address);
}
