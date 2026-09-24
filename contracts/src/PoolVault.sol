// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolVault, IPoolFactoryRoles} from "./interfaces/IPoolVault.sol";

/// @notice T1a funding/refunds implementation. Purchase, mining and transfers activate in later task cards.
contract PoolVault is ERC20Upgradeable, ReentrancyGuardUpgradeable, IPoolVault {
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
        uint256 amount = s.bnbOwed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        s.bnbOwed[msg.sender] = 0;
        s.totalBnbOwed -= amount;
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit BnbWithdrawn(msg.sender, amount);
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
        super._update(from, to, amount);
        VaultStorage storage s = _vaultStorage();
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
        return _vaultStorage().bnbOwed[member];
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
        return _vaultStorage().bnbOwed[member];
    }

    function totalBnbOwed() external view returns (uint256) {
        return _vaultStorage().totalBnbOwed;
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

    // Plain BNB does not constitute a subscription. T1b will add a validated purchase callback context.
    receive() external payable {
        revert UnsupportedSubscriptionAsset();
    }
}
