// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IPoolMachineRegistry {
    function claimMachine(address circuits, uint256 circuitId) external;
    function machinePool(address circuits, uint256 circuitId) external view returns (address);
    function machineRegistryStatus()
        external
        view
        returns (bool initialized, bool ready, uint256 cursor, uint256 cutoff);
}
