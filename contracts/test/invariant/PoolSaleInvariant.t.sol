// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SaleTestBase, ISaleVault} from "../utils/SaleTestBase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @dev Independent BNB oracle starts from raw subscription/refund/purchase amounts.
/// It never obtains liabilities or distribution rates from production accounting getters.
/// Budget burning is covered by the separate router tests; this model retains that reserve.
contract PoolSaleHandler is Test {
    PoolVault public immutable vault;
    ISaleVault public immutable sale;
    IERC721 public immutable nft;
    uint256 public immutable tokenId;
    uint256 public immutable initialBnb;
    uint256 public immutable purchaseTail;
    address[6] public actors;
    uint256[6] public shares;
    uint256[6] public owed;
    uint256[6] public saleEntitlement;
    bool[6] public materialized;
    IPoolVault.State public phase = IPoolVault.State.Active;
    uint256 public price;
    uint256 public deadline;
    uint256 public grossReceived;
    uint256 public reservedBurn;
    uint256 public saleTail;
    uint256 public totalPaid;
    uint256 public forcedBnb;
    uint256 public listings;
    uint256 public cancellations;
    uint256 public completions;
    uint256 public withdrawals;

    constructor(
        PoolVault vault_,
        address nft_,
        uint256 id_,
        address[6] memory actors_,
        uint256 unitPrice,
        uint256 directPrice
    ) {
        vault = vault_;
        sale = ISaleVault(address(vault_));
        nft = IERC721(nft_);
        tokenId = id_;
        actors = actors_;
        shares = [uint256(49), 49, 2, 0, 0, 0];
        uint256 raise = unitPrice * 100;
        uint256 refund = unitPrice * 2;
        uint256 surplus = raise - directPrice;
        uint256 perShare = surplus / 100;
        initialBnb = raise + refund;
        purchaseTail = surplus % 100;
        owed[0] = refund + directPrice + perShare * 49;
        owed[1] = perShare * 49;
        owed[2] = perShare * 2;
    }

    function moveShares(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) public {
        if (phase != IPoolVault.State.Active) return;
        uint256 from = fromSeed % 6;
        uint256 to = toSeed % 6;
        if (from == to || shares[from] == 0 || shares[to] == 49) return;
        uint256 maximum = shares[from] < 49 - shares[to] ? shares[from] : 49 - shares[to];
        uint256 amount = bound(amountSeed, 1, maximum);
        vm.prank(actors[from]);
        assertTrue(vault.transfer(actors[to], amount));
        shares[from] -= amount;
        shares[to] += amount;
        // Purchase surplus belongs to the original funding holders, not the recipients.
    }

    function listSale(uint256 priceSeed) public {
        if (phase != IPoolVault.State.Active) return;
        // Close this model's current holdings before collecting all eligible approvals.
        vm.warp(block.timestamp + 1);
        uint256 proposer;
        while (shares[proposer] == 0) ++proposer;
        price = bound(priceSeed, 0, 20 ether);
        vm.prank(actors[proposer]);
        uint256 id = vault.propose(price, 0, 0);
        for (uint256 i; i < 6; ++i) {
            if (shares[i] == 0) continue;
            vm.prank(actors[i]);
            vault.vote(id, true);
        }
        sale.executeSale(id);
        deadline = block.timestamp + 7 days;
        phase = IPoolVault.State.Listed;
        ++listings;
    }

    function advanceTime(uint256 seed) public {
        vm.warp(block.timestamp + bound(seed, 0, 8 days));
    }

    function cancel() public {
        if (phase != IPoolVault.State.Listed || block.timestamp < deadline) return;
        sale.cancelExpired();
        phase = IPoolVault.State.Active;
        price = 0;
        deadline = 0;
        ++cancellations;
    }

    function complete() public {
        if (phase != IPoolVault.State.Listed || block.timestamp >= deadline) return;
        vm.deal(actors[4], actors[4].balance + price);
        vm.prank(actors[4]);
        sale.completeSale{value: price}();
        uint256 fee = price / 50;
        uint256 memberNet = price - fee * 2;
        uint256 perShare = memberNet / 100;
        grossReceived = price;
        reservedBurn = fee;
        saleTail = memberNet % 100;
        owed[5] += fee; // The treasury is also eligible to own shares in this model.
        for (uint256 i; i < 6; ++i) {
            saleEntitlement[i] = shares[i] * perShare;
            owed[i] += saleEntitlement[i];
        }
        phase = IPoolVault.State.Closed;
        ++completions;
    }

    function withdraw(uint256 actorSeed) public {
        uint256 actor = actorSeed % 6;
        uint256 expected = owed[actor];
        uint256 beforeBalance = actors[actor].balance;
        vm.prank(actors[actor]);
        (bool ok, bytes memory result) = address(vault).call(abi.encodeCall(IPoolVault.withdrawBnb, ()));
        if (expected == 0) {
            assertFalse(ok);
            assertEq(result, abi.encodeWithSelector(IPoolVault.NothingToClaim.selector));
            return;
        }
        assertTrue(ok);
        assertEq(actors[actor].balance - beforeBalance, expected);
        owed[actor] = 0;
        totalPaid += expected;
        if (phase == IPoolVault.State.Closed) materialized[actor] = true;
        ++withdrawals;
    }

    function forceBnb(uint256 seed) public {
        uint256 amount = bound(seed, 0, 1 ether);
        // Simulates native BNB that bypasses receive(); no contract storage is changed.
        vm.deal(address(vault), address(vault).balance + amount);
        forcedBnb += amount;
    }

    function assertIndependentMoneyConservation() external view {
        uint256 liabilities;
        uint256 unsettledSale;
        for (uint256 i; i < 6; ++i) {
            liabilities += owed[i];
            assertEq(vault.bnbOwed(actors[i]), owed[i]);
            assertEq(sale.saleSettled(actors[i]), materialized[i]);
            uint256 pending = materialized[i] ? 0 : saleEntitlement[i];
            assertEq(sale.pendingSaleProceeds(actors[i]), pending);
            unsettledSale += pending;
        }
        assertEq(vault.totalBnbOwed(), liabilities);
        assertEq(sale.saleOutstandingWei(), unsettledSale);
        assertEq(sale.burnBudget(), reservedBurn);
        assertEq(sale.saleRemainder(), saleTail);
        assertEq(vault.surplusRemainder(), purchaseTail);
        assertEq(sale.saleProceeds(), grossReceived);
        assertEq(address(vault).balance, liabilities + purchaseTail + saleTail + reservedBurn + forcedBnb);
        assertEq(address(vault).balance + totalPaid, initialBnb + grossReceived + forcedBnb);
    }

    function assertFrozenOwnershipAndLifecycle() external view {
        assertEq(uint256(vault.state()), uint256(phase));
        uint256 total;
        uint256 members;
        for (uint256 i; i < 6; ++i) {
            total += shares[i];
            if (shares[i] != 0) ++members;
            assertEq(vault.balanceOf(actors[i]), shares[i]);
        }
        assertEq(total, 100);
        assertEq(vault.totalSupply(), 100);
        assertEq(vault.memberCount(), members);
        assertLe(completions, 1);
        assertEq(nft.ownerOf(tokenId), phase == IPoolVault.State.Closed ? actors[4] : address(vault));
        if (phase == IPoolVault.State.Listed) {
            assertEq(sale.expiresAt(), deadline);
            assertEq(sale.salePrice(), price);
        }
    }
}

