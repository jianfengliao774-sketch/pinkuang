// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoolSaleState} from "../PoolSaleState.sol";

/// @notice Historical ABI only. Not linked by PoolVault; no swap or burn is executable.
library BurnOperations {
    error BurnDisabled();

    function execute(PoolSaleState.SaleStorage storage, uint256, uint256) external pure returns (uint256, uint256) {
        revert BurnDisabled();
    }
}
