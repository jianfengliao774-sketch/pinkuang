// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {PurchaseMockNft, PurchaseMockBem, PurchaseMockMining, PurchaseMockMarket} from "../utils/PurchaseMocks.sol";
import {FirstoBatchAskMock} from "../utils/FirstoBatchMocks.sol";
import {Firsto1271Mock, FirstoRejectingRecipient} from "../utils/FirstoMocks.sol";
import {IFirstoBatchAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";
import {PoolTimelock24} from "../../src/PoolTimelock24.sol";
import {Governance24Beacon} from "../../src/Governance24Beacon.sol";
import {Governance24Dispatcher} from "../../src/Governance24Dispatcher.sol";

/// @notice CONTROLLED PROTOCOL TESTS ONLY. Exact observed runtime remains at the fixed address,
/// but vm.mockFunction delegates its calls to a fault fixture. These tests exercise PoolVault
/// checks without changing its pin; they are not a real-protocol fork or source/runtime provenance.
contract FirstoBatchControlledProtocolTest is FundingTestBase {
    event FirstoPurchased(
        address indexed exchange,
        bytes32 indexed orderHash,
        uint256 indexed circuitId,
        uint256 sellerPrice,
        uint256 sourceFee,
        uint256 totalCost
    );

    address private constant EXCHANGE = 0x3F58C9cbce933c76158B2A29B0d612c46546Dc43;
    address private constant PROTOCOL_FACTORY = 0x68224F668083c29e9800Be2a646d42d18cedF7e2;
    uint256 private constant SELLER_KEY = 0x12345;
    address private seller;
    PurchaseMockNft private nft;
    PurchaseMockBem private bem;
    PurchaseMockMining private mining;
    PurchaseMockMarket private officialMarket;
    FirstoBatchAskMock private exchange;
    IFirstoBatchAskExchange.BatchAsk private batch;
    IFirstoBatchAskExchange.AskLeaf private leaf;
    bytes32[] private proof;

    function setUp() public override {
        super.setUp();
        vm.chainId(56);
        seller = vm.addr(SELLER_KEY);
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        bytes memory observedRuntime = vm.parseBytes(vm.readFile("test/fixtures/firsto-batch-observed-runtime.hex"));
        assertEq(keccak256(observedRuntime), 0x84072ba0b149f0cb72a8d1be49797ba293206d931407eeb2a25eeaf9f28db0b0);
        vm.etch(EXCHANGE, observedRuntime);
        address fixture = address(new FirstoBatchAskMock());
        string[21] memory selectors = [
            "configure(address,uint16,uint256)",
            "factory()",
            "paused()",
            "defaultTakerFeeBps()",
            "feeEpoch()",
            "feeBpsAtEpoch(uint256)",
            "BATCH_ASK_SCHEMA_VERSION()",
            "batchCancelled(address,uint256)",
            "isAskLeafInvalidated(address,uint256,uint256)",
            "leafUsed(bytes32)",
            "fault()",
            "fills()",
            "reentrySucceeded()",
            "setSchema(uint16)",
            "setPaused(bool)",
            "setFault(uint8)",
            "setReentry(bytes)",
            "cancel(address,uint256)",
            "consume((address,address,uint256,uint128,address,uint16,uint256,uint256,uint256,uint16))",
            "leafKey((address,address,uint256,uint128,address,uint16,uint256,uint256,uint256,uint16))",
            "hashLeaf((address,address,uint256,uint128,address,uint16,uint256,uint256,uint256,uint16))"
        ];
        for (uint256 i; i < selectors.length; ++i) {
            vm.mockFunction(EXCHANGE, fixture, abi.encodePacked(bytes4(keccak256(bytes(selectors[i])))));
        }
        vm.mockFunction(EXCHANGE, fixture, abi.encodePacked(IFirstoBatchAskExchange.fillAsk.selector));
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        bem = PurchaseMockBem(Addresses.BEM);
        mining = PurchaseMockMining(payable(Addresses.MINING));
        officialMarket = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);
        exchange = FirstoBatchAskMock(EXCHANGE);
        exchange.configure(PROTOCOL_FACTORY, 100, 1);
        nft.mint(seller, defaultParams.circuitId);
        mining.configure(address(nft), defaultParams.circuitId, 0, 21 * 1e8);
        vm.prank(seller);
        nft.approve(EXCHANGE, defaultParams.circuitId);
        leaf = IFirstoBatchAskExchange.AskLeaf(
            seller, address(nft), defaultParams.circuitId, uint128(5 ether), seller, 100, 1, 17, 257, 1
        );
        batch = IFirstoBatchAskExchange.BatchAsk(
            seller, exchange.hashLeaf(leaf), 17, uint64(block.timestamp + 5 days), seller, 100, 1, 1
        );
    }

    function _initialReferenceOwner() internal override returns (address) {
        return vm.addr(SELLER_KEY);
    }

    function _signature() private view returns (bytes memory) {
        return _signatureForKey(SELLER_KEY);
    }

    function _signatureForKey(uint256 signingKey) private view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Firsto Circuit Batch Ask"),
                keccak256("1"),
                block.chainid,
                EXCHANGE
            )
        );
        bytes32 typehash = keccak256(
            "BatchAsk(address maker,bytes32 merkleRoot,uint256 batchNonce,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion)"
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typehash, batch))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signingKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _order() private view returns (bytes memory) {
        return abi.encode(batch, leaf, proof, _signature());
    }

    function _buy() private {
        pool.buyFromFirsto(1, _order());
    }

    function _assertUnchanged() private view {
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funded));
        assertEq(nft.ownerOf(leaf.tokenId), seller);
        assertEq(address(pool).balance, pool.totalRaised());
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(exchange.fills(), 0);
        assertEq(bem.balanceOf(seller), 0);
        assertEq(mining.claimCalls(), 0);
        assertFalse(exchange.leafUsed(exchange.leafKey(leaf)));
    }

    function _refreshRoot() private {
        batch.merkleRoot = exchange.hashLeaf(leaf);
        delete proof;
    }

    function test_MOCK_PROTOCOL_batchSingleLeafExactCostCustodyAndSellerRewards() public {
        _fundPool();
        uint256 sellerBefore = seller.balance;
        vm.expectEmit(true, true, true, true, address(pool));
        emit FirstoPurchased(EXCHANGE, exchange.hashLeaf(leaf), leaf.tokenId, leaf.price, 0.05 ether, 5.05 ether);
        _buy();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertEq(nft.ownerOf(leaf.tokenId), address(pool));
        assertEq(seller.balance - sellerBefore, leaf.price);
        assertEq(EXCHANGE.balance, 0.05 ether);
        assertEq(PoolVault(payable(address(pool))).purchaseCost(), 5.05 ether);
        assertEq(bem.balanceOf(seller), 21 * 1e8);
        assertEq(poolFactory.machinePool(address(nft), leaf.tokenId), address(pool));
        assertTrue(exchange.leafUsed(exchange.leafKey(leaf)));
        assertFalse(exchange.batchCancelled(seller, batch.batchNonce));
    }

    function test_MOCK_PROTOCOL_batchSingleLeafAfterGovernance24DispatcherKeepsCustodyAndSettlement() public {
        PoolTimelock24 nextLock = new PoolTimelock24(OWNER);
        Governance24Beacon secondary =
            new Governance24Beacon(address(new PoolVault(address(poolFactory))), address(nextLock));
        Governance24Dispatcher dispatcher = new Governance24Dispatcher(address(poolFactory), address(secondary));
        bytes memory upgrade = abi.encodeWithSignature("upgradeTo(address)", address(dispatcher));
        bytes32 salt = keccak256("batch-after-governance24-dispatch");
        vm.prank(OWNER);
        timelock.schedule(address(beacon), 0, upgrade, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(beacon), 0, upgrade, bytes32(0), salt);
        // Repeat the controlled protocol acquisition with both delegatecall layers active.
        // Exact NFT custody, cost, seller BEM settlement and leaf consumption checks remain identical.
        test_MOCK_PROTOCOL_batchSingleLeafExactCostCustodyAndSellerRewards();
    }

    function test_MOCK_PROTOCOL_multiLeafSortedProofAndSiblingRemainUnspent() public {
        _fundPool();
        IFirstoBatchAskExchange.AskLeaf memory sibling = leaf;
        sibling.tokenId += 1;
        sibling.leafIndex += 1;
        bytes32 a = exchange.hashLeaf(leaf);
        bytes32 b = exchange.hashLeaf(sibling);
        batch.merkleRoot = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        proof.push(b);
        _buy();
        assertTrue(exchange.leafUsed(exchange.leafKey(leaf)));
        assertFalse(exchange.leafUsed(exchange.leafKey(sibling)));
    }

    function test_MOCK_PROTOCOL_badProofIndexAndMismatchedLeafReject() public {
        _fundPool();
        proof.push(bytes32(uint256(123)));
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        delete proof;
        ++leaf.leafIndex;
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        --leaf.leafIndex;
        ++leaf.batchNonce;
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        --leaf.batchNonce;
        ++leaf.feeEpoch;
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        --leaf.feeEpoch;
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_signatureBatchCancellationConsumedLeafRollback() public {
        _fundPool();
        bytes memory signature = _signature();
        signature[0] ^= 0x01;
        vm.expectRevert();
        pool.buyFromFirsto(1, abi.encode(batch, leaf, proof, signature));
        _assertUnchanged();
        exchange.cancel(seller, batch.batchNonce);
        vm.expectRevert();
        _buy();
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_alreadyConsumedLeafCannotBuy() public {
        _fundPool();
        exchange.consume(leaf);
        vm.expectRevert();
        _buy();
        assertEq(nft.ownerOf(leaf.tokenId), seller);
        assertEq(bem.balanceOf(seller), 0);
        assertEq(exchange.fills(), 0);
    }

    function test_MOCK_PROTOCOL_officialPriorityAndReadFailureBlockFallback() public {
        _fundPool();
        officialMarket.createListing(seller, address(nft), leaf.tokenId, 5 ether);
        vm.expectRevert(IPoolVault.OriginalTargetAvailable.selector);
        _buy();
        _assertUnchanged();
        vm.mockCallRevert(
            address(officialMarket),
            abi.encodeWithSignature("listingFor(address,uint256)", address(nft), leaf.tokenId),
            abi.encodeWithSignature("Error(string)", "unavailable")
        );
        vm.expectRevert();
        _buy();
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_feeChangesGrossCapAndFloor() public {
        _fundPool();
        exchange.configure(PROTOCOL_FACTORY, 100, 2);
        vm.expectRevert(IPoolVault.FirstoFeeChanged.selector);
        _buy();
        exchange.configure(PROTOCOL_FACTORY, 101, 1);
        vm.expectRevert(IPoolVault.FirstoFeeChanged.selector);
        _buy();
        exchange.configure(PROTOCOL_FACTORY, 100, 1);
        leaf.price = uint128(defaultParams.priceCap);
        _refreshRoot();
        vm.expectRevert(IPoolVault.OverPriceCap.selector);
        _buy();
        leaf.price = 10_099;
        _refreshRoot();
        _buy();
        assertEq(PoolVault(payable(address(pool))).purchaseCost(), 10_199);
        assertEq(EXCHANGE.balance, 100);
    }

    function test_MOCK_PROTOCOL_marketFaultsAndNftCallbackFaultsRollback() public {
        _fundPool();
        for (uint8 fault = 1; fault <= 7; ++fault) {
            exchange.setFault(fault);
            vm.expectRevert();
            _buy();
            _assertUnchanged();
        }
        exchange.setFault(0);
        for (uint8 fault = 1; fault <= 6; ++fault) {
            nft.setCallbackFault(fault);
            vm.expectRevert();
            _buy();
            _assertUnchanged();
        }
    }

    function test_MOCK_PROTOCOL_reentryCannotSpendAgain() public {
        _fundPool();
        exchange.setReentry(abi.encodeCall(IPoolVault.buyFromFirsto, (1, _order())));
        _buy();
        assertFalse(exchange.reentrySucceeded());
        assertEq(exchange.fills(), 1);
    }

    function test_MOCK_PROTOCOL_1271AndBoundsAndCanonicalEncoding() public {
        _fundPool();
        vm.etch(seller, address(new Firsto1271Mock()).code);
        bytes memory longSignature = new bytes(1025);
        longSignature[0] = 0x42;
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        pool.buyFromFirsto(1, abi.encode(batch, leaf, proof, longSignature));
        bytes memory accepted = new bytes(1024);
        accepted[0] = 0x42;
        bytes memory encoded = abi.encode(batch, leaf, proof, accepted);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        pool.buyFromFirsto(1, bytes.concat(encoded, hex"00"));
        pool.buyFromFirsto(1, encoded);
        assertEq(nft.ownerOf(leaf.tokenId), address(pool));
    }

    function _makeProof(uint256 count) private {
        delete proof;
        bytes32 root = exchange.hashLeaf(leaf);
        for (uint256 i; i < count; ++i) {
            bytes32 sibling = keccak256(abi.encode("isolated proof node", i));
            proof.push(sibling);
            root = root < sibling
                ? keccak256(abi.encodePacked(root, sibling))
                : keccak256(abi.encodePacked(sibling, root));
        }
        batch.merkleRoot = root;
    }

    function test_MOCK_PROTOCOL_proofDepthAndMaximumCanonicalPayload() public {
        _fundPool();
        _makeProof(33);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        _assertUnchanged();
        _makeProof(32);
        vm.etch(seller, address(new Firsto1271Mock()).code);
        bytes memory signature = new bytes(1024);
        signature[0] = 0x42;
        bytes memory maximum = abi.encode(batch, leaf, proof, signature);
        assertEq(maximum.length, 2752);
        pool.buyFromFirsto(1, maximum);
        assertEq(nft.ownerOf(leaf.tokenId), address(pool));
    }

    function test_MOCK_PROTOCOL_expiryWrongSchemaWrongNftAndPayoutRollback() public {
        _fundPool();
        batch.expiry = uint64(block.timestamp);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        batch.expiry = uint64(block.timestamp + 1 days);
        leaf.schemaVersion = 2;
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        leaf.schemaVersion = 1;
        ++leaf.tokenId;
        _refreshRoot();
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        _buy();
        --leaf.tokenId;
        leaf.payoutRecipient = address(new FirstoRejectingRecipient());
        batch.payoutRecipient = leaf.payoutRecipient;
        _refreshRoot();
        vm.expectRevert();
        _buy();
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_claimFailureAndPostClaimQualityMutationRollback() public {
        _fundPool();
        mining.configure(address(nft), leaf.tokenId, 7 * 1e8, 21 * 1e8);
        for (uint8 fault = 1; fault <= 9; ++fault) {
            mining.setClaimFault(fault);
            vm.expectRevert();
            _buy();
            _assertUnchanged();
            assertEq(poolFactory.machinePool(address(nft), leaf.tokenId), address(pool));
        }
    }

    function _flexiblePool() private {
        ++defaultParams.circuitId;
        defaultParams.targetRaise = 6.6 ether;
        nft.mint(seller, defaultParams.circuitId);
        mining.configure(address(nft), defaultParams.circuitId, 0, 21 * 1e8);
        vm.prank(seller);
        nft.approve(EXCHANGE, defaultParams.circuitId);
        IPoolVault.FlexiblePurchaseConfig memory config = IPoolVault.FlexiblePurchaseConfig({
            minVerifiedWeight: 1,
            referencePriceWei: 6 ether,
            targetDailyYieldAtomic: 1e8,
            extraBps: 1000,
            referenceObservedAt: uint64(block.timestamp),
            referenceBlock: uint64(block.number),
            referenceDigest: keccak256("isolated fixture")
        });
        vm.prank(OPERATOR);
        pool = IFundingVault(poolFactory.createFlexiblePool(defaultParams, config));
        leaf.tokenId = defaultParams.circuitId;
        _refreshRoot();
    }

    function test_MOCK_PROTOCOL_flexibleGrossSurplusAllocatedAndOriginalPriority() public {
        _flexiblePool();
        _deposit(pool, ALICE, 37);
        _deposit(pool, BOB, 63);
        uint256 listing = officialMarket.createListing(seller, address(nft), leaf.tokenId, 5 ether);
        vm.expectRevert(IPoolVault.OriginalTargetAvailable.selector);
        _buy();
        _assertUnchanged();
        officialMarket.setValid(listing, false);
        _buy();
        assertEq(pool.totalBnbOwed(), 1.55 ether);
        assertEq(pool.bnbOwed(ALICE), 1.55 ether * 37 / 100);
        assertEq(pool.bnbOwed(BOB), 1.55 ether * 63 / 100);
        assertEq(address(pool).balance, pool.totalBnbOwed());
    }

    function test_MOCK_PROTOCOL_flexibleLockedModelAndWeightGrossCap() public {
        _flexiblePool();
        _deposit(pool, ALICE, 100);
        bytes32 minerKey = mining.minerKey(address(nft), leaf.tokenId);
        mining.setTaskId(minerKey, 2);
        vm.expectRevert(IPoolVault.WrongPurchaseModel.selector);
        _buy();
        _assertUnchanged();
        mining.setTaskId(minerKey, 1);
        mining.setVerifiedWeight(minerKey, 1);
        leaf.price = uint128(3 ether);
        _refreshRoot();
        vm.expectRevert(IPoolVault.OverReferenceUnitPrice.selector);
        _buy();
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_batchFailureStillAllowsDeadlinePrincipalRefund() public {
        _fundPool();
        exchange.setPaused(true);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        vm.warp(defaultParams.purchaseDeadline);
        pool.finalizeFailure();
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - before, 49 * UNIT_PRICE);
        assertEq(exchange.fills(), 0);
    }

    function test_MOCK_PROTOCOL_runtimeMismatchFailsBeforeRewardsOrPayment() public {
        _fundPool();
        vm.etch(EXCHANGE, address(new FirstoBatchAskMock()).code);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_wrongNetworkAndProtocolBindingsFailClosed() public {
        _fundPool();
        vm.chainId(1);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        vm.chainId(56);
        exchange.configure(address(0xBAD), 100, 1);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        exchange.configure(PROTOCOL_FACTORY, 100, 1);
        exchange.setSchema(2);
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_changedTargetOwnerCannotBeBoughtEvenWithNewValidSignature() public {
        _fundPool();
        address nextOwner = vm.addr(0x23456);
        nft.forceTransfer(nextOwner, leaf.tokenId);
        leaf.maker = nextOwner;
        batch.maker = nextOwner;
        _refreshRoot();
        vm.expectRevert(IPoolVault.TargetOwnerChanged.selector);
        pool.buyFromFirsto(1, abi.encode(batch, leaf, proof, _signatureForKey(0x23456)));
        assertEq(nft.ownerOf(leaf.tokenId), nextOwner);
        assertEq(exchange.fills(), 0);
        assertEq(mining.claimCalls(), 0);
        assertEq(address(pool).balance, pool.totalRaised());
    }

    function test_MOCK_PROTOCOL_unconfiguredLegacyTargetCannotBuy() public {
        _fundPool();
        bytes32 slot = 0x5e3815662d4c25a0aafa80ec36671d2b01c656be89eff3f6936c6387169fd700;
        // Obtain the reviewed namespace from TargetOwnerTest; only this test's local storage is modified.
        vm.store(address(pool), slot, bytes32(0));
        vm.expectRevert(IPoolVault.TargetOwnerNotConfigured.selector);
        _buy();
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_wrongStateAndExactPurchaseDeadlineDoNotSpend() public {
        vm.expectRevert(IPoolVault.WrongState.selector);
        _buy();
        _fundPool();
        vm.warp(defaultParams.purchaseDeadline);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        _buy();
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_claimCanInvalidateLeafAndEntirePurchaseRollsBack() public {
        _fundPool();
        mining.setClaimReentry(EXCHANGE, abi.encodeCall(FirstoBatchAskMock.consume, (leaf)));
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        _buy();
        _assertUnchanged();
    }

    function test_MOCK_PROTOCOL_batchCapabilityVersionIsSeparateFromNativeSaleAndOwner() public view {
        PoolVault vault = PoolVault(payable(address(pool)));
        assertEq(vault.firstoBatchPurchaseVersion(), 1);
        assertEq(vault.targetOwnerVersion(), 1);
        assertEq(vault.nativeFirstoSaleVersion(), 1);
    }
}
