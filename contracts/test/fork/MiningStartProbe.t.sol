// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Addresses} from "../../script/Addresses.sol";
import {ProbeHolder} from "../utils/ProbeHolder.sol";
import {MiningStartFixtures} from "../utils/MiningStartFixtures.sol";

interface IStartMining {
    struct Miner {
        address circuits;
        uint64 circuitId;
        uint32 taskId;
        uint32 gateCount;
        uint32 stateCount;
        uint32 depth;
        uint64 area;
        uint32 mult;
        uint64 since;
        uint8 status;
        address registrant;
        uint32 nandBurn;
        uint32 latchBurn;
        uint64 bstar;
        uint64 bonus;
        bool optimal;
        uint64 commitBlock;
        uint64 firstUnusedId;
        uint64 stopBlock;
        uint128 verifWeight;
        uint128 unverWeight;
        uint256 debt;
    }

    function minerKey(address circuits, uint256 tokenId) external view returns (bytes32);
    function getMiner(bytes32 key) external view returns (Miner memory);
    function arm(address circuits, uint256 circuitId) external;
    function armedAt(bytes32 key) external view returns (uint64);
    function stop(bytes32 key) external;
    function STOP_COOLDOWN() external view returns (uint256);
    function cachedDepth(address circuits, uint256 circuitId)
        external
        view
        returns (bool cached, uint32 depth, uint32 live);
    function sampleCountFor(uint32 liveGates, uint32 cycles) external view returns (uint32);
    function start(
        address circuits,
        uint256 circuitId,
        uint32 taskId,
        uint256 anchorBlock,
        bytes[] calldata inputs,
        bytes[] calldata outputs,
        bytes32[][] calldata proofs,
        bytes32 salt
    ) external returns (bytes32);
}

