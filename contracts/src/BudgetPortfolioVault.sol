// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {ITapeoutMining} from "./interfaces/ITapeoutMining.sol";
import {TransferableBemRewards} from "./libraries/TransferableBemRewards.sol";
import {SaleReviewPolicy} from "./libraries/SaleReviewPolicy.sol";
import {BudgetGovernanceState} from "./BudgetGovernanceState.sol";

interface IBudgetLegacyFactory {
    function isPool(address pool) external view returns (bool);
    function designatedSubscriber(address pool) external view returns (address);
}

interface IBudgetChild is IPoolVault, IERC20 {
    function state() external view returns (State);
    function params() external view returns (PoolParams memory);
    function factory() external view returns (address);
    function treasury() external view returns (address);
    function purchaseCost() external view returns (uint256);
    function activatedAt() external view returns (uint64);
    function claimable(address member) external view returns (uint256);
    function expiresAt() external view returns (uint64);
    function bnbOwed(address member) external view returns (uint256);
}

interface IBudgetPortfolioFactoryRoles {
    function operator() external view returns (address);
    function shareMarket() external view returns (address);
}

interface IBudgetSaleReference {
    function saleReference(address pool)
        external
        view
        returns (uint128 priceWei, uint64 observedAt, bytes32 sourceDigest);
    function approveBudgetChildSale(address pool, uint256 proposalId, uint256 projectProposalId) external;
}

interface IBudgetLegacySaleMarket {
    function shareMarket() external view returns (address);
}

