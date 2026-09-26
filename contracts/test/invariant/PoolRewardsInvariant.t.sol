// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RewardsTestBase, RewardsVaultHarness, RewardsFaultBem, IRewardsVault} from "../utils/RewardsTestBase.sol";
import {PurchaseMockMining} from "../utils/PurchaseMocks.sol";

/// @dev Independent, unbounded-history oracle. It stores raw net token units, never production accumulator values.
contract RewardsHandler is Test {
    IRewardsVault public immutable vault;
    RewardsFaultBem public immutable bem;
    PurchaseMockMining public immutable mining;
    address public immutable nft;
    uint256 public immutable tokenId;
    bytes32 public immutable key;
    bool public immutable expiry;
    address[3] public actors;
    uint256[3] public shares = [uint256(49), 49, 2];

    uint32[] public epochs;
    mapping(uint32 => bool) public seenEpoch;
    mapping(uint32 => uint256) public netByEpoch;
    mapping(uint32 => uint256) public paidByEpoch;
    mapping(uint32 => uint256) public burnedByEpoch;
    mapping(uint32 => bool) public burnedFlag;
    mapping(address => mapping(uint32 => uint256)) public memberPaidByEpoch;
    mapping(address => uint256) public paidByMember;
    mapping(address => uint256) public lastPaidAt;

    uint256 public gross;
    uint256 public platform;
    uint256 public baseBurned;
    uint256 public memberNet;
    uint256 public memberPaid;
    uint256 public expiredBurned;
    uint256 public unaccounted;
    uint256 public queuedMining;

    constructor(
        IRewardsVault vault_,
        RewardsFaultBem bem_,
        PurchaseMockMining mining_,
        address nft_,
        uint256 id_,
        address[3] memory actors_,
        bool expiry_
    ) {
        vault = vault_;
        bem = bem_;
        mining = mining_;
        nft = nft_;
        tokenId = id_;
        key = mining_.minerKey(nft_, id_);
        actors = actors_;
        expiry = false;
        expiry_; // Both compatibility factory modes now use permanent rewards.
    }

    function donate(uint96 amountSeed) external {
        uint256 amount = bound(uint256(amountSeed), 0, 1e12);
        bem.mint(address(vault), amount);
        unaccounted += amount;
    }

    function queueMining(uint96 amountSeed) external {
        queuedMining += bound(uint256(amountSeed), 0, 1e12);
        mining.configure(nft, tokenId, 0, queuedMining);
    }

    function externalMiningClaim() external {
        mining.claim(key);
        unaccounted += queuedMining;
        queuedMining = 0;
    }

    function harvest() external {
        vault.harvest();
        _recordHarvest();
    }

    function settle(uint256 actorSeed) external {
        RewardsVaultHarness(payable(address(vault))).settleUser(actors[actorSeed % 3]);
    }

    function advanceTime(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 0, 30 days));
    }

    function claim(uint256 actorSeed) external {
        uint256 actorIndex = actorSeed % 3;
        address actor = actors[actorIndex];
        uint256 newNet = 0; // claim pays booked income only.
        uint256 expected = _claimable(actorIndex, newNet);
        bool tooSoon = lastPaidAt[actor] != 0 && block.timestamp < lastPaidAt[actor] + 1 days;
        uint256 beforeBalance = bem.balanceOf(actor);
        vm.prank(actor);
        (bool success, bytes memory reason) = address(vault).call(abi.encodeCall(IRewardsVault.claim, ()));
        if (tooSoon || expected == 0) {
            assertFalse(success, "a failed/empty claim must not transfer or reset time");
            bytes4 errorSelector = tooSoon ? bytes4(keccak256("ClaimTooSoon()")) : bytes4(keccak256("NothingToClaim()"));
            assertEq(reason, abi.encodeWithSelector(errorSelector));
            assertEq(bem.balanceOf(actor), beforeBalance);
            return;
        }
        assertTrue(success, "valid reward claim failed");
        if (expiry) {
            for (uint256 i; i < epochs.length; ++i) {
                uint32 e = epochs[i];
                if (_expired(e) || burnedFlag[e]) continue;
                uint256 owed = netByEpoch[e] * shares[actorIndex] / 100 - memberPaidByEpoch[actor][e];
                memberPaidByEpoch[actor][e] += owed;
                paidByEpoch[e] += owed;
            }
        }
        memberPaid += expected;
        paidByMember[actor] += expected;
        lastPaidAt[actor] = block.timestamp;
        assertEq(bem.balanceOf(actor) - beforeBalance, expected);
    }

    function burn(uint256 seed) external {
        (bool success, bytes memory reason) =
            address(vault).call(abi.encodeCall(IRewardsVault.burnExpired, (uint32(seed))));
        assertFalse(success);
        assertEq(reason, abi.encodeWithSelector(bytes4(keccak256("BurnDisabled()"))));
    }

    function _recordHarvest() private {
        uint256 amount = unaccounted + queuedMining;
        unaccounted = 0;
        queuedMining = 0;
        if (amount == 0) return;
        uint256 fee = amount / 100;
        uint256 burnAmount = 0;
        uint256 net = amount - fee - burnAmount;
        gross += amount;
        platform += fee;
        baseBurned += burnAmount;
        memberNet += net;
        uint32 e = uint32(block.timestamp / 1 days);
        if (!seenEpoch[e]) {
            seenEpoch[e] = true;
            epochs.push(e);
        }
        netByEpoch[e] += net;
    }

    function _expired(uint32 e) private view returns (bool) {
        return block.timestamp >= (uint256(e) + 8) * 1 days;
    }

    function _claimable(uint256 actorIndex, uint256 newNet) private view returns (uint256 total) {
        address actor = actors[actorIndex];
        if (!expiry) return (memberNet + newNet) * shares[actorIndex] / 100 - paidByMember[actor];
        uint32 current = uint32(block.timestamp / 1 days);
        for (uint256 i; i < epochs.length; ++i) {
            uint32 e = epochs[i];
            if (_expired(e) || burnedFlag[e]) continue;
            uint256 net = netByEpoch[e] + (e == current ? newNet : 0);
            total += net * shares[actorIndex] / 100 - memberPaidByEpoch[actor][e];
        }
        if (!seenEpoch[current]) total += newNet * shares[actorIndex] / 100;
    }

    function expectedClaimable(uint256 actorIndex) external view returns (uint256) {
        return _claimable(actorIndex, 0);
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    function liabilityCategories() external view returns (uint256 live, uint256 expired, uint256 dust) {
        if (!expiry) {
            uint256 entitlement;
            for (uint256 i; i < 3; ++i) {
                uint256 amount = memberNet * shares[i] / 100;
                entitlement += amount;
                live += amount - paidByMember[actors[i]];
            }
            dust = memberNet - entitlement;
            return (live, 0, dust);
        }
        for (uint256 j; j < epochs.length; ++j) {
            uint32 e = epochs[j];
            if (burnedFlag[e]) continue;
            uint256 entitlement;
            uint256 unpaid;
            for (uint256 i; i < 3; ++i) {
                uint256 amount = netByEpoch[e] * shares[i] / 100;
                entitlement += amount;
                unpaid += amount - memberPaidByEpoch[actors[i]][e];
            }
            dust += netByEpoch[e] - entitlement;
            if (_expired(e)) expired += unpaid;
            else live += unpaid;
        }
    }
}

