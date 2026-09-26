// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {RewardsVaultHarness} from "../utils/RewardsTestBase.sol";
import {PoolLens} from "../../src/PoolLens.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolSaleState} from "../../src/PoolSaleState.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

/// @dev The claimed getter deliberately attempts storage writes or burns its whole call budget.
contract LensHostileGetter {
    address public immutable factory;
    uint256 public touched;
    bool private immutable exhaust;

    constructor(address factory_, bool exhaust_) {
        factory = factory_;
        exhaust = exhaust_;
    }

    function OFFICIAL_FACTORY() external view returns (address) {
        return factory;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        if (msg.sig == bytes4(keccak256("claimable(address)"))) {
            if (exhaust) {
                assembly {
                    invalid()
                }
            }
            touched = 1;
        }
        return abi.encode(uint256(0));
    }
}

contract PoolLensTest is ShareTransferTestBase {
    PoolLens private lens;
    PoolVault private vault;

    function setUp() public override {
        super.setUp();
        lens = new PoolLens(address(poolFactory));
        vault = PoolVault(payable(address(pool)));
    }

    function _positions(address member) private view returns (PoolLens.PoolRow memory) {
        address[] memory pools = new address[](1);
        pools[0] = address(pool);
        return lens.positions(pools, member).pools[0];
    }

    function _bit(PoolLens.Field field) private pure returns (uint256) {
        return 1 << uint256(field);
    }

    function _govBit(PoolLens.GovernanceField field) private pure returns (uint256) {
        return 1 << uint256(field);
    }

    function test_constructorOnlyRejectsZeroAndHasNoPayableEntry() public {
        vm.expectRevert(PoolLens.ZeroFactory.selector);
        new PoolLens(address(0));
        PoolLens futureFactory = new PoolLens(address(0x1234));
        assertEq(futureFactory.factory(), address(0x1234));
        vm.deal(address(this), 1 ether);
        (bool paid,) = address(lens).call{value: 1}("");
        assertFalse(paid);
    }

    function test_realVaultFieldsMatchDirectReadsAndPreserveAtomicUnits() public {
        _harvestReward(10001);
        PoolLens.PoolRow memory r = _positions(ALICE);
        assertEq(r.status.validMask, (1 << 17) - 1);
        assertEq(r.status.errorMask, 0);
        assertEq(uint256(r.status.trustError), 0);
        assertEq(r.pool, address(pool));
        assertEq(abi.encode(r.params), abi.encode(pool.params()));
        assertEq(r.state, uint256(pool.state()));
        assertEq(r.unitPriceWei, pool.unitPriceWei());
        assertEq(r.totalRaised, pool.totalRaised());
        assertEq(r.totalSupply, pool.totalSupply());
        assertEq(r.memberCount, pool.memberCount());
        assertEq(r.depositPaused, pool.depositPaused());
        assertEq(r.purchaseCost, vault.purchaseCost());
        assertEq(r.activatedAt, vault.activatedAt());
        assertEq(r.shareTradingAllowed, pool.shareTradingAllowed());
        assertEq(r.shares, pool.balanceOf(ALICE));
        assertEq(r.lockedShares, vault.lockedShares(ALICE));
        assertEq(r.availableShares, vault.availableShares(ALICE));
        assertEq(r.claimableBEM, rewards.claimable(ALICE));
        assertEq(r.bnbOwed, pool.bnbOwed(ALICE));
        assertEq(r.initialContributedWei, pool.contributedWei(ALICE));
        assertEq(r.initialContributedWei, 49 * UNIT_PRICE);
    }

    function test_zeroShareFormerHolderKeepsRewardsAndBnbRightsVisible() public {
        _harvestReward(10000);
        _transfer(ALICE, DAVE, 49);
        PoolLens.PoolRow memory r = _positions(ALICE);
        assertEq(r.shares, 0);
        assertEq(r.claimableBEM, 4851);
        assertEq(r.bnbOwed, pool.bnbOwed(ALICE));
        assertGt(r.bnbOwed, 0);
        assertEq(r.status.errorMask, 0);
        assertEq(rewards.lastClaimAt(ALICE), 0);
        assertEq(rewards.bemAccounted(), 9900);
        assertEq(bem.balanceOf(ALICE), 0);
    }

    function test_closedAndRefundingRowsAreNotFiltered() public {
        _harvestReward(10000);
        RewardsVaultHarness(payable(address(pool))).fixtureSetTerminalState(IPoolVault.State.Closed);
        PoolLens.PoolRow memory r = _positions(ALICE);
        assertEq(r.state, 4);
        assertEq(r.claimableBEM, 4851);
        assertFalse(r.shareTradingAllowed);
        vm.mockCall(address(pool), abi.encodeWithSignature("state()"), abi.encode(uint256(5)));
        r = _positions(ALICE);
        assertEq(r.state, 5);
        assertEq(r.claimableBEM, 4851);
    }

    function test_snapshotPagesBoundedAndEndCursorSafeIncludingHugeOffset() public {
        uint256 count = poolFactory.poolCount();
        PoolLens.Snapshot memory page = lens.poolPage(0, 1, address(0));
        assertEq(page.blockNumber, block.number);
        assertEq(page.timestamp, block.timestamp);
        assertEq(page.totalPools, count);
        assertTrue(page.registryCountValid);
        assertEq(page.nextCursor, 1);
        assertEq(page.pools.length, 1);
        assertEq(page.pools[0].pool, poolFactory.allPools(0));
        assertEq(page.pools[0].status.validMask, (1 << 11) - 1);
        assertEq(page.pools[0].status.errorMask, 0);
        page = lens.poolPage(count - 1, 20, ALICE);
        assertEq(page.pools.length, 1);
        assertEq(page.nextCursor, count);
        page = lens.poolPage(type(uint256).max, 20, ALICE);
        assertEq(page.pools.length, 0);
        assertEq(page.nextCursor, count);
        page = lens.poolPage(1, 0, ALICE);
        assertEq(page.nextCursor, 1);
        assertEq(page.pools.length, 0);
        vm.expectRevert(PoolLens.TooManyPools.selector);
        lens.poolPage(0, 21, ALICE);
        address[] memory tooMany = new address[](21);
        vm.expectRevert(PoolLens.TooManyPools.selector);
        lens.positions(tooMany, ALICE);
        address[] memory none = new address[](0);
        assertEq(lens.positions(none, ALICE).pools.length, 0);
    }

    function test_registryCountFailureDoesNotHideExplicitPositions() public {
        vm.mockCallRevert(address(poolFactory), abi.encodeWithSignature("poolCount()"), "bad registry");
        vm.expectRevert(PoolLens.RegistryUnavailable.selector);
        lens.poolPage(0, 1, ALICE);
        address[] memory pools = new address[](1);
        pools[0] = address(pool);
        PoolLens.Snapshot memory result = lens.positions(pools, ALICE);
        assertFalse(result.registryCountValid);
        assertEq(result.pools[0].shares, 49);
        assertEq(result.pools[0].status.errorMask, 0);
    }

    function test_badRegistryEntryFailsLocallyAndDoesNotSkipCursor() public {
        vm.mockCall(
            address(poolFactory), abi.encodeWithSignature("allPools(uint256)", 0), abi.encode(type(uint256).max)
        );
        PoolLens.Snapshot memory result = lens.poolPage(0, 2, ALICE);
        assertEq(result.nextCursor, 2);
        assertEq(result.pools[0].status.errorMask, 1);
        assertEq(uint256(result.pools[0].status.trustError), uint256(PoolLens.TrustError.RegistryReadFailed));
        assertEq(result.pools[1].status.errorMask, 0);
    }

    function test_registrationAndBothFactoryBindingsRequired() public {
        address[] memory pools = new address[](2);
        pools[0] = address(0xBAD);
        pools[1] = address(pool);
        vm.mockCall(pools[0], abi.encodeWithSignature("factory()"), abi.encode(address(poolFactory)));
        vm.mockCall(pools[0], abi.encodeWithSignature("OFFICIAL_FACTORY()"), abi.encode(address(poolFactory)));
        PoolLens.Snapshot memory result = lens.positions(pools, ALICE);
        assertEq(uint256(result.pools[0].status.trustError), uint256(PoolLens.TrustError.NotRegistered));
        assertEq(result.pools[0].status.validMask, 0);
        assertEq(result.pools[1].status.errorMask, 0);
        vm.mockCall(address(pool), abi.encodeWithSignature("OFFICIAL_FACTORY()"), abi.encode(address(0x123)));
        assertEq(uint256(_positions(ALICE).status.trustError), uint256(PoolLens.TrustError.IdentityMismatch));
        vm.clearMockedCalls();
        vm.mockCall(address(pool), abi.encodeWithSignature("factory()"), abi.encode(type(uint256).max));
        assertEq(uint256(_positions(ALICE).status.trustError), uint256(PoolLens.TrustError.IdentityMismatch));
        vm.clearMockedCalls();
        vm.mockCall(address(pool), abi.encodeWithSignature("factory()"), hex"01");
        assertEq(uint256(_positions(ALICE).status.trustError), uint256(PoolLens.TrustError.IdentityReadFailed));
        vm.clearMockedCalls();
        vm.mockCall(
            address(poolFactory), abi.encodeWithSignature("isPool(address)", address(pool)), abi.encode(uint256(2))
        );
        assertEq(uint256(_positions(ALICE).status.trustError), uint256(PoolLens.TrustError.RegistryReadFailed));
    }

    function test_failedClaimableIsUnknownNotZeroAndOtherFieldsStillValid() public {
        vm.mockCallRevert(
            address(pool),
            abi.encodeWithSignature("claimable(address)", ALICE),
            abi.encodeWithSelector(IPoolVault.LegacyRewardMigrationRequired.selector)
        );
        PoolLens.PoolRow memory r = _positions(ALICE);
        assertEq(r.claimableBEM, 0);
        assertEq(r.status.errorMask, _bit(PoolLens.Field.Claimable));
        assertEq(r.status.validMask, ((1 << 17) - 1) ^ _bit(PoolLens.Field.Claimable));
        assertEq(r.shares, 49);
        assertGt(r.bnbOwed, 0);
    }

    function test_badAbiShortEmptyLongAndInvalidBoolDoNotRevertWholeRead() public {
        bytes memory selector = abi.encodeWithSignature("claimable(address)", ALICE);
        vm.mockCall(address(pool), selector, hex"");
        assertEq(_positions(ALICE).status.errorMask, _bit(PoolLens.Field.Claimable));
        vm.mockCall(address(pool), selector, new bytes(31));
        assertEq(_positions(ALICE).status.errorMask, _bit(PoolLens.Field.Claimable));
        vm.mockCall(address(pool), selector, new bytes(65536));
        assertEq(_positions(ALICE).status.errorMask, _bit(PoolLens.Field.Claimable));
        vm.clearMockedCalls();
        vm.mockCall(address(pool), abi.encodeWithSignature("depositPaused()"), abi.encode(uint256(2)));
        vm.mockCall(address(pool), abi.encodeWithSignature("state()"), abi.encode(uint256(6)));
        PoolLens.PoolRow memory r = _positions(ALICE);
        assertEq(r.status.errorMask, _bit(PoolLens.Field.Paused) | _bit(PoolLens.Field.State));
        assertEq(r.shares, 49);
    }

    function test_badParamsNarrowIntegerIsRejectedBeforeDecode() public {
        bytes memory raw = abi.encode(pool.params());
        assembly {
            mstore(add(raw, 224), not(0))
        }
        vm.mockCall(address(pool), abi.encodeWithSignature("params()"), raw);
        PoolLens.PoolRow memory r = _positions(ALICE);
        assertEq(r.status.errorMask, _bit(PoolLens.Field.Params));
        assertEq(r.params.circuitId, 0);
        assertEq(r.shares, 49);
    }

    function test_inconsistentAvailableSharesNotAccepted() public {
        vm.mockCall(address(pool), abi.encodeWithSignature("availableShares(address)", ALICE), abi.encode(uint256(50)));
        PoolLens.PoolRow memory r = _positions(ALICE);
        assertEq(r.status.errorMask, _bit(PoolLens.Field.Available));
        assertEq(r.status.validMask & _bit(PoolLens.Field.Available), 0);
    }

    function test_getterCannotWriteAndExhaustedGasDoesNotBlockFollowingPool() public {
        for (uint256 mode = 0; mode < 2; ++mode) {
            LensHostileGetter hostile = new LensHostileGetter(address(poolFactory), mode != 0);
            vm.mockCall(
                address(poolFactory), abi.encodeWithSignature("isPool(address)", address(hostile)), abi.encode(true)
            );
            address[] memory pools = new address[](2);
            pools[0] = address(hostile);
            pools[1] = address(pool);
            PoolLens.Snapshot memory result = lens.positions(pools, ALICE);
            assertEq(result.pools[0].status.errorMask & _bit(PoolLens.Field.Claimable), _bit(PoolLens.Field.Claimable));
            assertEq(hostile.touched(), 0);
            assertEq(result.pools[1].status.errorMask, 0);
            assertEq(result.pools[1].shares, 49);
        }
    }

    function test_duplicateNftPoolAddressesRemainSeparateAndParamsAreCurrent() public {
        vm.prank(OPERATOR);
        address second = poolFactory.createPool(defaultParams);
        address[] memory pools = new address[](2);
        pools[0] = address(pool);
        pools[1] = second;
        PoolLens.Snapshot memory result = lens.positions(pools, ALICE);
        assertEq(result.pools.length, 2);
        assertEq(result.pools[0].params.circuitId, result.pools[1].params.circuitId);
        assertTrue(result.pools[0].pool != result.pools[1].pool);
        IPoolVault.PoolParams memory changed = pool.params();
        changed.circuitId = type(uint256).max;
        vm.mockCall(address(pool), abi.encodeWithSignature("params()"), abi.encode(changed));
        assertEq(_positions(ALICE).params.circuitId, type(uint256).max);
    }

    function _proposePrice(uint256 price) private returns (uint256 id) {
        vm.warp(uint256(vault.activatedAt()) + 7 days);
        vm.prank(ALICE);
        id = pool.propose(price, 123 ether, uint64(block.timestamp));
    }

    function test_governanceUsesActualCostAndSnapshotVotingThenExpiry() public {
        _transfer(BOB, CAROL, 23); // 49 / 26 / 25.
        uint256 id = _proposePrice(vault.purchaseCost() - 1);
        PoolLens.Governance memory g = lens.governance(address(pool), ALICE);
        assertEq(g.activeProposalId, id);
        assertEq(abi.encode(g.proposal), abi.encode(vault.getProposal(id)));
        assertTrue(g.discounted);
        assertEq(g.requiredYesShares, 60);
        assertEq(g.requiredYesCount, 2);
        assertEq(g.snapshotShares, 49);
        assertTrue(g.canVote);
        assertFalse(g.canExecute);
        assertFalse(_positions(ALICE).shareTradingAllowed);
        vm.prank(BOB);
        pool.vote(id, true);
        vm.prank(CAROL);
        pool.vote(id, true);
        g = lens.governance(address(pool), BOB);
        assertEq(g.proposal.yesShares, 51);
        assertFalse(g.passed);
        assertFalse(g.canVote);
        vm.prank(ALICE);
        pool.vote(id, true);
        g = lens.governance(address(pool), DAVE);
        assertEq(g.snapshotShares, 0);
        assertFalse(g.canVote);
        assertTrue(g.passed);
        assertTrue(g.canExecute);
        assertEq(g.passed, vault.proposalPassed(id));
        pool.executeSale(id);
        g = lens.governance(address(pool), ALICE);
        assertEq(g.state, 3);
        assertFalse(g.canVote);
        assertFalse(g.canExecute);
        assertFalse(g.canCancelExpired);
        vm.warp(g.expiresAt);
        g = lens.governance(address(pool), ALICE);
        assertTrue(g.canCancelExpired);
        pool.cancelExpired();
        assertFalse(lens.governance(address(pool), ALICE).canCancelExpired);
    }

    function test_sameSecondBuyerReceivesLensVoteAndFormerHolderDoesNot() public {
        vm.warp(uint256(vault.activatedAt()) + 7 days);
        _transfer(ALICE, DAVE, 49);
        uint256 price = vault.purchaseCost();
        vm.prank(BOB);
        uint256 id = pool.propose(price, 0, 0);
        assertEq(vault.getProposal(id).snapshotTs, block.timestamp);

        PoolLens.Governance memory buyer = lens.governance(address(pool), DAVE);
        assertEq(buyer.snapshotShares, 49);
        assertTrue(buyer.canVote);
        assertEq(buyer.status.errorMask, 0);
        PoolLens.Governance memory former = lens.governance(address(pool), ALICE);
        assertEq(former.snapshotShares, 0);
        assertFalse(former.canVote);
    }

    function test_oldProposalFormatIsNeverShownAsExecutable() public {
        uint256 id = _proposePrice(vault.purchaseCost());
        PoolSaleState.Proposal memory old = vault.getProposal(id);
        old.snapshotTs -= 1;
        old.yesCount = 2;
        old.yesShares = 98;
        vm.mockCall(address(pool), abi.encodeWithSignature("getProposal(uint256)", id), abi.encode(old));

        PoolLens.Governance memory g = lens.governance(address(pool), ALICE);
        assertFalse(g.passed);
        assertFalse(g.canExecute);
        assertFalse(g.canVote);
    }

    function test_atCostMajorityThresholdAndVotingDeadlineBoundary() public {
        _transfer(BOB, CAROL, 23);
        uint256 id = _proposePrice(vault.purchaseCost());
        vm.prank(BOB);
        pool.vote(id, true);
        vm.prank(CAROL);
        pool.vote(id, true);
        PoolLens.Governance memory g = lens.governance(address(pool), ALICE);
        assertFalse(g.discounted);
        assertEq(g.requiredYesShares, 51);
        assertTrue(g.canExecute);
        assertEq(g.passed, vault.proposalPassed(id));
        vm.warp(g.proposal.endsAt);
        g = lens.governance(address(pool), ALICE);
        assertTrue(g.passed);
        assertFalse(g.canVote);
        assertFalse(g.canExecute);
        assertTrue(_positions(ALICE).shareTradingAllowed);
    }

    function test_governanceMalformedProposalAndFailedVoteLookupRemainIsolated() public {
        _proposePrice(vault.purchaseCost());
        vm.mockCallRevert(address(pool), abi.encodeWithSignature("hasVoted(uint256,address)", 1, ALICE), "failed");
        PoolLens.Governance memory g = lens.governance(address(pool), ALICE);
        assertEq(g.status.errorMask, _govBit(PoolLens.GovernanceField.HasVoted));
        assertEq(g.status.validMask & _govBit(PoolLens.GovernanceField.Eligibility), 0);
        assertGt(g.status.validMask & _govBit(PoolLens.GovernanceField.ExecutionEligibility), 0);
        vm.clearMockedCalls();
        bytes memory raw = abi.encode(vault.getProposal(1));
        assembly {
            mstore(add(raw, 352), 2)
        }
        vm.mockCall(address(pool), abi.encodeWithSignature("getProposal(uint256)", 1), raw);
        g = lens.governance(address(pool), ALICE);
        assertEq(g.status.errorMask, _govBit(PoolLens.GovernanceField.Proposal));
        assertFalse(g.canExecute);
        assertEq(g.purchaseCost, vault.purchaseCost());
    }

    function test_referenceIndependentAndNarrowTypesValidated() public {
        IPoolVault.FlexiblePurchaseConfig memory config =
            IPoolVault.FlexiblePurchaseConfig(55, 4 ether, 123456789, 1000, 123, 456, bytes32(uint256(789)));
        vm.mockCall(address(pool), abi.encodeWithSignature("flexiblePurchase()"), abi.encode(true, uint256(42), config));
        vm.mockCall(address(pool), abi.encodeWithSignature("purchaseModel()"), abi.encode(true, uint32(170)));
        vm.mockCall(address(pool), abi.encodeWithSignature("purchaseReferenceWeight()"), abi.encode(uint128(99)));
        PoolLens.PurchaseReference memory r = lens.purchaseReference(address(pool));
        assertEq(r.status.validMask, 15);
        assertEq(r.status.errorMask, 0);
        assertTrue(r.enabled);
        assertEq(r.referenceCircuitId, 42);
        assertEq(abi.encode(r.config), abi.encode(config));
        assertTrue(r.modelInitialized);
        assertEq(r.taskId, 170);
        assertEq(r.referenceVerifiedWeight, 99);
        vm.mockCall(address(pool), abi.encodeWithSignature("purchaseModel()"), abi.encode(true, type(uint256).max));
        r = lens.purchaseReference(address(pool));
        assertEq(r.status.errorMask, 1 << uint256(PoolLens.ReferenceField.Model));
        assertFalse(r.modelInitialized);
        assertTrue(r.enabled);
        bytes memory raw = abi.encode(true, uint256(42), config);
        assembly {
            mstore(add(raw, 192), not(0))
        }
        vm.mockCall(address(pool), abi.encodeWithSignature("flexiblePurchase()"), raw);
        r = lens.purchaseReference(address(pool));
        assertEq(
            r.status.errorMask,
            (1 << uint256(PoolLens.ReferenceField.Model)) | (1 << uint256(PoolLens.ReferenceField.Configuration))
        );
        assertEq(r.referenceVerifiedWeight, 99);
    }

    function test_twentyRealRowsBoundedGasAndNeverMutateAccounting() public {
        _harvestReward(10000);
        address[] memory pools = new address[](20);
        for (uint256 i = 0; i < pools.length; ++i) {
            pools[i] = address(pool);
        }
        uint256 beforeGas = gasleft();
        PoolLens.Snapshot memory result = lens.positions(pools, ALICE);
        uint256 spent = beforeGas - gasleft();
        emit log_named_uint("20 warm repeated actual-vault positions execution gas", spent);
        assertLt(spent, 6000000);
        for (uint256 i = 0; i < result.pools.length; ++i) {
            assertEq(result.pools[i].claimableBEM, 4851);
            assertEq(result.pools[i].status.errorMask, 0);
        }
        assertEq(rewards.lastClaimAt(ALICE), 0);
        assertEq(rewards.bemAccounted(), 9900);
        assertEq(bem.balanceOf(ALICE), 0);
    }

    function test_twentyDistinctColdPoolsStayWithinMeasuredReadBudget() public {
        address[] memory pools = new address[](20);
        for (uint256 i = 0; i < pools.length; ++i) {
            vm.prank(OPERATOR);
            pools[i] = poolFactory.createPool(defaultParams);
            vm.cool(pools[i]);
        }
        vm.cool(address(beacon));
        vm.cool(beacon.implementation());
        vm.cool(address(poolFactory));
        uint256 beforeGas = gasleft();
        PoolLens.Snapshot memory result = lens.positions(pools, ALICE);
        uint256 spent = beforeGas - gasleft();
        emit log_named_uint("20 distinct cold Funding-pool positions execution gas", spent);
        assertLt(spent, 6000000);
        for (uint256 i = 0; i < result.pools.length; ++i) {
            assertEq(result.pools[i].pool, pools[i]);
            assertEq(result.pools[i].status.errorMask, 0);
            assertEq(result.pools[i].state, 0);
        }
    }
}
