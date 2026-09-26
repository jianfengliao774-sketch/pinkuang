// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {PurchaseMockNft, PurchaseMockBem, PurchaseMockMarket} from "../utils/PurchaseMocks.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {ITapeoutMining} from "../../src/interfaces/ITapeoutMining.sol";
import {ICircuitMarket} from "../../src/interfaces/ICircuitMarket.sol";
import {Addresses} from "../../script/Addresses.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev Fault injection only, installed by vm.etch at the protocol constant on the isolated test EVM.
contract FlexibleMiningMock {
    mapping(bytes32 => ITapeoutMining.Miner) private miners;
    mapping(bytes32 => uint256) public pending;
    uint8 public claimFault;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentrySucceeded;
    bool public reentryAttempted;
    uint256 public claimCalls;

    function minerKey(address circuits, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(circuits, id));
    }

    function configure(address circuits, uint256 id, uint128 verified, uint128 unverified, bool optimal) external {
        bytes32 key = minerKey(circuits, id);
        ITapeoutMining.Miner storage miner = miners[key];
        miner.circuits = circuits;
        miner.circuitId = uint64(id);
        miner.taskId = 7;
        miner.status = 1;
        miner.verifWeight = verified;
        miner.unverWeight = unverified;
        miner.optimal = optimal;
    }

    function getMiner(bytes32 key) external view returns (ITapeoutMining.Miner memory) {
        return miners[key];
    }

    function setStatus(bytes32 key, uint8 status) external {
        miners[key].status = status;
    }

    function setTaskId(bytes32 key, uint32 taskId) external {
        miners[key].taskId = taskId;
    }

    function setIdentity(bytes32 key, address circuits, uint64 circuitId) external {
        miners[key].circuits = circuits;
        miners[key].circuitId = circuitId;
    }

    function setPending(bytes32 key, uint256 amount) external {
        pending[key] = amount;
    }

    function setClaimFault(uint8 fault) external {
        claimFault = fault;
    }

    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
    }

    function claim(bytes32 key) external {
        ITapeoutMining.Miner storage miner = miners[key];
        require(miner.status == 1 && claimFault != 1, "mock claim failure");
        ++claimCalls;
        uint256 amount = pending[key];
        pending[key] = 0;
        if (amount > 0) {
            PurchaseMockBem(Addresses.BEM).mint(PurchaseMockNft(miner.circuits).ownerOf(miner.circuitId), amount);
        }
        if (claimFault == 2) miner.unverWeight = 1;
        if (claimFault == 3) miner.verifWeight = 1;
        if (claimFault == 4) miner.optimal = true;
        if (claimFault == 5) miner.taskId += 1;
        if (reentryTarget != address(0)) {
            reentryAttempted = true;
            (reentrySucceeded,) = reentryTarget.call(reentryData);
        }
    }
}

contract RejectingFlexibleHolder {
    receive() external payable {
        revert("BNB rejected");
    }
}