abstract contract PoolSaleInvariantBase is SaleTestBase {
    PoolSaleHandler internal handler;

    function _setupHandler(bool finishSale) internal {
        _directPoolWithRefund(5 ether + 17);
        _readyForSale();
        address[6] memory actors = [ALICE, BOB, CAROL, DAVE, NFT_BUYER, TREASURY];
        handler = new PoolSaleHandler(saleVault, address(nft), rewardId, actors, UNIT_PRICE, 5 ether + 17);
        handler.withdraw(0); // Old refund, direct-seller debt and purchase surplus are actually paid first.
        handler.moveShares(1, 5, 2);
        handler.moveShares(0, 3, 5);
        handler.moveShares(3, 4, 3); // The final NFT buyer also owns shares.
        handler.listSale(10003);
        handler.advanceTime(7 days);
        handler.cancel();
        handler.listSale(20007);
        handler.forceBnb(17);
        if (finishSale) {
            handler.complete();
            handler.withdraw(4);
        }
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = PoolSaleHandler.moveShares.selector;
        selectors[1] = PoolSaleHandler.listSale.selector;
        selectors[2] = PoolSaleHandler.advanceTime.selector;
        selectors[3] = PoolSaleHandler.cancel.selector;
        selectors[4] = PoolSaleHandler.complete.selector;
        selectors[5] = PoolSaleHandler.withdraw.selector;
        selectors[6] = PoolSaleHandler.forceBnb.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_bnbEqualsIndependentCreditsReservesAndForcedFunds() public view {
        handler.assertIndependentMoneyConservation();
        assertGe(handler.withdrawals(), 1);
        assertGe(handler.cancellations(), 1);
        assertGe(handler.listings(), 2);
    }

    function invariant_ownershipRemainsFrozenAfterAtMostOneCompletedSale() public view {
        handler.assertFrozenOwnershipAndLifecycle();
    }
}

contract PoolSaleLifecycleInvariantTest is PoolSaleInvariantBase {
    function setUp() public override {
        super.setUp();
        _setupHandler(false);
    }
}

contract PoolSaleClosedInvariantTest is PoolSaleInvariantBase {
    function setUp() public override {
        super.setUp();
        _setupHandler(true);
    }
}
