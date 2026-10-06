// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TransferableBemRewards} from "../../src/libraries/TransferableBemRewards.sol";

contract TransferableBemRewardsHarness {
    using TransferableBemRewards for TransferableBemRewards.Ledger;

    TransferableBemRewards.Ledger private rewards;
    mapping(address => uint256) public shares;
    uint256 public supply;

    function mint(address holder, uint256 amount) external {
        require(supply + amount <= 100, "overfunded");
        shares[holder] += amount;
        supply += amount;
    }

    function receiveBem(uint256 amount) external returns (uint256) {
        require(supply == 100, "not fully funded");
        return rewards.record(amount);
    }

    function move(address from, address to, uint256 amount) external returns (uint256 moved) {
        moved = rewards.move(from, to, shares[from], shares[to], amount);
        if (from != to) {
            shares[from] -= amount;
            shares[to] += amount;
        }
    }

    function claim(address holder) external returns (uint256) {
        return rewards.take(holder, shares[holder]);
    }

    function claimable(address holder) external view returns (uint256) {
        return rewards.claimable(holder, shares[holder]);
    }

    function received() external view returns (uint256) {
        return rewards.totalReceived;
    }

    function claimed() external view returns (uint256) {
        return rewards.totalClaimed;
    }

    function remainder() external view returns (uint256) {
        return rewards.remainder;
    }
}

contract TransferableBemRewardsTest is Test {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    TransferableBemRewardsHarness private ledger;

    function setUp() public {
        ledger = new TransferableBemRewardsHarness();
    }

    function test_unclaimedIncomeFollowsAllTransferredShares() public {
        ledger.mint(ALICE, 100);
        ledger.receiveBem(1_000);
        assertEq(ledger.move(ALICE, BOB, 100), 1_000);
        assertEq(ledger.claimable(ALICE), 0);
        assertEq(ledger.claimable(BOB), 1_000);
        assertEq(ledger.claim(BOB), 1_000);
        assertEq(ledger.claim(BOB), 0, "one claim clears the entire project balance");
    }

    function test_manualClaimBeforeTransferDoesNotPayBuyerTwice() public {
        ledger.mint(ALICE, 100);
        ledger.receiveBem(1_000);
        assertEq(ledger.claim(ALICE), 1_000);
        assertEq(ledger.move(ALICE, BOB, 40), 0);
        assertEq(ledger.claimable(BOB), 0);
        ledger.receiveBem(500);
        assertEq(ledger.claimable(ALICE), 300);
        assertEq(ledger.claimable(BOB), 200);
    }

    function test_oneWalletCombinesRewardsFromMultipleReceivedShareLots() public {
        ledger.mint(ALICE, 60);
        ledger.mint(BOB, 40);
        ledger.receiveBem(1_000);
        assertEq(ledger.move(ALICE, BOB, 20), 200);
        ledger.receiveBem(1_000);
        assertEq(ledger.claimable(ALICE), 800);
        assertEq(ledger.claimable(BOB), 1_200);
        assertEq(ledger.claim(BOB), 1_200, "one claim combines existing and acquired shares");
        assertEq(ledger.claim(ALICE), 800);
        assertEq(ledger.claimed(), 2_000);
    }

    function test_mixedClaimedAndUnclaimedSharesMoveOnlyTheirRemainingEntitlement() public {
        ledger.mint(ALICE, 50);
        ledger.mint(BOB, 50);
        ledger.receiveBem(1_000);
        assertEq(ledger.claim(ALICE), 500);
        assertEq(ledger.move(BOB, ALICE, 20), 200);
        ledger.receiveBem(1_000);
        assertEq(ledger.claimable(ALICE), 900);
        assertEq(ledger.claimable(BOB), 600);
        assertEq(ledger.claim(ALICE) + ledger.claim(BOB) + 500, 2_000);
    }

    function test_roundingStaysInProjectUntilEnoughNewBemArrives() public {
        ledger.mint(ALICE, 3);
        ledger.mint(BOB, 97);
        assertEq(ledger.receiveBem(99), 0);
        assertEq(ledger.remainder(), 99);
        assertEq(ledger.receiveBem(1), 100);
        assertEq(ledger.move(ALICE, BOB, 1), 1);
        assertEq(ledger.claim(ALICE), 2);
        assertEq(ledger.claim(BOB), 98);
        assertEq(ledger.received(), ledger.claimed() + ledger.remainder());
    }

    function test_selfTransferPreservesEntitlement() public {
        ledger.mint(ALICE, 100);
        ledger.receiveBem(200);
        assertEq(ledger.move(ALICE, ALICE, 15), 0);
        assertEq(ledger.claimable(ALICE), 200);
    }

    function testFuzz_receiptsClaimsAndTransfersConserveEveryAtomicBem(uint256 seed) public {
        address carol = address(0xCA201);
        address[3] memory holders = [ALICE, BOB, carol];
        ledger.mint(ALICE, 40);
        ledger.mint(BOB, 30);
        ledger.mint(carol, 30);
        for (uint256 i; i < 40; ++i) {
            uint256 choice = uint256(keccak256(abi.encode(seed, i))) % 3;
            address actor = holders[uint256(keccak256(abi.encode(seed, i, uint256(1)))) % 3];
            if (choice == 0) {
                ledger.receiveBem(uint256(keccak256(abi.encode(seed, i, uint256(2)))) % 1_000_000);
            } else if (choice == 1) {
                ledger.claim(actor);
            } else {
                address recipient = holders[uint256(keccak256(abi.encode(seed, i, uint256(3)))) % 3];
                uint256 balance = ledger.shares(actor);
                if (balance > 0) {
                    ledger.move(actor, recipient, 1 + uint256(keccak256(abi.encode(seed, i, uint256(4)))) % balance);
                }
            }
            assertEq(
                ledger.received(),
                ledger.claimed() + ledger.claimable(ALICE) + ledger.claimable(BOB) + ledger.claimable(carol)
                    + ledger.remainder(),
                "BEM accounting conservation"
            );
        }
    }
}
