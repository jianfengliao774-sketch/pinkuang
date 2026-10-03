// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPancakeBurnRouter} from "../../src/interfaces/IPancakeBurnRouter.sol";
import {PurchaseMockBem} from "./PurchaseMocks.sol";
import {Addresses} from "../../script/Addresses.sol";

/// @dev Unit fault injection only. The real fork suite never replaces WBNB or Router code/storage.
contract BurnMockWbnb is ERC20 {
    uint8 public fault;
    uint256 public lastWithdrawal;

    constructor() ERC20("Mock wrapped BNB", "mWBNB") {}

    function setFault(uint8 value) external {
        fault = value;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function forceBurn(address holder, uint256 amount) external {
        _burn(holder, amount);
    }

    function deposit() external payable {
        _mint(msg.sender, fault == 1 ? msg.value - 1 : msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        lastWithdrawal = amount;
        if (fault != 2) payable(msg.sender).transfer(fault == 3 ? amount - 1 : amount);
    }
}

contract BurnMockRouter is IPancakeBurnRouter {
    address private constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    uint256 public spend;
    uint256 public output;
    uint256 public reported;
    uint256 public calls;
    uint256 public lastInput;
    uint256 public lastMinimum;
    uint8 public fault;
    bytes public reentryData;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryResult;

    function configure(uint256 spend_, uint256 output_, uint256 reported_) external {
        spend = spend_;
        output = output_;
        reported = reported_;
    }

    function setFault(uint8 value) external {
        fault = value;
    }

    function setReentry(bytes calldata data) external {
        reentryData = data;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256) {
        require(
            msg.value == 0 && p.tokenIn == WBNB && p.tokenOut == Addresses.BEM && p.fee == 10_000
                && p.recipient == msg.sender && p.sqrtPriceLimitX96 == 0,
            "unapproved burn path"
        );
        ++calls;
        lastInput = p.amountIn;
        lastMinimum = p.amountOutMinimum;
        uint256 pulled = spend == type(uint256).max ? p.amountIn : spend;
        if (pulled != 0) require(IERC20(WBNB).transferFrom(msg.sender, address(this), pulled), "pull failed");
        if (fault == 1) BurnMockWbnb(WBNB).forceBurn(msg.sender, 1);
        if (fault == 2) BurnMockWbnb(WBNB).mint(msg.sender, p.amountIn + 1);
        if (reentryData.length != 0) {
            reentryAttempted = true;
            (reentrySucceeded, reentryResult) = msg.sender.call(reentryData);
        }
        PurchaseMockBem(Addresses.BEM).mint(p.recipient, output);
        return reported;
    }
}
