// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PoolSaleState} from "../PoolSaleState.sol";

/// @notice Beneficial-owner voting, executed in the PoolVault storage context.
/// @dev Vault checks the required Active/Listed state and provides its current
/// balance and activation time. This library never calls out or changes assets.
library SaleGovernance {
    using Checkpoints for Checkpoints.Trace208;

    uint256 private constant PROPOSE_INTERVAL = 7 days;
    uint256 private constant VOTE_DURATION = 1 days;
    uint256 private constant LISTING_DURATION = 7 days;
    uint256 private constant TOTAL_SHARES = 100;

    struct ProposalInput {
        uint64 activatedAt;
        uint256 currentShares;
        uint256 price;
        uint256 refPrice;
        uint64 refAt;
    }

    error DeadlineNotReached();
    error DeadlinePassed();
    error NotMember();
    error ProposeCooldown();
    error ProposalActive();
    error InvalidProposal();
    error AlreadyVoted();
    error ProposalNotPassed();
    error InvalidListing();
    error InvalidSalePrice();

    event SaleProposed(
        uint256 indexed proposalId,
        address indexed proposer,
        uint256 price,
        uint256 refPrice,
        uint64 refAt,
        uint64 endsAt
    );
    event SaleSnapshotRecorded(
        uint256 indexed proposalId, uint48 snapshotTs, uint256 snapshotMemberCount, uint256 snapshotTotalShares
    );
    event Voted(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event SaleListed(uint256 indexed proposalId, uint256 listingId, uint256 price, uint64 expiresAt);
    event SaleExpired(uint256 indexed proposalId);

    function propose(
        PoolSaleState.SaleStorage storage s,
        Checkpoints.Trace208 storage counts,
        ProposalInput memory input
    ) external returns (uint256 proposalId) {
        if (block.timestamp < uint256(input.activatedAt) + PROPOSE_INTERVAL) {
            revert DeadlineNotReached();
        }
        if (input.currentShares == 0) revert NotMember();
        if (input.price == 0) revert InvalidSalePrice();
        uint256 activeId = s.activeProposalId;
        uint48 snapshotTs = 0;
        uint64 endsAt = 0;
        uint256 snapshotMemberCount = 0;
        bool joiningRound = false;
        if (activeId != 0) {
            PoolSaleState.Proposal storage active = s.proposals[activeId];
            if (!active.executed && block.timestamp < active.endsAt) {
                // A later candidate shares the first proposal's frozen ownership
                // and deadline. Never inherit a pre-upgrade timestamp-1 snapshot.
                if (!_currentSnapshot(active) || active.snapshotTotalShares != TOTAL_SHARES) revert ProposalActive();
                joiningRound = true;
                snapshotTs = active.snapshotTs;
                endsAt = active.endsAt;
                snapshotMemberCount = active.snapshotMemberCount;
            } else {
                // Keep one seven-day round even if minority addresses rotate.
                if (block.timestamp < uint256(active.endsAt) + PROPOSE_INTERVAL - VOTE_DURATION) {
                    revert ProposeCooldown();
                }
            }
        }
        uint256 last = s.lastProposed[msg.sender];
        if (last != 0 && block.timestamp < last + PROPOSE_INTERVAL) revert ProposeCooldown();

        // The opener atomically snapshots and freezes ownership. Later
        // candidates reuse it; no share can move before this round closes.
        if (!joiningRound) {
            snapshotTs = SafeCast.toUint48(block.timestamp);
            endsAt = SafeCast.toUint64(block.timestamp + VOTE_DURATION);
            snapshotMemberCount = counts.upperLookupRecent(snapshotTs);
        }
        if (snapshotTs <= input.activatedAt) revert DeadlineNotReached();
        proposalId = s.nextProposalId;
        if (proposalId == 0) proposalId = 1;
        s.nextProposalId = proposalId + 1;
        if (!joiningRound) s.activeProposalId = proposalId;
        s.lastProposed[msg.sender] = SafeCast.toUint64(block.timestamp);

        PoolSaleState.Proposal storage p = s.proposals[proposalId];
        p.proposer = msg.sender;
        p.snapshotTs = snapshotTs;
        p.endsAt = endsAt;
        p.refAt = input.refAt;
        p.price = input.price;
        p.refPrice = input.refPrice;
        p.snapshotMemberCount = snapshotMemberCount;
        p.snapshotTotalShares = TOTAL_SHARES;

        emit SaleProposed(proposalId, msg.sender, p.price, p.refPrice, p.refAt, p.endsAt);
        emit SaleSnapshotRecorded(proposalId, snapshotTs, snapshotMemberCount, TOTAL_SHARES);
    }

    function vote(
        PoolSaleState.SaleStorage storage s,
        mapping(address => Checkpoints.Trace208) storage shares,
        uint256 proposalId,
        bool support
    ) external {
        PoolSaleState.Proposal storage p = _proposal(s, proposalId);
        if (!_inActiveRound(s, proposalId, p) || p.executed) revert InvalidProposal();
        if (block.timestamp >= p.endsAt) revert DeadlinePassed();
        if (s.hasVoted[proposalId][msg.sender]) revert AlreadyVoted();
        // Subsequent holdings are irrelevant: only the frozen proposal snapshot votes.
        uint256 weight = shares[msg.sender].upperLookupRecent(p.snapshotTs);
        if (weight == 0) revert NotMember();
        s.hasVoted[proposalId][msg.sender] = true;
        if (support) {
            ++p.yesCount;
            p.yesShares += weight;
        }
        emit Voted(proposalId, msg.sender, support, weight);
    }

    /// @notice Reports only the vote result; execution must independently check its deadline and state.
    function passed(PoolSaleState.SaleStorage storage s, uint256 proposalId, uint256 purchaseCost)
        external
        view
        returns (bool)
    {
        PoolSaleState.Proposal storage p = _proposal(s, proposalId);
        return _passed(p, purchaseCost);
    }

    /// @notice Freeze ownership from proposal creation until voting closes.
    function tradingFrozen(PoolSaleState.SaleStorage storage s) external view returns (bool) {
        PoolSaleState.Proposal storage p = s.proposals[s.activeProposalId];
        return s.activeProposalId != 0 && !p.executed && block.timestamp < p.endsAt;
    }

    /// @notice Opens only the Vault's controlled listing; no external market receives an approval.
    function execute(PoolSaleState.SaleStorage storage s, uint256 proposalId, uint256 purchaseCost) external {
        PoolSaleState.Proposal storage p = _proposal(s, proposalId);
        if (!_inActiveRound(s, proposalId, p) || p.executed) revert InvalidProposal();
        if (block.timestamp >= p.endsAt) revert DeadlinePassed();
        if (!_passed(p, purchaseCost)) revert ProposalNotPassed();
        p.executed = true;
        s.listedProposalId = proposalId;
        s.listedAt = SafeCast.toUint64(block.timestamp);
        s.expiresAt = SafeCast.toUint64(block.timestamp + LISTING_DURATION);
        s.salePrice = p.price;
        emit SaleListed(proposalId, 0, p.price, s.expiresAt);
    }

    /// @notice Removes only the expired listing; executed proposal history can never be reused.
    function cancel(PoolSaleState.SaleStorage storage s) external {
        uint256 proposalId = s.listedProposalId;
        if (proposalId == 0) revert InvalidListing();
        if (block.timestamp < s.expiresAt) revert DeadlineNotReached();
        delete s.listedProposalId;
        delete s.listedAt;
        delete s.expiresAt;
        delete s.salePrice;
        emit SaleExpired(proposalId);
    }

    function _passed(PoolSaleState.Proposal storage p, uint256 purchaseCost) private view returns (bool) {
        if (!_currentSnapshot(p) || p.price == 0 || p.snapshotTotalShares != TOTAL_SHARES) return false;
        // Only the actual on-chain acquisition cost sets the floor. refPrice is disclosure, never authority.
        bool sharesPassed = p.price < purchaseCost ? p.yesShares >= 60 : p.yesShares * 2 > p.snapshotTotalShares;
        return p.yesCount * 2 > p.snapshotMemberCount && sharesPassed;
    }

    /// @dev Refuse proposals created by the former timestamp-1 implementation after an upgrade.
    /// Those proposals may have lost their original owners before the vote freeze began.
    function _currentSnapshot(PoolSaleState.Proposal storage p) private view returns (bool) {
        return uint256(p.snapshotTs) + VOTE_DURATION == p.endsAt;
    }

    function _inActiveRound(PoolSaleState.SaleStorage storage s, uint256 proposalId, PoolSaleState.Proposal storage p)
        private
        view
        returns (bool)
    {
        uint256 activeId = s.activeProposalId;
        if (activeId == 0 || proposalId < activeId || !_currentSnapshot(p)) return false;
        PoolSaleState.Proposal storage opener = s.proposals[activeId];
        return _currentSnapshot(opener) && p.snapshotTs == opener.snapshotTs && p.endsAt == opener.endsAt
            && p.snapshotMemberCount == opener.snapshotMemberCount && p.snapshotTotalShares == TOTAL_SHARES;
    }

    function _proposal(PoolSaleState.SaleStorage storage s, uint256 proposalId)
        private
        view
        returns (PoolSaleState.Proposal storage p)
    {
        p = s.proposals[proposalId];
        if (proposalId == 0 || p.proposer == address(0)) revert InvalidProposal();
    }
}
