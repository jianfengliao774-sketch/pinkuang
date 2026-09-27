// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {PurchaseMockNft, PurchaseMockBem, PurchaseMockMining} from "../utils/PurchaseMocks.sol";
import {FirstoSignedAskMock, FirstoRejectingRecipient, Firsto1271Mock} from "../utils/FirstoMocks.sol";
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";

contract FirstoPurchaseTest is FundingTestBase {
    address private constant EXCHANGE = 0x33423244F9a5bF81b12B1a018aF6F4e079B97f29;
    address private constant PROTOCOL_FACTORY = 0x68224F668083c29e9800Be2a646d42d18cedF7e2;
    uint256 private constant SELLER_KEY = 0x12345; // public local test fixture only
    address private seller;
    PurchaseMockNft private nft;
    PurchaseMockBem private bem;
    PurchaseMockMining private mining;
    FirstoSignedAskMock private exchange;
    IFirstoSignedAskExchange.SignedAsk private ask;

    function setUp() public override {
        super.setUp();
        vm.chainId(56);
        seller = vm.addr(SELLER_KEY);
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        vm.etch(EXCHANGE, address(new FirstoSignedAskMock()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        bem = PurchaseMockBem(Addresses.BEM);
        mining = PurchaseMockMining(payable(Addresses.MINING));
        exchange = FirstoSignedAskMock(EXCHANGE);
        exchange.configure(PROTOCOL_FACTORY, 100, 1);
        _prepareMiner(defaultParams.circuitId);
        ask = IFirstoSignedAskExchange.SignedAsk({
            maker: seller,
            collection: address(nft),
            tokenId: defaultParams.circuitId,
            nonce: 17,
            price: uint128(5 ether),
            expiry: uint64(block.timestamp + 5 days),
            payoutRecipient: seller,
            feeBps: 100,
            feeEpoch: 1,
            schemaVersion: 2
        });
    }

    function _prepareMiner(uint256 tokenId) private {
        nft.mint(seller, tokenId);
        mining.configure(address(nft), tokenId, 0, 21 * 1e8);
        vm.prank(seller);
        nft.approve(EXCHANGE, tokenId);
    }

    function _order() private view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Firsto Circuit Signed Ask"),
                keccak256("2"),
                block.chainid,
                EXCHANGE
            )
        );
        bytes32 typehash = keccak256(
            "SignedAsk(address maker,address collection,uint256 tokenId,uint256 nonce,uint128 price,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion)"
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typehash, ask))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SELLER_KEY, digest);
        return abi.encode(ask, abi.encodePacked(r, s, v));
    }

    function _buy() private {
        pool.buyFromFirsto(0, _order());
    }

    function _assertUnchanged() private view {
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funded));
        assertEq(nft.ownerOf(ask.tokenId), seller);
        assertEq(address(pool).balance, pool.totalRaised());
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(exchange.fills(), 0);
        assertEq(bem.balanceOf(seller), 0);
        assertEq(mining.claimCalls(), 0);
    }

    function test_signedOriginalPaysGrossReceivesExactNftAndSettlesStaleZeroPending() public {
        _fundPool();
        uint256 beforeSeller = seller.balance;
        _buy();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertEq(nft.ownerOf(ask.tokenId), address(pool));
        assertEq(seller.balance - beforeSeller, ask.price);
        assertEq(EXCHANGE.balance, 0.05 ether);
        assertEq(address(pool).balance, 1.45 ether);
        assertEq(bem.balanceOf(seller), 21 * 1e8);
        assertEq(mining.claimCalls(), 1);
        assertEq(poolFactory.machinePool(address(nft), ask.tokenId), address(pool));
        vm.expectRevert(IPoolVault.WrongState.selector);
        _buy();
    }

    function test_batchAndUnknownRoutesStayDisabled() public {
        _fundPool();
        vm.expectRevert(IPoolVault.UnverifiedPurchaseRoute.selector);
        pool.buyFromFirsto(1, _order());
        vm.expectRevert(IPoolVault.UnverifiedPurchaseRoute.selector);
        pool.buyFromFirsto(255, _order());
        _assertUnchanged();
    }

    function test_firstoAlternativeCannotBypassReference() public {
        _fundPool();
        ask.tokenId += 1;
        _prepareMiner(ask.tokenId);
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        _buy();
        assertEq(exchange.fills(), 0);
        assertEq(poolFactory.machinePool(address(nft), ask.tokenId), address(0));
    }

    function test_feeEpochOrFeeChangeFailsClosedEvenWhenOldEpochAcceptedByExchange() public {
        _fundPool();
        exchange.configure(PROTOCOL_FACTORY, 100, 2);
        vm.expectRevert(IPoolVault.FirstoFeeChanged.selector);
        _buy();
        exchange.configure(PROTOCOL_FACTORY, 101, 1);
        vm.expectRevert(IPoolVault.FirstoFeeChanged.selector);
        _buy();
        _assertUnchanged();
    }

    function test_grossAboveCapRejectedEvenWhenSellerPriceAtCap() public {
        _fundPool();
        ask.price = uint128(defaultParams.priceCap);
        vm.expectRevert(IPoolVault.OverPriceCap.selector);
        _buy();
        _assertUnchanged();
    }

    function test_feeRoundsDownWithoutOverpayingOneWei() public {
        _fundPool();
        ask.price = 10_099;
        _buy();
        assertEq(EXCHANGE.balance, 100);
        assertEq(address(pool).balance, defaultParams.targetRaise - 10_199);
    }

    function test_invalidSignatureRevertsSellerSettlementAndEveryBalance() public {
        _fundPool();
        bytes memory order = _order();
        order[order.length - 33] = bytes1(uint8(order[order.length - 33]) ^ 1);
        vm.expectRevert();
        pool.buyFromFirsto(0, order);
        _assertUnchanged();
    }

    function test_short1271SignatureUsesExchangeValidation() public {
        _fundPool();
        vm.etch(seller, address(new Firsto1271Mock()).code);
        pool.buyFromFirsto(0, abi.encode(ask, hex"420102"));
        assertEq(nft.ownerOf(ask.tokenId), address(pool));
        assertEq(bem.balanceOf(seller), 21 * 1e8);
    }

    function test_long1271SignatureBoundAndCanonicalEncoding() public {
        _fundPool();
        vm.etch(seller, address(new Firsto1271Mock()).code);
        bytes memory tooLong = new bytes(1025);
        tooLong[0] = 0x42;
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        pool.buyFromFirsto(0, abi.encode(ask, tooLong));
        bytes memory accepted = new bytes(1024);
        accepted[0] = 0x42;
        bytes memory canonical = abi.encode(ask, accepted);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        pool.buyFromFirsto(0, bytes.concat(canonical, hex"00"));
        pool.buyFromFirsto(0, canonical);
        assertEq(nft.ownerOf(ask.tokenId), address(pool));
    }

    function test_malformedEncodingWrongChainExpiredAndCancelledFailClosed() public {
        _fundPool();
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        pool.buyFromFirsto(0, bytes("invalid"));
        vm.chainId(57);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        vm.chainId(56);
        ask.expiry = uint64(block.timestamp);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        ask.expiry = uint64(block.timestamp + 1 days);
        exchange.invalidate(seller, ask.nonce);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        _assertUnchanged();
    }

    function test_pausedWrongProtocolFactoryAndSchemaFailClosed() public {
        _fundPool();
        exchange.setPaused(true);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        exchange.setPaused(false);
        exchange.configure(address(0xBAD), 100, 1);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        exchange.configure(PROTOCOL_FACTORY, 100, 1);
        ask.schemaVersion = 1;
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        _assertUnchanged();
    }

    function test_allNftCallbackFaultsRevertAtomicPurchase() public {
        _fundPool();
        for (uint8 fault = 1; fault <= 6; ++fault) {
            nft.setCallbackFault(fault);
            vm.expectRevert();
            _buy();
            _assertUnchanged();
        }
    }

    function test_marketRevertMissingNftWrongRecipientRefundFeeMutationAndOwnerMutationRollback() public {
        _fundPool();
        for (uint8 fault = 1; fault <= 6; ++fault) {
            exchange.setFault(fault);
            vm.expectRevert();
            _buy();
            _assertUnchanged();
        }
    }

    function test_claimFailureWrongOwnerAndInactiveMinerRollback() public {
        _fundPool();
        // A positive stored pending value makes the short-payment fault objectively detectable.
        mining.configure(address(nft), ask.tokenId, 7 * 1e8, 21 * 1e8);
        for (uint8 fault = 1; fault <= 6; ++fault) {
            mining.setClaimFault(fault);
            vm.expectRevert();
            _buy();
            _assertUnchanged();
        }
    }

    function test_reentrantPurchaseCannotSpendAgain() public {
        _fundPool();
        exchange.setReentry(abi.encodeCall(IPoolVault.buyFromFirsto, (0, _order())));
        _buy();
        assertFalse(exchange.reentrySucceeded());
        assertEq(exchange.fills(), 1);
        assertEq(address(pool).balance, 1.45 ether);
    }

    function test_rejectingPayoutCannotConsumeOrderOrSellerRewards() public {
        _fundPool();
        ask.payoutRecipient = address(new FirstoRejectingRecipient());
        vm.expectRevert();
        _buy();
        _assertUnchanged();
    }

    function test_failedMarketCannotBlockDeadlinePrincipalRefund() public {
        _fundPool();
        exchange.setPaused(true);
        vm.warp(defaultParams.purchaseDeadline);
        pool.finalizeFailure();
        assertEq(pool.bnbOwed(ALICE), 49 * UNIT_PRICE);
        uint256 beforeAlice = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - beforeAlice, 49 * UNIT_PRICE);
        assertEq(exchange.fills(), 0);
    }

    function _useFlexiblePool() private {
        defaultParams.circuitId += 1;
        defaultParams.targetRaise = 6.6 ether;
        _prepareMiner(defaultParams.circuitId);
        IPoolVault.FlexiblePurchaseConfig memory config = IPoolVault.FlexiblePurchaseConfig({
            minVerifiedWeight: 1,
            referencePriceWei: 6 ether,
            targetDailyYieldAtomic: 1e8,
            extraBps: 1000,
            referenceObservedAt: uint64(block.timestamp),
            referenceBlock: uint64(block.number),
            referenceDigest: keccak256("fixture")
        });
        vm.prank(OPERATOR);
        pool = IFundingVault(poolFactory.createFlexiblePool(defaultParams, config));
        ask.tokenId = defaultParams.circuitId;
    }

    function test_flexibleGrossSurplusAllocatedToPurchaseTime37And63Shares() public {
        _useFlexiblePool();
        _deposit(pool, ALICE, 37);
        _deposit(pool, BOB, 63);
        _buy();
        assertEq(pool.totalBnbOwed(), 1.55 ether);
        assertEq(pool.bnbOwed(ALICE), 1.55 ether * 37 / 100);
        assertEq(pool.bnbOwed(BOB), 1.55 ether * 63 / 100);
        assertEq(address(pool).balance, pool.totalBnbOwed());
    }

    function test_flexibleLockedReferenceWeightCapAppliesToGross() public {
        _useFlexiblePool();
        _deposit(pool, ALICE, 100);
        mining.setVerifiedWeight(mining.minerKey(address(nft), ask.tokenId), 1);
        ask.price = uint128(3 ether);
        vm.expectRevert(IPoolVault.OverReferenceUnitPrice.selector);
        _buy();
        _assertUnchanged();
    }
}
