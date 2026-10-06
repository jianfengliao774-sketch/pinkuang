// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {FirstoSignedAskMock} from "../utils/FirstoMocks.sol";
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {PoolVault} from "../../src/PoolVault.sol";

contract FirstoSaleTest is SaleTestBase {
    uint256 private constant PAYMENT = SALE_PRICE + SALE_PRICE / 100;

    function setUp() public override {
        super.setUp();
        FirstoSignedAskMock(FIRSTO).configure(0x68224F668083c29e9800Be2a646d42d18cedF7e2, 100, 1);
    }

    function _buy() private {
        vm.deal(NFT_BUYER, PAYMENT);
        vm.prank(NFT_BUYER);
        saleVault.completeFirstoSale{value: PAYMENT}(1, SALE_PRICE, 100, 1);
    }

    function _assertUnchanged(uint256 oldBalance) private view {
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
        assertEq(nft.ownerOf(rewardId), address(pool));
        assertEq(nft.getApproved(rewardId), FIRSTO);
        assertEq(address(pool).balance, oldBalance);
        assertEq(saleVault.saleProceeds(), 0);
        assertEq(saleVault.saleBuyer(), address(0));
        assertFalse(FirstoSignedAskMock(FIRSTO).isSignedAskNonceInvalidated(address(pool), 1));
        assertEq(saleVault.isValidSignature(bytes32(0), new bytes(65)), bytes4(0xffffffff));
    }

    function test_controlledSaleClaimsBeforeTransferPaysExactGrossAndClearsAuthorization() public {
        _listSale(SALE_PRICE);
        _queueReward(10_000);
        uint256 oldBalance = address(pool).balance;
        uint256 firstoBefore = FIRSTO.balance;
        _buy();
        assertEq(saleVault.controlledFirstoSaleVersion(), 1);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Closed));
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
        assertEq(nft.getApproved(rewardId), address(0));
        assertEq(address(pool).balance, oldBalance + SALE_PRICE);
        assertEq(FIRSTO.balance - firstoBefore, SALE_PRICE / 100);
        assertEq(NFT_BUYER.balance, 0);
        assertEq(saleVault.saleProceeds(), SALE_PRICE);
        assertEq(saleVault.bnbOwed(TREASURY), SALE_PRICE / 100);
        assertEq(saleVault.saleOutstandingWei(), SALE_PRICE * 99 / 100);
        assertEq(mining.pending(key), 0);
        assertEq(bem.balanceOf(TREASURY), 100);
        assertEq(rewards.bemAccounted(), 9900);
        assertEq(bem.balanceOf(NFT_BUYER), 0);
        assertTrue(FirstoSignedAskMock(FIRSTO).isSignedAskNonceInvalidated(address(pool), 1));
        vm.prank(FIRSTO);
        assertEq(saleVault.isValidSignature(bytes32(0), new bytes(65)), bytes4(0xffffffff));
        vm.deal(FIRSTO, SALE_PRICE);
        vm.prank(FIRSTO);
        (bool paid,) = address(pool).call{value: SALE_PRICE}("");
        assertFalse(paid);
    }

    function test_prefundedPredictableExecutorCannotBlockTheSale() public {
        _listSale(SALE_PRICE);
        address predicted = vm.computeCreateAddress(address(pool), vm.getNonce(address(pool)));
        vm.deal(predicted, 1);
        _buy();
        assertEq(predicted.balance, 1, "unrelated forced wei remains untouched");
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Closed));
    }

    function test_externalNativeFillUsesApprovedAskButLegacyDirectEntryRemainsDisabled() public {
        _listSale(SALE_PRICE);
        IFirstoSignedAskExchange.SignedAsk memory ask = IFirstoSignedAskExchange.SignedAsk({
            maker: address(pool),
            collection: address(nft),
            tokenId: rewardId,
            nonce: 1,
            price: uint128(SALE_PRICE),
            expiry: sale.expiresAt(),
            payoutRecipient: address(pool),
            feeBps: 100,
            feeEpoch: 1,
            schemaVersion: 2
        });
        bytes32 orderHash = FirstoSignedAskMock(FIRSTO).hash(ask);
        vm.prank(FIRSTO);
        assertEq(saleVault.isValidSignature(orderHash, new bytes(65)), bytes4(0x1626ba7e));
        vm.deal(NFT_BUYER, PAYMENT);
        vm.prank(NFT_BUYER);
        vm.expectRevert(IPoolVault.UnverifiedSaleRoute.selector);
        saleVault.completeSale{value: SALE_PRICE}();
        vm.deal(NFT_BUYER, PAYMENT);
        vm.prank(NFT_BUYER);
        IFirstoSignedAskExchange(FIRSTO).fillSignedAsk{value: PAYMENT}(ask, new bytes(65), NFT_BUYER);
        assertEq(nft.ownerOf(rewardId), NFT_BUYER);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Closed));
    }

    function test_confirmationPriceProposalFeeAndEpochAreBinding() public {
        _listSale(SALE_PRICE);
        vm.deal(NFT_BUYER, PAYMENT);
        vm.startPrank(NFT_BUYER);
        vm.expectRevert(IPoolVault.InvalidProposal.selector);
        saleVault.completeFirstoSale{value: PAYMENT}(2, SALE_PRICE, 100, 1);
        vm.expectRevert(IPoolVault.PaymentMismatch.selector);
        saleVault.completeFirstoSale{value: PAYMENT}(1, SALE_PRICE - 1, 100, 1);
        vm.expectRevert(IPoolVault.FirstoFeeChanged.selector);
        saleVault.completeFirstoSale{value: PAYMENT}(1, SALE_PRICE, 99, 1);
        vm.expectRevert(IPoolVault.FirstoFeeChanged.selector);
        saleVault.completeFirstoSale{value: PAYMENT}(1, SALE_PRICE, 100, 2);
        vm.expectRevert(IPoolVault.PaymentMismatch.selector);
        saleVault.completeFirstoSale{value: PAYMENT - 1}(1, SALE_PRICE, 100, 1);
        vm.stopPrank();
    }

    function test_claimFailureCannotLeaveSignatureApprovalOrSpendBuyerFunds() public {
        _listSale(SALE_PRICE);
        mining.configure(address(nft), rewardId, 10_000, 0);
        mining.setClaimFault(1);
        uint256 oldBalance = address(pool).balance;
        vm.expectRevert(IPoolVault.FinalRewardSettlementFailed.selector);
        _buy();
        _assertUnchanged(oldBalance);
        assertEq(mining.pending(key), 10_000);
        assertEq(NFT_BUYER.balance, PAYMENT);
    }

    function test_eachExchangeFaultRollsBackNftMiningAccountingValueAndPermit() public {
        _listSale(SALE_PRICE);
        mining.configure(address(nft), rewardId, 10_000, 0);
        uint256 oldBalance = address(pool).balance;
        // Includes missing/wrong owner, forced BNB, changed fees, absent/short/duplicate payment,
        // wrong ERC-1271 hash and a missing source nonce-consumption postcondition.
        for (uint8 fault = 1; fault <= 11; ++fault) {
            FirstoSignedAskMock(FIRSTO).setFault(fault);
            vm.deal(FIRSTO, SALE_PRICE * 2);
            vm.expectRevert();
            _buy();
            _assertUnchanged(oldBalance);
            assertEq(mining.pending(key), 10_000);
            assertEq(rewards.bemAccounted(), 0);
            assertEq(bem.balanceOf(TREASURY), 0);
            assertEq(NFT_BUYER.balance, PAYMENT);
        }
    }

    function test_exchangeCannotReenterAnySecondSale() public {
        _listSale(SALE_PRICE);
        FirstoSignedAskMock(FIRSTO).setReentryTarget(address(pool));
        FirstoSignedAskMock(FIRSTO).setReentry(abi.encodeCall(PoolVault.completeFirstoSale, (1, SALE_PRICE, 100, 1)));
        _buy();
        assertFalse(FirstoSignedAskMock(FIRSTO).reentrySucceeded());
        assertEq(saleVault.saleProceeds(), SALE_PRICE);
    }
}
