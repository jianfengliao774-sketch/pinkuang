// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Records beneficial owners, not market custody addresses, in the Vault's existing storage.
library ShareCheckpoints {
    using Checkpoints for Checkpoints.Trace208;

    function sync(
        address[] storage members,
        mapping(address => uint256) storage indexes,
        mapping(address => Checkpoints.Trace208) storage histories,
        Checkpoints.Trace208 storage memberHistory,
        address from,
        address to,
        uint256 fromBalance,
        uint256 toBalance,
        uint48 timestamp
    ) external returns (uint208 previousCount, uint208 currentCount) {
        if (from != address(0)) {
            _syncMember(members, indexes, histories, from, fromBalance, timestamp);
        }
        if (to != address(0) && to != from) _syncMember(members, indexes, histories, to, toBalance, timestamp);
        (previousCount, currentCount) = memberHistory.push(timestamp, SafeCast.toUint208(members.length));
    }

    function _syncMember(
        address[] storage members,
        mapping(address => uint256) storage indexes,
        mapping(address => Checkpoints.Trace208) storage histories,
        address member,
        uint256 balance,
        uint48 timestamp
    ) private {
        uint256 index = indexes[member];
        (uint208 previousShares, uint208 currentShares) = histories[member].push(timestamp, SafeCast.toUint208(balance));
        // The returned values are integer shares; zero is exactly the membership boundary.
        // slither-disable-next-line incorrect-equality
        if (currentShares != 0 && previousShares == 0) {
            members.push(member);
            indexes[member] = members.length;
            // slither-disable-next-line incorrect-equality
        } else if (currentShares == 0 && previousShares != 0) {
            uint256 last = members.length;
            if (index != last) {
                address moved = members[last - 1];
                members[index - 1] = moved;
                indexes[moved] = index;
            }
            members.pop();
            delete indexes[member];
        }
    }
}
