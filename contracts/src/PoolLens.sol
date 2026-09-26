// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {PoolSaleState} from "./PoolSaleState.sol";

/// @notice Versioned, bounded read aggregation for one trusted Factory. Holds no funds or permissions.
/// @dev Pin this deployment and its factory on the client. Masks distinguish failed reads from real zeroes.
///      Use a fixed RPC blockTag across pages. Historical holders must not be filtered by current shares.
contract PoolLens {
    uint256 public constant VERSION = 1;
    uint256 public constant MAX_POOLS = 20;
    uint256 private constant READ_GAS = 60000;
    uint256 private constant ACCOUNTING_GAS = 1000000;
    address public immutable factory;

    error ZeroFactory();
    error TooManyPools();
    error RegistryUnavailable();

    enum TrustError {
        None,
        RegistryReadFailed,
        NotRegistered,
        IdentityReadFailed,
        IdentityMismatch
    }

    // Each enum ordinal is a bit index, not a mask. Unattempted fields have neither bit set.
    enum Field {
        Identity,
        Params,
        State,
        UnitPrice,
        Raised,
        Supply,
        Members,
        Paused,
        PurchaseCost,
        ActivatedAt,
        TradingAllowed,
        Shares,
        Locked,
        Available,
        Claimable,
        BnbOwed,
        InitialContribution
    }

    enum GovernanceField {
        Identity,
        State,
        ActiveProposal,
        Proposal,
        PurchaseCost,
        HasVoted,
        SnapshotShares,
        ListedProposal,
        ExpiresAt,
        SalePrice,
        Thresholds,
        Eligibility,
        CancelEligibility,
        ExecutionEligibility
    }

    enum ReferenceField {
        Identity,
        Configuration,
        Model,
        Weight
    }

    struct ReadStatus {
        uint256 validMask;
        uint256 errorMask;
        TrustError trustError;
    }

    struct PoolRow {
        address pool;
        ReadStatus status;
        IPoolVault.PoolParams params;
        uint256 state;
        uint256 unitPriceWei;
        uint256 totalRaised;
        uint256 totalSupply;
        uint256 memberCount;
        bool depositPaused;
        uint256 purchaseCost;
        uint256 activatedAt;
        bool shareTradingAllowed;
        uint256 shares;
        uint256 lockedShares;
        uint256 availableShares;
        uint256 claimableBEM;
        uint256 bnbOwed;
        uint256 initialContributedWei;
    }

    struct Snapshot {
        uint256 blockNumber;
        uint256 timestamp;
        uint256 totalPools;
        uint256 nextCursor;
        bool registryCountValid;
        PoolRow[] pools;
    }

    struct Governance {
        ReadStatus status;
        uint256 state;
        uint256 activeProposalId;
        PoolSaleState.Proposal proposal;
        uint256 purchaseCost;
        bool hasVoted;
        uint256 snapshotShares;
        uint256 listedProposalId;
        uint256 expiresAt;
        uint256 salePrice;
        uint256 requiredYesCount;
        uint256 requiredYesShares;
        bool discounted;
        bool passed;
        bool canVote;
        bool canExecute;
        bool canCancelExpired;
    }

    struct PurchaseReference {
        ReadStatus status;
        bool enabled;
        uint256 referenceCircuitId;
        IPoolVault.FlexiblePurchaseConfig config;
        bool modelInitialized;
        uint32 taskId;
        uint128 referenceVerifiedWeight;
    }

    /// @dev Factory may deploy this while its proxy constructor is still running (code.length == 0).
    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroFactory();
        factory = factory_;
    }

    function poolPage(uint256 offset, uint256 limit, address account) external view returns (Snapshot memory result) {
        if (limit > MAX_POOLS) revert TooManyPools();
        result = _snapshot();
        if (!result.registryCountValid) revert RegistryUnavailable();
        uint256 count = offset < result.totalPools ? result.totalPools - offset : 0;
        if (count > limit) count = limit;
        result.nextCursor = count == 0 ? (offset < result.totalPools ? offset : result.totalPools) : offset + count;
        result.pools = new PoolRow[](count);
        for (uint256 i = 0; i < count; ++i) {
            (bool ok, bytes memory data) =
                _read(factory, abi.encodeWithSignature("allPools(uint256)", offset + i), 32, READ_GAS);
            uint256 value = _word(data, 0);
            // This raw ABI word represents an address: exactly zero is forbidden, not a funding threshold.
            // slither-disable-next-line incorrect-equality
            if (!ok || value == 0 || value > type(uint160).max) {
                result.pools[i].status.errorMask = 1;
                result.pools[i].status.trustError = TrustError.RegistryReadFailed;
            } else {
                result.pools[i] = _pool(address(uint160(value)), account);
            }
        }
    }

    /// @notice Includes zero-share and Closed/Refunding positions; caller supplies previously discovered pool addresses.
    function positions(address[] calldata pools, address account) external view returns (Snapshot memory result) {
        if (pools.length > MAX_POOLS) revert TooManyPools();
        result = _snapshot();
        result.pools = new PoolRow[](pools.length);
        for (uint256 i = 0; i < pools.length; ++i) {
            result.pools[i] = _pool(pools[i], account);
        }
        // Explicit addresses have no registry cursor; nextCursor remains zero.
    }

    function _snapshot() private view returns (Snapshot memory result) {
        result.blockNumber = block.number;
        result.timestamp = block.timestamp;
        (bool ok, bytes memory data) = _read(factory, abi.encodeWithSignature("poolCount()"), 32, READ_GAS);
        result.registryCountValid = ok;
        if (ok) result.totalPools = _word(data, 0);
    }

    function _pool(address pool, address account) private view returns (PoolRow memory r) {
        r.pool = pool;
        if (!_trusted(pool, r.status)) return r;
        (bool ok, bytes memory data) = _read(pool, abi.encodeWithSignature("params()"), 256, READ_GAS);
        ok = ok && _word(data, 0) <= type(uint160).max && _word(data, 4) <= type(uint160).max
            && _word(data, 6) <= type(uint64).max && _word(data, 7) <= type(uint64).max;
        _mark(r.status, uint256(Field.Params), ok);
        if (ok) r.params = abi.decode(data, (IPoolVault.PoolParams));
        r.state = _field(r.status, uint256(Field.State), pool, abi.encodeWithSignature("state()"), 5, READ_GAS);
        r.unitPriceWei = _field(
            r.status,
            uint256(Field.UnitPrice),
            pool,
            abi.encodeWithSignature("unitPriceWei()"),
            type(uint256).max,
            READ_GAS
        );
        r.totalRaised = _field(
            r.status, uint256(Field.Raised), pool, abi.encodeWithSignature("totalRaised()"), type(uint256).max, READ_GAS
        );
        r.totalSupply =
            _field(r.status, uint256(Field.Supply), pool, abi.encodeWithSignature("totalSupply()"), 100, READ_GAS);
        r.memberCount =
            _field(r.status, uint256(Field.Members), pool, abi.encodeWithSignature("memberCount()"), 100, READ_GAS);
        // _field accepts only canonical ABI booleans (0 or 1); exactly 1 means true.
        // slither-disable-next-line incorrect-equality
        r.depositPaused =
            _field(r.status, uint256(Field.Paused), pool, abi.encodeWithSignature("depositPaused()"), 1, READ_GAS) == 1;
        r.purchaseCost = _field(
            r.status,
            uint256(Field.PurchaseCost),
            pool,
            abi.encodeWithSignature("purchaseCost()"),
            type(uint256).max,
            READ_GAS
        );
        r.activatedAt = _field(
            r.status,
            uint256(Field.ActivatedAt),
            pool,
            abi.encodeWithSignature("activatedAt()"),
            type(uint64).max,
            READ_GAS
        );
        // This is a validated ABI boolean, so equality to 1 is required to decode true.
        // slither-disable-next-line incorrect-equality
        r.shareTradingAllowed = _field(
            r.status, uint256(Field.TradingAllowed), pool, abi.encodeWithSignature("shareTradingAllowed()"), 1, READ_GAS
        ) == 1;
        if (account == address(0)) return r;
        r.shares = _field(
            r.status, uint256(Field.Shares), pool, abi.encodeWithSignature("balanceOf(address)", account), 100, READ_GAS
        );
        r.lockedShares = _field(
            r.status,
            uint256(Field.Locked),
            pool,
            abi.encodeWithSignature("lockedShares(address)", account),
            100,
            READ_GAS
        );
        r.availableShares = _field(
            r.status,
            uint256(Field.Available),
            pool,
            abi.encodeWithSignature("availableShares(address)", account),
            100,
            READ_GAS
        );
        if (_valid(
                r.status, (1 << uint256(Field.Shares)) | (1 << uint256(Field.Locked)) | (1 << uint256(Field.Available))
            )) {
            if (r.lockedShares > r.shares || r.availableShares != r.shares - r.lockedShares) {
                _mark(r.status, uint256(Field.Available), false);
                r.availableShares = 0;
            }
        }
        r.claimableBEM = _field(
            r.status,
            uint256(Field.Claimable),
            pool,
            abi.encodeWithSignature("claimable(address)", account),
            type(uint256).max,
            ACCOUNTING_GAS
        );
        // This getter already includes lazy purchase refunds and sale proceeds. Do not add them a second time.
        r.bnbOwed = _field(
            r.status,
            uint256(Field.BnbOwed),
            pool,
            abi.encodeWithSignature("bnbOwed(address)", account),
            type(uint256).max,
            ACCOUNTING_GAS
        );
        r.initialContributedWei = _field(
            r.status,
            uint256(Field.InitialContribution),
            pool,
            abi.encodeWithSignature("contributedWei(address)", account),
            type(uint256).max,
            READ_GAS
        );
    }

    /// @notice Eligibility is a snapshot, not a promise that a later transaction will succeed.
    function governance(address pool, address account) external view returns (Governance memory g) {
        if (!_trusted(pool, g.status)) return g;
        g.state =
            _field(g.status, uint256(GovernanceField.State), pool, abi.encodeWithSignature("state()"), 5, READ_GAS);
        g.activeProposalId = _field(
            g.status,
            uint256(GovernanceField.ActiveProposal),
            pool,
            abi.encodeWithSignature("activeProposalId()"),
            type(uint256).max,
            READ_GAS
        );
        g.purchaseCost = _field(
            g.status,
            uint256(GovernanceField.PurchaseCost),
            pool,
            abi.encodeWithSignature("purchaseCost()"),
            type(uint256).max,
            READ_GAS
        );
        g.listedProposalId = _field(
            g.status,
            uint256(GovernanceField.ListedProposal),
            pool,
            abi.encodeWithSignature("listedProposalId()"),
            type(uint256).max,
            READ_GAS
        );
        g.expiresAt = _field(
            g.status,
            uint256(GovernanceField.ExpiresAt),
            pool,
            abi.encodeWithSignature("expiresAt()"),
            type(uint64).max,
            READ_GAS
        );
        g.salePrice = _field(
            g.status,
            uint256(GovernanceField.SalePrice),
            pool,
            abi.encodeWithSignature("salePrice()"),
            type(uint256).max,
            READ_GAS
        );
        if (_valid(
                g.status,
                (1 << uint256(GovernanceField.State)) | (1 << uint256(GovernanceField.ListedProposal))
                    | (1 << uint256(GovernanceField.ExpiresAt))
            )) {
            _mark(g.status, uint256(GovernanceField.CancelEligibility), true);
            // Listed is the exact State enum tag 3; the deadline separately uses >=, not equality.
            // slither-disable-next-line incorrect-equality
            g.canCancelExpired = g.state == 3 && g.listedProposalId != 0 && block.timestamp >= g.expiresAt;
        }
        // Proposal IDs start at 1; exactly zero is the no-proposal sentinel, not a balance threshold.
        // slither-disable-next-line incorrect-equality
        if (!_valid(g.status, 1 << uint256(GovernanceField.ActiveProposal)) || g.activeProposalId == 0) return g;
        (bool ok, bytes memory data) =
            _read(pool, abi.encodeWithSignature("getProposal(uint256)", g.activeProposalId), 352, READ_GAS);
        // Every supported proposal snapshots exactly 100 shares; other totals must fail ABI/semantic validation.
        // slither-disable-next-line incorrect-equality
        ok = ok && _word(data, 0) != 0 && _word(data, 0) <= type(uint160).max && _word(data, 1) <= type(uint48).max
            && _word(data, 2) <= type(uint64).max && _word(data, 3) <= type(uint64).max && _word(data, 6) <= 100
            && _word(data, 7) == 100 && _word(data, 8) <= _word(data, 6) && _word(data, 9) <= 100
            && _word(data, 10) <= 1;
        _mark(g.status, uint256(GovernanceField.Proposal), ok);
        if (!ok) return g;
        g.proposal = abi.decode(data, (PoolSaleState.Proposal));
        _governanceDerived(pool, account, g);
    }

    function _governanceDerived(address pool, address account, Governance memory g) private view {
        // The old timestamp-1 format is not executable after the Vault upgrade.
        // Exact equality distinguishes it from a proposal made at the current checkpoint.
        // slither-disable-next-line incorrect-equality
        bool validSnapshot = uint256(g.proposal.snapshotTs) + 1 days == g.proposal.endsAt;
        if (_valid(g.status, 1 << uint256(GovernanceField.PurchaseCost))) {
            g.discounted = g.proposal.price < g.purchaseCost;
            g.requiredYesShares = g.discounted ? 60 : g.proposal.snapshotTotalShares / 2 + 1;
            g.requiredYesCount = g.proposal.snapshotMemberCount / 2 + 1;
            g.passed = validSnapshot && g.proposal.price != 0 && g.proposal.yesShares >= g.requiredYesShares
                && g.proposal.yesCount >= g.requiredYesCount;
            _mark(g.status, uint256(GovernanceField.Thresholds), true);
        }
        if (account != address(0)) {
            // Only canonical ABI boolean 1 means hasVoted; failed/invalid reads remain masked unknown.
            // slither-disable-next-line incorrect-equality
            g.hasVoted = _field(
                g.status,
                uint256(GovernanceField.HasVoted),
                pool,
                abi.encodeWithSignature("hasVoted(uint256,address)", g.activeProposalId, account),
                1,
                READ_GAS
            ) == 1;
            // At proposal creation getPastShares rejects the current timestamp.
            // All transfer paths are frozen immediately, so balanceOf is that
            // timestamp's final checkpoint until the vote closes.
            // slither-disable-next-line incorrect-equality
            bytes memory sharesCall = g.proposal.snapshotTs == block.timestamp
                ? abi.encodeWithSignature("balanceOf(address)", account)
                : abi.encodeWithSignature("getPastShares(address,uint48)", account, g.proposal.snapshotTs);
            g.snapshotShares =
                _field(g.status, uint256(GovernanceField.SnapshotShares), pool, sharesCall, 100, READ_GAS);
        }
        uint256 necessary = (1 << uint256(GovernanceField.State)) | (1 << uint256(GovernanceField.Thresholds));
        if (!_valid(g.status, necessary)) return;
        // Active is exactly State enum tag 2; timestamp eligibility is an independent strict upper bound.
        // slither-disable-next-line incorrect-equality
        bool open = validSnapshot && g.state == 2 && !g.proposal.executed && block.timestamp < g.proposal.endsAt;
        g.canExecute = open && g.passed;
        _mark(g.status, uint256(GovernanceField.ExecutionEligibility), true);
        necessary |= (1 << uint256(GovernanceField.HasVoted)) | (1 << uint256(GovernanceField.SnapshotShares));
        if (account == address(0) || _valid(g.status, necessary)) {
            _mark(g.status, uint256(GovernanceField.Eligibility), true);
            g.canVote = account != address(0) && open && !g.hasVoted && g.snapshotShares != 0;
        }
    }

    /// @notice Reference yield is a recorded quote, not live APR or unclaimed rewards.
    function purchaseReference(address pool) external view returns (PurchaseReference memory r) {
        if (!_trusted(pool, r.status)) return r;
        (bool ok, bytes memory data) = _read(pool, abi.encodeWithSignature("flexiblePurchase()"), 288, READ_GAS);
        ok = ok && _word(data, 0) <= 1 && _word(data, 2) <= type(uint128).max && _word(data, 5) <= type(uint16).max
            && _word(data, 6) <= type(uint64).max && _word(data, 7) <= type(uint64).max;
        _mark(r.status, uint256(ReferenceField.Configuration), ok);
        if (ok) {
            (r.enabled, r.referenceCircuitId, r.config) =
                abi.decode(data, (bool, uint256, IPoolVault.FlexiblePurchaseConfig));
        }
        (ok, data) = _read(pool, abi.encodeWithSignature("purchaseModel()"), 64, READ_GAS);
        ok = ok && _word(data, 0) <= 1 && _word(data, 1) <= type(uint32).max;
        _mark(r.status, uint256(ReferenceField.Model), ok);
        if (ok) (r.modelInitialized, r.taskId) = abi.decode(data, (bool, uint32));
        r.referenceVerifiedWeight = uint128(
            _field(
                r.status,
                uint256(ReferenceField.Weight),
                pool,
                abi.encodeWithSignature("purchaseReferenceWeight()"),
                type(uint128).max,
                READ_GAS
            )
        );
    }

    function _trusted(address pool, ReadStatus memory status) private view returns (bool) {
        (bool ok, bytes memory data) = _read(factory, abi.encodeWithSignature("isPool(address)", pool), 32, READ_GAS);
        uint256 registered = _word(data, 0);
        if (!ok || registered > 1) {
            status.trustError = TrustError.RegistryReadFailed;
            // The preceding range check leaves ABI boolean 0/1; exactly 0 means not registered.
            // slither-disable-next-line incorrect-equality
        } else if (registered == 0) {
            status.trustError = TrustError.NotRegistered;
        } else {
            (bool okFactory, bytes memory actual) = _read(pool, abi.encodeWithSignature("factory()"), 32, READ_GAS);
            (bool okOfficial, bytes memory official) =
                _read(pool, abi.encodeWithSignature("OFFICIAL_FACTORY()"), 32, READ_GAS);
            if (!okFactory || !okOfficial) {
                status.trustError = TrustError.IdentityReadFailed;
            } else if (_word(actual, 0) != uint160(factory) || _word(official, 0) != uint160(factory)) {
                status.trustError = TrustError.IdentityMismatch;
            }
        }
        // Trust requires the exact no-error enum value; all other enum values deny trust.
        // slither-disable-next-line incorrect-equality
        bool trusted = status.trustError == TrustError.None;
        _mark(status, 0, trusted);
        return trusted;
    }

    function _field(
        ReadStatus memory status,
        uint256 bit,
        address target,
        bytes memory input,
        uint256 maximum,
        uint256 gasLimit
    ) private view returns (uint256 value) {
        (bool ok, bytes memory data) = _read(target, input, 32, gasLimit);
        value = _word(data, 0);
        ok = ok && value <= maximum;
        _mark(status, bit, ok);
        if (!ok) value = 0;
    }

    function _mark(ReadStatus memory status, uint256 bit, bool ok) private pure {
        uint256 mask = 1 << bit;
        if (ok) {
            status.validMask |= mask;
        } else {
            status.validMask &= ~mask;
            status.errorMask |= mask;
        }
    }

    function _valid(ReadStatus memory status, uint256 mask) private pure returns (bool) {
        // Exact bitset inclusion requires every requested validity bit; numeric >= would accept missing bits.
        // slither-disable-next-line incorrect-equality
        return status.validMask & mask == mask;
    }

    function _word(bytes memory data, uint256 index) private pure returns (uint256 value) {
        assembly ("memory-safe") {
            value := mload(add(add(data, 32), mul(index, 32)))
        }
    }

    /// @dev Never copy arbitrary returndata/revert data. Exact static ABI size and scalar ranges are checked before decoding.
    ///      A caller still needs enough eth_call gas for the requested page; per-call caps bound hostile individual getters.
    function _read(address target, bytes memory input, uint256 length, uint256 gasLimit)
        private
        view
        returns (bool ok, bytes memory data)
    {
        data = new bytes(length);
        assembly ("memory-safe") {
            ok := staticcall(gasLimit, target, add(input, 32), mload(input), add(data, 32), length)
            ok := and(ok, eq(returndatasize(), length))
        }
    }
}
