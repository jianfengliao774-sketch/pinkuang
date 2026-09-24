// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Mining ABI verified by the M0 fixed-block probes.
interface ITapeoutMining {
    struct Miner {
        address circuits;
        uint64 circuitId;
        uint32 taskId;
        uint32 gateCount;
        uint32 stateCount;
        uint32 depth;
        uint64 area;
        uint32 mult;
        uint64 since;
        uint8 status;
        address registrant;
        uint32 nandBurn;
        uint32 latchBurn;
        uint64 bstar;
        uint64 bonus;
        bool optimal;
        uint64 commitBlock;
        uint64 firstUnusedId;
        uint64 stopBlock;
        uint128 verifWeight;
        uint128 unverWeight;
        uint256 debt;
    }

    function minerKey(address circuits, uint256 circuitId) external view returns (bytes32);
    function getMiner(bytes32 key) external view returns (Miner memory);
    function pending(bytes32 key) external view returns (uint256);
    function claim(bytes32 key) external;
}