contract FlexiblePurchaseTest is FundingTestBase {
    address private constant SELLER = address(0x5E11E2);
    address private constant OTHER_BUYER = address(0xBEEF);
    address private constant DAVE = address(0xDA7E);
    uint256 private constant REFERENCE_ID = 16210;
    uint256 private constant ALTERNATIVE_ID = 16211;
    uint128 private constant MIN_WEIGHT = 200;

    PurchaseMockNft private nft;
    PurchaseMockBem private bem;
    FlexibleMiningMock private mining;
    PurchaseMockMarket private market;
    IPoolVault.FlexiblePurchaseConfig private config;

    function setUp() public override {
        super.setUp();
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEHEMOTH_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.MINING, address(new FlexibleMiningMock()).code);
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        bem = PurchaseMockBem(Addresses.BEM);
        mining = FlexibleMiningMock(Addresses.MINING);
        market = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);
        config = IPoolVault.FlexiblePurchaseConfig({
            minVerifiedWeight: MIN_WEIGHT,
            referencePriceWei: 6 ether,
            targetDailyYieldAtomic: 15 * 1e8,
            extraBps: 1000,
            referenceObservedAt: uint64(block.timestamp),
            referenceBlock: uint64(block.number),
            referenceDigest: keccak256("example disclosed Firsto snapshot, not oracle")
        });
        defaultParams.targetRaise = 6.6 ether;
        defaultParams.priceCap = defaultParams.targetRaise;
        _mintMiner(REFERENCE_ID);
        _mintMiner(ALTERNATIVE_ID);
        pool = _flexible(defaultParams, config);
    }

    function _flexible(IPoolVault.PoolParams memory params, IPoolVault.FlexiblePurchaseConfig memory terms)
        private
        returns (IFundingVault)
    {
        vm.prank(OPERATOR);
        return IFundingVault(poolFactory.createFlexiblePool(params, terms));
    }

    function _mintMiner(uint256 id) private {
        nft.mint(SELLER, id);
        mining.configure(address(nft), id, MIN_WEIGHT, 0, false);
        vm.prank(SELLER);
        nft.approve(address(market), id);
    }

    function _list(uint256 id, uint96 price) private returns (uint256) {
        return market.createListing(SELLER, address(nft), id, price);
    }

    function _fund() private {
        _deposit(pool, ALICE, 49);
        _deposit(pool, BOB, 26);
        _deposit(pool, CAROL, 25);
    }

    function _assertUntouched() private view {
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funded));
        assertEq(pool.params().circuitId, REFERENCE_ID);
        assertEq(address(pool).balance, defaultParams.targetRaise);
        assertEq(nft.ownerOf(ALTERNATIVE_ID), SELLER);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(market.buyCalls(), 0);
        assertEq(mining.claimCalls(), 0);
    }

    function test_configureIsAtomicFactoryOnlyAndImmutable() public {
        (bool enabled, uint256 referenceId, IPoolVault.FlexiblePurchaseConfig memory saved) = pool.flexiblePurchase();
        assertTrue(enabled);
        assertEq(referenceId, REFERENCE_ID);
        assertEq(saved.referencePriceWei, 6 ether);
        assertEq(saved.extraBps, 1000);
        assertEq(saved.minVerifiedWeight, MIN_WEIGHT);
        assertEq(saved.referenceDigest, config.referenceDigest);
        (bool initialized, uint32 taskId) = pool.purchaseModel();
        assertTrue(initialized);
        assertEq(taskId, 7);
        assertEq(IERC20Metadata(address(pool)).name(), "Verified Capacity Pool Share");
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        pool.configureFlexiblePurchase(config);
        vm.prank(address(poolFactory));
        vm.expectRevert(IPoolVault.FlexiblePurchaseAlreadyConfigured.selector);
        pool.configureFlexiblePurchase(config);
    }

    function test_configureRejectsPostFundingEvenWhenFactoryCalls() public {
        IFundingVault fixedPool = _createPool(defaultParams);
        _deposit(fixedPool, ALICE, 1);
        vm.prank(address(poolFactory));
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        fixedPool.configureFlexiblePurchase(config);
    }

    function testFuzz_configureRejectsInvalidOnchainReferenceAtomically(uint8 fault) public {
        fault = uint8(bound(fault, 0, 5));
        bytes32 key = mining.minerKey(address(nft), REFERENCE_ID);
        if (fault == 0) mining.setIdentity(key, Addresses.BEHEMOTH_CIRCUITS, uint64(REFERENCE_ID));
        if (fault == 1) mining.setIdentity(key, address(nft), uint64(REFERENCE_ID + 1));
        if (fault == 2) mining.setStatus(key, 3);
        if (fault == 3) mining.configure(address(nft), REFERENCE_ID, MIN_WEIGHT - 1, 0, false);
        if (fault == 4) mining.configure(address(nft), REFERENCE_ID, MIN_WEIGHT, 1, false);
        if (fault == 5) mining.configure(address(nft), REFERENCE_ID, MIN_WEIGHT, 0, true);
        uint256 count = poolFactory.poolCount();
        vm.prank(OPERATOR);
        vm.expectRevert();
        poolFactory.createFlexiblePool(defaultParams, config);
        assertEq(poolFactory.poolCount(), count);
    }

    function testFuzz_modelIsReadFromChainIncludingTaskZero(uint32 taskId) public {
        mining.setTaskId(mining.minerKey(address(nft), REFERENCE_ID), taskId);
        pool = _flexible(defaultParams, config);
        (bool initialized, uint32 lockedTask) = pool.purchaseModel();
        assertTrue(initialized);
        assertEq(lockedTask, taskId);
    }

    function test_sameWeightWrongTaskRejectedOnBothPurchaseEntries() public {
        _fund();
        mining.setTaskId(mining.minerKey(address(nft), ALTERNATIVE_ID), 8);
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        vm.expectRevert(IPoolVault.WrongPurchaseModel.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
        mining.setTaskId(mining.minerKey(address(nft), REFERENCE_ID), 8);
        listing = _list(REFERENCE_ID, 6 ether);
        vm.expectRevert(IPoolVault.WrongPurchaseModel.selector);
        pool.buyFromMarket(listing);
        _assertUntouched();
    }

    function testFuzz_wrongMinerIdentityRollsBackAllFunds(bool wrongCollection) public {
        _fund();
        bytes32 key = mining.minerKey(address(nft), ALTERNATIVE_ID);
        mining.setIdentity(
            key,
            wrongCollection ? Addresses.BEHEMOTH_CIRCUITS : address(nft),
            uint64(wrongCollection ? ALTERNATIVE_ID : REFERENCE_ID)
        );
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
    }

    function testFuzz_modelChangedDuringClaimOrMarketTransferRollsBack(bool duringClaim) public {
        _fund();
        if (duringClaim) mining.setClaimFault(5);
        else market.setBuyFault(5);
        bytes32 key = mining.minerKey(address(nft), ALTERNATIVE_ID);
        mining.setPending(key, 999);
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        uint256 sellerBefore = SELLER.balance;
        vm.expectRevert(IPoolVault.WrongPurchaseModel.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
        assertEq(SELLER.balance, sellerBefore);
        assertEq(mining.getMiner(key).taskId, 7);
        assertEq(mining.pending(key), 999);
        assertEq(bem.balanceOf(SELLER), 0);
    }

    function test_originalAffordableListingPreventsThirdPartyAlternativeFrontRun() public {
        _fund();
        uint256 original = _list(REFERENCE_ID, 5 ether);
        uint256 expensiveAlternative = _list(ALTERNATIVE_ID, uint96(defaultParams.priceCap));
        vm.prank(SELLER);
        vm.expectRevert(IPoolVault.OriginalTargetAvailable.selector);
        pool.buyAlternativeFromMarket(expensiveAlternative);
        _assertUntouched();
        // The same-ID alternative entry is valid; priority cannot lock out the actual original purchase.
        pool.buyAlternativeFromMarket(original);
        assertEq(pool.params().circuitId, REFERENCE_ID);
        assertEq(nft.ownerOf(REFERENCE_ID), address(pool));
        assertEq(pool.totalBnbOwed(), 1.6 ether);
    }

    function testFuzz_originalUnavailableOrUnqualifiedAllowsReplacement(uint8 fault) public {
        fault = uint8(bound(fault, 0, 7));
        _fund();
        uint256 original = _list(REFERENCE_ID, uint96(fault == 2 ? defaultParams.priceCap + 1 : 5 ether));
        bytes32 key = mining.minerKey(address(nft), REFERENCE_ID);
        if (fault == 0) market.setValid(original, false);
        if (fault == 1) nft.forceTransfer(OTHER_BUYER, REFERENCE_ID); // stale listing, owner changed
        if (fault == 3) mining.setStatus(key, 3);
        if (fault == 4) mining.setTaskId(key, 8);
        if (fault == 5) mining.configure(address(nft), REFERENCE_ID, MIN_WEIGHT - 1, 0, false);
        if (fault == 6) mining.configure(address(nft), REFERENCE_ID, MIN_WEIGHT, 1, false);
        if (fault == 7) mining.configure(address(nft), REFERENCE_ID, MIN_WEIGHT, 0, true);
        pool.buyAlternativeFromMarket(_list(ALTERNATIVE_ID, 6 ether));
        assertEq(pool.params().circuitId, ALTERNATIVE_ID);
        assertEq(nft.ownerOf(ALTERNATIVE_ID), address(pool));
    }

    function test_originalSimulationFailureDoesNotAuthorizeAlternativeButDeadlineRefundWorks() public {
        _fund();
        uint256 original = _list(REFERENCE_ID, 5 ether);
        uint256 alternative = _list(ALTERNATIVE_ID, 6 ether);
        vm.prank(SELLER);
        nft.approve(address(0), REFERENCE_ID);
        vm.expectRevert();
        pool.buyFromMarket(original);
        vm.expectRevert(IPoolVault.OriginalTargetAvailable.selector);
        pool.buyAlternativeFromMarket(alternative);
        _assertUntouched();
        vm.warp(defaultParams.purchaseDeadline);
        pool.finalizeFailure();
        assertEq(pool.totalBnbOwed(), defaultParams.targetRaise);
        vm.prank(ALICE);
        pool.withdrawBnb();
        vm.prank(BOB);
        pool.withdrawBnb();
        vm.prank(CAROL);
        pool.withdrawBnb();
        assertEq(address(pool).balance, 0);
    }

    function testFuzz_zeroPriceOrSellerOriginalIsNotPurchasable(bool zeroSeller) public {
        _fund();
        market.createListing(zeroSeller ? address(0) : SELLER, address(nft), REFERENCE_ID, zeroSeller ? 5 ether : 0);
        pool.buyAlternativeFromMarket(_list(ALTERNATIVE_ID, 6 ether));
        assertEq(pool.params().circuitId, ALTERNATIVE_ID);
    }

    function test_failedOriginalLookupCannotBeTreatedAsUnavailable() public {
        _fund();
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        vm.mockCallRevert(
            address(market),
            abi.encodeCall(ICircuitMarket.listingFor, (address(nft), REFERENCE_ID)),
            abi.encodeWithSignature("Error(string)", "protocol lookup unavailable")
        );
        vm.expectRevert();
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
        vm.clearMockedCalls();
        vm.warp(defaultParams.purchaseDeadline);
        pool.finalizeFailure();
        assertEq(pool.totalBnbOwed(), defaultParams.targetRaise);
    }

    function test_legacyFlexibleWithoutModelCannotPurchaseOrBackfillButCanRefund() public {
        // Simulate the pre-model namespace: the appended bool/uint32 share relative slot 7.
        bytes32 modelSlot = bytes32(uint256(0xabb161195ab2dca5bb4a3b74cf71ac027f503287a65da4d00c8f2426b582f100) + 7);
        vm.store(address(pool), modelSlot, bytes32(0));
        (bool initialized,) = pool.purchaseModel();
        assertFalse(initialized);
        _deposit(pool, ALICE, 1);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        vm.prank(ALICE);
        pool.withdrawBnb();
        _fund();
        uint256 original = _list(REFERENCE_ID, 5 ether);
        uint256 alternative = _list(ALTERNATIVE_ID, 6 ether);
        vm.expectRevert(IPoolVault.PurchaseModelNotInitialized.selector);
        pool.buyFromMarket(original);
        vm.expectRevert(IPoolVault.PurchaseModelNotInitialized.selector);
        pool.buyAlternativeFromMarket(alternative);
        vm.prank(address(poolFactory));
        vm.expectRevert(IPoolVault.FlexiblePurchaseAlreadyConfigured.selector);
        pool.configureFlexiblePurchase(config);
        _assertUntouched();
        vm.warp(defaultParams.purchaseDeadline);
        pool.finalizeFailure();
        assertEq(pool.totalBnbOwed(), defaultParams.targetRaise);
    }

    function test_missingTransferApprovalRollsBackSelectionPaymentAndSellerRewards() public {
        _fund();
        vm.prank(SELLER);
        nft.approve(address(0), ALTERNATIVE_ID);
        bytes32 key = mining.minerKey(address(nft), ALTERNATIVE_ID);
        mining.setPending(key, 999);
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        uint256 sellerBefore = SELLER.balance;
        vm.expectRevert();
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
        assertEq(SELLER.balance, sellerBefore);
        assertEq(mining.pending(key), 999);
        assertEq(bem.balanceOf(SELLER), 0);
    }

    function test_purchaseWith100HoldersStaysWithinLocalGasBudgetAndAllocatesEveryWei() public {
        for (uint256 i; i < 100; ++i) {
            _deposit(pool, address(uint160(0x10000 + i)), 1);
        }
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether + 1);
        // Clear warm slots from funding; this remains a local mock measurement, not a live-chain gas guarantee.
        vm.cool(address(pool));
        vm.cool(address(beacon));
        vm.cool(address(vaultImplementation));
        vm.cool(address(market));
        vm.cool(address(nft));
        vm.cool(address(mining));
        vm.cool(address(bem));
        uint256 gasBefore = gasleft();
        pool.buyAlternativeFromMarket(listing);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("100-holder purchase local execution gas (setup excluded)", gasUsed);
        assertLt(gasUsed, 8_000_000);
        uint256 credited;
        for (uint256 i; i < 100; ++i) {
            credited += pool.bnbOwed(address(uint160(0x10000 + i)));
        }
        assertEq(credited, defaultParams.targetRaise - 6 ether - 1);
        assertEq(credited, pool.totalBnbOwed());
        assertEq(nft.ownerOf(ALTERNATIVE_ID), address(pool));
    }

    function test_failureWith100HoldersStaysWithinLocalGasBudgetAndReturnsEveryWei() public {
        for (uint256 i; i < 100; ++i) {
            _deposit(pool, address(uint160(0x10000 + i)), 1);
        }
        vm.warp(defaultParams.purchaseDeadline);
        vm.cool(address(pool));
        vm.cool(address(beacon));
        vm.cool(address(vaultImplementation));
        uint256 gasBefore = gasleft();
        pool.finalizeFailure();
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("100-holder failure local execution gas (setup excluded)", gasUsed);
        assertLt(gasUsed, 5_000_000);
        for (uint256 i; i < 100; ++i) {
            address member = address(uint160(0x10000 + i));
            assertEq(pool.bnbOwed(member), pool.unitPriceWei());
            vm.prank(member);
            pool.withdrawBnb();
        }
        assertEq(address(pool).balance, 0);
        assertEq(pool.totalBnbOwed(), 0);
    }

    function testFuzz_rejectingBnbHolderCannotBlockPurchaseOrOtherRefunds(bool failPurchase) public {
        address rejecting = address(new RejectingFlexibleHolder());
        _deposit(pool, rejecting, 49);
        _deposit(pool, BOB, 26);
        _deposit(pool, CAROL, 25);
        if (failPurchase) {
            vm.warp(defaultParams.purchaseDeadline);
            pool.finalizeFailure();
        } else {
            pool.buyAlternativeFromMarket(_list(ALTERNATIVE_ID, 6 ether));
        }
        uint256 ownCredit = pool.bnbOwed(rejecting);
        assertGt(ownCredit, 0);
        vm.prank(rejecting);
        vm.expectRevert(IPoolVault.TransferFailed.selector);
        pool.withdrawBnb();
        assertEq(pool.bnbOwed(rejecting), ownCredit);
        vm.prank(BOB);
        pool.withdrawBnb();
        vm.prank(CAROL);
        pool.withdrawBnb();
        assertEq(pool.totalBnbOwed(), ownCredit);
        assertEq(address(pool).balance, ownCredit);
    }

    function test_factoryCreationRejectsUnauthorizedAndInvalidReferenceRaise() public {
        vm.expectRevert(PoolFactory.Unauthorized.selector);
        poolFactory.createFlexiblePool(defaultParams, config);
        IPoolVault.PoolParams memory invalid = defaultParams;
        invalid.targetRaise += 100;
        uint256 count = poolFactory.poolCount();
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        poolFactory.createFlexiblePool(invalid, config);
        assertEq(poolFactory.poolCount(), count);
    }

    function test_configRejectsDirectRouteAndZeroOrFutureTerms() public {
        IPoolVault.PoolParams memory params = defaultParams;
        params.directSeller = SELLER;
        params.directPrice = 6 ether;
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        poolFactory.createFlexiblePool(params, config);
        config.minVerifiedWeight = 0;
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        poolFactory.createFlexiblePool(defaultParams, config);
        config.minVerifiedWeight = MIN_WEIGHT;
        config.referenceObservedAt = uint64(block.timestamp + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        poolFactory.createFlexiblePool(defaultParams, config);
    }

    function test_extraAdjustableAndTargetRoundsUpToHundredWei() public {
        config.referencePriceWei = 1001;
        config.extraBps = 0;
        defaultParams.targetRaise = 1100;
        defaultParams.priceCap = 1100;
        IFundingVault rounded = _flexible(defaultParams, config);
        assertEq(rounded.unitPriceWei(), 11);
        config.extraBps = 2500;
        defaultParams.targetRaise = 1300;
        defaultParams.priceCap = 1300;
        rounded = _flexible(defaultParams, config);
        assertEq(rounded.unitPriceWei(), 13);
    }

    function test_originalSoldThenQualifiedAlternativeActivatesAndSettlesSellerOldRewards() public {
        _fund();
        uint256 originalListing = _list(REFERENCE_ID, 6 ether);
        nft.forceTransfer(OTHER_BUYER, REFERENCE_ID);
        market.setValid(originalListing, false);
        vm.expectRevert(IPoolVault.InvalidListing.selector);
        pool.buyFromMarket(originalListing);
        uint256 replacement = _list(ALTERNATIVE_ID, 6 ether);
        bytes32 key = mining.minerKey(address(nft), ALTERNATIVE_ID);
        mining.setPending(key, 12345);
        vm.prank(address(0xCA11));
        pool.buyAlternativeFromMarket(replacement);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertEq(pool.params().circuitId, ALTERNATIVE_ID);
        (, uint256 referenceId,) = pool.flexiblePurchase();
        assertEq(referenceId, REFERENCE_ID);
        assertEq(nft.ownerOf(REFERENCE_ID), OTHER_BUYER);
        assertEq(nft.ownerOf(ALTERNATIVE_ID), address(pool));
        assertEq(bem.balanceOf(SELLER), 12345);
        assertEq(bem.balanceOf(address(pool)), 0);
        assertEq(mining.pending(key), 0);
        assertEq(pool.totalBnbOwed(), 0.6 ether);
    }

    function test_fullSurplusUses49_26_25AndRoundingNoDustRemains() public {
        _fund();
        uint256 price = 6 ether + 1;
        pool.buyAlternativeFromMarket(_list(ALTERNATIVE_ID, uint96(price)));
        uint256 surplus = defaultParams.targetRaise - price;
        uint256 alice = surplus * 49 / 100;
        uint256 bob = surplus * 26 / 100;
        uint256 carol = surplus - alice - bob;
        assertEq(pool.bnbOwed(ALICE), alice);
        assertEq(pool.bnbOwed(BOB), bob);
        assertEq(pool.bnbOwed(CAROL), carol);
        assertEq(pool.totalBnbOwed(), surplus);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - before, alice);
        vm.prank(BOB);
        pool.withdrawBnb();
        vm.prank(CAROL);
        pool.withdrawBnb();
        assertEq(address(pool).balance, 0);
        assertEq(pool.totalBnbOwed(), 0);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        pool.withdrawBnb();
    }

    function test_originalEntryCannotBypassVerifiedQuality() public {
        _fund();
        mining.configure(address(nft), REFERENCE_ID, MIN_WEIGHT, 1, false);
        uint256 listing = _list(REFERENCE_ID, 6 ether);
        vm.expectRevert(IPoolVault.MinerDoesNotMeetCriteria.selector);
        pool.buyFromMarket(listing);
        _assertUntouched();
    }

    function testFuzz_alternativeRejectsLowWeightUnverifiedOptimalOrInactive(uint8 fault) public {
        fault = uint8(bound(fault, 0, 4));
        _fund();
        mining.configure(
            address(nft),
            ALTERNATIVE_ID,
            fault == 0 ? MIN_WEIGHT - 1 : fault == 4 ? 0 : MIN_WEIGHT,
            fault == 1 ? 1 : 0,
            fault == 2
        );
        if (fault == 3) mining.setStatus(mining.minerKey(address(nft), ALTERNATIVE_ID), 3);
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        vm.expectRevert();
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
    }

    function test_priceCapRejectsOneWeiExcessAndAllowsBoundary() public {
        _fund();
        uint256 listing = _list(ALTERNATIVE_ID, uint96(defaultParams.priceCap + 1));
        vm.expectRevert(IPoolVault.OverPriceCap.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
        pool.buyAlternativeFromMarket(_list(ALTERNATIVE_ID, uint96(defaultParams.priceCap)));
        assertEq(address(pool).balance, 0);
        assertEq(pool.totalBnbOwed(), 0);
    }

    function test_wrongCollectionEvenAnotherOfficialCollectionRejected() public {
        _fund();
        uint256 listing = market.createListing(SELLER, Addresses.BEHEMOTH_CIRCUITS, ALTERNATIVE_ID, 6 ether);
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
    }

    function test_fixedPoolCannotUseAlternativeAndKeepsOriginalName() public {
        pool = _createPool(defaultParams);
        _fund();
        assertEq(IERC20Metadata(address(pool)).name(), "TapeOut #16210 Pool Share");
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        vm.expectRevert(IPoolVault.FlexiblePurchaseDisabled.selector);
        pool.buyAlternativeFromMarket(listing);
    }

    function test_flexiblePoolCannotUseDirectSellerBypass() public {
        _fund();
        vm.prank(SELLER);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        pool.sellToPool();
        _assertUntouched();
    }

    function test_purchaseRequiresFullFundingAndStopsExactlyAtDeadline() public {
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.buyAlternativeFromMarket(listing);
        _fund();
        vm.warp(defaultParams.purchaseDeadline);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
        pool.finalizeFailure();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Refunding));
        assertEq(pool.bnbOwed(ALICE), defaultParams.targetRaise * 49 / 100);
        assertEq(pool.bnbOwed(BOB), defaultParams.targetRaise * 26 / 100);
        assertEq(pool.bnbOwed(CAROL), defaultParams.targetRaise * 25 / 100);
        vm.prank(ALICE);
        pool.withdrawBnb();
        vm.prank(BOB);
        pool.withdrawBnb();
        vm.prank(CAROL);
        pool.withdrawBnb();
        assertEq(address(pool).balance, 0);
    }

    function testFuzz_invalidNftCallbackRollsBackSelectionAndSellerSettlement(uint8 fault) public {
        fault = uint8(bound(fault, 1, 6));
        _fund();
        bytes32 key = mining.minerKey(address(nft), ALTERNATIVE_ID);
        mining.setPending(key, 99);
        nft.setCallbackFault(fault);
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        vm.expectRevert();
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
        assertEq(mining.pending(key), 99);
        assertEq(bem.balanceOf(SELLER), 0);
    }

    function testFuzz_qualityChangedDuringRewardClaimRollsBack(uint8 fault) public {
        fault = uint8(bound(fault, 2, 4));
        _fund();
        mining.setClaimFault(fault);
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        vm.expectRevert(IPoolVault.MinerDoesNotMeetCriteria.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
    }

    function testFuzz_marketFaultRollsBackSelectionAndFunds(uint8 fault) public {
        fault = uint8(bound(fault, 1, 4));
        _fund();
        market.setBuyFault(fault);
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        vm.expectRevert();
        pool.buyAlternativeFromMarket(listing);
        _assertUntouched();
    }

    function test_callbacksCannotReenterAndPurchaseCannotRepeat() public {
        _fund();
        uint256 listing = _list(ALTERNATIVE_ID, 6 ether);
        bytes memory nested = abi.encodeCall(IPoolVault.buyAlternativeFromMarket, (listing));
        mining.setReentry(address(pool), nested);
        nft.setReentryData(nested);
        pool.buyAlternativeFromMarket(listing);
        assertTrue(mining.reentryAttempted());
        assertFalse(mining.reentrySucceeded());
        assertTrue(nft.reentryAttempted());
        assertFalse(nft.reentrySucceeded());
        assertEq(market.buyCalls(), 1);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.buyAlternativeFromMarket(listing);
    }

    function test_withdrawnSubscriptionCreditAndDonationsExcludedFromNewSurplus() public {
        _deposit(pool, ALICE, 1);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        uint256 oldCredit = pool.unitPriceWei();
        _fund();
        vm.deal(address(pool), address(pool).balance + 1 ether);
        pool.buyAlternativeFromMarket(_list(ALTERNATIVE_ID, 6 ether));
        assertEq(pool.bnbOwed(ALICE), oldCredit + 0.6 ether * 49 / 100);
        assertEq(pool.totalBnbOwed(), oldCredit + 0.6 ether);
        assertEq(address(pool).balance, pool.totalBnbOwed() + 1 ether);
    }

    function test_transferAfterPurchaseKeepsRefundWithOriginalShareholders() public {
        ShareMarket implementation = new ShareMarket();
        address marketProxy = address(
            new ERC1967Proxy(
                address(implementation),
                abi.encodeCall(ShareMarket.initialize, (address(poolFactory), address(timelock)))
            )
        );
        bytes memory data = abi.encodeCall(PoolFactory.registerShareMarket, (marketProxy));
        bytes32 salt = keccak256("flexible-purchase-share-market");
        vm.prank(OWNER);
        timelock.schedule(address(poolFactory), 0, data, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(poolFactory), 0, data, bytes32(0), salt);
        _fund();
        pool.buyAlternativeFromMarket(_list(ALTERNATIVE_ID, 6 ether + 1));
        uint256 entitlement = pool.bnbOwed(ALICE);
        vm.prank(ALICE);
        pool.transfer(DAVE, 49);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.balanceOf(DAVE), 49);
        assertEq(pool.bnbOwed(ALICE), entitlement);
        assertEq(pool.bnbOwed(DAVE), 0);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - before, entitlement);
    }
}
