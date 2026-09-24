// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ShareTransferTestBase, IShareTransferVault} from "../utils/ShareTransferTestBase.sol";
import {IFundingVault} from "../utils/FundingTestBase.sol";
import {PurchaseMockMining} from "../utils/PurchaseMocks.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @dev Independent order/payment ledger. All locks and fills go through the real
/// market; the handler never impersonates the market or writes Vault storage.
contract ShareMarketHandler is Test {
    uint256 public constant MAX_ORDERS = 32;
    uint256 private constant OPENING_BNB = 100 ether;
    ShareMarket public immutable market;
    PurchaseMockMining public immutable mining;
    IFundingVault[2] public pools;
    address[7] public actors;

    struct GhostOrder {
        uint256 poolIndex;
        uint256 sellerIndex;
        uint256 originalAmount;
        uint256 remaining;
        uint256 filled;
        uint256 cancelled;
        uint256 price;
        bool active;
    }

    mapping(uint256 => GhostOrder) public orders;
    uint256[7][2] public shares;
    uint256[7][2] public locked;
    uint256[7] public credits;
    uint256[7] public spent;
    uint256[7] public withdrawn;
    uint256 public orderCount;
    uint256 public paidIn;
    uint256 public paidOut;
    uint256 public successfulFills;
    uint256 public successfulCancels;
    uint256 public successfulWithdrawals;
    uint256 public rejectedPayments;
    uint256 public rejectedSettlements;

    constructor(
        ShareMarket market_,
        PurchaseMockMining mining_,
        IFundingVault[2] memory pools_,
        address[7] memory actors_
    ) {
        market = market_;
        mining = mining_;
        pools = pools_;
        actors = actors_;
        for (uint256 p; p < 2; ++p) {
            shares[p][0] = 49;
            shares[p][1] = 49;
            shares[p][2] = 2;
            assertEq(pools[p].treasury(), actors[6]);
        }
        for (uint256 i; i < 7; ++i) {
            vm.deal(actors[i], OPENING_BNB);
        }
    }

    function listOrder(uint256 poolSeed, uint256 sellerSeed, uint256 amountSeed, uint256 priceSeed) external {
        if (orderCount == MAX_ORDERS) return;
        uint256 p = poolSeed % 2;
        uint256 seller = sellerSeed % 7;
        uint256 available = shares[p][seller] - locked[p][seller];
        if (available == 0) return;
        uint256 amount = bound(amountSeed, 1, available);
        uint256 price = priceSeed % 4 == 0 ? 0 : bound(priceSeed, 1, 0.001 ether);
        vm.prank(actors[seller]);
        uint256 id = market.list(address(pools[p]), amount, price);
        assertEq(id, ++orderCount);
        orders[id] = GhostOrder(p, seller, amount, amount, 0, 0, price, true);
        locked[p][seller] += amount;
    }

    function fillOrder(uint256 orderSeed, uint256 buyerSeed, uint256 amountSeed) external {
        uint256 id = _activeId(orderSeed);
        if (id == 0) return;
        GhostOrder storage order = orders[id];
        uint256 buyer = buyerSeed % 7;
        uint256 capacity = buyer == order.sellerIndex ? order.remaining : 49 - shares[order.poolIndex][buyer];
        if (capacity == 0) return;
        if (capacity > order.remaining) capacity = order.remaining;
        uint256 amount = bound(amountSeed, 1, capacity);
        uint256 gross = amount * order.price;
        vm.prank(actors[buyer]);
        market.fill{value: gross}(id, amount);
        order.remaining -= amount;
        order.filled += amount;
        order.active = order.remaining != 0;
        locked[order.poolIndex][order.sellerIndex] -= amount;
        shares[order.poolIndex][order.sellerIndex] -= amount;
        shares[order.poolIndex][buyer] += amount;
        credits[order.sellerIndex] += gross - gross / 100;
        credits[6] += gross / 100;
        spent[buyer] += gross;
        paidIn += gross;
        ++successfulFills;
    }

    function cancelOrder(uint256 orderSeed) external {
        uint256 id = _activeId(orderSeed);
        if (id == 0) return;
        GhostOrder storage order = orders[id];
        vm.prank(actors[order.sellerIndex]);
        market.cancel(id);
        locked[order.poolIndex][order.sellerIndex] -= order.remaining;
        order.cancelled = order.remaining;
        order.remaining = 0;
        order.active = false;
        ++successfulCancels;
    }

    function withdraw(uint256 actorSeed) external {
        uint256 actor = actorSeed % 7;
        uint256 amount = credits[actor];
        if (amount == 0) return;
        uint256 beforeBalance = actors[actor].balance;
        vm.prank(actors[actor]);
        market.withdrawBnb();
        assertEq(actors[actor].balance - beforeBalance, amount);
        credits[actor] = 0;
        withdrawn[actor] += amount;
        paidOut += amount;
        ++successfulWithdrawals;
    }

    function rejectBadPayment(uint256 orderSeed, uint256 buyerSeed) external {
        uint256 id = _activeId(orderSeed);
        if (id == 0) return;
        uint256 buyer = buyerSeed % 7;
        // One share with one wei too much fails even when the order is free.
        _rejectFill(id, buyer, orders[id].price + 1, IShareMarket.PaymentMismatch.selector);
        ++rejectedPayments;
    }

    function rejectMiningFailure(uint256 orderSeed, uint256 buyerSeed) external {
        uint256 id = _activeId(orderSeed);
        if (id == 0) return;
        mining.setClaimFault(1);
        // This fails after Market has updated remaining/credit and Vault has
        // released the order's lock, exercising the entire atomic rollback.
        _rejectFill(id, buyerSeed % 7, orders[id].price, IPoolVault.FinalRewardSettlementFailed.selector);
        mining.setClaimFault(0);
        ++rejectedSettlements;
    }

    function _rejectFill(uint256 id, uint256 buyer, uint256 value, bytes4 expected) private {
        bytes32 beforeState = _systemDigest();
        vm.prank(actors[buyer]);
        (bool success, bytes memory reason) = address(market).call{value: value}(abi.encodeCall(market.fill, (id, 1)));
        assertFalse(success);
        assertEq(reason, abi.encodeWithSelector(expected));
        assertEq(_systemDigest(), beforeState, "failed fill changed orders, balances, locks, liabilities or members");
    }

    function _activeId(uint256 seed) private view returns (uint256) {
        if (orderCount == 0) return 0;
        uint256 start = seed % orderCount;
        for (uint256 i; i < orderCount; ++i) {
            uint256 id = (start + i) % orderCount + 1;
            if (orders[id].active) return id;
        }
        return 0;
    }

    function _systemDigest() private view returns (bytes32 digest) {
        digest = keccak256(
            abi.encode(market.nextOrderId(), market.totalBnbOwed(), address(market).balance, mining.claimCalls())
        );
        for (uint256 id = 1; id <= orderCount; ++id) {
            digest = keccak256(abi.encode(digest, market.orders(id)));
        }
        for (uint256 a; a < 7; ++a) {
            digest = keccak256(abi.encode(digest, actors[a].balance, market.bnbOwed(actors[a])));
        }
        for (uint256 p; p < 2; ++p) {
            IFundingVault vault = pools[p];
            digest = keccak256(abi.encode(digest, vault.totalSupply(), vault.activeMembers(), vault.totalBnbOwed()));
            for (uint256 a; a < 7; ++a) {
                digest = keccak256(
                    abi.encode(
                        digest,
                        vault.balanceOf(actors[a]),
                        IShareTransferVault(address(vault)).lockedShares(actors[a]),
                        vault.bnbOwed(actors[a])
                    )
                );
            }
        }
    }

    function assertOrdersAndLocks() external view {
        uint256[7][2] memory orderLocks;
        assertEq(market.nextOrderId(), orderCount + 1);
        for (uint256 id = 1; id <= orderCount; ++id) {
            GhostOrder storage expected = orders[id];
            IShareMarket.Order memory actual = market.orders(id);
            assertEq(actual.pool, address(pools[expected.poolIndex]));
            assertEq(actual.seller, actors[expected.sellerIndex]);
            assertEq(actual.remaining, expected.remaining);
            assertEq(actual.pricePerUnit, expected.price);
            assertEq(actual.active, expected.active);
            assertEq(expected.originalAmount, expected.remaining + expected.filled + expected.cancelled);
            assertEq(actual.active, actual.remaining > 0);
            orderLocks[expected.poolIndex][expected.sellerIndex] += actual.remaining;
        }
        for (uint256 p; p < 2; ++p) {
            uint256 supply;
            uint256 count;
            IFundingVault vault = pools[p];
            for (uint256 a; a < 7; ++a) {
                uint256 balance = vault.balanceOf(actors[a]);
                assertEq(balance, shares[p][a]);
                assertEq(vault.shareOf(actors[a]), balance);
                assertLe(balance, 49);
                assertEq(IShareTransferVault(address(vault)).lockedShares(actors[a]), orderLocks[p][a]);
                assertEq(orderLocks[p][a], locked[p][a]);
                assertLe(locked[p][a], balance);
                supply += balance;
                if (balance != 0) ++count;
            }
            assertEq(supply, 100);
            assertEq(vault.totalSupply(), 100);
            assertEq(vault.memberCount(), count);
            assertEq(vault.balanceOf(address(market)), 0);
            address[] memory members = vault.activeMembers();
            assertEq(members.length, count);
            for (uint256 i; i < members.length; ++i) {
                assertTrue(members[i] != address(market));
                assertGt(vault.balanceOf(members[i]), 0);
                for (uint256 j; j < i; ++j) {
                    assertTrue(members[i] != members[j]);
                }
            }
        }
    }

    function assertBnbConservation() external view {
        uint256 totalCredits;
        uint256 totalSpent;
        uint256 totalWithdrawn;
        for (uint256 a; a < 7; ++a) {
            assertEq(market.bnbOwed(actors[a]), credits[a]);
            totalCredits += credits[a];
            totalSpent += spent[a];
            totalWithdrawn += withdrawn[a];
            assertEq(actors[a].balance, OPENING_BNB - spent[a] + withdrawn[a]);
        }
        assertEq(totalSpent, paidIn);
        assertEq(totalWithdrawn, paidOut);
        assertEq(market.totalBnbOwed(), totalCredits);
        assertEq(totalCredits + paidOut, paidIn);
        assertGe(address(market).balance, totalCredits);
        // This handler does not force-send BNB, so the stronger equality also holds.
        assertEq(address(market).balance, totalCredits);
        assertEq(market.bnbOwed(address(this)), 0);
    }
}

