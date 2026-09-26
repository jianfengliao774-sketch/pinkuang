// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {ITapeoutMining} from "../../src/interfaces/ITapeoutMining.sol";
import {Addresses} from "../../script/Addresses.sol";
import {MiningStartFixtures} from "../utils/MiningStartFixtures.sol";

interface IRewardsForkVault {
    function deposit(uint8 shares) external payable;
    function sellToPool() external;
    function harvest() external;
    function claim() external;
    function mine(bytes calldata data) external returns (bytes memory);
    function burnExpired(uint32 epoch) external;
    function state() external view returns (IPoolVault.State);
    function claimable(address member) external view returns (uint256);
    function bemAccounted() external view returns (uint256);
    function epochNet(uint32 epoch) external view returns (uint256);
    function epochPaid(uint32 epoch) external view returns (uint256);
    function epochBurned(uint32 epoch) external view returns (uint256);
    function lastClaimAt(address member) external view returns (uint64);
    function expiryEnabled() external view returns (bool);
}

interface IRewardsForkMiningState {
    function armedAt(bytes32 key) external view returns (uint64);
    function stop(bytes32 key) external;
    function STOP_COOLDOWN() external view returns (uint256);
    function cachedDepth(address circuits, uint256 id) external view returns (bool cached, uint32 depth, uint32 live);
    function sampleCountFor(uint32 liveGates, uint32 cycles) external view returns (uint32);
}

