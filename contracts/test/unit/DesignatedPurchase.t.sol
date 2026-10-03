// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {PurchaseMockNft, PurchaseMockBem, PurchaseMockMining, PurchaseMockMarket} from "../utils/PurchaseMocks.sol";
import {FirstoSignedAskMock} from "../utils/FirstoMocks.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {Addresses} from "../../script/Addresses.sol";

/// @dev Offline EVM only. These mocks are not proof of a live Mining or market deployment.
contract DesignatedPurchaseTest is FundingTestBase {
    address private constant EXCHANGE = 0x33423244F9a5bF81b12B1a018aF6F4e079B97f29;
    address private constant PROTOCOL_FACTORY = 0x68224F668083c29e9800Be2a646d42d18cedF7e2;
    uint256 private constant SELLER_KEY = 0x12345;
    uint256 private constant ORIGINAL_ID = 16210;
    uint256 private constant CANDIDATE_ID = 16211;
    address private seller;
    address private nextOwner;
    PurchaseMockNft private nft;
    PurchaseMockBem private bem;
    PurchaseMockMining private mining;
    PurchaseMockMarket private market;
    FirstoSignedAskMock private exchange;
    IPoolVault.DesignatedPurchaseConfig private config;

    function setUp() public override {
        super.setUp();
        vm.chainId(56);
        seller = vm.addr(SELLER_KEY);
        nextOwner = address(0xBEEF);
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEHEMOTH_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        vm.etch(EXCHANGE, address(new FirstoSignedAskMock()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        bem = PurchaseMockBem(Addresses.BEM);
        mining = PurchaseMockMining(payable(Addresses.MINING));
        market = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);
        exchange = FirstoSignedAskMock(EXCHANGE);
        exchange.configure(PROTOCOL_FACTORY, 100, 1);
        mining.setEmission(10_000, 9_900); // U=100, V=9,900; each weight earns one atomic BEM/s.
        _mintMiner(ORIGINAL_ID, 100);
        _mintMiner(CANDIDATE_ID, 100);
        config = IPoolVault.DesignatedPurchaseConfig({
            referenceSeller: seller,
            referencePriceWei: 10_000,
            referenceCostWei: 10_000,
            referenceDailyOutputAtomic: 100 * 86_400,
            referenceObservedAt: uint64(block.timestamp),
            referenceBlock: uint64(block.number),
            referenceDigest: keccak256("reviewed original ask and mining snapshot")
        });
        pool = _designated(config);
    }

    function _mintMiner(uint256 id, uint128 weight) private {
        nft.mint(seller, id);
        mining.configure(address(nft), id, 0, 0);
        mining.setVerifiedWeight(mining.minerKey(address(nft), id), weight);
        vm.prank(seller);
        nft.approve(address(market), id);
    }

    function _designated(IPoolVault.DesignatedPurchaseConfig memory terms) private returns (IFundingVault) {
        // A reference already reserved by the previous fixture needs a distinct Factory.
        _deployFactory();
        defaultParams.targetRaise = ((terms.referenceCostWei * 11 + 9) / 10 + 99) / 100 * 100;
        defaultParams.priceCap = (terms.referenceCostWei * 11 + 9) / 10;
        uint128 referenceWeight = mining.getMiner(mining.minerKey(address(nft), ORIGINAL_ID)).verifWeight;
        vm.prank(OPERATOR);
        return IFundingVault(poolFactory.createDesignatedPoolChecked(defaultParams, terms, 1, referenceWeight));
    }

    function _fundAndTransferOriginal() private {
        _fundPool();
        nft.forceTransfer(nextOwner, ORIGINAL_ID);
    }

    function _listCandidate(uint96 price) private returns (uint256) {
        return market.createListing(seller, address(nft), CANDIDATE_ID, price);
    }

    function _assertFundedUnchanged() private view {
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funded));
        assertEq(pool.params().circuitId, ORIGINAL_ID);
        assertEq(nft.ownerOf(CANDIDATE_ID), seller);
        assertEq(address(pool).balance, pool.totalRaised());
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(mining.claimCalls(), 0);
        assertEq(market.buyCalls(), 0);
        assertEq(exchange.fills(), 0);
    }

    function test_configurationIsExplicitAtomicAndExistingPoolsStayDisabled() public {
        assertEq(poolFactory.designatedPurchaseVersion(), 1);
        assertEq(pool.designatedPurchaseVersion(), 1);
        (bool enabled, uint256 id, uint32 taskId, uint128 weight, IPoolVault.DesignatedPurchaseConfig memory saved) =
            pool.designatedPurchase();
        assertTrue(enabled);
        assertEq(id, ORIGINAL_ID);
        assertEq(taskId, 1);
        assertEq(weight, 100);
        assertEq(saved.referenceSeller, seller);
        assertEq(saved.referencePriceWei, 10_000);
        assertEq(saved.referenceCostWei, 10_000);
        assertEq(saved.referenceDailyOutputAtomic, 100 * 86_400);
        assertEq(pool.params().targetRaise, 11_000);
        assertEq(pool.params().priceCap, 11_000);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        pool.configureDesignatedPurchase(config);
        vm.prank(address(poolFactory));
        vm.expectRevert(IPoolVault.DesignatedPurchaseAlreadyConfigured.selector);
        pool.configureDesignatedPurchase(config);
        IFundingVault fixedPool = _createFixedDifferentReference();
        (bool fixedEnabled,,,,) = fixedPool.designatedPurchase();
        assertFalse(fixedEnabled);
    }

    function _createFixedDifferentReference() private returns (IFundingVault) {
        IPoolVault.PoolParams memory p = defaultParams;
        p.circuitId = CANDIDATE_ID;
        return _createPool(p);
    }

    function test_modelAndReferenceSnapshotMustMatchChainBeforeAnyPoolSurvives() public {
        _deployFactory();
        uint256 count = poolFactory.poolCount();
        IPoolVault.DesignatedPurchaseConfig memory bad = config;
        bad.referenceDailyOutputAtomic += 86_400;
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        poolFactory.createDesignatedPoolChecked(defaultParams, bad, 1, 100);
        assertEq(poolFactory.poolCount(), count);

        bad = config;
        bad.referenceSeller = nextOwner;
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.InvalidListing.selector);
        poolFactory.createDesignatedPoolChecked(defaultParams, bad, 1, 100);

        bad = config;
        bad.referenceObservedAt = uint64(block.timestamp - 301);
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        poolFactory.createDesignatedPoolChecked(defaultParams, bad, 1, 100);

        vm.prank(OPERATOR);
        vm.expectRevert(PoolFactory.ReferenceMinerChanged.selector);
        poolFactory.createDesignatedPoolChecked(defaultParams, config, 2, 100);
        vm.prank(OPERATOR);
        vm.expectRevert(PoolFactory.ReferenceMinerChanged.selector);
        poolFactory.createDesignatedPoolChecked(defaultParams, config, 1, 99);
        assertEq(poolFactory.poolCount(), count);
    }

    function test_officialRoundingFloorsUnverifiedFirstThenMinerSecond() public {
        mining.setEmission(10_001, 9_901);
        mining.setVerifiedWeight(mining.minerKey(address(nft), ORIGINAL_ID), 9_901);
        IPoolVault.DesignatedPurchaseConfig memory terms = config;
        terms.referenceDailyOutputAtomic = 9_901 * 86_400;
        IFundingVault fresh = _designated(terms);
        (,,,, IPoolVault.DesignatedPurchaseConfig memory saved) = fresh.designatedPurchase();
        assertEq(saved.referenceDailyOutputAtomic, 9_901 * 86_400);
        terms.referenceDailyOutputAtomic = 9_900 * 86_400; // Single collapsed floor would be wrong.
        _deployFactory();
        vm.prank(OPERATOR);
        vm.expectRevert(IPoolVault.InvalidParameters.selector);
        poolFactory.createDesignatedPoolChecked(defaultParams, terms, 1, 9_901);
    }

    function test_originalMustTransferAndAnEligibleRelistingKeepsPriority() public {
        _fundPool();
        uint256 alternative = _listCandidate(10_000);
        vm.expectRevert(IPoolVault.OriginalTargetNotTransferred.selector);
        pool.buyAlternativeFromMarket(alternative);
        nft.forceTransfer(nextOwner, ORIGINAL_ID);
        vm.prank(nextOwner);
        nft.approve(address(market), ORIGINAL_ID);
        uint256 original = market.createListing(nextOwner, address(nft), ORIGINAL_ID, 10_000);
        vm.expectRevert(IPoolVault.OriginalTargetAvailable.selector);
        pool.buyAlternativeFromMarket(alternative);
        market.setValid(original, false);
        pool.buyAlternativeFromMarket(alternative);
        assertEq(nft.ownerOf(CANDIDATE_ID), address(pool));
        assertEq(pool.params().circuitId, CANDIDATE_ID);
        assertEq(poolFactory.machinePool(address(nft), CANDIDATE_ID), address(pool));
        assertEq(pool.totalBnbOwed(), 1000);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.buyAlternativeFromMarket(alternative);
    }

    function test_originalTaskCannotChangeAfterConfiguration() public {
        _fundPool();
        mining.setTaskId(mining.minerKey(address(nft), ORIGINAL_ID), 2);
        uint256 listing = market.createListing(seller, address(nft), ORIGINAL_ID, 10_000);
        vm.expectRevert(IPoolVault.WrongPurchaseModel.selector);
        pool.buyFromMarket(listing);
        vm.prank(seller);
        nft.approve(EXCHANGE, ORIGINAL_ID);
        bytes memory originalAsk = _signedAsk(ORIGINAL_ID, 10_000);
        vm.expectRevert(IPoolVault.WrongPurchaseModel.selector);
        pool.buyFromFirsto(0, originalAsk);
        _assertFundedUnchanged();
    }

    function test_taskChangedOriginalListingDoesNotBlockSameTaskAlternative() public {
        _fundAndTransferOriginal();
        mining.setTaskId(mining.minerKey(address(nft), ORIGINAL_ID), 2);
        vm.prank(nextOwner);
        nft.approve(address(market), ORIGINAL_ID);
        market.createListing(nextOwner, address(nft), ORIGINAL_ID, 10_000);
        pool.buyAlternativeFromMarket(_listCandidate(10_000));
        assertEq(nft.ownerOf(CANDIDATE_ID), address(pool));
    }

    function test_lowerAskBandEndpointAndOneWeiOutside() public {
        _fundAndTransferOriginal();
        uint256 tooCheap = _listCandidate(8_999);
        vm.expectRevert(IPoolVault.OutsideDesignatedPriceBand.selector);
        pool.buyAlternativeFromMarket(tooCheap);
        pool.buyAlternativeFromMarket(_listCandidate(9_000));
        assertEq(nft.ownerOf(CANDIDATE_ID), address(pool));
    }

    function test_upperAskBandEndpointAndOneWeiOutsideIndependentOfGrossCap() public {
        IPoolVault.DesignatedPurchaseConfig memory terms = config;
        terms.referenceCostWei = 10_100;
        pool = _designated(terms); // Cap 11,110 lets us distinguish ask band from budget.
        _fundAndTransferOriginal();
        uint256 tooExpensive = _listCandidate(11_001);
        vm.expectRevert(IPoolVault.OutsideDesignatedPriceBand.selector);
        pool.buyAlternativeFromMarket(tooExpensive);
        pool.buyAlternativeFromMarket(_listCandidate(11_000));
        assertEq(nft.ownerOf(CANDIDATE_ID), address(pool));
    }

    function test_priceAndDailyUnitBandsAreIndependentAndRespondToCurrentEmissions() public {
        _fundAndTransferOriginal();
        mining.setEmission(12_000, 9_900); // same NFT weight, 20% more daily output.
        uint256 listing = _listCandidate(10_000);
        vm.expectRevert(IPoolVault.OutsideDesignatedUnitPriceBand.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertFundedUnchanged();
        mining.setEmission(10_000, 9_900);
        mining.setVerifiedWeight(mining.minerKey(address(nft), CANDIDATE_ID), 200);
        vm.expectRevert(IPoolVault.OutsideDesignatedUnitPriceBand.selector);
        pool.buyAlternativeFromMarket(listing);
        mining.setVerifiedWeight(mining.minerKey(address(nft), CANDIDATE_ID), 100);
        pool.buyAlternativeFromMarket(listing);
        assertEq(nft.ownerOf(CANDIDATE_ID), address(pool));
    }

    function test_upperDailyUnitPriceEndpointAndOneWeiBeyond() public {
        mining.setVerifiedWeight(mining.minerKey(address(nft), ORIGINAL_ID), 110);
        IPoolVault.DesignatedPurchaseConfig memory terms = config;
        terms.referenceDailyOutputAtomic = 110 * 86_400;
        pool = _designated(terms);
        _fundAndTransferOriginal();
        uint256 outside = _listCandidate(10_001);
        vm.expectRevert(IPoolVault.OutsideDesignatedUnitPriceBand.selector);
        pool.buyAlternativeFromMarket(outside);
        pool.buyAlternativeFromMarket(_listCandidate(10_000));
        assertEq(nft.ownerOf(CANDIDATE_ID), address(pool));
    }

    function test_lowerDailyUnitPriceEndpointAndOneWeiBeyond() public {
        mining.setVerifiedWeight(mining.minerKey(address(nft), ORIGINAL_ID), 90);
        IPoolVault.DesignatedPurchaseConfig memory terms = config;
        terms.referenceDailyOutputAtomic = 90 * 86_400;
        pool = _designated(terms);
        _fundAndTransferOriginal();
        uint256 outside = _listCandidate(9_999);
        vm.expectRevert(IPoolVault.OutsideDesignatedUnitPriceBand.selector);
        pool.buyAlternativeFromMarket(outside);
        pool.buyAlternativeFromMarket(_listCandidate(10_000));
        assertEq(nft.ownerOf(CANDIDATE_ID), address(pool));
    }

    function test_sameTaskPureVerifiedAndClaimCallbackChecksFailAtomically() public {
        _fundAndTransferOriginal();
        bytes32 key = mining.minerKey(address(nft), CANDIDATE_ID);
        uint256 listing = _listCandidate(10_000);
        mining.setTaskId(key, 2);
        vm.expectRevert(IPoolVault.WrongPurchaseModel.selector);
        pool.buyAlternativeFromMarket(listing);
        mining.setTaskId(key, 1);
        mining.setUnverifiedWeight(key, 1);
        vm.expectRevert(IPoolVault.MinerDoesNotMeetCriteria.selector);
        pool.buyAlternativeFromMarket(listing);
        mining.setUnverifiedWeight(key, 0);
        mining.setClaimFault(9); // reward settlement mutates verified weight before payment.
        vm.expectRevert(IPoolVault.MinerDoesNotMeetCriteria.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertFundedUnchanged();
        mining.setClaimFault(0);
        market.setBuyFault(6); // market callback increases output and breaks the unit-price lower bound.
        vm.expectRevert(IPoolVault.OutsideDesignatedUnitPriceBand.selector);
        pool.buyAlternativeFromMarket(listing);
        _assertFundedUnchanged();
    }

    function test_reservationAndCapStillBindAlternative() public {
        IPoolVault.PoolParams memory p = defaultParams;
        p.circuitId = CANDIDATE_ID;
        IFundingVault competing = _createPool(p);
        _fundAndTransferOriginal();
        uint256 listing = _listCandidate(10_000);
        vm.expectRevert(abi.encodeWithSelector(PoolFactory.MachineAlreadyReserved.selector,
            address(nft), CANDIDATE_ID, address(competing)));
        pool.buyAlternativeFromMarket(listing);
        _assertFundedUnchanged();
    }

    function _signedAsk(uint256 id, uint128 price) private view returns (bytes memory) {
        IFirstoSignedAskExchange.SignedAsk memory ask = IFirstoSignedAskExchange.SignedAsk({
            maker: seller, collection: address(nft), tokenId: id, nonce: 17, price: price,
            expiry: uint64(block.timestamp + 1 days), payoutRecipient: seller,
            feeBps: 100, feeEpoch: 1, schemaVersion: 2
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SELLER_KEY, exchange.hash(ask));
        return abi.encode(ask, abi.encodePacked(r, s, v));
    }

    function test_firstoAlternativeChecksAskUnitAndFeeInclusiveGross() public {
        IPoolVault.DesignatedPurchaseConfig memory terms = config;
        terms.referenceCostWei = 10_100;
        pool = _designated(terms);
        _fundAndTransferOriginal();
        // A stale official listing without owner approval cannot block the signed alternative.
        market.createListing(nextOwner, address(nft), ORIGINAL_ID, 10_000);
        vm.prank(seller);
        nft.approve(EXCHANGE, CANDIDATE_ID);
        assertEq(pool.params().priceCap, 11_110);
        assertEq(pool.params().targetRaise, 11_200);
        pool.buyAlternativeFromFirsto(0, _signedAsk(CANDIDATE_ID, 11_000));
        assertEq(nft.ownerOf(CANDIDATE_ID), address(pool));
        assertEq(pool.params().circuitId, CANDIDATE_ID);
        assertEq(exchange.fills(), 1);
        assertEq(EXCHANGE.balance, 110);
        assertEq(pool.totalBnbOwed(), 90);
        bytes memory repeatedOrder = _signedAsk(CANDIDATE_ID, 11_000);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.buyAlternativeFromFirsto(0, repeatedOrder);
    }

    function test_originalFirstoRemainsExecutableWhenMarketApprovalWasRevoked() public {
        _fundPool();
        market.createListing(seller, address(nft), ORIGINAL_ID, 10_000);
        vm.prank(seller);
        nft.approve(EXCHANGE, ORIGINAL_ID);
        pool.buyFromFirsto(0, _signedAsk(ORIGINAL_ID, 10_000));
        assertEq(nft.ownerOf(ORIGINAL_ID), address(pool));
        assertEq(pool.params().circuitId, ORIGINAL_ID);
    }

    function test_firstoAlternativeBuyerFeeCannotCrossGrossCapEvenWithInBandAsk() public {
        _fundAndTransferOriginal();
        vm.prank(seller);
        nft.approve(EXCHANGE, CANDIDATE_ID);
        // 10,900 is inside both ask bands, but the 1% buyer fee makes gross 11,009 > 11,000.
        bytes memory inBandAsk = _signedAsk(CANDIDATE_ID, 10_900);
        vm.expectRevert(IPoolVault.OverPriceCap.selector);
        pool.buyAlternativeFromFirsto(0, inBandAsk);
        _assertFundedUnchanged();
    }

    function test_fullWidthUnitCrossProductKeepsExactOneWeiBoundary() public {
        uint256 p0 = (uint256(type(uint128).max) / 20) * 10;
        uint256 rate = (type(uint256).max / 86_400 / 11_000) * 11_000;
        uint256 verifiedRate = rate - rate / 100;
        mining.setEmission(rate, 110);
        mining.setVerifiedWeight(mining.minerKey(address(nft), ORIGINAL_ID), 110);
        IPoolVault.DesignatedPurchaseConfig memory terms = config;
        terms.referencePriceWei = p0;
        terms.referenceCostWei = (p0 * 102 + 99) / 100;
        terms.referenceDailyOutputAtomic = verifiedRate * 86_400;
        pool = _designated(terms);
        _fundAndTransferOriginal();
        vm.prank(seller);
        nft.approve(EXCHANGE, CANDIDATE_ID);
        bytes memory outside = _signedAsk(CANDIDATE_ID, uint128(p0 + 1));
        bytes memory endpoint = _signedAsk(CANDIDATE_ID, uint128(p0));
        vm.expectRevert(IPoolVault.OutsideDesignatedUnitPriceBand.selector);
        pool.buyAlternativeFromFirsto(0, outside);
        pool.buyAlternativeFromFirsto(0, endpoint);
        assertEq(nft.ownerOf(CANDIDATE_ID), address(pool));
    }

    function test_oldFixedPoolCannotUseEitherAlternativeSelector() public {
        IFundingVault fixedPool = _createFixedDifferentReference();
        _deposit(fixedPool, ALICE, 100);
        uint256 listing = _listCandidate(10_000);
        vm.expectRevert(IPoolVault.FlexiblePurchaseDisabled.selector);
        fixedPool.buyAlternativeFromMarket(listing);
        bytes memory order = _signedAsk(CANDIDATE_ID, 10_000);
        vm.expectRevert(IPoolVault.DesignatedPurchaseDisabled.selector);
        fixedPool.buyAlternativeFromFirsto(0, order);
    }
}
