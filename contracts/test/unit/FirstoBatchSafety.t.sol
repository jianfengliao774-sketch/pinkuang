// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase} from "../utils/FundingTestBase.sol";
import {FlexiblePurchase} from "../../src/libraries/FlexiblePurchase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IFirstoBatchAskExchange} from "../../src/interfaces/IFirstoExchange.sol";

contract FirstoBudgetEnvelopeHarness {
    function unwrap(bytes calldata data) external pure returns (uint8 kind, bytes memory inner) {
        return FlexiblePurchase.unwrapBudgetFirsto(data);
    }
}

/// @notice Production-candidate tests retain the actual advertised runtime pin.
/// @dev The mismatching observed protocol code must NOT become trusted merely to make a test pass.
contract FirstoBatchSafetyTest is FundingTestBase {
    address private constant EXCHANGE = 0x3F58C9cbce933c76158B2A29B0d612c46546Dc43;
    bytes32 private constant MAGIC = keccak256("BEMine Firsto order envelope v1");
    bytes32 private constant ADVERTISED = 0x0a44a1aa18057cf5345eea9e1c58e4d40b0ff9c3da52c0f6eb8032320e7f23fb;
    bytes32 private constant OBSERVED = 0x84072ba0b149f0cb72a8d1be49797ba293206d931407eeb2a25eeaf9f28db0b0;
    FirstoBudgetEnvelopeHarness private envelope;

    function setUp() public override {
        super.setUp();
        envelope = new FirstoBudgetEnvelopeHarness();
    }

    function test_observedWrongRuntimeRejectsWithoutPaymentOrStateMutation() public {
        vm.chainId(56);
        bytes memory runtime = vm.parseBytes(vm.readFile("test/fixtures/firsto-batch-observed-runtime.hex"));
        assertEq(keccak256(runtime), OBSERVED);
        assertNotEq(OBSERVED, ADVERTISED);
        vm.etch(EXCHANGE, runtime);
        _fundPool();
        // Use a canonical, internally consistent batch order rather than zero-filled
        // bytes that would also fail ordinary decoding/field validation without a gate.
        IFirstoBatchAskExchange.AskLeaf memory leaf = IFirstoBatchAskExchange.AskLeaf(
            address(0x1234),
            defaultParams.circuits,
            defaultParams.circuitId,
            uint128(1 ether),
            address(0x1234),
            100,
            1,
            17,
            0,
            1
        );
        bytes32 root = keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        keccak256(
                            "AskLeaf(address maker,address collection,uint256 tokenId,uint128 price,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint256 batchNonce,uint256 leafIndex,uint16 schemaVersion)"
                        ),
                        leaf
                    )
                )
            )
        );
        IFirstoBatchAskExchange.BatchAsk memory batch = IFirstoBatchAskExchange.BatchAsk(
            leaf.maker, root, leaf.batchNonce, uint64(block.timestamp + 1 days), leaf.payoutRecipient, 100, 1, 1
        );
        bytes memory order = abi.encode(batch, leaf, new bytes32[](0), new bytes(65));
        uint256 before = address(pool).balance;
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        pool.buyFromFirsto(1, order);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funded));
        assertEq(address(pool).balance, before);
        assertEq(EXCHANGE.balance, 0);
        assertEq(PoolVault(payable(address(pool))).purchaseCost(), 0);
    }

    function test_envelopeRoundTripAndLegacyBytesRemainExact() public view {
        bytes memory single = abi.encode(address(0x1234), bytes("legacy"));
        (uint8 kind, bytes memory inner) = envelope.unwrap(single);
        assertEq(kind, 0);
        assertEq(inner, single);
        bytes memory rawBatch = new bytes(704);
        (kind, inner) = envelope.unwrap(abi.encode(MAGIC, uint8(1), rawBatch));
        assertEq(kind, 1);
        assertEq(inner, rawBatch);
    }

    function test_envelopeRejectsWrongKindInnerBoundsAndTrailingBytes() public {
        for (uint8 kind; kind < 3; kind += 2) {
            vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
            envelope.unwrap(abi.encode(MAGIC, kind, new bytes(704)));
        }
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        envelope.unwrap(abi.encode(MAGIC, uint8(1), new bytes(703)));
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        envelope.unwrap(abi.encode(MAGIC, uint8(1), new bytes(2753)));
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        envelope.unwrap(bytes.concat(abi.encode(MAGIC, uint8(1), new bytes(704)), hex"00"));
    }

    function test_envelopeRejectsNoncanonicalOffset() public {
        bytes memory encoded = abi.encode(MAGIC, uint8(1), new bytes(704));
        // Insert a vacant word and point the dynamic payload at it. Decoding alone accepts
        // the equivalent value; the exact re-encoding comparison must reject the extra word.
        bytes memory altered = new bytes(encoded.length + 32);
        for (uint256 i; i < 96; ++i) {
            altered[i] = encoded[i];
        }
        altered[95] = bytes1(uint8(128));
        for (uint256 i = 96; i < encoded.length; ++i) {
            altered[i + 32] = encoded[i];
        }
        vm.expectRevert(IPoolVault.InvalidFirstoOrder.selector);
        envelope.unwrap(altered);
    }
}
