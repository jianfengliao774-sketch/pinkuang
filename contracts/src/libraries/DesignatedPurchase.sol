// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {ITapeoutMining} from "../interfaces/ITapeoutMining.sol";
import {PoolVaultState} from "../PoolVaultState.sol";
import {DesignatedPurchaseState} from "../DesignatedPurchaseState.sol";

/// @notice Internal-only policy code. No new external library address is linked into the graph.
/// @dev The original transfer check is intentionally not described as proof of a sale.
library DesignatedPurchase {
    address private constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address private constant TAPEOUT = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address private constant BEHEMOTH = 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C;
    uint256 private constant BASIS_POINTS = 10_000;
    uint256 private constant DAY = 86_400;
    uint256 private constant MAX_REFERENCE_AGE = 5 minutes;

    // keccak256(abi.encode(uint256(keccak256("tapeout.storage.DesignatedPurchase")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0x76e43e61f7df7dbfe76729486c5ef28ccf37427cde03f35ed7a98d8c30b99b00;

    event DesignatedPurchaseConfigured(
        uint256 indexed referenceCircuitId, address indexed referenceSeller, uint32 indexed taskId,
        uint256 referencePriceWei, uint256 referenceCostWei, uint256 referenceDailyOutputAtomic,
        bytes32 referenceDigest
    );

    function storageRef() internal pure returns (DesignatedPurchaseState.DesignatedStorage storage s) {
        bytes32 slot = STORAGE_SLOT;
        assembly { s.slot := slot }
    }

    function configure(
        PoolVaultState.VaultStorage storage vault,
        IPoolVault.DesignatedPurchaseConfig calldata config,
        uint256 supply,
        bool flexibleEnabled
    ) internal {
        if (msg.sender != vault.factory) revert IPoolVault.Unauthorized();
        DesignatedPurchaseState.DesignatedStorage storage s = storageRef();
        if (s.enabled || flexibleEnabled) revert IPoolVault.DesignatedPurchaseAlreadyConfigured();
        if (
            vault.state != IPoolVault.State.Funding || supply != 0 || vault.params.directSeller != address(0)
                || vault.params.directPrice != 0 || config.referenceSeller == address(0)
                || config.referencePriceWei == 0 || config.referencePriceWei > type(uint128).max
                || config.referenceCostWei < config.referencePriceWei
                || config.referenceCostWei > config.referencePriceWei * 2
                || config.referenceDailyOutputAtomic == 0 || config.referenceObservedAt == 0
                || config.referenceObservedAt > block.timestamp
                || block.timestamp - config.referenceObservedAt > MAX_REFERENCE_AGE
                || config.referenceBlock == 0 || config.referenceBlock > block.number
                || config.referenceDigest == bytes32(0)
                || vault.params.circuits != TAPEOUT && vault.params.circuits != BEHEMOTH
        ) revert IPoolVault.InvalidParameters();
        uint256 cap = Math.mulDiv(config.referenceCostWei, 11, 10, Math.Rounding.Ceil);
        if (vault.params.priceCap != cap || vault.params.targetRaise != Math.ceilDiv(cap, 100) * 100) {
            revert IPoolVault.InvalidParameters();
        }
        if (IERC721(vault.params.circuits).ownerOf(vault.params.circuitId) != config.referenceSeller) {
            revert IPoolVault.InvalidListing();
        }
        ITapeoutMining.Miner memory miner = _qualifiedMiner(vault.params.circuits, vault.params.circuitId);
        if (_dailyOutput(miner.verifWeight) != config.referenceDailyOutputAtomic) {
            revert IPoolVault.InvalidParameters();
        }
        s.enabled = true;
        s.referenceCircuitId = vault.params.circuitId;
        s.taskId = miner.taskId;
        s.referenceVerifiedWeight = miner.verifWeight;
        s.config = config;
        emit DesignatedPurchaseConfigured(
            s.referenceCircuitId, config.referenceSeller, miner.taskId, config.referencePriceWei,
            config.referenceCostWei, config.referenceDailyOutputAtomic, config.referenceDigest
        );
    }

    function configuration()
        internal
        view
        returns (
            bool enabled,
            uint256 referenceCircuitId,
            uint32 taskId,
            uint128 referenceVerifiedWeight,
            IPoolVault.DesignatedPurchaseConfig memory config
        )
    {
        DesignatedPurchaseState.DesignatedStorage storage s = storageRef();
        return (s.enabled, s.referenceCircuitId, s.taskId, s.referenceVerifiedWeight, s.config);
    }

    function requireTransferred(address collection) internal view {
        DesignatedPurchaseState.DesignatedStorage storage s = storageRef();
        if (!s.enabled) revert IPoolVault.DesignatedPurchaseDisabled();
        // A transfer may be a gift, so the surrounding product must not say this proves a sale.
        if (IERC721(collection).ownerOf(s.referenceCircuitId) == s.config.referenceSeller) {
            revert IPoolVault.OriginalTargetNotTransferred();
        }
    }

    function requireOriginal(address collection) internal view {
        DesignatedPurchaseState.DesignatedStorage storage s = storageRef();
        ITapeoutMining.Miner memory miner = _qualifiedMiner(collection, s.referenceCircuitId);
        if (miner.taskId != s.taskId) revert IPoolVault.WrongPurchaseModel();
    }

    function requireAlternative(address collection, uint256 circuitId, uint256 askPriceWei) internal view {
        DesignatedPurchaseState.DesignatedStorage storage s = storageRef();
        if (!s.enabled) revert IPoolVault.DesignatedPurchaseDisabled();
        if (circuitId == s.referenceCircuitId || askPriceWei == 0 || askPriceWei > type(uint128).max) {
            revert IPoolVault.WrongCircuit();
        }
        ITapeoutMining.Miner memory miner = _qualifiedMiner(collection, circuitId);
        if (miner.taskId != s.taskId) revert IPoolVault.WrongPurchaseModel();
        uint256 p0 = s.config.referencePriceWei;
        if (_compareProducts(askPriceWei, 10, p0, 9) < 0 || _compareProducts(askPriceWei, 10, p0, 11) > 0) {
            revert IPoolVault.OutsideDesignatedPriceBand();
        }
        uint256 y1 = _dailyOutput(miner.verifWeight);
        uint256 y0 = s.config.referenceDailyOutputAtomic;
        if (_compareProducts(10 * askPriceWei, y0, 9 * p0, y1) < 0
            || _compareProducts(10 * askPriceWei, y0, 11 * p0, y1) > 0) {
            revert IPoolVault.OutsideDesignatedUnitPriceBand();
        }
    }

    function _qualifiedMiner(address collection, uint256 circuitId)
        private
        view
        returns (ITapeoutMining.Miner memory miner)
    {
        bytes32 key = ITapeoutMining(MINING).minerKey(collection, circuitId);
        miner = ITapeoutMining(MINING).getMiner(key);
        if (miner.circuits != collection || miner.circuitId != circuitId) revert IPoolVault.WrongCircuit();
        if (miner.status != 1) revert IPoolVault.MinerNotActive();
        if (miner.taskId == 0 || miner.optimal || miner.unverWeight != 0 || miner.verifWeight == 0) {
            revert IPoolVault.MinerDoesNotMeetCriteria();
        }
    }

    function _dailyOutput(uint128 weight) private view returns (uint256) {
        ITapeoutMining mining = ITapeoutMining(MINING);
        uint256 rate = mining.currentRate();
        uint256 unverifiedBps = mining.UNVERIFIED_BPS();
        uint256 totalWeight = mining.totalVerifWeight();
        if (rate == 0 || unverifiedBps > BASIS_POINTS || totalWeight == 0 || weight > totalWeight) {
            revert IPoolVault.InvalidMiningRate();
        }
        // Official Mining floors the unverified allocation first, then each
        // verified miner's per-second share. Do not collapse these divisions.
        uint256 unverifiedRate = Math.mulDiv(rate, unverifiedBps, BASIS_POINTS);
        uint256 perSecond = Math.mulDiv(rate - unverifiedRate, weight, totalWeight);
        if (perSecond == 0 || perSecond > type(uint256).max / DAY) revert IPoolVault.InvalidMiningRate();
        return perSecond * DAY;
    }

    /// @dev Compare two unsigned 512-bit products without rounding or intermediate overflow.
    function _compareProducts(uint256 a, uint256 b, uint256 c, uint256 d) private pure returns (int8) {
        (uint256 ah, uint256 al) = _fullProduct(a, b);
        (uint256 ch, uint256 cl) = _fullProduct(c, d);
        if (ah < ch || ah == ch && al < cl) return -1;
        if (ah > ch || ah == ch && al > cl) return 1;
        return 0;
    }

    function _fullProduct(uint256 a, uint256 b) private pure returns (uint256 high, uint256 low) {
        assembly {
            let mm := mulmod(a, b, not(0))
            low := mul(a, b)
            high := sub(sub(mm, low), lt(mm, low))
        }
    }
}
