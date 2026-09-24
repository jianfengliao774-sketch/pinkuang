// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {ITapeoutMining} from "../interfaces/ITapeoutMining.sol";
import {ICircuitMarket} from "../interfaces/ICircuitMarket.sol";

/// @notice Existing purchase checks and seller reward settlement, executed in the Vault context.
/// @dev Callers enforce the purchase window and nonReentrant. This library has no
/// storage and neither buys, transfers, nor approves the NFT or purchase funds.
library PurchaseValidation {
    address private constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address private constant CIRCUIT_MARKET = 0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f;
    address private constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;

    event RewardSettledBeforeTransfer(
        address indexed circuits, uint256 indexed circuitId, address previousOwner, uint256 bemAmount, bytes32 tradeId
    );

    function prepareMarketPurchase(address circuits, uint256 circuitId, uint256 priceCap, uint256 listingId)
        external
        returns (address seller, uint256 price, bytes32 key)
    {
        {
            // M0: feeBps is deducted from the seller's price; the buyer pays exactly price.
            // Deliberately ignore that display field: adding it would charge the buyer twice.
            // slither-disable-next-line unused-return
            (address listedSeller, address listedCircuits, uint256 listedId, uint96 listedPrice,, bool valid) =
                ICircuitMarket(CIRCUIT_MARKET).listingView(listingId);
            if (!valid || listedSeller == address(0) || listedPrice == 0) revert IPoolVault.InvalidListing();
            if (listedCircuits != circuits || listedId != circuitId) revert IPoolVault.WrongCircuit();
            if (listedPrice > priceCap) revert IPoolVault.OverPriceCap();
            if (IERC721(listedCircuits).ownerOf(listedId) != listedSeller) revert IPoolVault.InvalidListing();
            seller = listedSeller;
            price = listedPrice;
        }
        key = _activeMinerKey(circuits, circuitId);
        // ABI words encode the original uint96 listing price identically after widening.
        _settleSellerRewards(
            circuits,
            circuitId,
            seller,
            key,
            keccak256(abi.encode(address(this), uint8(0), listingId, seller, key, price))
        );
    }

    function prepareDirectPurchase(address circuits, uint256 circuitId, address seller, uint256 price, uint256 priceCap)
        external
        returns (bytes32 key)
    {
        if (seller == address(0) || msg.sender != seller) revert IPoolVault.Unauthorized();
        if (price == 0 || price > priceCap) revert IPoolVault.OverPriceCap();
        if (IERC721(circuits).ownerOf(circuitId) != seller) revert IPoolVault.InvalidListing();
        key = _activeMinerKey(circuits, circuitId);
        _settleSellerRewards(
            circuits,
            circuitId,
            seller,
            key,
            keccak256(abi.encode(address(this), uint8(1), uint256(0), seller, key, price))
        );
    }

    function activeMinerKey(address circuits, uint256 circuitId) external view returns (bytes32 key) {
        return _activeMinerKey(circuits, circuitId);
    }

    function _activeMinerKey(address circuits, uint256 circuitId) private view returns (bytes32 key) {
        key = ITapeoutMining(MINING).minerKey(circuits, circuitId);
        ITapeoutMining.Miner memory miner = ITapeoutMining(MINING).getMiner(key);
        if (miner.circuits != circuits || miner.circuitId != circuitId) revert IPoolVault.WrongCircuit();
        if (miner.status != 1) revert IPoolVault.MinerNotActive();
    }

    function _settleSellerRewards(address circuits, uint256 circuitId, address seller, bytes32 key, bytes32 tradeId)
        private
    {
        uint256 pendingBefore = ITapeoutMining(MINING).pending(key);
        uint256 beforeBalance = IERC20(BEM).balanceOf(seller);
        // M0 shows pending() can be stale, including zero. Never skip claim or swallow a failure.
        try ITapeoutMining(MINING).claim(key) {}
        catch {
            revert IPoolVault.FinalRewardSettlementFailed();
        }
        uint256 afterBalance = IERC20(BEM).balanceOf(seller);
        // Both Vault callers hold nonReentrant. This delta proves receipt; the earlier
        // balance does not authorize an outgoing payment after an unguarded external call.
        // slither-disable-next-line reentrancy-balance
        if (afterBalance < beforeBalance || afterBalance - beforeBalance < pendingBefore) {
            revert IPoolVault.FinalRewardSettlementFailed();
        }
        if (ITapeoutMining(MINING).pending(key) != 0 || IERC721(circuits).ownerOf(circuitId) != seller) {
            revert IPoolVault.FinalRewardSettlementFailed();
        }
        emit RewardSettledBeforeTransfer(circuits, circuitId, seller, afterBalance - beforeBalance, tradeId);
    }
}
