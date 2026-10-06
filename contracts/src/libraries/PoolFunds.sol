// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPoolVault, IPoolFactoryRoles} from "../interfaces/IPoolVault.sol";
import {PoolVaultState} from "../PoolVaultState.sol";
import {TargetOwner} from "./TargetOwner.sol";

/// @notice Existing BNB liabilities and purchase surplus, in the guarded Vault context.
/// @dev Vault retains mint/burn, NFT verification and each nonReentrant entry point.
library PoolFunds {
    uint256 private constant TOTAL_SHARES = 100;

    event Failed(uint8 reason);
    event Funded(uint256 totalRaised, uint256 totalShares, uint256 memberCount);
    event BnbWithdrawn(address indexed user, uint256 amount);
    event Purchased(uint256 cost, uint8 path, uint256 listingId);
    event PurchaseSurplusSettled(address indexed user, uint256 shares, uint256 amount);

    /// @dev Vault's initializer and immutable factory check guard this delegate call.
    function initialize(
        PoolVaultState.VaultStorage storage s,
        address factory,
        IPoolVault.PoolParams calldata params,
        address treasury
    ) external {
        if (msg.sender != factory || factory.code.length == 0 || treasury == address(0)) {
            revert IPoolVault.Unauthorized();
        }
        if (params.targetRaise == 0 || params.targetRaise % TOTAL_SHARES != 0) {
            revert IPoolVault.FundingTargetNotDivisible();
        }
        if (params.priceCap == 0 || params.priceCap > params.targetRaise) revert IPoolVault.OverPriceCap();
        if (params.fundingDeadline <= block.timestamp || params.purchaseDeadline <= params.fundingDeadline) {
            revert IPoolVault.InvalidParameters();
        }
        s.factory = factory;
        s.treasury = treasury;
        s.params = params;
        s.unitPriceWei = params.targetRaise / TOTAL_SHARES;
        s.state = IPoolVault.State.Funding;
        TargetOwner.initialize(s);
    }

    /// @notice Wallet metadata identifies both the collection and the intended miner.
    function shareName(address circuits, uint256 circuitId) external pure returns (string memory) {
        string memory collection = circuits == 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C ? "Behemoth" : "TapeOut";
        return string.concat(collection, " #", Strings.toString(circuitId), " Pool Share");
    }

    function finalizeFailure(PoolVaultState.VaultStorage storage s) external {
        uint8 reason = 0;
        if (s.state == IPoolVault.State.Funding) {
            if (block.timestamp < s.params.fundingDeadline) revert IPoolVault.DeadlineNotReached();
        } else if (s.state == IPoolVault.State.Funded) {
            if (block.timestamp < s.params.purchaseDeadline) revert IPoolVault.DeadlineNotReached();
            reason = 1;
        } else {
            revert IPoolVault.WrongState();
        }
        _recordFailure(s, reason);
    }

    /// @dev Existing deposit conditions and accounting. Vault supplies its actual balances and mints under nonReentrant.
    function recordDeposit(PoolVaultState.VaultStorage storage s, uint8 shares, uint256 memberShares, uint256 supply)
        external
        returns (uint256 amount)
    {
        if (s.factory == address(0)) revert IPoolVault.Unauthorized();
        if (s.state != IPoolVault.State.Funding) revert IPoolVault.WrongState();
        if (s.depositPaused) revert IPoolVault.DepositPaused();
        TargetOwner.assertFundable(s);
        address subscriber = IPoolFactoryRoles(s.factory).designatedSubscriber(address(this));
        if (subscriber != address(0) && msg.sender != subscriber) revert IPoolVault.Unauthorized();
        if (block.timestamp >= s.params.fundingDeadline) revert IPoolVault.DeadlinePassed();
        if (shares == 0) revert IPoolVault.InvalidShareCount();
        if (shares > TOTAL_SHARES || memberShares + shares > TOTAL_SHARES) revert IPoolVault.ShareOutOfRange();
        if (supply + shares > TOTAL_SHARES) revert IPoolVault.ExceedsTarget();
        amount = uint256(shares) * s.unitPriceWei;
        if (msg.value != amount) revert IPoolVault.PaymentMismatch();
        s.contributedWei[msg.sender] += amount;
        s.totalRaised += amount;
    }

    function recordFullyFunded(PoolVaultState.VaultStorage storage s, uint256 supply) external {
        if (s.activeMembers.length < 1) revert IPoolVault.NotEnoughMembers();
        if (supply != TOTAL_SHARES || s.totalRaised != s.params.targetRaise) revert IPoolVault.PaymentMismatch();
        s.state = IPoolVault.State.Funded;
        emit Funded(s.totalRaised, supply, s.activeMembers.length);
    }

    /// @dev Existing full-subscription withdrawal; Vault burns the verified caller's shares after accounting.
    function recordDepositWithdrawal(PoolVaultState.VaultStorage storage s, uint256 shares)
        external
        returns (uint256 amount)
    {
        if (s.state != IPoolVault.State.Funding) revert IPoolVault.WrongState();
        if (shares == 0) revert IPoolVault.NotMember();
        amount = s.contributedWei[msg.sender];
        s.contributedWei[msg.sender] = 0;
        s.totalRaised -= amount;
        _credit(s, msg.sender, amount);
    }

    function configureTargetOwner(PoolVaultState.VaultStorage storage s, bytes calldata encoded) external {
        if (encoded.length != 512) revert IPoolVault.InvalidTargetOwnerAuthorization();
        (
            IPoolVault.TargetOwnerAuthorization memory authorization,
            bytes memory signatureOne,
            bytes memory signatureTwo
        ) = abi.decode(encoded, (IPoolVault.TargetOwnerAuthorization, bytes, bytes));
        if (
            signatureOne.length != 65 || signatureTwo.length != 65
                || keccak256(encoded) != keccak256(abi.encode(authorization, signatureOne, signatureTwo))
        ) {
            revert IPoolVault.InvalidTargetOwnerAuthorization();
        }
        TargetOwner.configure(s, authorization, signatureOne, signatureTwo);
    }

    function syncTargetAvailability(PoolVaultState.VaultStorage storage s) external returns (bool refunded) {
        if (s.state != IPoolVault.State.Funding && s.state != IPoolVault.State.Funded) revert IPoolVault.WrongState();
        if (!TargetOwner.unavailable(s)) return false;
        _recordFailure(s, 2);
        return true;
    }

    function _recordFailure(PoolVaultState.VaultStorage storage s, uint8 reason) private {
        if (s.refundsRecorded) revert IPoolVault.WrongState();
        s.state = IPoolVault.State.Refunding;
        s.refundsRecorded = true;
        uint256 count = s.activeMembers.length;
        for (uint256 i; i < count; ++i) {
            address member = s.activeMembers[i];
            uint256 amount = s.contributedWei[member];
            s.contributedWei[member] = 0;
            _credit(s, member, amount);
        }
        emit Failed(reason);
    }

    /// @dev Called only after Vault has verified its exact expected NFT callback, owner and miner key.
    function recordPurchase(PoolVaultState.VaultStorage storage s, uint256 cost, uint8 path, uint256 listingId)
        external
    {
        delete s.expectedNftSeller;
        delete s.expectedNftOperator;
        delete s.nftReceived;
        s.purchaseCost = cost;
        s.activatedAt = SafeCast.toUint64(block.timestamp);
        s.state = IPoolVault.State.Active;
        uint256 surplus = s.totalRaised - cost;
        s.surplusPerShareWei = surplus / TOTAL_SHARES;
        // Deterministic integer division remainder, not randomness.
        // slither-disable-next-line weak-prng
        s.surplusRemainder = surplus % TOTAL_SHARES;
        s.surplusOutstandingWei = s.surplusPerShareWei * TOTAL_SHARES;
        emit Purchased(cost, path, listingId);
    }

    function pendingPurchase(PoolVaultState.VaultStorage storage s, address member, uint256 shares)
        external
        view
        returns (uint256)
    {
        return _pending(s, member, shares);
    }

    function materializePurchase(PoolVaultState.VaultStorage storage s, address member, uint256 shares) external {
        if (!_hasPurchase(s.state) || s.surplusSettled[member]) return;
        uint256 amount = shares * s.surplusPerShareWei;
        s.surplusOutstandingWei -= amount;
        // A budget project is the sole holder of all 100 child shares. Its exact
        // purchase surplus belongs to that same holder, including the <100 wei
        // division tail. The old per-share path remains unchanged for split pools.
        if (shares == TOTAL_SHARES) {
            amount += s.surplusRemainder;
            s.surplusRemainder = 0;
        }
        s.surplusSettled[member] = true;
        _credit(s, member, amount);
        emit PurchaseSurplusSettled(member, shares, amount);
    }

    /// @dev Only the original caller's credit can be withdrawn; CEI precedes its one external call.
    function withdraw(PoolVaultState.VaultStorage storage s) external {
        uint256 amount = s.bnbOwed[msg.sender];
        if (amount == 0) revert IPoolVault.NothingToClaim();
        s.bnbOwed[msg.sender] = 0;
        s.totalBnbOwed -= amount;
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert IPoolVault.TransferFailed();
        emit BnbWithdrawn(msg.sender, amount);
    }

    function _credit(PoolVaultState.VaultStorage storage s, address member, uint256 amount) private {
        s.bnbOwed[member] += amount;
        s.totalBnbOwed += amount;
    }

    function _pending(PoolVaultState.VaultStorage storage s, address member, uint256 shares)
        private
        view
        returns (uint256)
    {
        if (!_hasPurchase(s.state) || s.surplusSettled[member]) return 0;
        uint256 amount = shares * s.surplusPerShareWei;
        if (shares == TOTAL_SHARES) amount += s.surplusRemainder;
        return amount;
    }

    function _hasPurchase(IPoolVault.State state) private pure returns (bool) {
        return state == IPoolVault.State.Active || state == IPoolVault.State.Listed || state == IPoolVault.State.Closed;
    }
}
