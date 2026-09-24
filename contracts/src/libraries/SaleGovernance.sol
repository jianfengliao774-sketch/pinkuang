// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PoolSaleState} from "../PoolSaleState.sol";

/// @notice Beneficial-owner voting, executed in the PoolVault storage context.
/// @dev Vault checks Active state and provides its current balance and activation
/// time. This library makes no external calls and never changes shares or assets.
library SaleGovernance {
    using Checkpoints for Checkpoints.Trace208;

    uint256 private constant PROPOSE_INTERVAL = 7 days;
    uint256 private constant VOTE_DURATION = 1 days;
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

    function propose(
        PoolSaleState.SaleStorage storage s,
        Checkpoints.Trace208 storage counts,
        ProposalInput memory input
    ) external returns (uint256 proposalId) {
        if (block.timestamp < uint256(input.activatedAt) + PROPOSE_INTERVAL) {
            revert DeadlineNotReached();
        }
        if (input.currentShares == 0) revert NotMember();
        uint256 last = s.lastProposed[msg.sender];
        if (last != 0 && block.timestamp < last + PROPOSE_INTERVAL) revert ProposeCooldown();

        uint256 activeId = s.activeProposalId;
        if (activeId != 0) {
            PoolSaleState.Proposal storage active = s.proposals[activeId];
            if (!active.executed && block.timestamp < active.endsAt) revert ProposalActive();
        }

        uint48 snapshotTs = SafeCast.toUint48(block.timestamp - 1);
        if (snapshotTs <= input.activatedAt) revert DeadlineNotReached();
        proposalId = s.nextProposalId;
        if (proposalId == 0) proposalId = 1;
        s.nextProposalId = proposalId + 1;
        s.activeProposalId = proposalId;
        s.lastProposed[msg.sender] = SafeCast.toUint64(block.timestamp);

        PoolSaleState.Proposal storage p = s.proposals[proposalId];
        p.proposer = msg.sender;
        p.snapshotTs = snapshotTs;
        p.endsAt = SafeCast.toUint64(block.timestamp + VOTE_DURATION);
        p.refAt = input.refAt;
        p.price = input.price;
        p.refPrice = input.refPrice;
        p.snapshotMemberCount = counts.upperLookupRecent(snapshotTs);
        p.snapshotTotalShares = TOTAL_SHARES;

        emit SaleProposed(proposalId, msg.sender, p.price, p.refPrice, p.refAt, p.endsAt);
        emit SaleSnapshotRecorded(proposalId, snapshotTs, p.snapshotMemberCount, TOTAL_SHARES);
    }

    function vote(
        PoolSaleState.SaleStorage storage s,
        mapping(address => Checkpoints.Trace208) storage shares,
        uint256 proposalId,
        bool support
    ) external {
        PoolSaleState.Proposal storage p = _proposal(s, proposalId);
        if (proposalId != s.activeProposalId || p.executed) revert InvalidProposal();
        if (block.timestamp >= p.endsAt) revert DeadlinePassed();
        if (s.hasVoted[proposalId][msg.sender]) revert AlreadyVoted();
        // Current holdings are deliberately irrelevant: only the closed snapshot votes.
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
    function passed(PoolSaleState.SaleStorage storage s, uint256 proposalId) external view returns (bool) {
        PoolSaleState.Proposal storage p = _proposal(s, proposalId);
        return p.yesCount * 2 > p.snapshotMemberCount && p.yesShares * 2 > p.snapshotTotalShares;
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
