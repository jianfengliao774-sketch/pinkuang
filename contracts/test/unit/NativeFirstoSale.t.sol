// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {FirstoSignedAskMock} from "../utils/FirstoMocks.sol";
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {PoolVault} from "../../src/PoolVault.sol";

/// @dev Fault injection only. The real official exchange is covered separately by the pinned fork.
contract NativeSaleCallbackBuyer is IERC721Receiver {
    PoolVault public pool;
    bool public completeSucceeded;
    bool public transferSucceeded;
    IPoolVault.State public observedState;

    constructor(PoolVault pool_) {
        pool = pool_;
    }

    function buy(IFirstoSignedAskExchange exchange, IFirstoSignedAskExchange.SignedAsk memory ask) external payable {
        exchange.fillSignedAsk{value: msg.value}(ask, new bytes(65), address(this));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        observedState = pool.state();
        (completeSucceeded,) = address(pool)
            .call(
                abi.encodeCall(
                    PoolVault.completeFirstoSale, (pool.listedProposalId(), pool.salePrice(), uint16(100), uint256(1))
                )
            );
        (transferSucceeded,) =
            address(pool).call(abi.encodeWithSignature("transfer(address,uint256)", address(0xBAD), 1));
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract NativeFirstoSaleTest is SaleTestBase {
    uint256 private constant PAYMENT = SALE_PRICE + SALE_PRICE / 100;

    function setUp() public override {
        super.setUp();
        FirstoSignedAskMock(FIRSTO).configure(0x68224F668083c29e9800Be2a646d42d18cedF7e2, 100, 1);
    }

    function _ask() private view returns (IFirstoSignedAskExchange.SignedAsk memory ask, bytes32 hash) {
        bool active;
        (ask, hash, active) = saleVault.nativeFirstoAsk();
        assertTrue(active);
    }

    function _nativeBuy(address buyer, IFirstoSignedAskExchange.SignedAsk memory ask) private {
        vm.deal(buyer, PAYMENT);
        vm.prank(buyer);
        IFirstoSignedAskExchange(FIRSTO).fillSignedAsk{value: PAYMENT}(ask, new bytes(65), buyer);
    }

    function test_openHarvestsExistingBemAndPublishesOnlyTheExactGovernanceAsk() public {
        _queueReward(10_000);
        uint256 id = _listSale(SALE_PRICE);
        (IFirstoSignedAskExchange.SignedAsk memory ask, bytes32 hash) = _ask();
        assertEq(saleVault.nativeFirstoSaleVersion(), 1);
        assertEq(ask.maker, address(pool));
        assertEq(ask.payoutRecipient, address(pool));
        assertEq(ask.collection, address(nft));
        assertEq(ask.tokenId, rewardId);
        assertEq(ask.price, SALE_PRICE);
        assertEq(ask.nonce, id);
        assertEq(ask.expiry, sale.expiresAt());
        assertEq(ask.feeBps, 100);
        assertEq(ask.feeEpoch, 1);
        assertEq(hash, FirstoSignedAskMock(FIRSTO).hash(ask));
        assertEq(nft.getApproved(rewardId), FIRSTO);
        assertEq(mining.pending(key), 0);
        assertEq(rewards.bemAccounted(), 9900);
        assertEq(bem.balanceOf(TREASURY), 100);
        vm.prank(address(0xA91)); // Indexers need not impersonate the exchange.
        assertEq(saleVault.isValidSignature(hash, new bytes(65)), bytes4(0x1626ba7e));
        assertEq(saleVault.isValidSignature(bytes32(0), new bytes(65)), bytes4(0xffffffff));
        ask.price += 1;
        assertEq(saleVault.isValidSignature(FirstoSignedAskMock(FIRSTO).hash(ask), new bytes(65)), bytes4(0xffffffff));
    }

    function test_nativeFillBooksOnlyReceivedBemAndLeavesPostListingMiningToBuyer() public {
        _queueReward(10_000);
        _listSale(SALE_PRICE);
        (IFirstoSignedAskExchange.SignedAsk memory ask,) = _ask();
        _queueReward(5000);
        _donate(1000);
        uint256 oldBnb = address(pool).balance;
        uint256 firstoBefore = FIRSTO.balance;
        _nativeBuy(NFT_BUYER, ask);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Closed));
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
        assertEq(nft.getApproved(rewardId), address(0));
        assertEq(address(pool).balance, oldBnb + SALE_PRICE);
        assertEq(FIRSTO.balance - firstoBefore, SALE_PRICE / 100);
        assertEq(sale.saleProceeds(), SALE_PRICE);
        assertEq(sale.saleBuyer(), NFT_BUYER);
        assertEq(sale.bnbOwed(TREASURY), SALE_PRICE / 100);
        assertEq(sale.saleOutstandingWei(), SALE_PRICE * 99 / 100);
        assertEq(rewards.bemAccounted(), 10890);
        assertEq(bem.balanceOf(TREASURY), 110);
        assertEq(mining.pending(key), 0); // The mock stores this queued amount lazily until claim.
        uint256 buyerBefore = bem.balanceOf(NFT_BUYER);
        mining.claim(key);
        assertEq(bem.balanceOf(NFT_BUYER) - buyerBefore, 5000);
        assertEq(rewards.bemAccounted(), 10890, "buyer-owned income is never booked to old shares");
        assertGt(_claim(ALICE), 0, "old BEM liabilities remain payable after native sale");
    }

    function testFuzz_nativeAndControlledSitesConsumeOneNonceOnly(bool nativeFirst) public {
        _listSale(SALE_PRICE);
        (IFirstoSignedAskExchange.SignedAsk memory ask, bytes32 hash) = _ask();
        if (nativeFirst) {
            _nativeBuy(NFT_BUYER, ask);
            vm.deal(DAVE, PAYMENT);
            vm.prank(DAVE);
            vm.expectRevert(IPoolVault.WrongState.selector);
            saleVault.completeFirstoSale{value: PAYMENT}(1, SALE_PRICE, 100, 1);
            assertEq(DAVE.balance, PAYMENT);
        } else {
            vm.deal(DAVE, PAYMENT);
            vm.prank(DAVE);
            saleVault.completeFirstoSale{value: PAYMENT}(1, SALE_PRICE, 100, 1);
            vm.deal(NFT_BUYER, PAYMENT);
            vm.prank(NFT_BUYER);
            vm.expectRevert("nonce invalidated");
            IFirstoSignedAskExchange(FIRSTO).fillSignedAsk{value: PAYMENT}(ask, new bytes(65), NFT_BUYER);
            assertEq(NFT_BUYER.balance, PAYMENT);
        }
        assertEq(FirstoSignedAskMock(FIRSTO).fills(), 1);
        assertEq(sale.saleProceeds(), SALE_PRICE);
        assertEq(sale.saleOutstandingWei(), SALE_PRICE * 99 / 100);
        assertEq(saleVault.isValidSignature(hash, new bytes(65)), bytes4(0xffffffff));
        (,, bool active) = saleVault.nativeFirstoAsk();
        assertFalse(active);
    }

    function test_nativeReceiverCannotChangeSharesOrReenterControlledSale() public {
        _listSale(SALE_PRICE);
        (IFirstoSignedAskExchange.SignedAsk memory ask,) = _ask();
        NativeSaleCallbackBuyer buyer = new NativeSaleCallbackBuyer(saleVault);
        vm.deal(address(this), PAYMENT);
        buyer.buy{value: PAYMENT}(IFirstoSignedAskExchange(FIRSTO), ask);
        assertEq(uint256(buyer.observedState()), uint256(IPoolVault.State.Listed));
        assertFalse(buyer.completeSucceeded());
        assertFalse(buyer.transferSucceeded());
        assertEq(sale.saleBuyer(), address(buyer));
        assertEq(nft.ownerOf(rewardId), address(buyer));
        assertEq(sale.saleProceeds(), SALE_PRICE);
    }

    function test_nativeWrongPayoutAndMissingNonceRevertEntireNftTransfer() public {
        _listSale(SALE_PRICE);
        (IFirstoSignedAskExchange.SignedAsk memory ask, bytes32 hash) = _ask();
        uint256 oldBalance = address(pool).balance;
        uint8[3] memory faults = [uint8(8), uint8(9), uint8(11)];
        for (uint256 i; i < faults.length; ++i) {
            FirstoSignedAskMock(FIRSTO).setFault(faults[i]);
            vm.deal(FIRSTO, SALE_PRICE * 2);
            vm.expectRevert();
            _nativeBuy(NFT_BUYER, ask);
            assertEq(nft.ownerOf(rewardId), address(pool));
            assertEq(nft.getApproved(rewardId), FIRSTO);
            assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
            assertEq(sale.saleProceeds(), 0);
            assertEq(address(pool).balance, oldBalance);
            assertEq(saleVault.isValidSignature(hash, new bytes(65)), bytes4(0x1626ba7e));
            assertFalse(FirstoSignedAskMock(FIRSTO).isSignedAskNonceInvalidated(address(pool), 1));
        }
    }

    function test_unrelatedOrPrematurePaymentCannotCloseTheListing() public {
        _listSale(SALE_PRICE);
        vm.deal(address(this), SALE_PRICE);
        (bool accepted,) = address(pool).call{value: SALE_PRICE}("");
        assertFalse(accepted);
        vm.deal(FIRSTO, SALE_PRICE);
        vm.prank(FIRSTO);
        (accepted,) = address(pool).call{value: SALE_PRICE}("");
        assertFalse(accepted, "NFT must already have transferred and the nonce must be used");
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
        assertEq(nft.ownerOf(rewardId), address(pool));
    }

    function test_expiryDisablesSignatureImmediatelyAndCleanupRevokesOnlyTokenApproval() public {
        _listSale(SALE_PRICE);
        (IFirstoSignedAskExchange.SignedAsk memory ask, bytes32 hash) = _ask();
        vm.warp(ask.expiry);
        assertEq(saleVault.isValidSignature(hash, new bytes(65)), bytes4(0xffffffff));
        vm.expectRevert("expired or schema");
        _nativeBuy(NFT_BUYER, ask);
        sale.cancelExpired();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertEq(nft.getApproved(rewardId), address(0));
        (,, bool active) = saleVault.nativeFirstoAsk();
        assertFalse(active);
        uint256 newId = _listSale(SALE_PRICE);
        assertGt(newId, ask.nonce);
        assertEq(saleVault.isValidSignature(hash, new bytes(65)), bytes4(0xffffffff));
    }

    function test_feeChangeAndPauseDisableNativeAskWithoutPretendingItWasSold() public {
        _listSale(SALE_PRICE);
        (, bytes32 hash) = _ask();
        FirstoSignedAskMock(FIRSTO).setPaused(true);
        assertEq(saleVault.isValidSignature(hash, new bytes(65)), bytes4(0xffffffff));
        FirstoSignedAskMock(FIRSTO).setPaused(false);
        FirstoSignedAskMock(FIRSTO).configure(0x68224F668083c29e9800Be2a646d42d18cedF7e2, 101, 2);
        assertEq(saleVault.isValidSignature(hash, new bytes(65)), bytes4(0xffffffff));
        (,, bool active) = saleVault.nativeFirstoAsk();
        assertFalse(active);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
        assertEq(sale.saleProceeds(), 0);
        vm.expectRevert(IPoolVault.UnverifiedSaleRoute.selector);
        saleVault.enableNativeFirstoSale(1, SALE_PRICE, 101, 2);
    }

    function test_listingClaimFailureRollsBackGovernanceAndApproval() public {
        uint256 id = _passSaleProposal(SALE_PRICE);
        mining.setClaimFault(1);
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        sale.executeSale(id);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertFalse(saleVault.getProposal(id).executed);
        assertEq(nft.getApproved(rewardId), address(0));
    }
}
