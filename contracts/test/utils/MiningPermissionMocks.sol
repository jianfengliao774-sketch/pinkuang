// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PurchaseMockMining, PurchaseMockNft} from "./PurchaseMocks.sol";

/// @dev Call-boundary fault injection only; this mock makes no claim about real Mining eligibility.
contract MiningPermissionMock is PurchaseMockMining {
    uint256 public mineCalls;
    address public lastCaller;
    bytes public lastData;
    bytes public mineRevert;
    uint8 public mineFault;
    address public mineCallbackTarget;
    bytes public mineCallbackData;
    bool public mineCallbackAttempted;
    bool public mineCallbackSucceeded;
    bytes public mineCallbackResult;

    function setMineRevert(bytes calldata reason) external {
        mineRevert = reason;
    }

    function setMineFault(uint8 fault) external {
        mineFault = fault;
    }

    function setMineCallback(address target, bytes calldata data) external {
        mineCallbackTarget = target;
        mineCallbackData = data;
    }

    function arm(address circuits, uint256 id) external {
        _record(circuits, id);
    }

    function start(
        address circuits,
        uint256 id,
        uint32,
        uint256,
        bytes[] calldata,
        bytes[] calldata,
        bytes32[][] calldata,
        bytes32
    ) external returns (bytes32) {
        _record(circuits, id);
        return minerKey(circuits, id);
    }

    function reclaim(bytes32 key) external {
        Miner memory miner = this.getMiner(key);
        _record(miner.circuits, miner.circuitId);
    }

    function _record(address circuits, uint256 id) private {
        if (mineRevert.length != 0) {
            bytes memory reason = mineRevert;
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
        ++mineCalls;
        lastCaller = msg.sender;
        lastData = msg.data;
        if (mineCallbackData.length != 0) {
            mineCallbackAttempted = true;
            (mineCallbackSucceeded, mineCallbackResult) = mineCallbackTarget.call(mineCallbackData);
        }
        if (mineFault == 1) PurchaseMockNft(circuits).forceTransfer(address(0xBAD), id);
        if (mineFault == 2) this.setIdentity(minerKey(circuits, id), address(0xBAD), uint64(id));
    }

    // Accept unknown selectors deliberately: permission tests must prove that Vault rejects them itself.
    fallback() external {
        ++mineCalls;
        lastCaller = msg.sender;
        lastData = msg.data;
    }
}
