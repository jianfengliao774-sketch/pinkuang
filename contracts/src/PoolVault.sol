// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IPoolVault, IPoolFactoryRoles} from "./interfaces/IPoolVault.sol";
import {ICircuitMarket} from "./interfaces/ICircuitMarket.sol";
import {PoolRewardState} from "./PoolRewardState.sol";
import {PoolSaleState} from "./PoolSaleState.sol";
import {RewardAccounting} from "./libraries/RewardAccounting.sol";
import {MiningOperations} from "./libraries/MiningOperations.sol";
import {ShareCheckpoints} from "./libraries/ShareCheckpoints.sol";
import {SaleGovernance} from "./libraries/SaleGovernance.sol";
import {PurchaseValidation} from "./libraries/PurchaseValidation.sol";
import {SaleSettlement} from "./libraries/SaleSettlement.sol";
import {BurnOperations} from "./libraries/BurnOperations.sol";
import {PoolVaultState} from "./PoolVaultState.sol";
import {PoolFunds} from "./libraries/PoolFunds.sol";

/// @notice Integer BNB pools with atomic acquisition and bounded daily BEM accounting.
/// @dev Linked libraries are reviewed with this implementation and fixed in its bytecode.
/// @custom:oz-upgrades-unsafe-allow external-library-linking
contract PoolVault is
    ERC20Upgradeable,
    ReentrancyGuardUpgradeable,
    IPoolVault,
    IERC721Receiver,
    PoolRewardState,
    PoolSaleState,
    PoolVaultState
{
    using Checkpoints for Checkpoints.Trace208;

    uint256 public constant TOTAL_SHARES = 100;
    uint16 public constant minShares = 1;
    uint16 public constant maxShares = 49;
    uint8 public constant minMembers = 3;
    uint16 public constant platformBps = 100;
    uint16 public constant burnBps = 400;
    uint16 public constant saleFeeBps = 200;
    uint16 public constant saleBurnBps = 200;
    uint32 public constant claimInterval = 86400;
    uint32 public constant voteDuration = 86400;
    address public constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address public constant CIRCUIT_MARKET = 0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f;
    address public constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    /// @dev Shared by all proxies behind this implementation; every upgrade must preserve this factory binding.
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable OFFICIAL_FACTORY;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address officialFactory_) {
        if (officialFactory_ == address(0)) revert Unauthorized();
        OFFICIAL_FACTORY = officialFactory_;
        _disableInitializers();
    }

    function initialize(address factory_, PoolParams calldata params_, address treasury_) external initializer {
        if (
            factory_ != OFFICIAL_FACTORY || msg.sender != OFFICIAL_FACTORY || factory_.code.length == 0
                || treasury_ == address(0)
        ) revert Unauthorized();
        if (params_.targetRaise == 0 || params_.targetRaise % TOTAL_SHARES != 0) revert FundingTargetNotDivisible();
        if (params_.priceCap == 0 || params_.priceCap > params_.targetRaise) revert OverPriceCap();
        if (params_.fundingDeadline <= block.timestamp || params_.purchaseDeadline <= params_.fundingDeadline) {
            revert InvalidParameters();
        }
        __ERC20_init(PoolFunds.shareName(params_.circuits, params_.circuitId), "TPS");
        __ReentrancyGuard_init();
        VaultStorage storage s = _vaultStorage();
        s.factory = factory_;
        s.treasury = treasury_;
        s.params = params_;
        s.unitPriceWei = params_.targetRaise / TOTAL_SHARES;
        s.state = State.Funding;
    }

    function deposit(uint8 shares) external payable nonReentrant {
        VaultStorage storage s = _vaultStorage();
        if (s.state != State.Funding) revert WrongState();
        if (s.depositPaused) revert DepositPaused();
        if (block.timestamp >= s.params.fundingDeadline) revert DeadlinePassed();
        if (shares == 0) revert InvalidShareCount();
        if (shares > maxShares || balanceOf(msg.sender) + shares > maxShares) revert ShareOutOfRange();
        if (totalSupply() + shares > TOTAL_SHARES) revert ExceedsTarget();
        uint256 amount = uint256(shares) * s.unitPriceWei;
        if (msg.value != amount) revert PaymentMismatch();
        s.contributedWei[msg.sender] += amount;
        s.totalRaised += amount;
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, shares, amount, s.totalRaised);
        if (totalSupply() == TOTAL_SHARES) {
            if (s.activeMembers.length < minMembers) revert NotEnoughMembers();
            if (s.totalRaised != s.params.targetRaise) revert PaymentMismatch();
            s.state = State.Funded;
            emit Funded(s.totalRaised, totalSupply(), s.activeMembers.length);
        }
    }

    /// @notice Withdraws the full subscription into the caller's pull-payment balance.
    function withdrawDeposit() external nonReentrant {
        VaultStorage storage s = _vaultStorage();
        if (s.state != State.Funding) revert WrongState();
        uint256 shares = balanceOf(msg.sender);
        if (shares == 0) revert NotMember();
        uint256 amount = s.contributedWei[msg.sender];
        s.contributedWei[msg.sender] = 0;
        s.totalRaised -= amount;
        _burn(msg.sender, shares);
        _creditBnb(s, msg.sender, amount);
        // Minting is bounded to 49 integer shares per member, so this cast is exact.
        emit DepositWithdrawn(msg.sender, uint8(shares), amount);
    }

    function finalizeFailure() external nonReentrant {
        PoolFunds.finalizeFailure(_vaultStorage());
    }

    function _creditBnb(VaultStorage storage s, address member, uint256 amount) private {
        s.bnbOwed[member] += amount;
        s.totalBnbOwed += amount;
    }

    function withdrawBnb() external nonReentrant {
        VaultStorage storage s = _vaultStorage();
        _materializePurchaseSurplus(s, msg.sender);
        _materializeSaleProceeds(s, msg.sender);
        PoolFunds.withdraw(s);
    }

    function buyFromMarket(uint256 listingId) external nonReentrant {
        VaultStorage storage s = _requirePurchaseWindow();
        (address seller, uint256 price, bytes32 key) = PurchaseValidation.prepareMarketPurchase(
            s.params.circuits, s.params.circuitId, s.params.priceCap, listingId
        );
        _expectNft(s, seller, CIRCUIT_MARKET);
        // M0 proves that the listed price is the buyer's entire payment, including the seller-borne 1% fee.
        ICircuitMarket(CIRCUIT_MARKET).buy{value: price}(listingId, SafeCast.toUint96(price));
        _finishPurchase(s, price, 0, listingId, key);
    }

    function sellToPool() external nonReentrant {
        VaultStorage storage s = _requirePurchaseWindow();
        address seller = s.params.directSeller;
        uint256 price = s.params.directPrice;
        bytes32 key = PurchaseValidation.prepareDirectPurchase(
            s.params.circuits, s.params.circuitId, seller, price, s.params.priceCap
        );
        _expectNft(s, seller, address(this));
        IERC721(s.params.circuits).safeTransferFrom(seller, address(this), s.params.circuitId);
        _finishPurchase(s, price, 1, 0, key);
        // Seller proceeds are a liability, not an immediate outgoing call. A rejecting seller cannot block purchase.
        _creditBnb(s, seller, price);
    }

    function _requirePurchaseWindow() private view returns (VaultStorage storage s) {
        s = _vaultStorage();
        if (s.state != State.Funded) revert WrongState();
        if (block.timestamp >= s.params.purchaseDeadline) revert DeadlinePassed();
    }

    function _activeMinerKey(VaultStorage storage s) private view returns (bytes32 key) {
        return PurchaseValidation.activeMinerKey(s.params.circuits, s.params.circuitId);
    }

    function _expectNft(VaultStorage storage s, address seller, address expectedOperator) private {
        s.expectedNftSeller = seller;
        s.expectedNftOperator = expectedOperator;
        s.nftReceived = false;
    }

    function onERC721Received(address operator, address from, uint256 id, bytes calldata) external returns (bytes4) {
        VaultStorage storage s = _vaultStorage();
        if (
            s.state != State.Funded || s.expectedNftOperator == address(0) || s.nftReceived
                || msg.sender != s.params.circuits || id != s.params.circuitId || from != s.expectedNftSeller
                || operator != s.expectedNftOperator
        ) revert UnexpectedNft();
        s.nftReceived = true;
        s.expectedNftOperator = address(0); // Consume the single permitted callback.
        return IERC721Receiver.onERC721Received.selector;
    }

    function _finishPurchase(VaultStorage storage s, uint256 cost, uint8 path, uint256 listingId, bytes32 expectedKey)
        private
    {
        if (!s.nftReceived) revert UnexpectedNft();
        if (IERC721(s.params.circuits).ownerOf(s.params.circuitId) != address(this)) revert NotOwnerAfterBuy();
        if (_activeMinerKey(s) != expectedKey) revert WrongCircuit();
        PoolFunds.recordPurchase(s, cost, path, listingId);
    }

    function _pendingPurchaseSurplus(VaultStorage storage s, address member) private view returns (uint256) {
        return PoolFunds.pendingPurchase(s, member, balanceOf(member));
    }

    function _materializePurchaseSurplus(VaultStorage storage s, address member) private {
        PoolFunds.materializePurchase(s, member, balanceOf(member));
    }

    function setDepositPaused(bool paused) external {
        VaultStorage storage s = _vaultStorage();
        if (msg.sender != IPoolFactoryRoles(s.factory).operator()) revert Unauthorized();
        s.depositPaused = paused;
        emit DepositPauseChanged(paused);
    }

    /// @notice Called only by Factory as part of creation, before the pool is published.
    function configureExpiry(bool enabled) external {
        VaultStorage storage s = _vaultStorage();
        RewardStorage storage r = _rewardStorage();
        if (msg.sender != s.factory) revert Unauthorized();
        if (r.expiryConfigured || s.state != State.Funding || totalSupply() != 0) revert InvalidParameters();
        r.expiryConfigured = true;
        r.expiryDisabled = !enabled;
        emit ExpiryConfigured(enabled);
    }

    function mine(bytes calldata data) external nonReentrant returns (bytes memory result) {
        VaultStorage storage s = _vaultStorage();
        if (msg.sender != IPoolFactoryRoles(s.factory).operator()) revert Unauthorized();
        if (s.state != State.Active) revert WrongState();
        result = MiningOperations.execute(s.params.circuits, s.params.circuitId, data);
        emit MiningCall(bytes4(data[:4]), data);
    }

    function harvest() external nonReentrant returns (uint256 gross, uint256 fee, uint256 burned, uint256 net) {
        State current = _vaultStorage().state;
        if (current != State.Active && current != State.Listed) revert WrongState();
        return _harvest(false);
    }

    /// @dev Also used by the later controlled sale, with strict settlement required.
    function _harvest(bool finalHandover) internal returns (uint256 gross, uint256 fee, uint256 burned, uint256 net) {
        VaultStorage storage s = _vaultStorage();
        MiningOperations.claimReward(s.params.circuits, s.params.circuitId, finalHandover);
        (gross, fee, burned, net) = RewardAccounting.account(_rewardStorage(), BEM, s.treasury);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        State current = _vaultStorage().state;
        if (current == State.Active || current == State.Listed) _harvest(false);
        return RewardAccounting.claim(_rewardStorage(), msg.sender, balanceOf(msg.sender), BEM);
    }

    function burnExpired(uint32 epoch) external nonReentrant returns (uint256 amount) {
        return RewardAccounting.burnExpired(_rewardStorage(), epoch, BEM);
    }

    function _settleRewards(address member) internal {
        RewardAccounting.settle(_rewardStorage(), member, balanceOf(member));
    }

    function propose(uint256 price, uint256 refPrice, uint64 refAt) external nonReentrant returns (uint256 proposalId) {
        VaultStorage storage s = _vaultStorage();
        if (s.state != State.Active) revert WrongState();
        return SaleGovernance.propose(
            _saleStorage(),
            s.memberHistory,
            SaleGovernance.ProposalInput(s.activatedAt, balanceOf(msg.sender), price, refPrice, refAt)
        );
    }

    function vote(uint256 proposalId, bool support) external nonReentrant {
        VaultStorage storage s = _vaultStorage();
        if (s.state != State.Active) revert WrongState();
        SaleGovernance.vote(_saleStorage(), s.shareHistory, proposalId, support);
    }

    function executeSale(uint256 proposalId) external nonReentrant {
        _executeSale(proposalId);
    }

    /// @notice Re-listing always needs a fresh passed proposal; there is no direct price change.
    function relist(uint256 proposalId) external nonReentrant {
        _executeSale(proposalId);
    }

    function _executeSale(uint256 proposalId) private {
        VaultStorage storage s = _vaultStorage();
        if (s.state != State.Active) revert WrongState();
        SaleGovernance.execute(_saleStorage(), proposalId);
        s.state = State.Listed;
    }

    function cancelExpired() external nonReentrant {
        VaultStorage storage s = _vaultStorage();
        if (s.state != State.Listed) revert WrongState();
        SaleGovernance.cancel(_saleStorage());
        s.state = State.Active;
    }

    function completeSale() external payable nonReentrant {
        VaultStorage storage s = _vaultStorage();
        SaleStorage storage sale = _saleStorage();
        if (s.state != State.Listed) revert WrongState();
        if (block.timestamp >= sale.expiresAt) revert DeadlinePassed();
        if (msg.value != sale.salePrice) revert PaymentMismatch();
        // The guarded internal path proves receipt, zero pending and unchanged
        // NFT/miner identity, then accounts all old-owner income before transfer.
        (uint256 settledBem,,,) = _harvest(true);
        uint256 fee = SaleSettlement.prepare(sale, msg.sender, msg.value, s.params.circuits, s.params.circuitId);
        s.state = State.Closed;
        _creditBnb(s, s.treasury, fee);
        SaleSettlement.handover(sale, s.params.circuits, s.params.circuitId, settledBem);
    }

    /// @notice Reserved for a future verified adapter. Controlled sales settle atomically above.
    function settleSale() external pure {
        revert UnverifiedSaleRoute();
    }

    function executeBurn(uint256 minOut, uint256 maxIn) external nonReentrant returns (uint256 spent, uint256 burned) {
        VaultStorage storage s = _vaultStorage();
        if (msg.sender != IPoolFactoryRoles(s.factory).operator()) revert Unauthorized();
        if (s.state != State.Closed) revert WrongState();
        (spent, burned) = BurnOperations.execute(_saleStorage(), minOut, maxIn);
    }

    function _materializeSaleProceeds(VaultStorage storage s, address member) private {
        SaleStorage storage sale = _saleStorage();
        if (sale.saleBuyer == address(0) || sale.saleSettled[member]) return;
        uint256 shares = balanceOf(member);
        uint256 amount = SaleSettlement.materialize(sale, member, shares);
        _creditBnb(s, member, amount);
        emit SaleProceedsSettled(member, shares, amount);
    }

    function pendingSaleProceeds(address member) public view returns (uint256) {
        return SaleSettlement.pending(_saleStorage(), member, balanceOf(member));
    }

    function listedProposalId() external view returns (uint256) {
        return _saleStorage().listedProposalId;
    }

    function listedAt() external view returns (uint64) {
        return _saleStorage().listedAt;
    }

    function expiresAt() external view returns (uint64) {
        return _saleStorage().expiresAt;
    }

    function salePrice() external view returns (uint256) {
        return _saleStorage().salePrice;
    }

    function saleBuyer() external view returns (address) {
        return _saleStorage().saleBuyer;
    }

    function completedAt() external view returns (uint64) {
        return _saleStorage().completedAt;
    }

    function saleProceeds() external view returns (uint256) {
        return _saleStorage().saleProceeds;
    }

    function salePerShareWei() external view returns (uint256) {
        return _saleStorage().salePerShareWei;
    }

    function saleRemainder() external view returns (uint256) {
        return _saleStorage().saleRemainder;
    }

    function saleOutstandingWei() external view returns (uint256) {
        return _saleStorage().saleOutstandingWei;
    }

    function saleSettled(address member) external view returns (bool) {
        return _saleStorage().saleSettled[member];
    }

    function saleTradeId() external view returns (bytes32) {
        return _saleStorage().saleTradeId;
    }

    function burnBudget() external view returns (uint256) {
        return _saleStorage().burnBudget;
    }

    function totalBurnBnbSpent() external view returns (uint256) {
        return _saleStorage().totalBurnBnbSpent;
    }

    function totalBurnBem() external view returns (uint256) {
        return _saleStorage().totalBurnBem;
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        Proposal storage p = _saleStorage().proposals[proposalId];
        if (p.proposer == address(0)) revert InvalidProposal();
        return p;
    }

    function hasVoted(uint256 proposalId, address member) external view returns (bool) {
        return _saleStorage().hasVoted[proposalId][member];
    }

    function lastProposed(address member) external view returns (uint64) {
        return _saleStorage().lastProposed[member];
    }

    function activeProposalId() external view returns (uint256) {
        return _saleStorage().activeProposalId;
    }

    function nextProposalId() external view returns (uint256) {
        uint256 next = _saleStorage().nextProposalId;
        return next == 0 ? 1 : next;
    }

    /// @notice Reports the two vote thresholds; execution must separately check state and expiry.
    function proposalPassed(uint256 proposalId) external view returns (bool) {
        return SaleGovernance.passed(_saleStorage(), proposalId);
    }

    function transfer(address to, uint256 amount) public override nonReentrant returns (bool) {
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override nonReentrant returns (bool) {
        return super.transferFrom(from, to, amount);
    }

    function _onlyShareMarket(VaultStorage storage s) private view {
        if (msg.sender != IPoolFactoryRoles(s.factory).shareMarket()) revert Unauthorized();
    }

    function _requireShareQuantity(uint256 amount) private pure {
        if (amount == 0) revert InvalidShareCount();
        if (amount > maxShares) revert ShareOutOfRange();
    }

    function lock(address member, uint256 amount) external nonReentrant {
        VaultStorage storage s = _vaultStorage();
        _onlyShareMarket(s);
        if (s.state != State.Active) revert WrongState();
        _requireShareQuantity(amount);
        uint256 previous = s.lockedShares[member];
        if (amount > balanceOf(member) - previous) revert InsufficientUnlockedShares();
        s.lockedShares[member] = previous + amount;
        emit LockedSharesChanged(member, previous, previous + amount);
    }

    function unlock(address member, uint256 amount) external nonReentrant {
        VaultStorage storage s = _vaultStorage();
        _onlyShareMarket(s);
        _requireShareQuantity(amount);
        uint256 previous = s.lockedShares[member];
        if (amount > previous) revert InsufficientLockedShares();
        s.lockedShares[member] = previous - amount;
        emit LockedSharesChanged(member, previous, previous - amount);
    }

    function transferLocked(address seller, address buyer, uint256 amount) external nonReentrant {
        VaultStorage storage s = _vaultStorage();
        _onlyShareMarket(s);
        _requireShareQuantity(amount);
        uint256 previous = s.lockedShares[seller];
        if (amount > previous) revert InsufficientLockedShares();
        // Release precisely this order's fill, then use the normal guarded balance path.
        // There is no global bypass flag that another transfer could inherit.
        s.lockedShares[seller] = previous - amount;
        emit LockedSharesChanged(seller, previous, previous - amount);
        _transfer(seller, buyer, amount);
    }

    function lockedShares(address member) external view returns (uint256) {
        return _vaultStorage().lockedShares[member];
    }

    function availableShares(address member) external view returns (uint256) {
        return balanceOf(member) - _vaultStorage().lockedShares[member];
    }

    function expiryEnabled() external view returns (bool) {
        return !_rewardStorage().expiryDisabled;
    }

    function claimable(address member) external view returns (uint256) {
        return RewardAccounting.claimable(_rewardStorage(), member, balanceOf(member));
    }

    function accBemPerShare() external view returns (uint256) {
        return _rewardStorage().acc;
    }

    function bemAccounted() external view returns (uint256) {
        return _rewardStorage().bemAccounted;
    }

    function epochNet(uint32 epoch) external view returns (uint256) {
        return _rewardStorage().epochNet[epoch];
    }

    function epochPaid(uint32 epoch) external view returns (uint256) {
        return _rewardStorage().epochPaid[epoch];
    }

    function epochBurned(uint32 epoch) external view returns (uint256) {
        return _rewardStorage().epochBurned[epoch];
    }

    /// @notice Sum of explicitly settled fractional BEM (scaled 1e36), retained as historical data after burn.
    /// This is neither all unsettled dust nor an additional liability on top of epochNet - epochPaid.
    function epochRemainderScaled(uint32 epoch) external view returns (uint256) {
        return _rewardStorage().epochRemainderScaled[epoch];
    }

    function totalGlobalRemainderScaled() external view returns (uint256) {
        return _rewardStorage().totalGlobalRemainderScaled;
    }

    function lastClaimAt(address member) external view returns (uint64) {
        return _rewardStorage().users[member].lastClaimAt;
    }

    function bemOwed(address member) external view returns (uint256) {
        return _rewardStorage().users[member].owed;
    }

    function rewardSlot(address member, uint8 index)
        external
        view
        returns (uint32 epoch, uint256 amount, uint256 remainder)
    {
        RewardSlot storage slot = _rewardStorage().users[member].slots[index];
        return (slot.epoch, slot.amount, slot.remainder);
    }

    function _update(address from, address to, uint256 amount) internal override {
        VaultStorage storage s = _vaultStorage();
        // Neither contract can manage a member's shares, votes or pull-payment rights.
        // Apply to minting too, so a future subscription entry point cannot bypass the guard.
        if (to == address(this) || to == s.factory) revert InvalidShareRecipient();
        if (from != address(0) && to != address(0)) {
            if (s.state != State.Active) revert WrongState();
            address market = IPoolFactoryRoles(s.factory).shareMarket();
            // Register before enabling transfers, so the market can never become a voting member.
            if (market == address(0)) revert WrongState();
            if (to == market) revert MarketCannotHoldShares();
            _requireShareQuantity(amount);
            if (amount > balanceOf(from) - s.lockedShares[from]) revert InsufficientUnlockedShares();
            // A failed ordinary harvest must not shift unclaimed old income to the new owner.
            _harvest(true);
            _settleRewards(from);
            if (to != from) _settleRewards(to);
        } else if (s.state != State.Funding) {
            revert WrongState();
        }
        // Before changing balances, permanently assign acquisition-time BNB to the old holders.
        if (from != address(0)) _materializePurchaseSurplus(s, from);
        if (to != address(0)) _materializePurchaseSurplus(s, to);
        super._update(from, to, amount);
        if ((from != address(0) && balanceOf(from) > maxShares) || (to != address(0) && balanceOf(to) > maxShares)) {
            revert ShareOutOfRange();
        }
        (uint208 previousCount, uint208 currentCount) = ShareCheckpoints.sync(
            s.activeMembers,
            s.memberIndexPlusOne,
            s.shareHistory,
            s.memberHistory,
            from,
            to,
            balanceOf(from),
            balanceOf(to),
            clock()
        );
        if (previousCount != currentCount) emit MemberCountChanged(previousCount, currentCount);
    }

    function getPastShares(address member, uint48 timestamp) external view returns (uint256) {
        if (timestamp >= clock()) revert FutureLookup();
        return _vaultStorage().shareHistory[member].upperLookupRecent(timestamp);
    }

    function getPastMemberCount(uint48 timestamp) external view returns (uint256) {
        if (timestamp >= clock()) revert FutureLookup();
        return _vaultStorage().memberHistory.upperLookupRecent(timestamp);
    }

    function clock() public view returns (uint48) {
        return SafeCast.toUint48(block.timestamp);
    }

    function CLOCK_MODE() external pure returns (string memory) {
        return "mode=timestamp";
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function asset() external pure returns (address) {
        return address(0);
    }

    function assetDecimals() external pure returns (uint8) {
        return 18;
    }

    function assetOwed(address asset_, address member) external view returns (uint256) {
        if (asset_ != address(0)) revert UnsupportedSubscriptionAsset();
        VaultStorage storage s = _vaultStorage();
        return s.bnbOwed[member] + _pendingPurchaseSurplus(s, member) + pendingSaleProceeds(member);
    }

    function state() external view returns (State) {
        return _vaultStorage().state;
    }

    function params() external view returns (PoolParams memory) {
        return _vaultStorage().params;
    }

    function factory() external view returns (address) {
        return _vaultStorage().factory;
    }

    function treasury() external view returns (address) {
        return _vaultStorage().treasury;
    }

    function unitPriceWei() external view returns (uint256) {
        return _vaultStorage().unitPriceWei;
    }

    function totalRaised() external view returns (uint256) {
        return _vaultStorage().totalRaised;
    }

    function contributedWei(address member) external view returns (uint256) {
        return _vaultStorage().contributedWei[member];
    }

    function bnbOwed(address member) external view returns (uint256) {
        VaultStorage storage s = _vaultStorage();
        return s.bnbOwed[member] + _pendingPurchaseSurplus(s, member) + pendingSaleProceeds(member);
    }

    function totalBnbOwed() external view returns (uint256) {
        VaultStorage storage s = _vaultStorage();
        return s.totalBnbOwed + s.surplusOutstandingWei + _saleStorage().saleOutstandingWei;
    }

    function refundsRecorded() external view returns (bool) {
        return _vaultStorage().refundsRecorded;
    }

    function depositPaused() external view returns (bool) {
        return _vaultStorage().depositPaused;
    }

    function activeMembers() external view returns (address[] memory) {
        return _vaultStorage().activeMembers;
    }

    function memberCount() external view returns (uint256) {
        return _vaultStorage().activeMembers.length;
    }

    function shareOf(address member) external view returns (uint256) {
        return balanceOf(member);
    }

    function purchaseCost() external view returns (uint256) {
        return _vaultStorage().purchaseCost;
    }

    function activatedAt() external view returns (uint64) {
        return _vaultStorage().activatedAt;
    }

    function surplusPerShareWei() external view returns (uint256) {
        return _vaultStorage().surplusPerShareWei;
    }

    function surplusRemainder() external view returns (uint256) {
        return _vaultStorage().surplusRemainder;
    }

    function surplusOutstandingWei() external view returns (uint256) {
        return _vaultStorage().surplusOutstandingWei;
    }

    function surplusSettled(address member) external view returns (bool) {
        return _vaultStorage().surplusSettled[member];
    }

    function pendingPurchaseSurplus(address member) external view returns (uint256) {
        return _pendingPurchaseSurplus(_vaultStorage(), member);
    }

    // WBNB.withdraw uses a 2300-gas transfer. The outer guarded burn pre-warms and
    // sets this exact expected refund; receive must not write storage or take a lock.
    receive() external payable {
        if (msg.sender != WBNB || msg.value == 0 || msg.value != _saleStorage().expectedWbnbRefund) {
            revert UnsupportedSubscriptionAsset();
        }
    }
}
