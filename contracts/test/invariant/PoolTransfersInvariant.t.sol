// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ShareTransferTestBase, IShareTransferVault} from "../utils/ShareTransferTestBase.sol";
import {IFundingVault} from "../utils/FundingTestBase.sol";
import {IRewardsVault, RewardsFaultBem} from "../utils/RewardsTestBase.sol";
import {PurchaseMockMining} from "../utils/PurchaseMocks.sol";

/// @dev Records original token units times the shares held at each harvest, in hundredths of a token unit.
/// No production accumulator, reward debt, checkpoints or ring slots are used by this oracle.
contract ShareTransferHandler is Test {
    IFundingVault public immutable pool;
    IRewardsVault public immutable rewards;
    RewardsFaultBem public immutable bem;
    PurchaseMockMining public immutable mining;
    address public immutable market;
    address public immutable nft;
    uint256 public immutable tokenId;
    bool public immutable expiry;
    address[6] public actors;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public locked;
    uint32[] public epochs;
    mapping(uint32 => bool) public known;
    mapping(uint32 => uint256) public netByEpoch;
    mapping(uint32 => uint256) public paidByEpoch;
    mapping(uint32 => bool) public wasBurned;
    mapping(uint32 => uint256) public burnedByEpoch;
    mapping(address => mapping(uint32 => uint256)) public earnedHundredths;
    mapping(address => mapping(uint32 => uint256)) public paidInEpoch;
    mapping(address => uint256) public globalHundredths;
    mapping(address => uint256) public paid;
    mapping(address => uint256) public lastPaid;
    uint256 public unaccounted;
    uint256 public queued;
    uint256 public gross;
    uint256 public fees;
    uint256 public baseBurned;
    uint256 public memberNet;
    uint256 public memberPaid;
    uint256 public expiryBurned;

    constructor(
        IFundingVault pool_,
        RewardsFaultBem bem_,
        PurchaseMockMining mining_,
        address market_,
        address nft_,
        uint256 id_,
        address[6] memory actors_,
        bool expiry_
    ) {
        pool = pool_;
        rewards = IRewardsVault(address(pool_));
        bem = bem_;
        mining = mining_;
        market = market_;
        nft = nft_;
        tokenId = id_;
        actors = actors_;
        expiry = false;
        expiry_; // Both compatibility factory modes now use permanent rewards.
        shares[actors_[0]] = 49;
        shares[actors_[1]] = 49;
        shares[actors_[2]] = 2;
    }

    function donate(uint96 seed) external {
        uint256 amount = bound(uint256(seed), 0, 1e12);
        bem.mint(address(pool), amount);
        unaccounted += amount;
    }

    function queueMining(uint96 seed) external {
        queued += bound(uint256(seed), 0, 1e12);
        mining.configure(nft, tokenId, 0, queued);
    }

    function harvest() external {
        rewards.harvest();
        _recordHarvest();
    }

    function advanceTime(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 0, 15 days));
    }

    function changeLock(uint256 actorSeed, uint256 amountSeed, bool release) external {
        address actor = actors[actorSeed % 6];
        uint256 available = release ? locked[actor] : shares[actor] - locked[actor];
        if (available == 0) return;
        uint256 amount = bound(amountSeed, 1, available);
        vm.prank(market);
        if (release) IShareTransferVault(address(pool)).unlock(actor, amount);
        else IShareTransferVault(address(pool)).lock(actor, amount);
        if (release) locked[actor] -= amount;
        else locked[actor] += amount;
    }

    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 amountSeed, bool viaAllowance) external {
        address seller = actors[fromSeed % 6];
        address buyer = actors[toSeed % 6];
        if (seller == buyer) return;
        uint256 available = shares[seller] - locked[seller];
        uint256 capacity = 49 - shares[buyer];
        if (available == 0 || capacity == 0) return;
        if (available > capacity) available = capacity;
        uint256 amount = bound(amountSeed, 1, available);
        if (viaAllowance) {
            vm.prank(seller);
            pool.approve(address(this), amount);
            pool.transferFrom(seller, buyer, amount);
        } else {
            vm.prank(seller);
            pool.transfer(buyer, amount);
        }
        _recordHarvest(); // The oracle still holds the OLD balances here.
        shares[seller] -= amount;
        shares[buyer] += amount;
    }

    function transferLocked(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        address seller = actors[fromSeed % 6];
        address buyer = actors[toSeed % 6];
        if (seller == buyer) return;
        uint256 available = locked[seller];
        uint256 capacity = 49 - shares[buyer];
        if (available == 0 || capacity == 0) return;
        if (available > capacity) available = capacity;
        uint256 amount = bound(amountSeed, 1, available);
        vm.prank(market);
        IShareTransferVault(address(pool)).transferLocked(seller, buyer, amount);
        _recordHarvest();
        locked[seller] -= amount;
        shares[seller] -= amount;
        shares[buyer] += amount;
    }

    function claim(uint256 actorSeed) external {
        address actor = actors[actorSeed % 6];
        uint256 newNet = 0; // claim pays booked income only.
        uint256 expected = _claimable(actor, newNet);
        bool tooSoon = lastPaid[actor] != 0 && block.timestamp < lastPaid[actor] + 1 days;
        uint256 beforeBalance = bem.balanceOf(actor);
        vm.prank(actor);
        (bool success, bytes memory reason) = address(rewards).call(abi.encodeCall(IRewardsVault.claim, ()));
        if (tooSoon || expected == 0) {
            assertFalse(success);
            bytes4 errorSelector = tooSoon ? bytes4(keccak256("ClaimTooSoon()")) : bytes4(keccak256("NothingToClaim()"));
            assertEq(reason, abi.encodeWithSelector(errorSelector));
            return;
        }
        assertTrue(success);
        if (expiry) {
            for (uint256 i; i < epochs.length; ++i) {
                uint32 e = epochs[i];
                if (_expired(e) || wasBurned[e]) continue;
                uint256 amount = earnedHundredths[actor][e] / 100 - paidInEpoch[actor][e];
                paidInEpoch[actor][e] += amount;
                paidByEpoch[e] += amount;
            }
        }
        paid[actor] += expected;
        memberPaid += expected;
        lastPaid[actor] = block.timestamp;
        assertEq(bem.balanceOf(actor) - beforeBalance, expected);
    }

    function burn(uint256 seed) external {
        (bool success, bytes memory reason) =
            address(rewards).call(abi.encodeCall(IRewardsVault.burnExpired, (uint32(seed))));
        assertFalse(success);
        assertEq(reason, abi.encodeWithSelector(bytes4(keccak256("BurnDisabled()"))));
    }

    function _recordHarvest() private {
        uint256 amount = unaccounted + queued;
        unaccounted = 0;
        queued = 0;
        if (amount == 0) return;
        uint256 fee = amount / 100;
        uint256 burnAmount = 0;
        uint256 net = amount - fee - burnAmount;
        gross += amount;
        fees += fee;
        baseBurned += burnAmount;
        memberNet += net;
        uint32 e = uint32(block.timestamp / 1 days);
        if (!known[e]) {
            known[e] = true;
            epochs.push(e);
        }
        netByEpoch[e] += net;
        for (uint256 i; i < 6; ++i) {
            address actor = actors[i];
            uint256 rawEntitlement = net * shares[actor];
            earnedHundredths[actor][e] += rawEntitlement;
            globalHundredths[actor] += rawEntitlement;
        }
    }

    function _expired(uint32 e) private view returns (bool) {
        return block.timestamp >= (uint256(e) + 8) * 1 days;
    }

    function _claimable(address actor, uint256 newNet) private view returns (uint256 total) {
        if (!expiry) return (globalHundredths[actor] + newNet * shares[actor]) / 100 - paid[actor];
        uint32 current = uint32(block.timestamp / 1 days);
        for (uint256 i; i < epochs.length; ++i) {
            uint32 e = epochs[i];
            if (_expired(e) || wasBurned[e]) continue;
            uint256 raw = earnedHundredths[actor][e] + (e == current ? newNet * shares[actor] : 0);
            total += raw / 100 - paidInEpoch[actor][e];
        }
        if (!known[current]) total += newNet * shares[actor] / 100;
    }

    function expectedClaimable(address actor) external view returns (uint256) {
        return _claimable(actor, 0);
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    function liabilityCategories() external view returns (uint256 live, uint256 expired, uint256 dust) {
        if (!expiry) {
            uint256 entitlement;
            for (uint256 i; i < 6; ++i) {
                address actor = actors[i];
                uint256 amount = globalHundredths[actor] / 100;
                entitlement += amount;
                live += amount - paid[actor];
            }
            return (live, 0, memberNet - entitlement);
        }
        for (uint256 j; j < epochs.length; ++j) {
            uint32 e = epochs[j];
            if (wasBurned[e]) continue;
            uint256 entitlement;
            uint256 unpaid;
            for (uint256 i; i < 6; ++i) {
                address actor = actors[i];
                uint256 amount = earnedHundredths[actor][e] / 100;
                entitlement += amount;
                unpaid += amount - paidInEpoch[actor][e];
            }
            dust += netByEpoch[e] - entitlement;
            if (_expired(e)) expired += unpaid;
            else live += unpaid;
        }
    }
}

