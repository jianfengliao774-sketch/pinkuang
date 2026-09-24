// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase, IFundingVault} from "./FundingTestBase.sol";
import {PurchaseMockBem, PurchaseMockNft, PurchaseMockMining, PurchaseMockMarket} from "./PurchaseMocks.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IRewardsVault {
    function harvest() external;
    function claim() external;
    function burnExpired(uint32 epoch) external;
    function expiryEnabled() external view returns (bool);
    function claimable(address member) external view returns (uint256);
    function accBemPerShare() external view returns (uint256);
    function bemAccounted() external view returns (uint256);
    function epochNet(uint32 epoch) external view returns (uint256);
    function epochPaid(uint32 epoch) external view returns (uint256);
    function epochBurned(uint32 epoch) external view returns (uint256);
    function epochRemainderScaled(uint32 epoch) external view returns (uint256);
    function totalGlobalRemainderScaled() external view returns (uint256);
    function lastClaimAt(address member) external view returns (uint64);
    function rewardSlot(address member, uint8 index)
        external
        view
        returns (uint32 epoch, uint256 amount, uint256 remainder);
    function bemOwed(address member) external view returns (uint256);
}

interface IRewardsFactory {
    function createPoolWithExpiry(IPoolVault.PoolParams calldata params, bool enabled) external returns (address);
}

/// @dev Only compiled with tests. This exposes the production settlement primitive for future share changes.
/// It does not write synthetic balances, reward slots or epoch records.
contract RewardsVaultHarness is PoolVault {
    constructor(address officialFactory_) PoolVault(officialFactory_) {}

    function settleUser(address user) external {
        _settleRewards(user);
    }

    /// @dev Exercises the strict internal harvest primitive, without implementing a sale route.
    function strictHarvest() external nonReentrant returns (uint256 gross, uint256 fee, uint256 burned, uint256 net) {
        return _harvest(true);
    }

    /// @dev Lifecycle fixture only: all funding/acquisition/rewards still use their real entry points.
    /// No reward, ownership or payment storage is changed here. This is not a T1e sale implementation.
    function fixtureSetTerminalState(State terminal) external {
        require(terminal == State.Closed || terminal == State.Refunding, "terminal fixture only");
        require(_vaultStorage().state == State.Active, "fixture requires actual acquisition first");
        _vaultStorage().state = terminal;
    }
}

/// @dev Unit fault injection at the known BEM address, never fork compatibility evidence.
contract RewardsFaultBem is PurchaseMockBem {
    address public rejectedRecipient;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryResult;

    function rejectRecipient(address recipient) external {
        rejectedRecipient = recipient;
    }

    function setTransferReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
        reentryAttempted = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            require(to != rejectedRecipient, "injected BEM transfer failure");
            if (reentryData.length != 0 && !reentryAttempted) {
                reentryAttempted = true;
                (reentrySucceeded, reentryResult) = reentryTarget.call(reentryData);
            }
        }
        super._update(from, to, value);
    }
}

abstract contract RewardsTestBase is FundingTestBase {
    address internal constant REWARD_SELLER = address(0x5E11E2);
    address internal constant DEAD = address(0xdead);
    uint256 internal constant P = 1e36;
    uint96 internal constant REWARD_PRICE = 5 ether;

    IRewardsVault internal rewards;
    RewardsFaultBem internal bem;
    PurchaseMockNft internal nft;
    PurchaseMockMining internal mining;
    PurchaseMockMarket internal market;
    bytes32 internal key;
    uint256 internal rewardId;
    uint32 internal firstEpoch;

    function setUp() public virtual override {
        super.setUp();
        RewardsVaultHarness harness = new RewardsVaultHarness(address(poolFactory));
        bytes memory upgrade = abi.encodeWithSignature("upgradeTo(address)", address(harness));
        bytes32 salt = keccak256("reward-test-harness");
        vm.prank(OWNER);
        timelock.schedule(address(beacon), 0, upgrade, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(beacon), 0, upgrade, bytes32(0), salt);
        vm.warp((block.timestamp / 1 days + 1) * 1 days + 100);
        defaultParams.fundingDeadline = uint64(block.timestamp + 7 days);
        defaultParams.purchaseDeadline = uint64(block.timestamp + 10 days);
        pool = _createPool(defaultParams);

        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new RewardsFaultBem()).code);
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        bem = RewardsFaultBem(Addresses.BEM);
        mining = PurchaseMockMining(payable(Addresses.MINING));
        market = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);
        rewardId = defaultParams.circuitId;
        _activate();
    }

    function _activate() internal {
        nft.mint(REWARD_SELLER, rewardId);
        mining.configure(address(nft), rewardId, 0, 0);
        key = mining.minerKey(address(nft), rewardId);
        _fundPool();
        vm.prank(REWARD_SELLER);
        nft.approve(address(market), rewardId);
        uint256 listing = market.createListing(REWARD_SELLER, address(nft), rewardId, REWARD_PRICE);
        pool.buyFromMarket(listing);
        rewards = IRewardsVault(address(pool));
        firstEpoch = _epoch();
        _stateIs(IPoolVault.State.Active);
        assertEq(bem.balanceOf(address(pool)), 0);
    }

    function _disableExpiryForNewPool() internal {
        IPoolVault.PoolParams memory params = defaultParams;
        params.circuitId = ++rewardId;
        vm.prank(OPERATOR);
        pool = IFundingVault(IRewardsFactory(address(poolFactory)).createPoolWithExpiry(params, false));
        _activate();
        assertFalse(rewards.expiryEnabled());
    }

    function _epoch() internal view returns (uint32) {
        return uint32(block.timestamp / 1 days);
    }

    function _atEpoch(uint32 epoch) internal {
        vm.warp(uint256(epoch) * 1 days + 100);
    }

    function _queueReward(uint256 amount) internal {
        mining.configure(address(nft), rewardId, 0, amount);
    }

    function _harvestReward(uint256 amount) internal {
        _queueReward(amount);
        rewards.harvest();
    }

    function _donate(uint256 amount) internal {
        bem.mint(address(pool), amount);
    }

    function _settle(address user) internal {
        RewardsVaultHarness(payable(address(pool))).settleUser(user);
    }

    function _claim(address user) internal returns (uint256 received) {
        uint256 beforeBalance = bem.balanceOf(user);
        vm.prank(user);
        rewards.claim();
        received = bem.balanceOf(user) - beforeBalance;
    }

    function _expectError(string memory signature) internal {
        vm.expectRevert(bytes4(keccak256(bytes(signature))));
    }
}
