// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The deployed BSC SmartRouter uses this seven-field tuple, without a deadline field.
interface IPancakeBurnRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IWbnb {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