/// @notice Real BSC protocol calls, using only local fork impersonation and block progression.
/// @dev A deterministic LOCAL future blockhash is installed after arm so proofs are reproducible.
/// No target contract code, target storage, or NFT balance is overwritten.
contract MiningStartProbe is Test {
    uint256 internal constant FORK_BLOCK = 123728000;
    uint256 internal constant TOKEN_ID = 16210;
    address internal constant ORIGINAL_OWNER = 0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744;
    bytes32 internal constant LOCAL_ANCHOR_HASH = keccak256("TapeOut T0.2 local future anchor 123728000");
    bytes4 internal constant NOT_OWNER_ERROR = 0xa8ee9629;
    bytes4 internal constant ANCHOR_ERROR = 0x29b3fb30;

    IStartMining internal mining = IStartMining(Addresses.MINING);
    IERC721 internal nft = IERC721(Addresses.TAPEOUT_CIRCUITS);
    ProbeHolder internal holder;
    bytes32 internal key;

    function setUp() public {
        assertEq(block.chainid, 56, "requires a BSC mainnet fork");
        assertEq(block.number, FORK_BLOCK, "fork block is pinned for reproducibility");
        assertEq(nft.ownerOf(TOKEN_ID), ORIGINAL_OWNER, "unexpected historical holder");
        key = mining.minerKey(address(nft), TOKEN_ID);
        assertEq(mining.getMiner(key).status, 1, "fixture must initially be mining");
        holder = new ProbeHolder(address(nft), TOKEN_ID, address(mining), Addresses.CIRCUIT_MARKET, Addresses.BEM);
        vm.prank(ORIGINAL_OWNER);
        nft.safeTransferFrom(ORIGINAL_OWNER, address(holder), TOKEN_ID);
        assertEq(nft.ownerOf(TOKEN_ID), address(holder));
    }

    function _forward(bytes memory data) internal returns (bytes memory) {
        return holder.forward(address(mining), data);
    }

    function _stopAndWait() internal {
        _forward(abi.encodeCall(IStartMining.stop, (key)));
        assertNotEq(mining.getMiner(key).status, 1, "stop must change mining status");
        uint256 cooldown = mining.STOP_COOLDOWN();
        vm.roll(block.number + cooldown + 1);
        vm.warp(block.timestamp + cooldown + 1);
    }

    function _armAndData(uint256 blockDelay) internal returns (bytes memory data) {
        _forward(abi.encodeCall(IStartMining.arm, (address(nft), TOKEN_ID)));
        uint256 anchor = block.number;
        assertEq(mining.armedAt(key), anchor, "arm records its block number");
        (bool cached,, uint32 live) = mining.cachedDepth(address(nft), TOKEN_ID);
        assertTrue(cached);
        uint32 count = mining.sampleCountFor(live, MiningStartFixtures.CYCLES);
        assertEq(count, 32, "historical protocol parameter changed");
        (bytes[] memory inputs, bytes[] memory outputs, bytes32[][] memory proofs) =
            MiningStartFixtures.samples(LOCAL_ANCHOR_HASH, address(nft), TOKEN_ID, count);
        vm.roll(anchor + blockDelay);
        if (blockDelay > 0) vm.setBlockhash(anchor, LOCAL_ANCHOR_HASH);
        data = abi.encodeCall(
            IStartMining.start,
            (address(nft), TOKEN_ID, MiningStartFixtures.TASK_ID, anchor, inputs, outputs, proofs, bytes32(0))
        );
    }

    function _assertStarted(bytes memory data) internal {
        bytes memory result = _forward(data);
        assertEq(abi.decode(result, (bytes32)), key);
        IStartMining.Miner memory miner = mining.getMiner(key);
        assertEq(miner.status, 1);
        assertEq(miner.taskId, MiningStartFixtures.TASK_ID);
        assertEq(miner.registrant, address(holder), "registrant must be contract caller, not tx.origin");
        assertGt(miner.verifWeight, 0);
    }

    function test_Q1_contractHolderArmStartStop_realProofs() public {
        assertTrue(address(holder) != tx.origin);
        _stopAndWait();
        _assertStarted(_armAndData(1));
        _forward(abi.encodeCall(IStartMining.stop, (key)));
        assertNotEq(mining.getMiner(key).status, 1);
    }

    function test_Q1_strangerArmStartStopRevert() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(NOT_OWNER_ERROR);
        mining.arm(address(nft), TOKEN_ID);
        vm.prank(stranger);
        vm.expectRevert(NOT_OWNER_ERROR);
        mining.stop(key);
        _stopAndWait();
        bytes memory data = _armAndData(1);
        vm.prank(stranger);
        (bool ok, bytes memory reason) = address(mining).call(data);
        assertFalse(ok, "stranger cannot submit otherwise valid start proof");
        assertEq(bytes4(reason), NOT_OWNER_ERROR);
        _assertStarted(data);
    }

    function test_Q2_startAtTenBlocks_realProofs() public {
        _stopAndWait();
        _assertStarted(_armAndData(10));
    }

    function test_Q2_startAtElevenBlocks_realProofs() public {
        _stopAndWait();
        _assertStarted(_armAndData(11));
    }

    function test_Q2_startAtSixtyFourBlocks_realProofs() public {
        _stopAndWait();
        _assertStarted(_armAndData(64));
    }

    function test_Q2_startAfterSixtyFourBlocksReverts() public {
        _stopAndWait();
        bytes memory data = _armAndData(65);
        vm.expectRevert(ANCHOR_ERROR);
        _forward(data);
    }

    function test_Q2_startInArmBlockReverts() public {
        _stopAndWait();
        bytes memory data = _armAndData(0);
        vm.expectRevert(ANCHOR_ERROR);
        _forward(data);
    }

    function test_Q2_invalidMerkleProofRejectedThenValidProofAccepted() public {
        _stopAndWait();
        bytes memory data = _armAndData(1);
        // The final byte belongs to the final proof node (salt is in the ABI head).
        data[data.length - 1] ^= bytes1(uint8(1));
        vm.expectRevert();
        _forward(data);
        data[data.length - 1] ^= bytes1(uint8(1));
        _assertStarted(data);
    }

    function test_Q2_stopCooldownDoesNotExpireByTimestampAlone() public {
        _forward(abi.encodeCall(IStartMining.stop, (key)));
        vm.warp(block.timestamp + mining.STOP_COOLDOWN() + 1);
        bytes memory data = _armAndData(1);
        vm.expectRevert();
        _forward(data);
    }

    function test_Q2_stopCooldownRequiresMoreThan1200Blocks_notSeconds() public {
        uint256 timestampBefore = block.timestamp;
        uint256 stopBlock = block.number;
        assertEq(mining.STOP_COOLDOWN(), 1200);
        _forward(abi.encodeCall(IStartMining.stop, (key)));
        vm.roll(stopBlock + 1198);
        bytes memory data = _armAndData(1);
        assertEq(block.number, stopBlock + 1199);
        vm.expectRevert();
        _forward(data);
        data = _armAndData(1);
        assertEq(block.number, stopBlock + 1200);
        vm.expectRevert(bytes4(0x802cdbc8));
        _forward(data);
        data = _armAndData(1);
        assertEq(block.number, stopBlock + 1201);
        _assertStarted(data);
        assertEq(block.timestamp, timestampBefore, "cooldown succeeds without time progression");
    }
}
