// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ITapeoutMining} from "../interfaces/ITapeoutMining.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";

/// @notice Statically linked Mining adapter, executed in the guarded Vault's context.
library MiningOperations {
    address private constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;

    address private constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;

    event MiningClaimFailed(bytes32 indexed key, bytes reason);

    struct StartParameters {
        address circuits;
        uint256 circuitId;
        uint32 taskId;
        uint256 nonce;
        bytes[] inputs;
        bytes[] outputs;
        bytes32[][] proofs;
        bytes32 extra;
    }

    function execute(address circuits, uint256 circuitId, bytes calldata data) external returns (bytes memory result) {
        if (data.length < 4) revert IPoolVault.SelectorNotAllowed();
        bytes4 selector = bytes4(data[:4]);
        bytes32 key = ITapeoutMining(MINING).minerKey(circuits, circuitId);
        if (selector == ITapeoutMining.arm.selector) {
            if (data.length != 68) revert IPoolVault.InvalidParameters();
            (address target, uint256 id) = abi.decode(data[4:], (address, uint256));
            if (target != circuits || id != circuitId) revert IPoolVault.WrongCircuit();
        } else if (selector == ITapeoutMining.start.selector) {
            // Decode every dynamic argument, not just the first two words. A canonical ABI
            // encoding prevents hidden/trailing data from bypassing the target inspection.
            bytes memory wrapped = bytes.concat(bytes32(uint256(32)), data[4:]);
            StartParameters memory p = abi.decode(wrapped, (StartParameters));
            if (keccak256(abi.encode(p)) != keccak256(wrapped)) revert IPoolVault.InvalidParameters();
            if (p.circuits != circuits || p.circuitId != circuitId) revert IPoolVault.WrongCircuit();
        } else if (selector == ITapeoutMining.reclaim.selector) {
            if (data.length != 36) revert IPoolVault.InvalidParameters();
            if (abi.decode(data[4:], (bytes32)) != key) revert IPoolVault.WrongCircuit();
        } else {
            revert IPoolVault.SelectorNotAllowed();
        }
        if (IERC721(circuits).ownerOf(circuitId) != address(this)) revert IPoolVault.NotOwnerAfterBuy();
        _verifyIdentity(key, circuits, circuitId);
        bool success;
        (success, result) = MINING.call(data);
        if (!success) assembly { revert(add(result, 32), mload(result)) }
        if (IERC721(circuits).ownerOf(circuitId) != address(this)) revert IPoolVault.NotOwnerAfterBuy();
        if (ITapeoutMining(MINING).minerKey(circuits, circuitId) != key) revert IPoolVault.WrongCircuit();
        _verifyIdentity(key, circuits, circuitId);
    }

    /// @notice Strict handover permits a verified zero settlement for known non-mining states.
    function claimReward(address circuits, uint256 circuitId, bool finalHandover) external {
        if (IERC721(circuits).ownerOf(circuitId) != address(this)) revert IPoolVault.NotOwnerAfterBuy();
        bytes32 key = ITapeoutMining(MINING).minerKey(circuits, circuitId);
        ITapeoutMining.Miner memory miner = ITapeoutMining(MINING).getMiner(key);
        if (miner.circuits != circuits || miner.circuitId != circuitId) revert IPoolVault.WrongCircuit();
        uint256 pendingBefore = finalHandover ? ITapeoutMining(MINING).pending(key) : 0;
        bool zeroSettlement = finalHandover && miner.status != 1;
        if (zeroSettlement) {
            // At the pinned implementation, states 0/2/3 have no claimable reward and
            // claim always reverts. Do not call it for a proven empty settlement.
            // Unknown states and any outstanding debt still fail closed.
            if (miner.status > 3 || pendingBefore != 0) revert IPoolVault.FinalRewardSettlementFailed();
        }
        uint256 beforeBalance = IERC20(BEM).balanceOf(address(this));
        if (!zeroSettlement) {
            try ITapeoutMining(MINING).claim(key) {}
            catch (bytes memory reason) {
                if (finalHandover) revert IPoolVault.FinalRewardSettlementFailed();
                // Ordinary harvest can still account previously received BEM. Expose the
                // failed protocol claim so keepers never mistake it for a successful claim.
                emit MiningClaimFailed(key, reason);
            }
        }
        if (IERC721(circuits).ownerOf(circuitId) != address(this)) revert IPoolVault.NotOwnerAfterBuy();
        if (ITapeoutMining(MINING).minerKey(circuits, circuitId) != key) revert IPoolVault.WrongCircuit();
        miner = ITapeoutMining(MINING).getMiner(key);
        if (miner.circuits != circuits || miner.circuitId != circuitId) revert IPoolVault.WrongCircuit();
        if (finalHandover) {
            if (miner.status > 3) revert IPoolVault.FinalRewardSettlementFailed();
            uint256 afterBalance = IERC20(BEM).balanceOf(address(this));
            // Vault entry points hold nonReentrant. This historical balance only proves receipt.
            // slither-disable-next-line reentrancy-balance
            if (afterBalance < beforeBalance || afterBalance - beforeBalance < pendingBefore) {
                revert IPoolVault.FinalRewardSettlementFailed();
            }
            if (ITapeoutMining(MINING).pending(key) != 0) revert IPoolVault.FinalRewardSettlementFailed();
        }
    }

    function _verifyIdentity(bytes32 key, address circuits, uint256 circuitId) private view {
        ITapeoutMining.Miner memory miner = ITapeoutMining(MINING).getMiner(key);
        if (miner.circuits != circuits || miner.circuitId != circuitId) revert IPoolVault.WrongCircuit();
    }
}