abstract contract TransfersInvariantBase is ShareTransferTestBase {
    ShareTransferHandler internal handler;

    function _targetTransfers(bool enabled) internal {
        address[6] memory actors = [ALICE, BOB, CAROL, DAVE, ERIN, FRANK];
        handler =
            new ShareTransferHandler(pool, bem, mining, address(shareMarket), address(nft), rewardId, actors, enabled);
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = ShareTransferHandler.donate.selector;
        selectors[1] = ShareTransferHandler.queueMining.selector;
        selectors[2] = ShareTransferHandler.harvest.selector;
        selectors[3] = ShareTransferHandler.advanceTime.selector;
        selectors[4] = ShareTransferHandler.changeLock.selector;
        selectors[5] = ShareTransferHandler.transferShares.selector;
        selectors[6] = ShareTransferHandler.transferLocked.selector;
        selectors[7] = ShareTransferHandler.claim.selector;
        selectors[8] = ShareTransferHandler.burn.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_effectiveSharesLocksAndOriginalPurchaseSurplusRemainCorrect() public view {
        uint256 supply;
        uint256 members;
        for (uint256 i; i < 6; ++i) {
            address actor = handler.actors(i);
            uint256 balance = handler.shares(actor);
            assertEq(pool.balanceOf(actor), balance);
            assertEq(pool.shareOf(actor), balance);
            assertEq(_shareVault().lockedShares(actor), handler.locked(actor));
            assertLe(handler.locked(actor), balance);
            assertLe(balance, 49);
            supply += balance;
            if (balance != 0) ++members;
            uint256 originalSurplus = i < 2 ? 0.735 ether : i == 2 ? 0.03 ether : 0;
            assertEq(pool.bnbOwed(actor), originalSurplus);
        }
        assertEq(supply, 100);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.memberCount(), members);
        assertEq(pool.balanceOf(address(shareMarket)), 0);
        assertEq(pool.totalBnbOwed(), 1.5 ether);
        address[] memory list = pool.activeMembers();
        assertEq(list.length, members);
        for (uint256 i; i < list.length; ++i) {
            assertGt(handler.shares(list[i]), 0);
            for (uint256 j; j < i; ++j) {
                assertTrue(list[i] != list[j]);
            }
        }
    }

    function invariant_rawIncomeAndHistoricalHoldingsConserveEveryBemUnit() public view {
        assertEq(handler.gross(), handler.fees() + handler.baseBurned() + handler.memberNet());
        assertEq(bem.balanceOf(TREASURY), handler.fees());
        assertEq(bem.balanceOf(DEAD), handler.baseBurned() + handler.expiryBurned());
        (uint256 live, uint256 expired, uint256 dust) = handler.liabilityCategories();
        assertEq(handler.memberNet(), handler.memberPaid() + live + expired + dust + handler.expiryBurned());
        uint256 accounted = handler.memberNet() - handler.memberPaid() - handler.expiryBurned();
        assertEq(rewards.bemAccounted(), accounted);
        assertEq(bem.balanceOf(address(pool)), accounted + handler.unaccounted());
        for (uint256 i; i < 6; ++i) {
            address actor = handler.actors(i);
            assertEq(rewards.claimable(actor), handler.expectedClaimable(actor));
            assertEq(bem.balanceOf(actor), handler.paid(actor));
            assertEq(rewards.lastClaimAt(actor), handler.lastPaid(actor));
        }
        if (handler.expiry()) {
            for (uint256 i; i < handler.epochCount(); ++i) {
                uint32 e = handler.epochs(i);
                assertEq(rewards.epochNet(e), handler.netByEpoch(e));
                assertEq(rewards.epochPaid(e), handler.paidByEpoch(e));
                assertEq(rewards.epochBurned(e), handler.burnedByEpoch(e));
            }
        }
    }
}

contract PoolTransfersInvariantTest is TransfersInvariantBase {
    function setUp() public override {
        super.setUp();
        _targetTransfers(true);
    }
}

contract PoolTransfersNoExpiryInvariantTest is TransfersInvariantBase {
    function setUp() public override {
        super.setUp();
        _disableExpiryForNewPool();
        _targetTransfers(false);
    }
}