/// @notice Production T1c entry points against real BSC NFT, Mining and BEM at a fixed block.
/// @dev Native funding and owner impersonation are local-only; no protocol code/storage or BEM balance is replaced.
contract PoolRewardsForkTest is Test {
    uint256 private constant FORK_BLOCK = 123728000;
    uint256 private constant TOKEN_ID = 16210;
    uint256 private constant TARGET_RAISE = 0.02 ether;
    uint256 private constant PRICE = 0.01 ether;
    address private constant SELLER = 0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744;
    address private constant OWNER = address(0x1111);
    address private constant OPERATOR = address(0x2222);
    address private constant TREASURY = address(0x3333);
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);
    bytes32 private constant LOCAL_ANCHOR_HASH = keccak256("TapeOut T1c local future anchor 123728000");
    IERC721 private constant NFT = IERC721(Addresses.TAPEOUT_CIRCUITS);
    IERC20 private constant BEM = IERC20(Addresses.BEM);
    ITapeoutMining private constant MINING = ITapeoutMining(Addresses.MINING);
    IRewardsForkMiningState private constant MINING_STATE = IRewardsForkMiningState(Addresses.MINING);

    IRewardsForkVault private vault;
    bytes32 private key;

    function setUp() public {
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires pinned BSC fork");
        assertEq(NFT.ownerOf(TOKEN_ID), SELLER);
        key = MINING.minerKey(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        assertEq(MINING.getMiner(key).status, 1);
        PoolTimelock timelock = new PoolTimelock(OWNER);
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        PoolVault implementation = new PoolVault(predictedFactory);
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
            targetRaise: TARGET_RAISE,
            priceCap: PRICE,
            directSeller: SELLER,
            directPrice: PRICE,
            fundingDeadline: uint64(block.timestamp + 1 days),
            purchaseDeadline: uint64(block.timestamp + 2 days)
        });
        vm.prank(OPERATOR);
        vault = IRewardsForkVault(factory.createPool(p));
        _deposit(ALICE, 49);
        _deposit(BOB, 49);
        _deposit(CAROL, 2);
        uint256 sellerBemBefore = BEM.balanceOf(SELLER);
        vm.startPrank(SELLER);
        NFT.approve(address(vault), TOKEN_ID);
        vault.sellToPool();
        vm.stopPrank();
        assertGt(BEM.balanceOf(SELLER), sellerBemBefore, "old rewards settled to seller during real purchase");
        assertEq(BEM.balanceOf(address(vault)), 0);
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
        assertEq(uint256(vault.state()), uint256(IPoolVault.State.Active));
        assertTrue(vault.expiryEnabled());
    }

    function _deposit(address member, uint8 shares) private {
        uint256 contribution = uint256(shares) * (TARGET_RAISE / 100);
        vm.deal(member, member.balance + contribution);
        vm.prank(member);
        vault.deposit{value: contribution}(shares);
    }

    function test_Fork_PermissionlessHarvestPaysOnePercentAndNoBurnAndClaim24HourBoundary() public {
        uint256 sellerBemAfterPurchase = BEM.balanceOf(SELLER);
        uint256 supplyBefore = BEM.totalSupply();
        uint256 treasuryBefore = BEM.balanceOf(TREASURY);
        uint256 deadBefore = BEM.balanceOf(Addresses.BURN_SINK);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(address(0xBEEF));
        vault.harvest();
        uint256 gross = BEM.totalSupply() - supplyBefore;
        assertGt(gross, 0, "real Mining.claim must mint new BEM");
        uint256 fee = gross / 100;
        uint256 burn = 0;
        uint256 net = gross - fee - burn;
        uint32 epoch = uint32(block.timestamp / 1 days);
        assertEq(BEM.balanceOf(TREASURY) - treasuryBefore, fee);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK) - deadBefore, burn);
        assertEq(BEM.balanceOf(address(vault)), net);
        assertEq(vault.bemAccounted(), net);
        assertEq(vault.epochNet(epoch), 0);
        assertEq(vault.epochPaid(epoch), 0);
        assertEq(vault.epochBurned(epoch), 0);
        assertEq(BEM.balanceOf(SELLER), sellerBemAfterPurchase);
        assertEq(MINING.getMiner(key).status, 1);
        assertEq(vault.claimable(ALICE), net * 49 / 100);
        assertEq(vault.claimable(BOB), net * 49 / 100);
        assertEq(vault.claimable(CAROL), net * 2 / 100);

        uint256 firstPayment = vault.claimable(ALICE);
        assertEq(vault.lastClaimAt(ALICE), 0, "first claim has no cooldown");
        uint256 aliceBefore = BEM.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.claim();
        uint256 firstAt = block.timestamp;
        assertEq(BEM.balanceOf(ALICE) - aliceBefore, firstPayment);
        assertEq(vault.epochPaid(epoch), 0);
        assertEq(vault.bemAccounted(), net - firstPayment);
        assertEq(vault.lastClaimAt(ALICE), firstAt);

        vm.warp(firstAt + 1 days - 1);
        vault.harvest();
        assertGt(vault.claimable(ALICE), 0);
        uint256 accountedBeforeBlockedClaim = vault.bemAccounted();
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.ClaimTooSoon.selector);
        vault.claim();
        assertEq(vault.lastClaimAt(ALICE), firstAt);
        assertEq(vault.bemAccounted(), accountedBeforeBlockedClaim);
        assertEq(BEM.balanceOf(ALICE) - aliceBefore, firstPayment);

        vm.warp(firstAt + 1 days);
        vault.harvest();
        uint256 nextPayment = vault.claimable(ALICE);
        vm.prank(ALICE);
        vault.claim();
        assertGt(nextPayment, 0);
        assertEq(BEM.balanceOf(ALICE) - aliceBefore, firstPayment + nextPayment);
        assertEq(vault.lastClaimAt(ALICE), firstAt + 1 days);
        assertEq(vault.claimable(ALICE), 0);
        assertEq(BEM.balanceOf(address(vault)), vault.bemAccounted());
        assertEq(BEM.balanceOf(SELLER), sellerBemAfterPurchase);
        emit log_named_uint("real Mining gross BEM after 3600 seconds (atoms)", gross);
        emit log_named_uint("platform fee BEM (atoms)", fee);
        emit log_named_uint("base burn BEM (atoms)", burn);
        emit log_named_uint("members net BEM (atoms)", net);
    }

    function test_Fork_DirectBemTransferAccountedExactlyOnceAndAllThreeMembersPaid() public {
        uint256 treasuryBefore = BEM.balanceOf(TREASURY);
        uint256 deadBefore = BEM.balanceOf(Addresses.BURN_SINK);
        uint256 supplyBefore = BEM.totalSupply();
        vm.prank(SELLER);
        assertTrue(BEM.transfer(address(vault), 10_000));
        vault.harvest();
        uint32 epoch = uint32(block.timestamp / 1 days);
        assertEq(BEM.totalSupply(), supplyBefore, "same-second donation case needs no fresh Mining issuance");
        assertEq(BEM.balanceOf(TREASURY) - treasuryBefore, 100);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK) - deadBefore, 0);
        assertEq(vault.epochNet(epoch), 0);
        assertEq(vault.bemAccounted(), 9900);
        vault.harvest();
        assertEq(vault.epochNet(epoch), 0);
        assertEq(BEM.balanceOf(TREASURY) - treasuryBefore, 100);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK) - deadBefore, 0);
        address[3] memory members = [ALICE, BOB, CAROL];
        uint256[3] memory expected = [uint256(4851), uint256(4851), uint256(198)];
        for (uint256 i; i < members.length; ++i) {
            assertEq(vault.claimable(members[i]), expected[i]);
            uint256 before = BEM.balanceOf(members[i]);
            vm.prank(members[i]);
            vault.claim();
            assertEq(BEM.balanceOf(members[i]) - before, expected[i]);
        }
        assertEq(vault.epochPaid(epoch), 0);
        assertEq(vault.bemAccounted(), 0);
        assertEq(BEM.balanceOf(address(vault)), 0);
        vault.harvest();
        assertEq(vault.epochNet(epoch), 0);
    }

    function test_Fork_AlreadyClaimedProtocolBemStillHarvestedOnce() public {
        vm.warp(block.timestamp + 1 hours);
        vm.prank(address(0xBEEF));
        MINING.claim(key);
        uint256 alreadyReceived = BEM.balanceOf(address(vault));
        assertGt(alreadyReceived, 0);
        assertEq(vault.bemAccounted(), 0);
        assertEq(MINING.pending(key), 0);
        vault.harvest();
        uint256 net = alreadyReceived - alreadyReceived / 100;
        assertEq(vault.bemAccounted(), net);
        assertEq(vault.epochNet(uint32(block.timestamp / 1 days)), 0);
        vault.harvest();
        assertEq(vault.bemAccounted(), net);
    }

    function test_Fork_RealBemRemainsClaimableAfterYearsAndBurnIsDisabled() public {
        vm.warp(block.timestamp + 1 hours);
        vault.harvest();
        uint256 bobOwed = vault.claimable(BOB);
        uint256 reserved = vault.bemAccounted();
        uint256 deadBefore = BEM.balanceOf(Addresses.BURN_SINK);
        vm.warp(block.timestamp + 30000 days);
        assertEq(vault.claimable(BOB), bobOwed);
        vm.expectRevert(IPoolVault.BurnDisabled.selector);
        vault.burnExpired(0);
        vm.prank(BOB);
        vault.claim();
        assertEq(vault.bemAccounted(), reserved - bobOwed);
        assertEq(BEM.balanceOf(Addresses.BURN_SINK), deadBefore);
    }

    function test_Fork_ProductionMineArmAndStartWithRealProofsAfterExplicitLocalStopSetup() public {
        // SETUP ONLY: the production Vault intentionally has no stop route. Impersonate it
        // on the local fork so arm/start eligibility can be tested after a protocol stop.
        vm.prank(address(vault));
        MINING_STATE.stop(key);
        assertNotEq(MINING.getMiner(key).status, 1);
        uint256 cooldown = MINING_STATE.STOP_COOLDOWN();
        vm.roll(block.number + cooldown + 1);
        vm.warp(block.timestamp + cooldown + 1);
        vm.prank(OPERATOR);
        vault.mine(abi.encodeCall(ITapeoutMining.arm, (Addresses.TAPEOUT_CIRCUITS, TOKEN_ID)));
        uint256 anchor = block.number;
        assertEq(MINING_STATE.armedAt(key), anchor, "production contract caller successfully armed");
        (bool cached,, uint32 live) = MINING_STATE.cachedDepth(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        assertTrue(cached);
        uint32 count = MINING_STATE.sampleCountFor(live, MiningStartFixtures.CYCLES);
        assertEq(count, 32);
        (bytes[] memory inputs, bytes[] memory outputs, bytes32[][] memory proofs) =
            MiningStartFixtures.samples(LOCAL_ANCHOR_HASH, Addresses.TAPEOUT_CIRCUITS, TOKEN_ID, count);
        vm.roll(anchor + 1);
        vm.setBlockhash(anchor, LOCAL_ANCHOR_HASH);
        bytes memory data = abi.encodeCall(
            ITapeoutMining.start,
            (
                Addresses.TAPEOUT_CIRCUITS,
                TOKEN_ID,
                MiningStartFixtures.TASK_ID,
                anchor,
                inputs,
                outputs,
                proofs,
                bytes32(0)
            )
        );
        vm.prank(OPERATOR);
        bytes memory result = vault.mine(data);
        assertEq(abi.decode(result, (bytes32)), key);
        ITapeoutMining.Miner memory miner = MINING.getMiner(key);
        assertEq(miner.status, 1);
        assertEq(miner.taskId, MiningStartFixtures.TASK_ID);
        assertEq(miner.registrant, address(vault));
        assertGt(miner.verifWeight, 0);
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
        emit log_named_uint("real start proof sample count", count);
        emit log_named_uint("real start verified mining weight", miner.verifWeight);
    }

    function test_Fork_ReclaimIneligibleActiveStateBubblesActualProtocolRevert() public {
        bytes memory data = abi.encodeCall(ITapeoutMining.reclaim, (key));
        vm.prank(address(vault));
        (bool ok, bytes memory protocolReason) = Addresses.MINING.call(data);
        assertFalse(ok, "this historical active miner is not an eligible reclaim fixture");
        assertEq(bytes4(protocolReason), bytes4(0x79710317), "observed protocol status rejection changed");
        vm.prank(OPERATOR);
        vm.expectRevert(protocolReason);
        vault.mine(data);
        assertEq(MINING.getMiner(key).status, 1);
        assertEq(NFT.ownerOf(TOKEN_ID), address(vault));
        // This verifies whitelist forwarding + exact failure propagation, NOT successful reclaim.
        emit log_named_bytes("real reclaim state rejection", protocolReason);
    }
}
