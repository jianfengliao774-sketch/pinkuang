// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IPoolVault, IPoolFactoryRoles} from "./interfaces/IPoolVault.sol";
import {ITapeoutMining} from "./interfaces/ITapeoutMining.sol";
import {ICircuitMarket} from "./interfaces/ICircuitMarket.sol";

/// @notice BNB funding, refunds and atomic NFT acquisition. Rewards and transfers activate in later task cards.
contract PoolVault is ERC20Upgradeable, ReentrancyGuardUpgradeable, IPoolVault, IERC721Receiver {
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

    /// @custom:storage-location erc7201:tapeout.storage.PoolVault
    struct VaultStorage {
        address factory;
        address treasury;
        PoolParams params;
        State state;
        bool depositPaused;
        bool refundsRecorded;
        uint256 unitPriceWei;
        uint256 totalRaised;
        uint256 totalBnbOwed;
        mapping(address => uint256) contributedWei;
        mapping(address => uint256) bnbOwed;
        address[] activeMembers;
        mapping(address => uint256) memberIndexPlusOne;
        mapping(address => Checkpoints.Trace208) shareHistory;
        Checkpoints.Trace208 memberHistory;
        // T1b additions: append only; compare against docs/storage/T1a-PoolVault.json.
        uint256 purchaseCost;
        uint64 activatedAt;
        uint256 surplusPerShareWei;
        uint256 surplusRemainder;
        uint256 surplusOutstandingWei;
        mapping(address => bool) surplusSettled;
        address expectedNftSeller;
        address expectedNftOperator;
        bool nftReceived;
    }

    bytes32 private constant VAULT_STORAGE_LOCATION =
        0x91bfb6bda130bea719738fb057a72863be36ca25095a844c93b1e775e47e6d00;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _vaultStorage() private pure returns (VaultStorage storage s) {
        assembly { s.slot := VAULT_STORAGE_LOCATION }
    }

    function initialize(address factory_, PoolParams calldata params_, address treasury_) external initializer {
        if (msg.sender != factory_ || factory_.code.length == 0 || treasury_ == address(0)) revert Unauthorized();
        if (params_.targetRaise == 0 || params_.targetRaise % TOTAL_SHARES != 0) revert FundingTargetNotDivisible();
        if (params_.priceCap == 0 || params_.priceCap > params_.targetRaise) revert OverPriceCap();
        if (params_.fundingDeadline <= block.timestamp || params_.purchaseDeadline <= params_.fundingDeadline) {
            revert InvalidParameters();
        }
        __ERC20_init("TapeOut Pool Share", "TPS");
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
        VaultStorage storage s = _vaultStorage();
        uint8 reason = 0;
        if (s.state == State.Funding) {
            if (block.timestamp < s.params.fundingDeadline) revert DeadlineNotReached();
        } else if (s.state == State.Funded) {
            if (block.timestamp < s.params.purchaseDeadline) revert DeadlineNotReached();
            reason = 1;
        } else {
            revert WrongState();
        }
        if (s.refundsRecorded) revert WrongState();
        s.state = State.Refunding;
        s.refundsRecorded = true;
        // At most 100 current members. Record liabilities only; never call members in this loop.
        uint256 count = s.activeMembers.length;
        for (uint256 i; i < count; ++i) {
            address member = s.activeMembers[i];
            uint256 amount = s.contributedWei[member];
            s.contributedWei[member] = 0;
            _creditBnb(s, member, amount);
        }
        // Frozen historical shares and totalRaised remain available after failure.
        emit Failed(reason);
    }

    function _creditBnb(VaultStorage storage s, address member, uint256 amount) private {
        s.bnbOwed[member] += amount;
        s.totalBnbOwed += amount;
    }

    function withdrawBnb() external nonReentrant {
        VaultStorage storage s = _vaultStorage();
        _materializePurchaseSurplus(s, msg.sender);
        uint256 amount = s.bnbOwed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        s.bnbOwed[msg.sender] = 0;
        s.totalBnbOwed -= amount;
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit BnbWithdrawn(msg.sender, amount);
    }

    function buyFromMarket(uint256 listingId) external nonReentrant {
        VaultStorage storage s = _requirePurchaseWindow();
        // M0: feeBps is deducted from the seller's price; the buyer pays exactly price.
        // Deliberately ignore that display field: adding it would charge the buyer twice.
        // slither-disable-next-line unused-return
        (address seller, address circuits, uint256 tokenId, uint96 price,, bool valid) =
            ICircuitMarket(CIRCUIT_MARKET).listingView(listingId);
        if (!valid || seller == address(0) || price == 0) revert InvalidListing();
        if (circuits != s.params.circuits || tokenId != s.params.circuitId) revert WrongCircuit();
        if (price > s.params.priceCap) revert OverPriceCap();
        if (IERC721(circuits).ownerOf(tokenId) != seller) revert InvalidListing();
        bytes32 key = _activeMinerKey(s);
        _settleSellerRewards(
            s, seller, key, keccak256(abi.encode(address(this), uint8(0), listingId, seller, key, price))
        );
        _expectNft(s, seller, CIRCUIT_MARKET);
        // M0 proves that the listed price is the buyer's entire payment, including the seller-borne 1% fee.
        ICircuitMarket(CIRCUIT_MARKET).buy{value: price}(listingId, price);
        _finishPurchase(s, price, 0, listingId, key);
    }

    function sellToPool() external nonReentrant {
        VaultStorage storage s = _requirePurchaseWindow();
        address seller = s.params.directSeller;
        uint256 price = s.params.directPrice;
        if (seller == address(0) || msg.sender != seller) revert Unauthorized();
        if (price == 0 || price > s.params.priceCap) revert OverPriceCap();
        if (IERC721(s.params.circuits).ownerOf(s.params.circuitId) != seller) revert InvalidListing();
        bytes32 key = _activeMinerKey(s);
        _settleSellerRewards(
            s, seller, key, keccak256(abi.encode(address(this), uint8(1), uint256(0), seller, key, price))
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
        key = ITapeoutMining(MINING).minerKey(s.params.circuits, s.params.circuitId);
        ITapeoutMining.Miner memory miner = ITapeoutMining(MINING).getMiner(key);
        if (miner.circuits != s.params.circuits || miner.circuitId != s.params.circuitId) revert WrongCircuit();
        if (miner.status != 1) revert MinerNotActive();
    }

    function _settleSellerRewards(VaultStorage storage s, address seller, bytes32 key, bytes32 tradeId) private {
        uint256 pendingBefore = ITapeoutMining(MINING).pending(key);
        uint256 beforeBalance = IERC20(BEM).balanceOf(seller);
        // M0 shows pending() can be stale, including zero. Never skip claim or swallow a failure.
        try ITapeoutMining(MINING).claim(key) {}
        catch {
            revert FinalRewardSettlementFailed();
        }
        uint256 afterBalance = IERC20(BEM).balanceOf(seller);
        // Both callers hold nonReentrant. This delta proves receipt; the earlier balance
        // is not used to authorize an outgoing payment after an unguarded external call.
        // slither-disable-next-line reentrancy-balance
        if (afterBalance < beforeBalance || afterBalance - beforeBalance < pendingBefore) {
            revert FinalRewardSettlementFailed();
        }
        if (
            ITapeoutMining(MINING).pending(key) != 0 || IERC721(s.params.circuits).ownerOf(s.params.circuitId) != seller
        ) revert FinalRewardSettlementFailed();
        emit RewardSettledBeforeTransfer(
            s.params.circuits, s.params.circuitId, seller, afterBalance - beforeBalance, tradeId
        );
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
        delete s.expectedNftSeller;
        delete s.expectedNftOperator;
        delete s.nftReceived;
        s.purchaseCost = cost;
        s.activatedAt = SafeCast.toUint64(block.timestamp);
        s.state = State.Active;
        uint256 surplus = s.totalRaised - cost;
        s.surplusPerShareWei = surplus / TOTAL_SHARES;
        // Deterministic integer division remainder, not randomness or a timestamp lottery.
        // slither-disable-next-line weak-prng
        s.surplusRemainder = surplus % TOTAL_SHARES;
        s.surplusOutstandingWei = s.surplusPerShareWei * TOTAL_SHARES;
        emit Purchased(cost, path, listingId);
    }

    function _pendingPurchaseSurplus(VaultStorage storage s, address member) private view returns (uint256) {
        if (s.state != State.Active && s.state != State.Listed && s.state != State.Closed) return 0;
        if (s.surplusSettled[member]) return 0;
        // Until a member's first balance change, current shares equal their acquisition shares.
        // _update MUST materialize both parties before any future Active transfer is enabled.
        return balanceOf(member) * s.surplusPerShareWei;
    }

    function _materializePurchaseSurplus(VaultStorage storage s, address member) private {
        if (s.state != State.Active && s.state != State.Listed && s.state != State.Closed) return;
        if (s.surplusSettled[member]) return;
        uint256 amount = _pendingPurchaseSurplus(s, member);
        s.surplusSettled[member] = true;
        s.surplusOutstandingWei -= amount;
        _creditBnb(s, member, amount);
        emit PurchaseSurplusSettled(member, balanceOf(member), amount);
    }

    function setDepositPaused(bool paused) external {
        VaultStorage storage s = _vaultStorage();
        if (msg.sender != IPoolFactoryRoles(s.factory).operator()) revert Unauthorized();
        s.depositPaused = paused;
        emit DepositPauseChanged(paused);
    }

    function _update(address from, address to, uint256 amount) internal override {
        // T1d must insert harvest/debt settlement and locked-share rules before enabling transfers.
        if (from != address(0) && to != address(0)) revert WrongState();
        VaultStorage storage s = _vaultStorage();
        // T1d will relax the transfer guard only after installing reward and locked-share rules.
        // Keep these before super._update: same-second transfers must not carry old purchase surplus.
        if (from != address(0)) _materializePurchaseSurplus(s, from);
        if (to != address(0)) _materializePurchaseSurplus(s, to);
        super._update(from, to, amount);
        if (from != address(0)) _syncMember(s, from);
        if (to != address(0)) _syncMember(s, to);
        (uint208 previousCount, uint208 currentCount) =
            s.memberHistory.push(clock(), SafeCast.toUint208(s.activeMembers.length));
        if (previousCount != currentCount) emit MemberCountChanged(previousCount, currentCount);
    }

    function _syncMember(VaultStorage storage s, address member) private {
        uint256 balance = balanceOf(member);
        uint256 index = s.memberIndexPlusOne[member];
        (uint208 previousShares, uint208 currentShares) =
            s.shareHistory[member].push(clock(), SafeCast.toUint208(balance));
        // These are integer SHARE VALUES returned by Checkpoints, not its timestamp keys.
        // Zero is precisely the membership boundary; neither value is an external BNB balance.
        // slither-disable-next-line incorrect-equality
        if (currentShares != 0 && previousShares == 0) {
            s.activeMembers.push(member);
            s.memberIndexPlusOne[member] = s.activeMembers.length;
            // slither-disable-next-line incorrect-equality
        } else if (currentShares == 0 && previousShares != 0) {
            uint256 last = s.activeMembers.length;
            if (index != last) {
                address moved = s.activeMembers[last - 1];
                s.activeMembers[index - 1] = moved;
                s.memberIndexPlusOne[moved] = index;
            }
            s.activeMembers.pop();
            delete s.memberIndexPlusOne[member];
        }
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
        return s.bnbOwed[member] + _pendingPurchaseSurplus(s, member);
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
        return s.bnbOwed[member] + _pendingPurchaseSurplus(s, member);
    }

    function totalBnbOwed() external view returns (uint256) {
        VaultStorage storage s = _vaultStorage();
        return s.totalBnbOwed + s.surplusOutstandingWei;
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

    // Plain BNB does not constitute a subscription; buyer-side acquisition never needs a BNB receive callback.
    receive() external payable {
        revert UnsupportedSubscriptionAsset();
    }
}