/// @notice A 100-share project that atomically buys separate, existing single-NFT pools.
/// @dev Every child keeps its NFT and existing source/sale protections. This project
/// holds all child shares; unclaimed BEM follows project shares when they move.
/// @custom:oz-upgrades-unsafe-allow state-variable-immutable
contract BudgetPortfolioVault is ERC20Upgradeable, ReentrancyGuardUpgradeable, BudgetGovernanceState {
    using SafeERC20 for IERC20;
    using TransferableBemRewards for TransferableBemRewards.Ledger;

    uint256 public constant TOTAL_SHARES = 100;
    uint16 public constant saleReviewThresholdBps = SaleReviewPolicy.THRESHOLD_BPS;
    uint256 public constant MAX_FUNDING_DURATION = 30 days;
    uint256 public constant MAX_PURCHASE_DURATION = 7 days;
    uint256 public constant MAX_SALE_CANDIDATES = 16;
    // At most ten distinct wallets can each hold this threshold in a 100-share project.
    // Even splitting ownership cannot fill the sixteen candidate slots with one-share spam.
    uint256 public constant MIN_PROPOSAL_SHARES = 10;
    address public constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address public constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;
    address public constant TAPEOUT = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address public constant BEHEMOTH = 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C;
    address public immutable OFFICIAL_FACTORY;

    struct Config {
        address legacyFactory;
        address treasury;
        uint256 budgetWei;
        uint256 absoluteCapWei;
        uint256 unitCapWei;
        uint64 fundingDeadline;
        uint64 purchaseDeadline;
    }

    struct Child {
        address collection;
        uint256 tokenId;
        uint256 purchaseCost;
        bool official;
        bool sold;
    }

    struct SaleProposal {
        address child;
        uint256 price;
        uint256 referencePrice;
        uint64 referenceAt;
        uint64 endsAt;
        uint16 memberCount;
        uint16 yesMembers;
        uint16 yesShares;
        bool executed;
    }

    error Unauthorized();
    error InvalidParameters();
    error WrongState();
    error DeadlinePassed();
    error DeadlineNotReached();
    error PaymentMismatch();
    error InvalidChild();
    error OverPriceCap();
    error AccountingDeficit();
    error NothingToClaim();
    error TransferFailed();
    error ProposalActive();
    error InvalidProposal();
    error AlreadyVoted();
    error ProposalNotPassed();
    error ProposeCooldown();
    error InsufficientUnlockedShares();
    error RewardsLocked();

    event Deposited(address indexed member, uint8 shares, uint256 amount);
    event ChildPurchased(
        address indexed child, address indexed collection, uint256 indexed tokenId, uint256 cost, bool official
    );
    event AcquisitionFinalized(
        uint256 spent, uint256 officialFee, uint256 refundableToMembers, uint256 roundingWei, uint256 children
    );
    event BemCollected(address indexed child, uint256 received);
    event ChildHarvestFailed(address indexed child, bytes32 reasonHash);
    event BemClaimed(address indexed member, uint256 amount);
    event BnbWithdrawn(address indexed member, uint256 amount);
    event ChildSaleProposed(uint256 indexed proposalId, address indexed child, uint256 price, uint64 endsAt);
    event ChildSaleVoted(uint256 indexed proposalId, address indexed member, bool support, uint256 shares);
    event ChildSaleApproved(uint256 indexed proposalId, address indexed child);
    event ChildSaleSettled(address indexed child, uint256 netProceeds);
    event ChildSaleExpired(uint256 indexed proposalId);
    event ChildSaleReviewed(uint256 indexed proposalId, bool approved, address indexed operator);

    address public legacyFactory;
    address public treasury;
    uint256 public budgetWei;
    uint256 public absoluteCapWei;
    uint256 public unitCapWei;
    uint64 public fundingDeadline;
    uint64 public purchaseDeadline;
    IPoolVault.State public state;
    uint256 public spentWei;
    uint256 public officialSpentWei;
    uint256 public purchaseFeeWei;
    uint256 public refundPerShareWei;
    uint256 public refundRoundingWei;
    uint256 public salePerShareWei;
    uint256 public saleRemainderWei;
    uint256 public totalBnbOwed;
    uint16 public memberCount;
    bool public fundingFailed;
    uint256 public activeChildCount;
    uint256 public nextProposalId;
    uint256 public activeProposalId;
    address[] private children;
    mapping(address => Child) public childInfo;
    mapping(address => bool) public refundSettled;
    mapping(address => uint256) public bnbOwed;
    mapping(address => uint256) public saleDebt;
    mapping(address => uint256) public lockedShares;
    mapping(uint256 => SaleProposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    TransferableBemRewards.Ledger private rewards;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address factory_) {
        if (factory_ == address(0)) revert InvalidParameters();
        OFFICIAL_FACTORY = factory_;
        _disableInitializers();
    }

    function initialize(address factory_, Config calldata config) external initializer {
        if (
            factory_ != OFFICIAL_FACTORY || msg.sender != OFFICIAL_FACTORY || config.legacyFactory.code.length == 0
                || config.treasury == address(0) || config.budgetWei == 0 || config.budgetWei % TOTAL_SHARES != 0
                || config.absoluteCapWei == 0 || config.unitCapWei == 0 || config.fundingDeadline <= block.timestamp
                || config.fundingDeadline > block.timestamp + MAX_FUNDING_DURATION
                || config.purchaseDeadline <= config.fundingDeadline
                || config.purchaseDeadline > config.fundingDeadline + MAX_PURCHASE_DURATION
        ) {
            revert InvalidParameters();
        }
        __ERC20_init("BEMine Budget Portfolio Share", "BPS");
        __ReentrancyGuard_init();
        legacyFactory = config.legacyFactory;
        treasury = config.treasury;
        budgetWei = config.budgetWei;
        absoluteCapWei = config.absoluteCapWei;
        unitCapWei = config.unitCapWei;
        fundingDeadline = config.fundingDeadline;
        purchaseDeadline = config.purchaseDeadline;
        state = IPoolVault.State.Funding;
        nextProposalId = 1;
    }

    function deposit(uint8 shares) external payable nonReentrant {
        if (state != IPoolVault.State.Funding) revert WrongState();
        if (block.timestamp >= fundingDeadline) revert DeadlinePassed();
        if (shares == 0 || totalSupply() + shares > TOTAL_SHARES) revert InvalidParameters();
        uint256 payment = uint256(shares) * budgetWei / TOTAL_SHARES;
        if (msg.value != payment) revert PaymentMismatch();
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, shares, payment);
        if (totalSupply() == TOTAL_SHARES) state = IPoolVault.State.Funded;
    }

    function withdrawDeposit() external nonReentrant {
        if (state != IPoolVault.State.Funding) revert WrongState();
        uint256 shares = balanceOf(msg.sender);
        if (shares == 0) revert NothingToClaim();
        _burn(msg.sender, shares);
        _creditBnb(msg.sender, shares * budgetWei / TOTAL_SHARES);
    }

    function finalizeFundingFailure() external nonReentrant {
        if (state != IPoolVault.State.Funding || block.timestamp < fundingDeadline) revert DeadlineNotReached();
        fundingFailed = true;
        state = IPoolVault.State.Refunding;
    }

    function claimFailedFunding() external nonReentrant {
        if (state != IPoolVault.State.Refunding || !fundingFailed) revert WrongState();
        uint256 shares = balanceOf(msg.sender);
        if (shares == 0) revert NothingToClaim();
        _burn(msg.sender, shares);
        _creditBnb(msg.sender, shares * budgetWei / TOTAL_SHARES);
    }

    function buyOfficial(address child, uint256 listingId) external nonReentrant {
        _requireOperatorPurchase();
        (IBudgetChild pool, IPoolVault.PoolParams memory params) = _prepareChild(child);
        // This entry point holds nonReentrant across every child call and the final budget update.
        // slither-disable-next-line reentrancy-eth
        pool.deposit{value: params.targetRaise}(100);
        // slither-disable-next-line reentrancy-eth
        pool.buyFromMarket(listingId);
        _finishChild(pool, params, true);
    }

    function buyFirsto(address child, bytes calldata encodedOrder) external nonReentrant {
        _requireOperatorPurchase();
        (IBudgetChild pool, IPoolVault.PoolParams memory params) = _prepareChild(child);
        // This entry point holds nonReentrant across every child call and the final budget update.
        // slither-disable-next-line reentrancy-eth
        pool.deposit{value: params.targetRaise}(100);
        // slither-disable-next-line reentrancy-eth
        pool.buyFromFirsto(0, encodedOrder);
        _finishChild(pool, params, false);
    }

    function _requireOperatorPurchase() private view {
        if (msg.sender != IBudgetPortfolioFactoryRoles(OFFICIAL_FACTORY).operator()) revert Unauthorized();
        if (state != IPoolVault.State.Funded) revert WrongState();
        if (block.timestamp >= purchaseDeadline) revert DeadlinePassed();
    }

    function _prepareChild(address child)
        private
        view
        returns (IBudgetChild pool, IPoolVault.PoolParams memory params)
    {
        if (
            childInfo[child].collection != address(0) || !IBudgetLegacyFactory(legacyFactory).isPool(child)
                || IBudgetLegacyFactory(legacyFactory).designatedSubscriber(child) != address(this)
        ) {
            revert InvalidChild();
        }
        pool = IBudgetChild(child);
        if (pool.factory() != legacyFactory || pool.state() != IPoolVault.State.Funding || pool.totalSupply() != 0) {
            revert InvalidChild();
        }
        params = pool.params();
        if (
            (params.circuits != TAPEOUT && params.circuits != BEHEMOTH) || params.directSeller != address(0)
                || params.directPrice != 0 || params.priceCap == 0 || params.targetRaise == 0
                || params.targetRaise > budgetWei - spentWei || block.timestamp >= params.fundingDeadline
                || block.timestamp >= params.purchaseDeadline
        ) revert InvalidChild();
        bytes32 key = ITapeoutMining(MINING).minerKey(params.circuits, params.circuitId);
        ITapeoutMining.Miner memory miner = ITapeoutMining(MINING).getMiner(key);
        if (
            miner.circuits != params.circuits || miner.circuitId != params.circuitId || miner.status != 1
                || miner.optimal || miner.unverWeight != 0 || miner.verifWeight == 0
        ) revert InvalidChild();
        uint256 weightedCap = unitCapWei * uint256(miner.verifWeight);
        uint256 cap = weightedCap < absoluteCapWei ? weightedCap : absoluteCapWei;
        if (params.priceCap > cap) revert OverPriceCap();
        if (address(this).balance < totalBnbOwed + params.targetRaise) revert AccountingDeficit();
    }

    function _finishChild(IBudgetChild pool, IPoolVault.PoolParams memory params, bool official) private {
        if (pool.state() != IPoolVault.State.Active || pool.balanceOf(address(this)) != TOTAL_SHARES) {
            revert InvalidChild();
        }
        IPoolVault.PoolParams memory acquired = pool.params();
        if (acquired.circuits != params.circuits || acquired.circuitId != params.circuitId) revert InvalidChild();
        uint256 cost = pool.purchaseCost();
        if (cost == 0 || cost > params.priceCap || cost > budgetWei - spentWei) revert OverPriceCap();
        spentWei += cost;
        if (official) officialSpentWei += cost;
        childInfo[address(pool)] = Child(params.circuits, params.circuitId, cost, official, false);
        children.push(address(pool));
        activeChildCount += 1;
        if (pool.bnbOwed(address(this)) != 0) pool.withdrawBnb();
        if (address(this).balance < totalBnbOwed + budgetWei - spentWei) revert AccountingDeficit();
        emit ChildPurchased(address(pool), params.circuits, params.circuitId, cost, official);
    }

    function finalizeAcquisition() external nonReentrant {
        if (state != IPoolVault.State.Funded || block.timestamp < purchaseDeadline) revert DeadlineNotReached();
        uint256 unused = budgetWei - spentWei;
        uint256 fee = officialSpentWei / 100;
        if (fee > unused) fee = unused;
        purchaseFeeWei = fee;
        uint256 refundable = unused - fee;
        refundPerShareWei = refundable / TOTAL_SHARES;
        refundRoundingWei = refundable % TOTAL_SHARES;
        uint256 totalRefundable = refundable - refundRoundingWei;
        _creditBnb(treasury, fee + refundRoundingWei);
        if (address(this).balance < totalBnbOwed + totalRefundable) {
            revert AccountingDeficit();
        }
        state = activeChildCount == 0 ? IPoolVault.State.Refunding : IPoolVault.State.Active;
        emit AcquisitionFinalized(spentWei, fee, totalRefundable, refundRoundingWei, children.length);
    }

    function collectChildBem(address child) external nonReentrant returns (uint256 amount) {
        if (childInfo[child].collection == address(0)) revert InvalidChild();
        amount = _collectChildBem(IBudgetChild(child));
    }

    function _collectChildBem(IBudgetChild child) private returns (uint256 amount) {
        IPoolVault.State childState = child.state();
        if (childState == IPoolVault.State.Active || childState == IPoolVault.State.Listed) {
            // An ordinary claim failure must not trap BEM the child already booked
            // for this project's shares. Controlled sale remains strict in the child.
            // We verify the actual BEM balance delta below, not the child's reported return values.
            // slither-disable-next-line unused-return
            try child.harvest() returns (uint256, uint256, uint256, uint256) {}
            catch (bytes memory reason) {
                emit ChildHarvestFailed(address(child), keccak256(reason));
            }
        }
        if (child.claimable(address(this)) == 0) return 0;
        uint256 previous = IERC20(BEM).balanceOf(address(this));
        // The project is the sole child shareholder; the actual BEM receipt is checked below.
        // slither-disable-next-line unused-return
        child.claim();
        amount = IERC20(BEM).balanceOf(address(this)) - previous;
        // The historical balance is a receipt measurement, never an authorization to pay.
        // All callers hold nonReentrant until this check and ledger update complete.
        // slither-disable-next-line reentrancy-balance,incorrect-equality
        if (amount == 0) revert AccountingDeficit();
        // The returned distributed amount excludes retained integer dust; receipt is reported above.
        // slither-disable-next-line unused-return
        rewards.record(amount);
        emit BemCollected(address(child), amount);
    }

    function claimBem() external nonReentrant returns (uint256 amount) {
        // A listed share carries its unclaimed BEM to the buyer. Letting the
        // seller claim while an order is live would let them front-run a fill
        // and strip that value after the buyer has agreed to the price.
        if (lockedShares[msg.sender] != 0) revert RewardsLocked();
        amount = rewards.take(msg.sender, balanceOf(msg.sender));
        if (amount == 0) revert NothingToClaim();
        IERC20(BEM).safeTransfer(msg.sender, amount);
        emit BemClaimed(msg.sender, amount);
    }

    function claimableBem(address member) external view returns (uint256) {
        return rewards.claimable(member, balanceOf(member));
    }

    function withdrawBnb() external nonReentrant returns (uint256 amount) {
        _settleBnb(msg.sender, balanceOf(msg.sender));
        amount = bnbOwed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        bnbOwed[msg.sender] = 0;
        totalBnbOwed -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit BnbWithdrawn(msg.sender, amount);
    }

    function _creditBnb(address member, uint256 amount) private {
        bnbOwed[member] += amount;
        totalBnbOwed += amount;
    }

    function _settleBnb(address member, uint256 balance) private {
        if (!refundSettled[member] && state != IPoolVault.State.Funding && state != IPoolVault.State.Funded) {
            refundSettled[member] = true;
            _creditBnb(member, balance * refundPerShareWei);
        }
        uint256 accrued = balance * salePerShareWei;
        if (accrued < saleDebt[member]) revert AccountingDeficit();
        _creditBnb(member, accrued - saleDebt[member]);
        saleDebt[member] = accrued;
    }

    function proposeChildSale(address child, uint256 price, uint256 referencePrice, uint64 referenceAt)
        external
        nonReentrant
        returns (uint256 proposalId)
    {
        if (state != IPoolVault.State.Active) revert WrongState();
        BudgetGovernanceStorage storage g = _budgetGovernanceStorage();
        uint64 endsAt;
        uint16 voters;
        uint256 opener = activeProposalId;
        if (opener != 0 && proposals[opener].executed) revert ProposalActive();
        if (opener != 0 && block.timestamp < proposals[opener].endsAt) {
            if (nextProposalId - opener >= MAX_SALE_CANDIDATES) revert ProposalActive();
            endsAt = proposals[opener].endsAt;
            voters = proposals[opener].memberCount;
        } else {
            if (block.timestamp < nextRoundAt()) revert ProposeCooldown();
            endsAt = uint64(block.timestamp + 1 days);
            voters = memberCount;
            g.nextRoundAt = uint64(block.timestamp + 3 days);
            if (opener != 0) emit ChildSaleExpired(opener);
        }
        if (g.lastProposed[msg.sender] != 0 && block.timestamp < uint256(g.lastProposed[msg.sender]) + 3 days) {
            revert ProposeCooldown();
        }
        if (
            balanceOf(msg.sender) < MIN_PROPOSAL_SHARES || childInfo[child].collection == address(0)
                || childInfo[child].sold || price == 0 || price > type(uint128).max
                || IBudgetChild(child).state() != IPoolVault.State.Active
                || block.timestamp < uint256(IBudgetChild(child).activatedAt()) + 3 days
        ) revert InvalidProposal();
        proposalId = nextProposalId++;
        proposals[proposalId] = SaleProposal(child, price, referencePrice, referenceAt, endsAt, voters, 0, 0, false);
        if (opener == 0 || block.timestamp >= proposals[opener].endsAt) activeProposalId = proposalId;
        g.lastProposed[msg.sender] = uint64(block.timestamp);
        emit ChildSaleProposed(proposalId, child, price, endsAt);
    }

    function voteChildSale(uint256 proposalId, bool support) external nonReentrant {
        SaleProposal storage p = proposals[proposalId];
        if (
            state != IPoolVault.State.Active || !_currentSaleCandidate(proposalId) || block.timestamp >= p.endsAt
                || p.executed
        ) revert InvalidProposal();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();
        uint256 weight = balanceOf(msg.sender);
        if (weight == 0) revert Unauthorized();
        hasVoted[proposalId][msg.sender] = true;
        if (support) {
            p.yesMembers += 1;
            p.yesShares += uint16(weight);
        }
        emit ChildSaleVoted(proposalId, msg.sender, support, weight);
    }

    function reviewChildSale(uint256 proposalId, bool approved) external nonReentrant {
        if (msg.sender != IBudgetPortfolioFactoryRoles(OFFICIAL_FACTORY).operator()) revert Unauthorized();
        SaleProposal storage p = proposals[proposalId];
        BudgetGovernanceStorage storage g = _budgetGovernanceStorage();
        if (!_currentSaleCandidate(proposalId) || p.executed || g.saleReviews[proposalId] == 2) {
            revert InvalidProposal();
        }
        // At exactly 80% of the current reference, voting alone is sufficient.
        if (!SaleReviewPolicy.requiresReview(p.price, _freshChildMarketPrice(p.child))) revert InvalidProposal();
        g.saleReviews[proposalId] = approved ? 1 : 2;
        emit ChildSaleReviewed(proposalId, approved, msg.sender);
    }

    function childSaleReview(uint256 proposalId) external view returns (uint8) {
        return _budgetGovernanceStorage().saleReviews[proposalId];
    }

    function executeChildSale(uint256 proposalId) external nonReentrant {
        SaleProposal storage p = proposals[proposalId];
        if (
            state != IPoolVault.State.Active || !_currentSaleCandidate(proposalId) || block.timestamp >= p.endsAt
                || p.executed
        ) revert InvalidProposal();
        bool discount = SaleReviewPolicy.requiresReview(p.price, _freshChildMarketPrice(p.child));
        if (discount && _budgetGovernanceStorage().saleReviews[proposalId] != 1) {
            revert ProposalNotPassed();
        }
        if (uint256(p.yesMembers) * 2 <= p.memberCount || uint256(p.yesShares) * 2 <= TOTAL_SHARES) {
            revert ProposalNotPassed();
        }
        p.executed = true;
        activeProposalId = proposalId;
        IBudgetChild pool = IBudgetChild(p.child);
        uint256 childProposal = pool.propose(p.price, p.referencePrice, p.referenceAt);
        pool.vote(childProposal, true);
        if (discount) {
            IBudgetSaleReference(IBudgetLegacySaleMarket(legacyFactory).shareMarket())
                .approveBudgetChildSale(p.child, childProposal, proposalId);
        }
        pool.executeSale(childProposal);
        emit ChildSaleApproved(proposalId, p.child);
    }

    function _freshChildMarketPrice(address child) private view returns (uint128 marketPrice) {
        uint64 observedAt;
        bytes32 digest;
        (marketPrice, observedAt, digest) =
            IBudgetSaleReference(IBudgetLegacySaleMarket(legacyFactory).shareMarket()).saleReference(child);
        if (
            marketPrice == 0 || digest == bytes32(0) || observedAt > block.timestamp
                || block.timestamp - observedAt > 15 minutes
        ) revert ProposalNotPassed();
    }

    function settleChildSale() external nonReentrant returns (uint256 net) {
        uint256 proposalId = activeProposalId;
        if (proposalId == 0 || !proposals[proposalId].executed) revert InvalidProposal();
        address child = proposals[proposalId].child;
        IBudgetChild pool = IBudgetChild(child);
        if (pool.state() != IPoolVault.State.Closed || childInfo[child].sold) revert WrongState();
        // Sale proceeds can settle while a child's booked BEM claim is unavailable.
        // The project still holds every child share; collectChildBem can retry later,
        // and uncollected BEM continues to follow project shares when they move.
        uint256 beforeBalance = address(this).balance;
        // The child was registered at purchase and this entry point holds nonReentrant.
        // slither-disable-next-line reentrancy-no-eth
        pool.withdrawBnb();
        net = address(this).balance - beforeBalance;
        // Zero is an exact receipt failure, not a price target.
        // slither-disable-next-line incorrect-equality
        if (net == 0 || net > proposals[proposalId].price) revert AccountingDeficit();
        uint256 available = net + saleRemainderWei;
        salePerShareWei += available / TOTAL_SHARES;
        saleRemainderWei = available % TOTAL_SHARES;
        childInfo[child].sold = true;
        activeChildCount -= 1;
        activeProposalId = 0;
        if (activeChildCount == 0) state = IPoolVault.State.Closed;
        emit ChildSaleSettled(child, net);
    }

    function expireChildSale() external nonReentrant {
        uint256 proposalId = activeProposalId;
        if (proposalId == 0) revert InvalidProposal();
        SaleProposal storage p = proposals[proposalId];
        bool executed = p.executed;
        if (!executed) {
            if (block.timestamp < p.endsAt) revert DeadlineNotReached();
        } else {
            IBudgetChild pool = IBudgetChild(p.child);
            IPoolVault.State childState = pool.state();
            // Another holder may already have cancelled the expired child listing.
            // Its proposal still has to be cleared so project shares can move again.
            if (childState == IPoolVault.State.Listed) {
                if (block.timestamp < pool.expiresAt()) revert DeadlineNotReached();
            } else if (childState != IPoolVault.State.Active) {
                revert WrongState();
            }
        }
        // Invalidate before calling the child; a failed child call reverts this write.
        activeProposalId = 0;
        if (executed && IBudgetChild(p.child).state() == IPoolVault.State.Listed) {
            IBudgetChild pool = IBudgetChild(p.child);
            pool.cancelExpired();
        }
        emit ChildSaleExpired(proposalId);
    }

    function shareTradingAllowed() external view returns (bool) {
        return state == IPoolVault.State.Active && !_saleFrozen();
    }

    /// @notice New sale rounds are globally separated by three days.
    function nextRoundAt() public view returns (uint64) {
        uint64 next = _budgetGovernanceStorage().nextRoundAt;
        // Preserve cooldown if an existing portfolio is upgraded with an old round.
        if (next == 0 && nextProposalId > 1) {
            return uint64(uint256(proposals[nextProposalId - 1].endsAt) + 2 days);
        }
        return next;
    }

    function _saleFrozen() private view returns (bool) {
        if (activeProposalId == 0) return false;
        SaleProposal storage p = proposals[activeProposalId];
        return p.executed || block.timestamp < p.endsAt;
    }

    function _currentSaleCandidate(uint256 proposalId) private view returns (bool) {
        uint256 opener = activeProposalId;
        // An identical deadline identifies the candidate's exact voting round; this is not token accounting.
        // slither-disable-next-line incorrect-equality
        return opener != 0 && proposalId >= opener && proposalId < nextProposalId
            && proposals[proposalId].endsAt == proposals[opener].endsAt
            && (!proposals[opener].executed || proposalId == opener);
    }

    function lock(address member, uint256 amount) external nonReentrant {
        _onlyShareMarket();
        if (state != IPoolVault.State.Active || _saleFrozen()) revert WrongState();
        if (amount == 0 || amount > balanceOf(member) - lockedShares[member]) revert InsufficientUnlockedShares();
        lockedShares[member] += amount;
    }

    function unlock(address member, uint256 amount) external nonReentrant {
        _onlyShareMarket();
        if (amount == 0 || amount > lockedShares[member]) revert InsufficientUnlockedShares();
        lockedShares[member] -= amount;
    }

    function transferLocked(address seller, address buyer, uint256 amount) external nonReentrant {
        _onlyShareMarket();
        if (amount == 0 || amount > lockedShares[seller]) revert InsufficientUnlockedShares();
        lockedShares[seller] -= amount;
        _transfer(seller, buyer, amount);
    }

    function _onlyShareMarket() private view {
        if (msg.sender != IBudgetPortfolioFactoryRoles(OFFICIAL_FACTORY).shareMarket()) revert Unauthorized();
    }

    function transfer(address to, uint256 value) public override nonReentrant returns (bool) {
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override nonReentrant returns (bool) {
        return super.transferFrom(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == address(this) || to == OFFICIAL_FACTORY) revert InvalidParameters();
        uint256 fromBefore = from == address(0) ? 0 : balanceOf(from);
        uint256 toBefore = to == address(0) ? 0 : balanceOf(to);
        if (from != address(0) && to != address(0)) {
            if (state != IPoolVault.State.Active || _saleFrozen()) revert WrongState();
            address market = IBudgetPortfolioFactoryRoles(OFFICIAL_FACTORY).shareMarket();
            if (market == address(0) || to == market) revert WrongState();
            if (value == 0 || value > fromBefore - lockedShares[from]) revert InsufficientUnlockedShares();
            _settleBnb(from, fromBefore);
            if (to != from) _settleBnb(to, toBefore);
            // The ledger moves only outstanding BEM; the returned moved amount is diagnostic.
            // slither-disable-next-line unused-return
            rewards.move(from, to, fromBefore, toBefore, value);
        } else if (from == address(0)) {
            if (state != IPoolVault.State.Funding) revert WrongState();
        } else if (state != IPoolVault.State.Funding && state != IPoolVault.State.Refunding) {
            revert WrongState();
        }
        super._update(from, to, value);
        if (from != address(0) && fromBefore > 0 && balanceOf(from) == 0) memberCount -= 1;
        if (to != address(0) && to != from && toBefore == 0 && balanceOf(to) > 0) memberCount += 1;
        if (from != address(0) && to != address(0) && to != from) {
            saleDebt[from] = balanceOf(from) * salePerShareWei;
            saleDebt[to] = balanceOf(to) * salePerShareWei;
        }
    }

    function childCount() external view returns (uint256) {
        return children.length;
    }

    function childAt(uint256 index) external view returns (address) {
        return children[index];
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }
    receive() external payable {}
}
