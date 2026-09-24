// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {PoolSaleState} from "../../src/PoolSaleState.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {ITapeoutMining} from "../../src/interfaces/ITapeoutMining.sol";
import {Addresses} from "../../script/Addresses.sol";

contract RejectingSaleForkBuyer is IERC721Receiver {
    error RejectedNFT();

    function buy(PoolVault vault) external payable {
        vault.completeSale{value: msg.value}();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert RejectedNFT();
    }
}

/// @notice Complete production sale against real NFT, Mining and BEM at the pinned BSC block.
/// @dev Only native funding, local owner impersonation and time progression are simulated.
/// No protocol code, protocol storage, NFT balances or BEM balances are replaced.
contract PoolSaleForkTest is Test {
    uint256 private constant FORK_BLOCK = 123728000;
    uint256 private constant TOKEN_ID = 16210;
    uint256 private constant RAISE = 0.02 ether;
    uint256 private constant PURCHASE_PRICE = 0.01 ether;
    uint256 private constant SALE_PRICE = 0.1 ether;
    address private constant SELLER = 0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744;
    address private constant OWNER = address(0x1111);
    address private constant OPERATOR = address(0x2222);
    address private constant TREASURY = address(0x3333);
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);
    address private constant BUYER = address(0xB01234);
    address private constant WRONG_OWNER = address(0xBAD01234);
    IERC721 private constant NFT = IERC721(Addresses.TAPEOUT_CIRCUITS);
    IERC20 private constant BEM = IERC20(Addresses.BEM);
    ITapeoutMining private constant MINING = ITapeoutMining(Addresses.MINING);
    bytes32 private constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant HARVEST_TOPIC = keccak256("Harvested(uint256,uint256,uint256,uint256)");
    bytes32 private constant SETTLED_TOPIC =
        keccak256("RewardSettledBeforeTransfer(address,uint256,address,uint256,bytes32)");
    bytes32 private constant COMPLETED_TOPIC = keccak256("SaleCompleted(uint256,uint256,uint256,uint256)");

    struct Balances {
        uint256 supply;
        uint256 vaultBem;
        uint256 treasuryBem;
        uint256 deadBem;
        uint256 vaultBnb;
        uint256 buyerBnb;
        uint256 accounted;
        uint256 epochNet;
    }

    PoolVault private vault;
    bytes32 private key;
    uint256 private sellerBemAfterPurchase;

    function setUp() public {
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires pinned BSC fork");
        assertEq(NFT.ownerOf(TOKEN_ID), SELLER);
        key = MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        assertEq(MINING.getMiner(key).status, 1);
        PoolTimelock timelock = new PoolTimelock(OWNER);
        PoolVault implementation = new PoolVault();
        PoolBeacon beacon = new PoolBeacon(address(implementation), address(timelock));
        PoolFactory factoryImplementation = new PoolFactory();
        PoolFactory factory = PoolFactory(
            address(
                new ERC1967Proxy(
                    address(factoryImplementation),
                    abi.encodeCall(
                        PoolFactory.initialize, (OWNER, OPERATOR, TREASURY, address(timelock), address(beacon))
                    )
                )
            )
        );
        IPoolVault.PoolParams memory p = IPoolVault.PoolParams({
            circuits: Addresses.TAPEOUT_CIRCUITS,
            circuitId: TOKEN_ID,
            targetRaise: RAISE,
            priceCap: PURCHASE_PRICE,
            directSeller: SELLER,
            directPrice: PURCHASE_PRICE,
            fundingDeadline: uint64(block.timestamp + 1 days),
            purchaseDeadline: uint64(block.timestamp + 2 days)
        });
        vm.prank(OPERATOR);
        vault = PoolVault(payable(factory.createPool(p)));
        _deposit(ALICE, 49);
        _deposit(BOB, 49);
        _deposit(CAROL, 2);
        uint256 sellerBefore = BEM.balanceOf(SELLER);
        vm.startPrank(SELLER);
        NFT.approve(address(vault), TOKEN_ID);
        vault.sellToPool();
        vm.stopPrank();
        sellerBemAfterPurchase = BEM.balanceOf(SELLER);
        assertGt(sellerBemAfterPurchase, sellerBefore);
        assertEq(BEM.balanceOf(address(vault)), 0, "original seller retains pre-acquisition rewards");
        assertEq(vault.bnbOwed(SELLER), PURCHASE_PRICE, "keep original seller pull credit through later sale");
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Active));
        vm.deal(BUYER, SALE_PRICE);
    }

    function test_Fork_ProductionSaleSettlesThenTransfersAndPaysOriginalMembers() public {
        uint256 proposalId = _list();
        vault.harvest();
        assertGt(vault.bemAccounted(), 0, "Listed continues mining before the final handover");
        _advanceOneHour();
        Balances memory before = _balances(BUYER);
        uint256 buyerBemBefore = BEM.balanceOf(BUYER);
        vm.recordLogs();
        vm.prank(BUYER);
        vault.completeSale{value: SALE_PRICE}();
        Vm.Log[] memory entries = vm.getRecordedLogs();

        uint256 finalGross = BEM.totalSupply() - before.supply;
        uint256 finalNet = _net(finalGross);
        assertGt(finalGross, 0, "the purchase transaction itself claims new real rewards");
        _assertSaleOrder(entries, finalGross);
        assertEq(BEM.balanceOf(TREASURY) - before.treasuryBem, finalGross / 100);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK) - before.deadBem, finalGross * 4 / 100);
        assertEq(BEM.balanceOf(address(vault)) - before.vaultBem, finalNet);
        assertEq(vault.bemAccounted(), before.accounted + finalNet);
        assertEq(vault.epochNet(uint32(block.timestamp / 1 days)), before.epochNet + finalNet);
        assertEq(BEM.balanceOf(BUYER), buyerBemBefore, "NFT purchase transfers no historical BEM to buyer");
        assertEq(BEM.balanceOf(SELLER), sellerBemAfterPurchase);
        assertEq(NFT.ownerOf(TOKEN_ID), BUYER);
        assertEq(MINING.pending(key), 0);
        assertEq(MINING.getMiner(key).status, 1, "sale never stops the real miner");
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Closed));
        assertEq(vault.saleBuyer(), BUYER);
        assertEq(vault.saleProceeds(), SALE_PRICE);
        assertEq(vault.listedProposalId(), proposalId);
        assertEq(vault.completedAt(), block.timestamp);
        assertEq(address(vault).balance - before.vaultBnb, SALE_PRICE);
        assertEq(before.buyerBnb - BUYER.balance, SALE_PRICE);
        _assertBnbLiabilities();
        _assertOnlyBuyerReceivesFutureRewards();
        _withdrawOriginalRights();
        emit log_named_uint("real final handover gross BEM (atoms)", finalGross);
        emit log_named_uint("real final handover member net BEM (atoms)", finalNet);
        emit log_named_uint("sale member BNB (wei)", SALE_PRICE - 2 * (SALE_PRICE / 50));
        emit log_named_uint("reserved BNB for later BEM burn (wei)", vault.burnBudget());
    }

    function test_Fork_NoApprovalLetsBuyerOrCircuitMarketBypassControlledSale() public {
        _list();
        assertEq(NFT.getApproved(TOKEN_ID), address(0));
        assertFalse(NFT.isApprovedForAll(address(vault), Addresses.CIRCUIT_MARKET));
        vm.prank(BUYER);
        vm.expectRevert();
        NFT.transferFrom(address(vault), BUYER, TOKEN_ID);
        // Even the real market contract's address has no transfer authority.
        vm.prank(Addresses.CIRCUIT_MARKET);
        vm.expectRevert();
        NFT.transferFrom(address(vault), BUYER, TOKEN_ID);
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Listed));
        assertEq(vault.saleBuyer(), address(0));
        assertEq(vault.saleProceeds(), 0);
        assertEq(vault.burnBudget(), 0);
        assertEq(vault.bnbOwed(SELLER), PURCHASE_PRICE);
    }

    function test_Fork_MissingOwnershipRejectsFinalSettlementAndPreservesBuyerPayment() public {
        _list();
        _advanceOneHour();
        // SETUP ONLY: impersonating Vault creates an otherwise unavailable ownership
        // failure. This proves the pre-claim guard, not a Mining.claim protocol revert.
        vm.prank(address(vault));
        NFT.transferFrom(address(vault), WRONG_OWNER, TOKEN_ID);
        Balances memory before = _balances(BUYER);
        vm.prank(BUYER);
        vm.expectRevert(IPoolVault.NotOwnerAfterBuy.selector);
        vault.completeSale{value: SALE_PRICE}();
        _assertSaleRollback(before, BUYER);
        assertEq(NFT.ownerOf(TOKEN_ID), WRONG_OWNER, "failed sale cannot manufacture a handover record");
    }

    function test_Fork_RejectingBuyerRollsBackRealFinalMintAndAllSaleAccounting() public {
        _list();
        _advanceOneHour();
        assertGt(MINING.pending(key), 0);
        RejectingSaleForkBuyer rejector = new RejectingSaleForkBuyer();
        vm.deal(address(this), SALE_PRICE);
        Balances memory before = _balances(address(this));
        vm.expectRevert(RejectingSaleForkBuyer.RejectedNFT.selector);
        rejector.buy{value: SALE_PRICE}(vault);
        _assertSaleRollback(before, address(this));
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
        assertGt(MINING.pending(key), 0, "failed handover rolls back the earlier real protocol claim");
        assertEq(MINING.getMiner(key).status, 1);
        // A successful retry uses the very same listing and still performs final settlement.
        vm.prank(BUYER);
        vault.completeSale{value: SALE_PRICE}();
        assertEq(NFT.ownerOf(TOKEN_ID), BUYER);
        assertEq(vault.saleBuyer(), BUYER);
        assertEq(MINING.pending(key), 0);
    }

    function _deposit(address member, uint8 shares) private {
        uint256 contribution = uint256(shares) * RAISE / 100;
        vm.deal(member, member.balance + contribution);
        vm.prank(member);
        vault.deposit{value: contribution}(shares);
    }

    function _list() private returns (uint256 proposalId) {
        vm.warp(uint256(vault.activatedAt()) + 7 days);
        vm.prank(ALICE);
        proposalId = vault.propose(SALE_PRICE, SALE_PRICE, uint64(block.timestamp));
        PoolSaleState.Proposal memory p = vault.getProposal(proposalId);
        assertEq(p.snapshotTs, block.timestamp - 1);
        assertEq(p.snapshotMemberCount, 3);
        assertEq(p.snapshotTotalShares, 100);
        vm.prank(ALICE);
        vault.vote(proposalId, true);
        assertFalse(vault.proposalPassed(proposalId), "49 shares and one member do not pass");
        vm.prank(BOB);
        vault.vote(proposalId, true);
        assertTrue(vault.proposalPassed(proposalId));
        vault.executeSale(proposalId);
        assertTrue(vault.getProposal(proposalId).executed);
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Listed));
        assertEq(vault.expiresAt(), block.timestamp + 7 days);
        assertEq(MINING.getMiner(key).status, 1);
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
    }

    function _advanceOneHour() private {
        vm.warp(block.timestamp + 1 hours);
        // A different real miner checkpoints the shared emission clock; pending alone is lazy.
        MINING.claim(MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, 400));
    }

    function _balances(address payer) private view returns (Balances memory b) {
        b.supply = BEM.totalSupply();
        b.vaultBem = BEM.balanceOf(address(vault));
        b.treasuryBem = BEM.balanceOf(TREASURY);
        b.deadBem = BEM.balanceOf(Addresses.BURN_SINK);
        b.vaultBnb = address(vault).balance;
        b.buyerBnb = payer.balance;
        b.accounted = vault.bemAccounted();
        b.epochNet = vault.epochNet(uint32(block.timestamp / 1 days));
    }

    function _assertSaleRollback(Balances memory before, address payer) private view {
        assertEq(BEM.totalSupply(), before.supply);
        assertEq(BEM.balanceOf(address(vault)), before.vaultBem);
        assertEq(BEM.balanceOf(TREASURY), before.treasuryBem);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK), before.deadBem);
        assertEq(address(vault).balance, before.vaultBnb);
        assertEq(payer.balance, before.buyerBnb);
        assertEq(vault.bemAccounted(), before.accounted);
        assertEq(vault.epochNet(uint32(block.timestamp / 1 days)), before.epochNet);
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Listed));
        assertEq(vault.saleBuyer(), address(0));
        assertEq(vault.completedAt(), 0);
        assertEq(vault.saleProceeds(), 0);
        assertEq(vault.saleOutstandingWei(), 0);
        assertEq(vault.burnBudget(), 0);
        assertEq(vault.bnbOwed(TREASURY), 0);
        assertEq(vault.bnbOwed(SELLER), PURCHASE_PRICE);
        assertEq(vault.totalBnbOwed(), RAISE);
    }

    function _assertBnbLiabilities() private view {
        uint256 fee = SALE_PRICE / 50;
        uint256 memberNet = SALE_PRICE - 2 * fee;
        assertEq(vault.burnBudget(), fee);
        assertEq(vault.totalBurnBnbSpent(), 0);
        assertEq(vault.totalBurnBem(), 0, "BNB budget is not already-burned BEM");
        assertEq(vault.salePerShareWei(), memberNet / 100);
        assertEq(vault.saleRemainder(), 0);
        assertEq(vault.saleOutstandingWei(), memberNet);
        assertEq(vault.bnbOwed(SELLER), PURCHASE_PRICE);
        assertEq(vault.bnbOwed(TREASURY), fee);
        assertEq(vault.bnbOwed(BUYER), 0);
        assertEq(vault.claimable(BUYER), 0);
        assertEq(vault.totalBnbOwed(), RAISE + memberNet + fee);
        assertEq(address(vault).balance, vault.totalBnbOwed() + vault.burnBudget());
    }

    function _assertOnlyBuyerReceivesFutureRewards() private {
        uint256 oldVaultBem = BEM.balanceOf(address(vault));
        uint256 oldAccounted = vault.bemAccounted();
        uint256 oldAliceClaimable = vault.claimable(ALICE);
        uint256 buyerBefore = BEM.balanceOf(BUYER);
        _advanceOneHour();
        uint256 pending = MINING.pending(key);
        assertGt(pending, 0);
        MINING.claim(key);
        assertGe(BEM.balanceOf(BUYER) - buyerBefore, pending);
        assertEq(MINING.pending(key), 0);
        assertEq(MINING.getMiner(key).status, 1);
        assertEq(BEM.balanceOf(address(vault)), oldVaultBem);
        assertEq(vault.bemAccounted(), oldAccounted);
        assertEq(vault.claimable(ALICE), oldAliceClaimable);
        assertEq(BEM.balanceOf(SELLER), sellerBemAfterPurchase);
        emit log_named_uint("real new-owner future BEM (atoms)", BEM.balanceOf(BUYER) - buyerBefore);
    }

    function _withdrawOriginalRights() private {
        address[3] memory members = [ALICE, BOB, CAROL];
        uint256[3] memory shares = [uint256(49), uint256(49), uint256(2)];
        uint256 net = vault.epochNet(uint32(block.timestamp / 1 days));
        uint256 memberBnb = SALE_PRICE - 2 * (SALE_PRICE / 50);
        uint256 paidBem;
        // The sold NFT's protocol claim must not be called while old members withdraw.
        vm.expectCall(Addresses.MINING, abi.encodeCall(ITapeoutMining.claim, (key)), uint64(0));
        for (uint256 i; i < members.length; ++i) {
            uint256 expectedBem = net * shares[i] / 100;
            uint256 expectedBnb = shares[i] * (RAISE - PURCHASE_PRICE + memberBnb) / 100;
            assertEq(vault.claimable(members[i]), expectedBem);
            assertEq(vault.bnbOwed(members[i]), expectedBnb);
            uint256 bemBefore = BEM.balanceOf(members[i]);
            uint256 bnbBefore = members[i].balance;
            vm.startPrank(members[i]);
            uint256 paid = vault.claim();
            vault.withdrawBnb();
            vm.stopPrank();
            assertEq(paid, expectedBem);
            assertEq(BEM.balanceOf(members[i]) - bemBefore, expectedBem);
            assertEq(members[i].balance - bnbBefore, expectedBnb);
            assertEq(vault.bnbOwed(members[i]), 0);
            assertEq(vault.claimable(members[i]), 0);
            paidBem += paid;
        }
        uint256 sellerBefore = SELLER.balance;
        vm.prank(SELLER);
        vault.withdrawBnb();
        assertEq(SELLER.balance - sellerBefore, PURCHASE_PRICE);
        uint256 treasuryBefore = TREASURY.balance;
        vm.prank(TREASURY);
        vault.withdrawBnb();
        assertEq(TREASURY.balance - treasuryBefore, SALE_PRICE / 50);
        assertEq(vault.totalBnbOwed(), 0);
        assertEq(vault.saleOutstandingWei(), 0);
        assertEq(address(vault).balance, vault.burnBudget());
        assertEq(vault.epochPaid(uint32(block.timestamp / 1 days)), paidBem);
        assertEq(vault.bemAccounted(), net - paidBem);
        assertEq(BEM.balanceOf(address(vault)), net - paidBem, "only member rounding dust remains");
    }

    function _assertSaleOrder(Vm.Log[] memory logs, uint256 finalGross) private view {
        uint256 mintIndex = type(uint256).max;
        uint256 harvestIndex = type(uint256).max;
        uint256 settlementIndex = type(uint256).max;
        uint256 transferIndex = type(uint256).max;
        uint256 completedIndex = type(uint256).max;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (entry.emitter == Addresses.BEM && entry.topics[0] == TRANSFER_TOPIC) {
                if (entry.topics[1] == bytes32(0) && address(uint160(uint256(entry.topics[2]))) == address(vault)) {
                    mintIndex = i;
                    assertEq(abi.decode(entry.data, (uint256)), finalGross);
                }
            } else if (entry.emitter == address(vault) && entry.topics[0] == HARVEST_TOPIC) {
                harvestIndex = i;
                (uint256 gross, uint256 fee, uint256 burned, uint256 net) =
                    abi.decode(entry.data, (uint256, uint256, uint256, uint256));
                assertEq(gross, finalGross);
                assertEq(fee, finalGross / 100);
                assertEq(burned, finalGross * 4 / 100);
                assertEq(net, _net(finalGross));
            } else if (entry.emitter == address(vault) && entry.topics[0] == SETTLED_TOPIC) {
                settlementIndex = i;
                assertEq(address(uint160(uint256(entry.topics[1]))), Addresses.TAPEOUT_CIRCUITS);
                assertEq(uint256(entry.topics[2]), TOKEN_ID);
                (address previousOwner, uint256 amount, bytes32 tradeId) =
                    abi.decode(entry.data, (address, uint256, bytes32));
                assertEq(previousOwner, address(vault));
                assertEq(amount, finalGross);
                assertEq(tradeId, vault.saleTradeId());
            } else if (entry.emitter == address(NFT) && entry.topics[0] == TRANSFER_TOPIC) {
                transferIndex = i;
                assertEq(address(uint160(uint256(entry.topics[1]))), address(vault));
                assertEq(address(uint160(uint256(entry.topics[2]))), BUYER);
                assertEq(uint256(entry.topics[3]), TOKEN_ID);
            } else if (entry.emitter == address(vault) && entry.topics[0] == COMPLETED_TOPIC) {
                completedIndex = i;
                (uint256 gross, uint256 fee, uint256 burnedBem, uint256 net) =
                    abi.decode(entry.data, (uint256, uint256, uint256, uint256));
                assertEq(gross, SALE_PRICE);
                assertEq(fee, SALE_PRICE / 50);
                assertEq(burnedBem, 0);
                assertEq(net, SALE_PRICE - 2 * fee);
            }
        }
        assertLt(mintIndex, harvestIndex, "real claim/mint precedes internal reward accounting");
        assertLt(harvestIndex, settlementIndex, "old-owner rewards are booked before settlement marker");
        assertLt(settlementIndex, transferIndex, "settlement precedes actual NFT Transfer");
        assertLt(transferIndex, completedIndex, "sale finalizes only after the NFT handover");
        assertLt(completedIndex, logs.length, "all required events were observed");
    }

    function _net(uint256 gross) private pure returns (uint256) {
        return gross - gross / 100 - gross * 4 / 100;
    }
}