abstract contract RewardsInvariantBase is RewardsTestBase {
    RewardsHandler internal handler;

    function _targetRewards(bool enabled) internal {
        address[3] memory actors = [ALICE, BOB, CAROL];
        handler = new RewardsHandler(rewards, bem, mining, address(nft), rewardId, actors, enabled);
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = RewardsHandler.donate.selector;
        selectors[1] = RewardsHandler.queueMining.selector;
        selectors[2] = RewardsHandler.externalMiningClaim.selector;
        selectors[3] = RewardsHandler.harvest.selector;
        selectors[4] = RewardsHandler.settle.selector;
        selectors[5] = RewardsHandler.advanceTime.selector;
        selectors[6] = RewardsHandler.claim.selector;
        selectors[7] = RewardsHandler.burn.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_actualBalancesMatchIndependentGrossNetAndLiabilities() public view {
        assertEq(handler.gross(), handler.platform() + handler.baseBurned() + handler.memberNet());
        assertEq(bem.balanceOf(TREASURY), handler.platform());
        assertEq(bem.balanceOf(DEAD), handler.baseBurned() + handler.expiredBurned());
        uint256 accounted = handler.memberNet() - handler.memberPaid() - handler.expiredBurned();
        assertEq(rewards.bemAccounted(), accounted);
        assertEq(bem.balanceOf(address(pool)), accounted + handler.unaccounted());
        assertEq(mining.unreported(key), handler.queuedMining());
        (uint256 live, uint256 expired, uint256 dust) = handler.liabilityCategories();
        assertEq(handler.memberNet(), handler.memberPaid() + live + expired + dust + handler.expiredBurned());
        for (uint256 i; i < 3; ++i) {
            address actor = handler.actors(i);
            assertEq(bem.balanceOf(actor), handler.paidByMember(actor));
            assertEq(rewards.claimable(actor), handler.expectedClaimable(i));
            assertEq(rewards.lastClaimAt(actor), handler.lastPaidAt(actor));
        }
    }

    function invariant_accumulatorAndHistoricalEpochLiabilitiesMatchOracle() public view {
        assertEq(rewards.accBemPerShare(), handler.memberNet() * P / 100);
        if (!handler.expiry()) return;
        for (uint256 i; i < handler.epochCount(); ++i) {
            uint32 e = handler.epochs(i);
            assertEq(rewards.epochNet(e), handler.netByEpoch(e));
            assertEq(rewards.epochPaid(e), handler.paidByEpoch(e));
            assertEq(rewards.epochBurned(e), handler.burnedByEpoch(e));
            assertLe(rewards.epochPaid(e) + rewards.epochBurned(e), rewards.epochNet(e));
        }
    }
}

contract PoolRewardsInvariantTest is RewardsInvariantBase {
    function setUp() public override {
        super.setUp();
        _targetRewards(true);
    }
}

contract PoolRewardsNoExpiryInvariantTest is RewardsInvariantBase {
    function setUp() public override {
        super.setUp();
        _disableExpiryForNewPool();
        _targetRewards(false);
    }
}