contract ShareMarketInvariantTest is ShareTransferTestBase {
    ShareMarketHandler internal handler;

    function setUp() public override {
        super.setUp();
        IFundingVault first = pool;
        _disableExpiryForNewPool(); // A second independently purchased NFT, using the same registered market.
        IFundingVault[2] memory pools = [first, pool];
        address[7] memory actors = [ALICE, BOB, CAROL, DAVE, ERIN, FRANK, TREASURY];
        handler = new ShareMarketHandler(shareMarket, mining, pools, actors);

        // Start with both pools, multiple sellers/orders, free and paid partial
        // fills, a treasury-as-seller, a withdrawal and both rejected-fill paths.
        handler.listOrder(0, 0, 12, 10001);
        handler.listOrder(0, 1, 20, 0);
        handler.listOrder(1, 0, 16, 99);
        handler.listOrder(1, 2, 2, 100000000000001);
        handler.fillOrder(0, 3, 5);
        handler.fillOrder(1, 6, 7);
        handler.listOrder(0, 6, 7, 133);
        handler.fillOrder(4, 4, 2);
        handler.withdraw(6);
        handler.rejectBadPayment(0, 3);
        handler.rejectMiningFailure(0, 3);
        handler.cancelOrder(3);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = ShareMarketHandler.listOrder.selector;
        selectors[1] = ShareMarketHandler.fillOrder.selector;
        selectors[2] = ShareMarketHandler.cancelOrder.selector;
        selectors[3] = ShareMarketHandler.withdraw.selector;
        selectors[4] = ShareMarketHandler.rejectBadPayment.selector;
        selectors[5] = ShareMarketHandler.rejectMiningFailure.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_realOrdersLockExactlyTheirRemainingBeneficialShares() public view {
        handler.assertOrdersAndLocks();
    }

    function invariant_paidBnbEqualsIndependentCreditsAndWithdrawals() public view {
        handler.assertBnbConservation();
        assertGe(handler.orderCount(), 5);
        assertGe(handler.successfulFills(), 3);
        assertGe(handler.successfulCancels(), 1);
        assertGe(handler.successfulWithdrawals(), 1);
        assertGe(handler.rejectedPayments(), 1);
        assertGe(handler.rejectedSettlements(), 1);
    }
}
