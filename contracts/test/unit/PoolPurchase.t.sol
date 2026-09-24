// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {FundingTestBase} from "../utils/FundingTestBase.sol";
import {
    PurchaseMockBem,
    PurchaseMockNft,
    PurchaseMockMining,
    PurchaseMockMarket,
    PurchaseRejectingSeller
} from "../utils/PurchaseMocks.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IPurchaseActions {
    function buyFromMarket(uint256 listingId) external;
    function sellToPool() external;
    function purchaseCost() external view returns (uint256);
    function activatedAt() external view returns (uint64);
    function surplusPerShareWei() external view returns (uint256);
    function surplusRemainder() external view returns (uint256);
    function surplusOutstandingWei() external view returns (uint256);
    function pendingPurchaseSurplus(address member) external view returns (uint256);
    function surplusSettled(address member) external view returns (bool);
}

/// @notice Unit fault injection only: code at the protocol constants is replaced by explicit mocks.
/// Real protocol compatibility is covered separately by the fixed-block purchase fork tests.
contract PoolPurchaseTest is FundingTestBase {
    address internal constant SELLER = address(0x5E11E2);
    uint256 internal constant ID = 16210;
    uint96 internal constant PRICE = 5 ether;
    uint256 internal constant STORED_PENDING = 1100;
    uint256 internal constant LIVE_EXTRA = 700;

    IPurchaseActions internal purchase;
    PurchaseMockNft internal nft;
    PurchaseMockBem internal bem;
    PurchaseMockMining internal mining;
    PurchaseMockMarket internal market;
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        bem = PurchaseMockBem(Addresses.BEM);
        mining = PurchaseMockMining(payable(Addresses.MINING));
        market = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);
        nft.mint(SELLER, ID);
        mining.configure(address(nft), ID, STORED_PENDING, LIVE_EXTRA);
        key = mining.minerKey(address(nft), ID);
        purchase = IPurchaseActions(address(pool));
    }

    function _list(uint96 price) internal returns (uint256 listingId) {
        vm.prank(SELLER);
        nft.approve(address(market), ID);
        listingId = market.createListing(SELLER, address(nft), ID, price);
    }

    function _directPool(address seller, uint256 price) internal {
        IPoolVault.PoolParams memory p = defaultParams;
        p.directSeller = seller;
        p.directPrice = price;
        pool = _createPool(p);
        purchase = IPurchaseActions(address(pool));
        if (nft.ownerOf(ID) != seller) nft.forceTransfer(seller, ID);
        vm.prank(seller);
        nft.approve(address(pool), ID);
        _fundPool();
    }

    function _assertActive(uint256 cost) internal view {
        _stateIs(IPoolVault.State.Active);
        assertEq(purchase.purchaseCost(), cost);
        assertEq(purchase.activatedAt(), block.timestamp);
        assertEq(nft.ownerOf(ID), address(pool));
        assertEq(mining.getMiner(key).status, 1);
        assertEq(mining.pending(key), 0);
        assertEq(bem.balanceOf(address(pool)), 0, "seller's old BEM must not enter the project");
        assertEq(pool.totalSupply(), 100);
    }

    function _assertMarketFailureAtomic(uint256 listingId) internal view {
        _stateIs(IPoolVault.State.Funded);
        assertEq(nft.ownerOf(ID), SELLER);
        assertEq(bem.balanceOf(SELLER), 0);
        assertEq(mining.pending(key), STORED_PENDING);
        assertEq(mining.unreported(key), LIVE_EXTRA);
        assertEq(mining.claimCalls(), 0);
        assertEq(market.buyCalls(), 0);
        assertEq(address(pool).balance, defaultParams.targetRaise);
        (,,,,, bool valid) = market.listingView(listingId);
        assertTrue(valid);
    }

    function test_marketPurchasePaysOnlyListedPriceAndCreditsOriginalSurplus() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        uint256 sellerBnbBefore = SELLER.balance;
        vm.prank(address(0x7777));
        purchase.buyFromMarket(listingId);
        _assertActive(PRICE);
        assertEq(SELLER.balance - sellerBnbBefore, uint256(PRICE) * 99 / 100);
        assertEq(market.fees(), uint256(PRICE) / 100);
        assertEq(address(pool).balance, defaultParams.targetRaise - PRICE);
        assertEq(bem.balanceOf(SELLER), STORED_PENDING + LIVE_EXTRA);
        assertEq(purchase.surplusPerShareWei(), 0.015 ether);
        assertEq(purchase.surplusOutstandingWei(), 1.5 ether);
        assertEq(pool.bnbOwed(ALICE), 0.735 ether);
        assertEq(pool.totalBnbOwed(), 1.5 ether);
    }

    function test_marketSettlementEventPrecedesNftTransferAndPurchase() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        vm.recordLogs();
        purchase.buyFromMarket(listingId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 settlement = type(uint256).max;
        uint256 nftTransfer = type(uint256).max;
        uint256 purchased = type(uint256).max;
        uint256 rewardMint = type(uint256).max;
        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(bem) && logs[i].topics[0] == transferTopic) rewardMint = i;
            if (logs[i].emitter == address(nft) && logs[i].topics[0] == transferTopic) nftTransfer = i;
            if (logs[i].emitter != address(pool)) continue;
            if (logs[i].topics[0] == keccak256("RewardSettledBeforeTransfer(address,uint256,address,uint256,bytes32)"))
            {
                settlement = i;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(nft));
                assertEq(uint256(logs[i].topics[2]), ID);
                (address owner, uint256 amount,) = abi.decode(logs[i].data, (address, uint256, bytes32));
                assertEq(owner, SELLER);
                assertEq(amount, STORED_PENDING + LIVE_EXTRA);
            }
            if (logs[i].topics[0] == keccak256("Purchased(uint256,uint8,uint256)")) {
                purchased = i;
                (uint256 cost, uint8 path, uint256 id) = abi.decode(logs[i].data, (uint256, uint8, uint256));
                assertEq(cost, PRICE);
                assertEq(path, 0);
                assertEq(id, listingId);
            }
        }
        assertLt(rewardMint, settlement);
        assertLt(settlement, nftTransfer);
        assertLt(nftTransfer, purchased);
        assertTrue(purchased != type(uint256).max, "Purchased event missing");
    }

    function test_zeroStoredPendingStillClaimsUnreportedRewards() public {
        mining.configure(address(nft), ID, 0, LIVE_EXTRA);
        _fundPool();
        purchase.buyFromMarket(_list(PRICE));
        assertEq(mining.claimCalls(), 1);
        assertEq(bem.balanceOf(SELLER), LIVE_EXTRA);
        _assertActive(PRICE);
    }

    function test_zeroTotalRewardCanStillBeSettledAndPurchased() public {
        mining.configure(address(nft), ID, 0, 0);
        _fundPool();
        purchase.buyFromMarket(_list(PRICE));
        assertEq(mining.claimCalls(), 1);
        _assertActive(PRICE);
    }

    function test_marketRejectsInvalidListingWrongNftAndWrongTokenId() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        market.setValid(listingId, false);
        vm.expectRevert(IPoolVault.InvalidListing.selector);
        purchase.buyFromMarket(listingId);
        listingId = market.createListing(SELLER, Addresses.BEHEMOTH_CIRCUITS, ID, PRICE);
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        purchase.buyFromMarket(listingId);
        listingId = market.createListing(SELLER, address(nft), ID + 1, PRICE);
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        purchase.buyFromMarket(listingId);
        assertEq(mining.claimCalls(), 0);
    }

    function test_marketRejectsSellerWhoseOwnershipChanged() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        nft.forceTransfer(address(0x9999), ID);
        vm.expectRevert();
        purchase.buyFromMarket(listingId);
        assertEq(mining.claimCalls(), 0);
        assertEq(market.buyCalls(), 0);
        _stateIs(IPoolVault.State.Funded);
    }

    function test_marketPriceCapInclusiveAndOneWeiExcessRejected() public {
        _fundPool();
        uint256 listingId = _list(uint96(defaultParams.priceCap + 1));
        vm.expectRevert(IPoolVault.OverPriceCap.selector);
        purchase.buyFromMarket(listingId);
        _assertMarketFailureAtomic(listingId);
        purchase.buyFromMarket(_list(uint96(defaultParams.priceCap)));
        _assertActive(defaultParams.priceCap);
    }

    function test_purchaseRequiresFundedAndCannotRepeat() public {
        uint256 listingId = _list(PRICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        purchase.buyFromMarket(listingId);
        _fundPool();
        purchase.buyFromMarket(listingId);
        vm.expectRevert(IPoolVault.WrongState.selector);
        purchase.buyFromMarket(listingId);
        assertEq(market.buyCalls(), 1);
        assertEq(mining.claimCalls(), 1);
    }

    function test_marketDeadlineRejectsAtDeadlineAndLeavesRefundAvailable() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        vm.warp(defaultParams.purchaseDeadline);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        purchase.buyFromMarket(listingId);
        _assertMarketFailureAtomic(listingId);
        pool.finalizeFailure();
        assertEq(pool.bnbOwed(ALICE), 49 * UNIT_PRICE);
    }

    function test_marketPurchaseOneSecondBeforeDeadlineSucceedsDespiteDepositPause() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        vm.prank(OPERATOR);
        pool.setDepositPaused(true);
        vm.warp(defaultParams.purchaseDeadline - 1);
        purchase.buyFromMarket(listingId);
        _assertActive(PRICE);
    }

    function test_claimFailureDoesNotGetSwallowedEvenWhenPendingZero() public {
        mining.configure(address(nft), ID, 0, 0);
        mining.setClaimFault(1);
        _fundPool();
        uint256 listingId = _list(PRICE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        purchase.buyFromMarket(listingId);
        assertEq(nft.ownerOf(ID), SELLER);
        assertEq(market.buyCalls(), 0);
        assertEq(address(pool).balance, defaultParams.targetRaise);
    }

    function testFuzz_badClaimPostconditionsRollback(uint8 fault) public {
        fault = uint8(bound(fault, 2, 4)); // nonzero pending, diverted reward, or changed NFT owner
        mining.setClaimFault(fault);
        _fundPool();
        uint256 listingId = _list(PRICE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        purchase.buyFromMarket(listingId);
        _assertMarketFailureAtomic(listingId);
    }

    function test_inactiveMinerCannotBePurchased() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        mining.setStatus(key, 3);
        vm.expectRevert(IPoolVault.MinerNotActive.selector);
        purchase.buyFromMarket(listingId);
        assertEq(mining.claimCalls(), 0);
        assertEq(nft.ownerOf(ID), SELLER);
    }

    function test_miningRecordMustMatchRequestedNft() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        mining.setIdentity(key, address(nft), uint64(ID + 1));
        vm.expectRevert();
        purchase.buyFromMarket(listingId);
        assertEq(mining.claimCalls(), 0);
        assertEq(nft.ownerOf(ID), SELLER);
    }

    function test_marketFailureRollsBackPreviouslyMintedSellerReward() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        market.setBuyFault(4);
        vm.expectRevert();
        purchase.buyFromMarket(listingId);
        _assertMarketFailureAtomic(listingId);
        assertEq(bem.totalSupply(), 0);
    }

    function testFuzz_badPostPurchaseOwnershipOrMiningRollsBack(uint8 fault) public {
        fault = uint8(bound(fault, 1, 3));
        _fundPool();
        uint256 listingId = _list(PRICE);
        market.setBuyFault(fault);
        vm.expectRevert();
        purchase.buyFromMarket(listingId);
        _assertMarketFailureAtomic(listingId);
    }

    function testFuzz_wrongOrDuplicateCallbackRollsBack(uint8 fault) public {
        fault = uint8(bound(fault, 1, 6)); // operator, from, id, duplicate, missing, or forged sender
        _fundPool();
        uint256 listingId = _list(PRICE);
        nft.setCallbackFault(fault);
        vm.expectRevert();
        purchase.buyFromMarket(listingId);
        _assertMarketFailureAtomic(listingId);
    }

    function test_unsolicitedTargetNftTransferRejectedOutsidePurchaseContext() public {
        _fundPool();
        vm.prank(SELLER);
        vm.expectRevert(IPoolVault.UnexpectedNft.selector);
        nft.safeTransferFrom(SELLER, address(pool), ID);
        assertEq(nft.ownerOf(ID), SELLER);
        vm.expectRevert(IPoolVault.UnexpectedNft.selector);
        IERC721Receiver(address(pool)).onERC721Received(address(market), SELLER, ID, "");
    }

    function test_callbackCannotReenterAnotherPurchase() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        nft.setReentryData(abi.encodeCall(IPurchaseActions.buyFromMarket, (listingId)));
        purchase.buyFromMarket(listingId);
        _assertActive(PRICE);
        assertTrue(nft.reentryAttempted());
        assertFalse(nft.reentrySucceeded());
        assertEq(market.buyCalls(), 1);
    }

    function test_claimCallbackCannotReenterAnotherPurchase() public {
        _fundPool();
        uint256 listingId = _list(PRICE);
        mining.setClaimReentry(address(pool), abi.encodeCall(IPurchaseActions.buyFromMarket, (listingId)));
        purchase.buyFromMarket(listingId);
        _assertActive(PRICE);
        _assertClaimReentryGuard();
        assertEq(market.buyCalls(), 1);
        assertEq(bem.balanceOf(SELLER), STORED_PENDING + LIVE_EXTRA);
    }

    function test_claimCallbackCannotWithdrawExistingCredit() public {
        _deposit(pool, address(mining), 1);
        vm.prank(address(mining));
        pool.withdrawDeposit();
        _fundPool();
        uint256 miningBnbBefore = address(mining).balance;
        mining.setClaimReentry(address(pool), abi.encodeCall(IPoolVault.withdrawBnb, ()));
        purchase.buyFromMarket(_list(PRICE));
        _assertActive(PRICE);
        _assertClaimReentryGuard();
        assertEq(market.buyCalls(), 1);
        assertEq(pool.bnbOwed(address(mining)), UNIT_PRICE, "blocked callback cannot spend existing credit");
        assertEq(address(mining).balance, miningBnbBefore);
        assertEq(address(pool).balance, pool.totalBnbOwed());
    }

    function _assertClaimReentryGuard() internal view {
        assertTrue(mining.reentryAttempted());
        assertFalse(mining.reentrySucceeded());
        assertEq(mining.reentryResult(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertEq(mining.claimCalls(), 1);
    }

    function test_directSellerReceivesPullCreditAndHistoricalBem() public {
        _directPool(SELLER, PRICE);
        uint256 sellerBefore = SELLER.balance;
        vm.prank(SELLER);
        purchase.sellToPool();
        _assertActive(PRICE);
        assertEq(SELLER.balance, sellerBefore, "direct seller is paid through pull accounting");
        assertEq(pool.bnbOwed(SELLER), PRICE);
        assertEq(pool.totalBnbOwed(), defaultParams.targetRaise);
        assertEq(address(pool).balance, defaultParams.targetRaise);
        assertEq(bem.balanceOf(SELLER), STORED_PENDING + LIVE_EXTRA);
        vm.prank(SELLER);
        pool.withdrawBnb();
        assertEq(SELLER.balance - sellerBefore, PRICE);
        assertEq(pool.totalBnbOwed(), 1.5 ether);
    }

    function test_directSellerMayBeAMemberWithoutMixingSellerPriceAndSurplus() public {
        _directPool(ALICE, PRICE);
        vm.prank(ALICE);
        purchase.sellToPool();
        assertEq(pool.bnbOwed(ALICE), uint256(PRICE) + 0.735 ether);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - before, uint256(PRICE) + 0.735 ether);
        assertEq(pool.bnbOwed(ALICE), 0);
        assertTrue(purchase.surplusSettled(ALICE));
        assertEq(pool.totalBnbOwed(), 0.765 ether);
    }

    function test_rejectingDirectSellerDoesNotBlockPurchaseAndKeepsPullCredit() public {
        PurchaseRejectingSeller seller = new PurchaseRejectingSeller();
        _directPool(address(seller), PRICE);
        seller.sell(address(pool));
        _assertActive(PRICE);
        assertEq(pool.bnbOwed(address(seller)), PRICE);
        vm.prank(address(seller));
        vm.expectRevert(IPoolVault.TransferFailed.selector);
        pool.withdrawBnb();
        assertEq(pool.bnbOwed(address(seller)), PRICE);
    }

    function test_directOnlyConfiguredSellerAndRequiresApproval() public {
        _directPool(SELLER, PRICE);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        purchase.sellToPool();
        vm.prank(SELLER);
        nft.approve(address(0), ID);
        vm.prank(SELLER);
        vm.expectRevert();
        purchase.sellToPool();
        assertEq(bem.balanceOf(SELLER), 0);
        assertEq(mining.pending(key), STORED_PENDING);
        assertEq(nft.ownerOf(ID), SELLER);
        assertEq(pool.bnbOwed(SELLER), 0);
    }

    function test_unconfiguredDirectPathRejected() public {
        _fundPool();
        vm.prank(SELLER);
        vm.expectRevert();
        purchase.sellToPool();
        assertEq(nft.ownerOf(ID), SELLER);
    }

    function test_directDeadlineRejectsAtDeadline() public {
        _directPool(SELLER, PRICE);
        vm.warp(defaultParams.purchaseDeadline);
        vm.prank(SELLER);
        vm.expectRevert(IPoolVault.DeadlinePassed.selector);
        purchase.sellToPool();
        assertEq(nft.ownerOf(ID), SELLER);
    }

    function test_directRepeatPurchaseCannotCreditSellerTwice() public {
        _directPool(SELLER, PRICE);
        vm.prank(SELLER);
        purchase.sellToPool();
        vm.prank(SELLER);
        vm.expectRevert(IPoolVault.WrongState.selector);
        purchase.sellToPool();
        assertEq(pool.bnbOwed(SELLER), PRICE);
        assertEq(mining.claimCalls(), 1);
        assertEq(pool.totalBnbOwed(), defaultParams.targetRaise);
    }

    function test_directPurchasedEventIdentifiesPathAndPrice() public {
        _directPool(SELLER, PRICE);
        vm.recordLogs();
        vm.prank(SELLER);
        purchase.sellToPool();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 matches;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pool) && logs[i].topics[0] == keccak256("Purchased(uint256,uint8,uint256)"))
            {
                (uint256 cost, uint8 path, uint256 listingId) = abi.decode(logs[i].data, (uint256, uint8, uint256));
                assertEq(cost, PRICE);
                assertEq(path, 1);
                assertEq(listingId, 0);
                ++matches;
            }
        }
        assertEq(matches, 1);
    }

    function testFuzz_directBadCallbackRollsBackSellerCreditAndReward(uint8 fault) public {
        fault = uint8(bound(fault, 1, 6));
        _directPool(SELLER, PRICE);
        nft.setCallbackFault(fault);
        vm.prank(SELLER);
        vm.expectRevert(IPoolVault.UnexpectedNft.selector);
        purchase.sellToPool();
        _stateIs(IPoolVault.State.Funded);
        assertEq(nft.ownerOf(ID), SELLER);
        assertEq(bem.balanceOf(SELLER), 0);
        assertEq(mining.pending(key), STORED_PENDING);
        assertEq(mining.unreported(key), LIVE_EXTRA);
        assertEq(mining.claimCalls(), 0);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(address(pool).balance, defaultParams.targetRaise);
    }

    function test_existingSellerBemCannotMaskMissingSettlementReceipt() public {
        bem.mint(SELLER, 1000000);
        mining.setClaimFault(3);
        _fundPool();
        uint256 listingId = _list(PRICE);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        purchase.buyFromMarket(listingId);
        assertEq(bem.balanceOf(SELLER), 1000000);
        assertEq(bem.balanceOf(address(0xBAD)), 0);
        assertEq(mining.pending(key), STORED_PENDING);
        assertEq(nft.ownerOf(ID), SELLER);
        assertEq(market.buyCalls(), 0);
    }

    function test_minerBecomingInactiveDuringClaimRollsBackEverything() public {
        mining.setClaimFault(5);
        _fundPool();
        uint256 listingId = _list(PRICE);
        vm.expectRevert(IPoolVault.MinerNotActive.selector);
        purchase.buyFromMarket(listingId);
        _assertMarketFailureAtomic(listingId);
        assertEq(mining.getMiner(key).status, 1);
    }

    function test_surplusWithdrawImmediatelyAtPurchaseTimestampAndOnlyOnce() public {
        _fundPool();
        purchase.buyFromMarket(_list(PRICE));
        assertEq(purchase.activatedAt(), block.timestamp);
        assertEq(purchase.pendingPurchaseSurplus(ALICE), 0.735 ether);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance - before, 0.735 ether);
        assertEq(purchase.pendingPurchaseSurplus(ALICE), 0);
        assertEq(purchase.surplusOutstandingWei(), 0.765 ether);
        assertEq(pool.bnbOwed(ALICE), 0);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        pool.withdrawBnb();
    }

    function test_surplusRemainderReservedSeparatelyAndAllMembersConserveBnb() public {
        _fundPool();
        uint96 oddPrice = PRICE + 1;
        purchase.buyFromMarket(_list(oddPrice));
        uint256 surplus = defaultParams.targetRaise - oddPrice;
        uint256 perShare = surplus / 100;
        assertEq(purchase.surplusRemainder(), 99);
        assertEq(purchase.surplusOutstandingWei(), perShare * 100);
        assertEq(pool.bnbOwed(ALICE), perShare * 49);
        assertEq(pool.bnbOwed(BOB), perShare * 49);
        assertEq(pool.bnbOwed(CAROL), perShare * 2);
        vm.prank(ALICE);
        pool.withdrawBnb();
        vm.prank(BOB);
        pool.withdrawBnb();
        vm.prank(CAROL);
        pool.withdrawBnb();
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(purchase.surplusOutstandingWei(), 0);
        assertEq(address(pool).balance, 99);
    }

    function test_previousWithdrawalCreditAndForcedBnbDoNotInflateSurplus() public {
        _deposit(pool, ALICE, 1);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        _fundPool();
        uint256 gift = 1 ether;
        vm.deal(address(pool), address(pool).balance + gift);
        purchase.buyFromMarket(_list(PRICE));
        assertEq(purchase.surplusPerShareWei(), 0.015 ether);
        assertEq(pool.bnbOwed(ALICE), UNIT_PRICE + 0.735 ether);
        assertEq(pool.totalBnbOwed(), UNIT_PRICE + 1.5 ether);
        assertEq(address(pool).balance, pool.totalBnbOwed() + gift);
    }

    function test_noSurplusWhenPurchaseUsesEntireRaise() public {
        IPoolVault.PoolParams memory p = defaultParams;
        p.priceCap = p.targetRaise;
        pool = _createPool(p);
        purchase = IPurchaseActions(address(pool));
        _fundPool();
        purchase.buyFromMarket(_list(uint96(p.targetRaise)));
        assertEq(purchase.surplusPerShareWei(), 0);
        assertEq(purchase.surplusRemainder(), 0);
        assertEq(pool.totalBnbOwed(), 0);
        assertEq(pool.bnbOwed(ALICE), 0);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.NothingToClaim.selector);
        pool.withdrawBnb();
    }

    function test_surplusDoesNotPermitOrdinaryTransfersBeforeT1d() public {
        _fundPool();
        purchase.buyFromMarket(_list(PRICE));
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.transfer(BOB, 1);
        assertEq(purchase.pendingPurchaseSurplus(ALICE), 0.735 ether);
        assertEq(purchase.pendingPurchaseSurplus(BOB), 0.735 ether);
    }
}
