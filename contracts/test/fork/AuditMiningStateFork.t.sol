// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ITapeoutMining} from "../../src/interfaces/ITapeoutMining.sol";
import {Addresses} from "../../script/Addresses.sol";

/// @notice Real fixed-block Mining bytecode, with explicitly artificial status-byte overrides.
/// @dev This verifies protocol branches; it does not claim a naturally occurring revocation or cooldown.
contract AuditMiningStateForkTest is Test {
    ITapeoutMining private constant MINING = ITapeoutMining(Addresses.MINING);
    uint256 private constant TOKEN_ID = 16210;
    bytes32 private key;

    function setUp() public {
        require(block.chainid == 56 && block.number == 123728000, "requires pinned BSC fork");
        bytes32 implementationSlot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        assertEq(
            address(uint160(uint256(vm.load(Addresses.MINING, implementationSlot)))),
            0xa3DBe873DA37cD4e4a13c7cEf23a7dB6Ca60f898
        );
        key = MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        assertEq(MINING.getMiner(key).status, 1);
    }

    function test_Fork_StateOverrideStatus0HasZeroPendingAndClaimRejects() public {
        _assertInactiveBranch(0);
    }

    function test_Fork_StateOverrideStatus2HasZeroPendingAndClaimRejects() public {
        _assertInactiveBranch(2);
    }

    function test_Fork_StateOverrideStatus3HasZeroPendingAndClaimRejects() public {
        _assertInactiveBranch(3);
    }

    function _assertInactiveBranch(uint8 status) private {
        ITapeoutMining.Miner memory expected = MINING.getMiner(key);
        bytes32 word = bytes32(uint256(keccak256(abi.encode(key, uint256(8)))) + 2);
        uint256 beforeWord = uint256(vm.load(Addresses.MINING, word));
        assertEq(uint8(beforeWord), 1);
        vm.store(Addresses.MINING, word, bytes32((beforeWord & ~uint256(0xff)) | status));
        expected.status = status;
        assertEq(keccak256(abi.encode(MINING.getMiner(key))), keccak256(abi.encode(expected)));
        assertEq(MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID), key);
        assertEq(MINING.pending(key), 0);
        address owner = IERC721(Addresses.TAPEOUT_CIRCUITS).ownerOf(TOKEN_ID);
        vm.prank(owner);
        vm.expectRevert(bytes4(0x5f9bb3be));
        MINING.claim(key);
        emit log_named_uint("artificial status override, not natural chain revocation", status);
        emit log_named_bytes32("only low status byte in this real Mining storage word changed", word);
    }
}
