// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";
import {ITapeoutMining} from "../interfaces/ITapeoutMining.sol";
import {ICircuitMarket} from "../interfaces/ICircuitMarket.sol";
import {IFirstoSignedAskExchange} from "../interfaces/IFirstoExchange.sol";
import {IPoolMachineRegistry} from "../interfaces/IPoolMachineRegistry.sol";
import {PoolVaultState} from "../PoolVaultState.sol";
import {PurchaseSelectionState} from "../PurchaseSelectionState.sol";
import {PurchaseValidation} from "./PurchaseValidation.sol";
import {PoolFunds} from "./PoolFunds.sol";

/// @notice Fixed purchase execution plus opt-in, immutable verified-capacity selection terms.
/// @dev All value-moving calls are fixed protocol calls under Vault.nonReentrant. Reference pricing is not an oracle.
library FlexiblePurchase {
    address private constant MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address private constant CIRCUIT_MARKET = 0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f;
    address private constant FIRSTO_SIGNED_ASK = 0x33423244F9a5bF81b12B1a018aF6F4e079B97f29;
    address private constant PROTOCOL_FACTORY = 0x68224F668083c29e9800Be2a646d42d18cedF7e2;
    bytes32 private constant SIGNED_ASK_TYPEHASH = keccak256(
        "SignedAsk(address maker,address collection,uint256 tokenId,uint256 nonce,uint128 price,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion)"
    );

    bytes32 private constant SELECTION_STORAGE = 0xabb161195ab2dca5bb4a3b74cf71ac027f503287a65da4d00c8f2426b582f100;

    event FlexiblePurchaseConfigured(
        uint256 indexed referenceCircuitId, uint128 minVerifiedWeight, bytes32 referenceDigest
    );
    event AlternativeMinerSelected(
        uint256 indexed referenceCircuitId, uint256 indexed acquiredCircuitId, uint256 listingId
    );
    event FlexibleSurplusAllocated(uint256 amount, address indexed roundingRecipient, uint256 roundingWei);
    event PurchaseSurplusSettled(address indexed user, uint256 shares, uint256 amount);
    event PurchaseModelLocked(uint32 indexed taskId);
    event PurchaseReferenceWeightLocked(uint128 verifiedWeight);
    event FirstoPurchased(
        address indexed exchange,
        bytes32 indexed orderHash,
        uint256 indexed circuitId,
        uint256 sellerPrice,
        uint256 sourceFee,
        uint256 totalCost
    );

    function configure(
        PoolVaultState.VaultStorage storage s,
        IPoolVault.FlexiblePurchaseConfig calldata config,
        uint256 supply
    ) external {
        if (msg.sender != s.factory) {
            revert IPoolVault.Unauthorized();
        }
        PurchaseSelectionState.SelectionStorage storage selection = _selection();
        if (selection.enabled) revert IPoolVault.FlexiblePurchaseAlreadyConfigured();
        if (
            s.state != IPoolVault.State.Funding || supply != 0 || s.params.directSeller != address(0)
                || s.params.directPrice != 0 || config.minVerifiedWeight == 0 || config.referencePriceWei == 0
                || config.targetDailyYieldAtomic == 0 || config.referenceObservedAt == 0
                || config.referenceObservedAt > block.timestamp || config.referenceBlock > block.number
                || config.referenceDigest == bytes32(0)
        ) revert IPoolVault.InvalidParameters();
        uint256 rawTarget =
            Math.mulDiv(config.referencePriceWei, uint256(10_000) + config.extraBps, 10_000, Math.Rounding.Ceil);
        uint256 target = Math.ceilDiv(rawTarget, 100) * 100;
        // Extra funding never authorizes paying more per unit of verified weight or more for the original machine.
        if (s.params.targetRaise != target || s.params.priceCap > config.referencePriceWei) {
            revert IPoolVault.InvalidParameters();
        }
        // The model comes from the official on-chain reference miner, never from a price feed or administrator.
        ITapeoutMining.Miner memory referenceMiner =
            _requireQuality(s.params.circuits, s.params.circuitId, config.minVerifiedWeight);
        selection.enabled = true;
        selection.referenceCircuitId = s.params.circuitId;
        selection.config = config;
        selection.modelInitialized = true;
        selection.taskId = referenceMiner.taskId;
        selection.referenceVerifiedWeight = referenceMiner.verifWeight;
        emit FlexiblePurchaseConfigured(s.params.circuitId, config.minVerifiedWeight, config.referenceDigest);
        emit PurchaseModelLocked(referenceMiner.taskId);
        emit PurchaseReferenceWeightLocked(referenceMiner.verifWeight);
    }

    function configuration()
        external
        view
        returns (bool enabled, uint256 referenceCircuitId, IPoolVault.FlexiblePurchaseConfig memory config)
    {
        PurchaseSelectionState.SelectionStorage storage selection = _selection();
        return (selection.enabled, selection.referenceCircuitId, selection.config);
    }

    function model() external view returns (bool initialized, uint32 taskId) {
        PurchaseSelectionState.SelectionStorage storage selection = _selection();
        return (selection.modelInitialized, selection.taskId);
    }

    function referenceWeight() external view returns (uint128) {
        return _selection().referenceVerifiedWeight;
    }

    function shareName(string memory fixedName) external view returns (string memory) {
        return _selection().enabled ? "Verified Capacity Pool Share" : fixedName;
    }

    function buy(PoolVaultState.VaultStorage storage s, uint256 listingId, bool allowAlternative) external {
        _requireWindow(s);
        PurchaseSelectionState.SelectionStorage storage selection = _selection();
        if (selection.enabled && !selection.modelInitialized) revert IPoolVault.PurchaseModelNotInitialized();
        if (selection.enabled && selection.referenceVerifiedWeight == 0) {
            revert IPoolVault.PurchasePricingNotInitialized();
        }
        uint256 circuitId = s.params.circuitId;
        if (allowAlternative) {
            if (!selection.enabled) revert IPoolVault.FlexiblePurchaseDisabled();
            // Seller and price are validated by prepareMarketPurchase; feeBps is seller-borne.
            // slither-disable-next-line unused-return
            (, address circuits, uint256 listedId,,, bool valid) = ICircuitMarket(CIRCUIT_MARKET).listingView(listingId);
            if (!valid) revert IPoolVault.InvalidListing();
            if (circuits != s.params.circuits) revert IPoolVault.WrongCircuit();
            circuitId = listedId;
        }
        if (selection.enabled) {
            // All listing identity/validity fields are checked by prepareMarketPurchase before payment.
            // slither-disable-next-line unused-return
            (,,, uint96 listedPrice,,) = ICircuitMarket(CIRCUIT_MARKET).listingView(listingId);
            _requirePricedModel(selection, s.params.circuits, circuitId, listedPrice);
            if (circuitId != selection.referenceCircuitId && _originalAvailable(s, selection)) {
                revert IPoolVault.OriginalTargetAvailable();
            }
        }
        IPoolMachineRegistry(s.factory).claimMachine(s.params.circuits, circuitId);
        (address seller, uint256 price, bytes32 key) =
            PurchaseValidation.prepareMarketPurchase(s.params.circuits, circuitId, s.params.priceCap, listingId);
        // Claim may alter miner state. Recheck the actual returned price and chain weight before any purchase payment.
        if (selection.enabled) _requirePricedModel(selection, s.params.circuits, circuitId, price);
        // A failed transfer, changed miner, or wrong callback reverts this temporary selection together with all funds.
        s.params.circuitId = circuitId;
        _expectNft(s, seller, CIRCUIT_MARKET);
        // The official market's seller-borne fee is already included in the listing price.
        ICircuitMarket(CIRCUIT_MARKET).buy{value: price}(listingId, SafeCast.toUint96(price));
        _finish(s, price, 0, listingId, key);
        if (selection.enabled) {
            // Repeat after claim/market callbacks so eligibility cannot be changed during execution.
            _requirePricedModel(selection, s.params.circuits, circuitId, price);
            _allocateEntireSurplus(s, s.totalRaised - price);
            emit AlternativeMinerSelected(selection.referenceCircuitId, circuitId, listingId);
        }
    }

    /// @dev Preserves the delivered fixed-pool direct purchase and pull-payment behavior.
    function sell(PoolVaultState.VaultStorage storage s) external {
        _requireWindow(s);
        if (_selection().enabled) revert IPoolVault.InvalidParameters();
        address seller = s.params.directSeller;
        uint256 price = s.params.directPrice;
        IPoolMachineRegistry(s.factory).claimMachine(s.params.circuits, s.params.circuitId);
        bytes32 key = PurchaseValidation.prepareDirectPurchase(
            s.params.circuits, s.params.circuitId, seller, price, s.params.priceCap
        );
        _expectNft(s, seller, address(this));
        IERC721(s.params.circuits).safeTransferFrom(seller, address(this), s.params.circuitId);
        _finish(s, price, 1, 0, key);
        s.bnbOwed[seller] += price;
        s.totalBnbOwed += price;
    }

    /// @notice Fixed signed-ask V2 purchase of the original target only. No caller-selected target or calldata.
    /// @dev The separate batch ABI is intentionally not executable until its runtime provenance is resolved.
    function buyFirsto(PoolVaultState.VaultStorage storage s, uint8 kind, bytes calldata encodedOrder) external {
        _requireWindow(s);
        if (kind != 0) revert IPoolVault.UnverifiedPurchaseRoute();
        // Bound work before decoding; the fixed exchange validates ECDSA or ERC-1271 signatures itself.
        if (block.chainid != 56 || encodedOrder.length < 384 || encodedOrder.length > 1408) {
            revert IPoolVault.InvalidFirstoOrder();
        }
        (IFirstoSignedAskExchange.SignedAsk memory ask, bytes memory signature) =
            abi.decode(encodedOrder, (IFirstoSignedAskExchange.SignedAsk, bytes));
        if (signature.length > 1024 || keccak256(encodedOrder) != keccak256(abi.encode(ask, signature))) {
            revert IPoolVault.InvalidFirstoOrder();
        }
        PurchaseSelectionState.SelectionStorage storage selection = _selection();
        uint256 originalId = selection.enabled ? selection.referenceCircuitId : s.params.circuitId;
        if (ask.collection != s.params.circuits || ask.tokenId != originalId || ask.tokenId != s.params.circuitId) {
            revert IPoolVault.WrongCircuit();
        }
        if (
            ask.maker == address(0) || ask.payoutRecipient == address(0) || ask.price == 0
                || ask.expiry <= block.timestamp || ask.schemaVersion != 2
        ) revert IPoolVault.InvalidFirstoOrder();
        if (selection.enabled && !selection.modelInitialized) revert IPoolVault.PurchaseModelNotInitialized();
        if (selection.enabled && selection.referenceVerifiedWeight == 0) {
            revert IPoolVault.PurchasePricingNotInitialized();
        }
        // A signed ask must not bypass an eligible official listing for this exact NFT.
        // A reverted official-market read does not prove that the listing is gone.
        if (_originalAvailable(s, selection)) revert IPoolVault.OriginalTargetAvailable();
        _requireFirstoFees(ask);
        if (IFirstoSignedAskExchange(FIRSTO_SIGNED_ASK).isSignedAskNonceInvalidated(ask.maker, ask.nonce)) {
            revert IPoolVault.InvalidFirstoOrder();
        }
        // Source protocol uses integer division (floor). The pool budget always includes this buyer-paid fee.
        uint256 fee = uint256(ask.price) * ask.feeBps / 10_000;
        uint256 cost = uint256(ask.price) + fee;
        if (cost > s.params.priceCap || cost > s.totalRaised) revert IPoolVault.OverPriceCap();
        if (address(this).balance < s.totalBnbOwed + cost) revert IPoolVault.AccountingDeficit();
        _requireFirstoQuality(selection, ask.collection, ask.tokenId, cost);
        IPoolMachineRegistry(s.factory).claimMachine(ask.collection, ask.tokenId);
        bytes32 orderHash = _signedAskHash(ask);
        bytes32 key = PurchaseValidation.prepareFirstoPurchase(ask.collection, ask.tokenId, ask.maker, orderHash);
        // The reward claim must not alter eligibility or source fees between validation and payment.
        _requireFirstoQuality(selection, ask.collection, ask.tokenId, cost);
        _requireFirstoFees(ask);
        _expectNft(s, ask.maker, FIRSTO_SIGNED_ASK);
        uint256 balanceBefore = address(this).balance;
        IFirstoSignedAskExchange(FIRSTO_SIGNED_ASK).fillSignedAsk{value: cost}(ask, signature, address(this));
        // A refund or unsolicited transfer during execution must not make recorded cost differ from net spending.
        if (address(this).balance != balanceBefore - cost) revert IPoolVault.PaymentMismatch();
        _finish(s, cost, 2, 0, key);
        _requireFirstoQuality(selection, ask.collection, ask.tokenId, cost);
        _requireFirstoFees(ask);
        if (selection.enabled) _allocateEntireSurplus(s, s.totalRaised - cost);
        emit FirstoPurchased(FIRSTO_SIGNED_ASK, orderHash, ask.tokenId, ask.price, fee, cost);
    }

    function _requireFirstoFees(IFirstoSignedAskExchange.SignedAsk memory ask) private view {
        IFirstoSignedAskExchange exchange = IFirstoSignedAskExchange(FIRSTO_SIGNED_ASK);
        if (exchange.factory() != PROTOCOL_FACTORY || exchange.paused() || exchange.SIGNED_ASK_SCHEMA_VERSION() != 2) {
            revert IPoolVault.InvalidFirstoOrder();
        }
        // Epoch changes fail closed even if the exchange itself still accepts a historical signed fee epoch.
        if (
            ask.feeBps > 10_000 || ask.feeEpoch != exchange.feeEpoch() || ask.feeBps != exchange.defaultTakerFeeBps()
                || ask.feeBps != exchange.feeBpsAtEpoch(ask.feeEpoch)
        ) revert IPoolVault.FirstoFeeChanged();
    }

    function _requireFirstoQuality(
        PurchaseSelectionState.SelectionStorage storage selection,
        address circuits,
        uint256 circuitId,
        uint256 cost
    ) private view {
        if (selection.enabled) _requirePricedModel(selection, circuits, circuitId, cost);
        else _requireQuality(circuits, circuitId, 1);
    }

    function _signedAskHash(IFirstoSignedAskExchange.SignedAsk memory ask) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Firsto Circuit Signed Ask"),
                keccak256("2"),
                block.chainid,
                FIRSTO_SIGNED_ASK
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(SIGNED_ASK_TYPEHASH, ask))));
    }

    function _requireWindow(PoolVaultState.VaultStorage storage s) private view {
        if (s.state != IPoolVault.State.Funded) revert IPoolVault.WrongState();
        if (block.timestamp >= s.params.purchaseDeadline) revert IPoolVault.DeadlinePassed();
    }

    function _requireQuality(address circuits, uint256 circuitId, uint128 minWeight)
        private
        view
        returns (ITapeoutMining.Miner memory miner)
    {
        bytes32 key = ITapeoutMining(MINING).minerKey(circuits, circuitId);
        miner = ITapeoutMining(MINING).getMiner(key);
        if (miner.circuits != circuits || miner.circuitId != circuitId) revert IPoolVault.WrongCircuit();
        if (miner.status != 1) revert IPoolVault.MinerNotActive();
        // "99% verified" names a reward pool; it does not mean 99% of a miner's weight may be verified.
        if (!_meetsQuality(miner, minWeight)) {
            revert IPoolVault.MinerDoesNotMeetCriteria();
        }
    }

    function _requirePricedModel(
        PurchaseSelectionState.SelectionStorage storage selection,
        address circuits,
        uint256 circuitId,
        uint256 price
    ) private view {
        ITapeoutMining.Miner memory miner = _requireQuality(circuits, circuitId, selection.config.minVerifiedWeight);
        if (miner.taskId != selection.taskId) {
            revert IPoolVault.WrongPurchaseModel();
        }
        if (price > _referencePriceLimit(selection, miner.verifWeight)) revert IPoolVault.OverReferenceUnitPrice();
    }

    function _referencePriceLimit(PurchaseSelectionState.SelectionStorage storage selection, uint128 weight)
        private
        view
        returns (uint256)
    {
        // Global cap is no larger than referencePrice, so avoid multiplication overflow when weight increased.
        if (weight >= selection.referenceVerifiedWeight) return selection.config.referencePriceWei;
        return Math.mulDiv(selection.config.referencePriceWei, weight, selection.referenceVerifiedWeight);
    }

    function _meetsQuality(ITapeoutMining.Miner memory miner, uint128 minWeight) private pure returns (bool) {
        return !miner.optimal && miner.unverWeight == 0 && miner.verifWeight >= minWeight;
    }

    /// @dev Original-target priority is enforced on chain, including for permissionless third-party buyers.
    /// A protocol read that reverts fails closed; a failed simulation never proves the original is unavailable.
    function _originalAvailable(
        PoolVaultState.VaultStorage storage s,
        PurchaseSelectionState.SelectionStorage storage selection
    ) private view returns (bool) {
        address circuits = s.params.circuits;
        uint256 id = selection.enabled ? selection.referenceCircuitId : s.params.circuitId;
        (uint256 listingId, address seller, uint96 price, bool valid) =
            ICircuitMarket(CIRCUIT_MARKET).listingFor(circuits, id);
        if (!valid || seller == address(0) || price == 0 || price > s.params.priceCap) return false;
        // Buyer pays the listing price; the omitted fee is deducted from the seller proceeds.
        // slither-disable-next-line unused-return
        (address listedSeller, address listedCircuits, uint256 listedId, uint96 listedPrice,, bool listingValid) =
            ICircuitMarket(CIRCUIT_MARKET).listingView(listingId);
        if (
            !listingValid || seller != listedSeller || circuits != listedCircuits || id != listedId
                || price != listedPrice
        ) {
            revert IPoolVault.InvalidListing();
        }
        if (IERC721(circuits).ownerOf(id) != seller) return false;
        ITapeoutMining.Miner memory miner =
            ITapeoutMining(MINING).getMiner(ITapeoutMining(MINING).minerKey(circuits, id));
        if (miner.circuits != circuits || miner.circuitId != id || miner.status != 1) return false;
        if (!selection.enabled) return _meetsQuality(miner, 1);
        return miner.taskId == selection.taskId && _meetsQuality(miner, selection.config.minVerifiedWeight)
            && price <= _referencePriceLimit(selection, miner.verifWeight);
    }

    function _expectNft(PoolVaultState.VaultStorage storage s, address seller, address expectedOperator) private {
        s.expectedNftSeller = seller;
        s.expectedNftOperator = expectedOperator;
        s.nftReceived = false;
    }

    function _finish(PoolVaultState.VaultStorage storage s, uint256 cost, uint8 path, uint256 listingId, bytes32 key)
        private
    {
        if (!s.nftReceived) revert IPoolVault.UnexpectedNft();
        if (IERC721(s.params.circuits).ownerOf(s.params.circuitId) != address(this)) {
            revert IPoolVault.NotOwnerAfterBuy();
        }
        if (PurchaseValidation.activeMinerKey(s.params.circuits, s.params.circuitId) != key) {
            revert IPoolVault.WrongCircuit();
        }
        PoolFunds.recordPurchase(s, cost, path, listingId);
    }

    /// @dev At most 100 current holders (100 integer shares). Credit the purchase-time owners now; no external payment.
    /// Each gets floor(surplus * shares / 100); the last member receives the remaining integer-division dust.
    function _allocateEntireSurplus(PoolVaultState.VaultStorage storage s, uint256 surplus) private {
        uint256 count = s.activeMembers.length;
        uint256 allocated = 0;
        uint256 totalShares = 0;
        uint256 rounding = 0;
        address lastMember = address(0);
        for (uint256 i; i < count; ++i) {
            address member = s.activeMembers[i];
            uint256 shares = IERC20(address(this)).balanceOf(member);
            uint256 amount = Math.mulDiv(surplus, shares, 100);
            totalShares += shares;
            if (i + 1 == count) {
                rounding = surplus - allocated - amount;
                amount += rounding;
                lastMember = member;
            }
            allocated += amount;
            s.surplusSettled[member] = true;
            s.bnbOwed[member] += amount;
            s.totalBnbOwed += amount;
            emit PurchaseSurplusSettled(member, shares, amount);
        }
        if (totalShares != 100 || allocated != surplus) revert IPoolVault.AccountingDeficit();
        s.surplusOutstandingWei = 0;
        s.surplusRemainder = 0;
        s.surplusPerShareWei = 0;
        emit FlexibleSurplusAllocated(surplus, lastMember, rounding);
    }

    function _selection() private pure returns (PurchaseSelectionState.SelectionStorage storage s) {
        bytes32 slot = SELECTION_STORAGE;
        assembly { s.slot := slot }
    }
}
