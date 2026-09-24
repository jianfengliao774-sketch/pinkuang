// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase} from "../utils/FundingTestBase.sol";
import {PurchaseMockBem, PurchaseMockNft} from "../utils/PurchaseMocks.sol";
import {MiningPermissionMock} from "../utils/MiningPermissionMocks.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IMiningVaultActions {
    error SelectorNotAllowed();
    error InvalidParameters();
    function mine(bytes calldata data) external returns (bytes memory);
    function sellToPool() external;
}

/// @notice Unit tests of the production Vault's authority and call boundary, not Mining proof validity.
contract PoolMiningTest is FundingTestBase {
    address private constant SELLER = address(0x5E11E2);
    uint256 private constant ID = 16210;
    uint256 private constant PRICE = 1 ether;
    bytes4 private constant STOP = bytes4(keccak256("stop(bytes32)"));

    IMiningVaultActions private actions;
    PurchaseMockNft private nft;
    MiningPermissionMock private mining;
    bytes32 private key;

    function setUp() public override {
        super.setUp();
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.MINING, address(new MiningPermissionMock()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        mining = MiningPermissionMock(payable(Addresses.MINING));
        nft.mint(SELLER, ID);
        mining.configure(address(nft), ID, 1000, 0);
        key = mining.minerKey(address(nft), ID);
        IPoolVault.PoolParams memory p = defaultParams;
        p.directSeller = SELLER;
        p.directPrice = PRICE;
        pool = _createPool(p);
        actions = IMiningVaultActions(address(pool));
    }

    function _activate() private {
        _fundPool();
        vm.startPrank(SELLER);
        nft.approve(address(pool), ID);
        actions.sellToPool();
        vm.stopPrank();
        _stateIs(IPoolVault.State.Active);
    }

    function _arm(address circuits, uint256 id) private pure returns (bytes memory) {
        return abi.encodeCall(MiningPermissionMock.arm, (circuits, id));
    }

    function _start(address circuits, uint256 id) private pure returns (bytes memory) {
        bytes[] memory inputs = new bytes[](1);
        bytes[] memory outputs = new bytes[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        inputs[0] = hex"010203";
        outputs[0] = hex"04";
        proofs[0] = new bytes32[](2);
        proofs[0][0] = bytes32(uint256(0xABCD));
        proofs[0][1] = bytes32(uint256(0xEF01));
        return abi.encodeCall(
            MiningPermissionMock.start,
            (circuits, id, uint32(7), uint256(8000), inputs, outputs, proofs, bytes32("salt"))
        );
    }

    function _operatorMine(bytes memory data) private returns (bytes memory) {
        vm.prank(OPERATOR);
        return actions.mine(data);
    }

    function test_mineRequiresActiveInFundingFundedAndRefunding() public {
        bytes memory data = _arm(address(nft), ID);
        vm.expectRevert(IPoolVault.WrongState.selector);
        _operatorMine(data);
        _fundPool();
        vm.expectRevert(IPoolVault.WrongState.selector);
        _operatorMine(data);
        vm.warp(defaultParams.purchaseDeadline);
        pool.finalizeFailure();
        vm.expectRevert(IPoolVault.WrongState.selector);
        _operatorMine(data);
        assertEq(mining.mineCalls(), 0);
    }

    function test_mineRejectsMemberOwnerAndStranger() public {
        _activate();
        bytes memory data = _arm(address(nft), ID);
        address[3] memory callers = [ALICE, OWNER, address(0xBAD)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(IPoolVault.Unauthorized.selector);
            actions.mine(data);
        }
        assertEq(mining.mineCalls(), 0);
    }

    function test_operatorRotationRevokesOldAuthorityOnExistingPool() public {
        _activate();
        address replacement = address(0x4400);
        vm.prank(OWNER);
        poolFactory.setOperator(replacement);
        bytes memory data = _arm(address(nft), ID);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        _operatorMine(data);
        vm.prank(replacement);
        actions.mine(data);
        assertEq(mining.mineCalls(), 1);
        assertEq(mining.lastCaller(), address(pool));
    }

    function test_armForwardsExactDataFromVaultToFixedMining() public {
        _activate();
        bytes memory data = _arm(address(nft), ID);
        uint256 vaultBnb = address(pool).balance;
        assertEq(_operatorMine(data).length, 0);
        assertEq(mining.mineCalls(), 1);
        assertEq(mining.lastCaller(), address(pool));
        assertEq(mining.lastData(), data);
        assertEq(address(pool).balance, vaultBnb);
        assertEq(nft.ownerOf(ID), address(pool));
    }

    function test_startDecodesCompleteDynamicArgumentsAndPreservesReturnData() public {
        _activate();
        bytes memory data = _start(address(nft), ID);
        bytes memory returned = _operatorMine(data);
        assertEq(abi.decode(returned, (bytes32)), key);
        assertEq(mining.lastData(), data);
        assertEq(mining.lastCaller(), address(pool));
    }

    function test_reclaimOnlyForCurrentProjectKey() public {
        _activate();
        bytes memory data = abi.encodeCall(MiningPermissionMock.reclaim, (key));
        _operatorMine(data);
        assertEq(mining.lastData(), data);
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        _operatorMine(abi.encodeCall(MiningPermissionMock.reclaim, (key ^ bytes32(uint256(1)))));
        assertEq(mining.mineCalls(), 1);
    }

    function test_armAndStartRejectOtherCollectionOrToken() public {
        _activate();
        bytes[4] memory wrong = [
            _arm(Addresses.BEHEMOTH_CIRCUITS, ID),
            _arm(address(nft), ID + 1),
            _start(Addresses.BEHEMOTH_CIRCUITS, ID),
            _start(address(nft), ID + 1)
        ];
        for (uint256 i; i < wrong.length; ++i) {
            vm.expectRevert(IPoolVault.WrongCircuit.selector);
            _operatorMine(wrong[i]);
        }
        assertEq(mining.mineCalls(), 0);
    }

    function test_stopClaimApprovalAndArbitrarySelectorRejectedBeforeExternalCall() public {
        _activate();
        bytes[5] memory forbidden = [
            abi.encodeWithSelector(STOP, key),
            abi.encodeWithSignature("claim(bytes32)", key),
            abi.encodeWithSignature("approve(address,uint256)", OPERATOR, ID),
            abi.encodeWithSignature("setApprovalForAll(address,bool)", OPERATOR, true),
            abi.encodeWithSelector(bytes4(0xDEADBEEF), Addresses.BEM, uint256(100))
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            vm.expectRevert(IMiningVaultActions.SelectorNotAllowed.selector);
            _operatorMine(forbidden[i]);
        }
        assertEq(mining.mineCalls(), 0, "mock fallback accepts unknown selectors, so Vault must block them");
        assertEq(nft.getApproved(ID), address(0));
        assertFalse(nft.isApprovedForAll(address(pool), OPERATOR));
    }

    function test_shortPayloadAndWrongFixedLengthsRejected() public {
        _activate();
        for (uint256 length; length < 4; ++length) {
            vm.expectRevert(IMiningVaultActions.SelectorNotAllowed.selector);
            _operatorMine(new bytes(length));
        }
        bytes memory armData = _arm(address(nft), ID);
        bytes memory reclaimData = abi.encodeCall(MiningPermissionMock.reclaim, (key));
        bytes[4] memory malformed = [
            abi.encodePacked(MiningPermissionMock.arm.selector, address(nft)),
            bytes.concat(armData, hex"00"),
            abi.encodePacked(MiningPermissionMock.reclaim.selector),
            bytes.concat(reclaimData, hex"00")
        ];
        for (uint256 i; i < malformed.length; ++i) {
            vm.expectRevert(IMiningVaultActions.InvalidParameters.selector);
            _operatorMine(malformed[i]);
        }
        assertEq(mining.mineCalls(), 0);
    }

    function test_startMalformedDynamicOffsetsCannotReachMining() public {
        _activate();
        bytes memory data = _start(address(nft), ID);
        // The inputs offset is the fifth ABI word, after the selector; point outside calldata.
        assembly {
            mstore(add(data, 164), not(0))
        }
        vm.expectRevert(); // Solidity's ABI decoder need not attach a named custom error.
        _operatorMine(data);
        assertEq(mining.mineCalls(), 0);
    }

    function test_startRejectsNoncanonicalTrailingData() public {
        _activate();
        bytes memory data = bytes.concat(_start(address(nft), ID), hex"00");
        vm.expectRevert(IMiningVaultActions.InvalidParameters.selector);
        _operatorMine(data);
        assertEq(mining.mineCalls(), 0);
    }

    function test_protocolCustomErrorBubblesWithoutChangingAssets() public {
        _activate();
        bytes memory reason = abi.encodeWithSignature("ProtocolRejected(bytes32,uint256)", key, uint256(77));
        mining.setMineRevert(reason);
        uint256 vaultBnb = address(pool).balance;
        vm.expectRevert(reason);
        _operatorMine(_arm(address(nft), ID));
        assertEq(mining.mineCalls(), 0);
        assertEq(nft.ownerOf(ID), address(pool));
        assertEq(address(pool).balance, vaultBnb);
        _stateIs(IPoolVault.State.Active);
    }

    function test_externalCallCannotReenterMineEvenWhenMiningIsOperator() public {
        _activate();
        bytes memory data = _arm(address(nft), ID);
        mining.setMineCallback(address(pool), abi.encodeCall(IMiningVaultActions.mine, (data)));
        vm.prank(OWNER);
        poolFactory.setOperator(address(mining));
        vm.prank(address(mining));
        actions.mine(data);
        assertTrue(mining.mineCallbackAttempted());
        assertFalse(mining.mineCallbackSucceeded());
        assertEq(bytes4(mining.mineCallbackResult()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(mining.mineCalls(), 1);
    }

    function test_ownerLossDuringMiningCallRollsBackProtocolMutation() public {
        _activate();
        mining.setMineFault(1);
        vm.expectRevert(IPoolVault.NotOwnerAfterBuy.selector);
        _operatorMine(_arm(address(nft), ID));
        assertEq(nft.ownerOf(ID), address(pool));
        assertEq(mining.mineCalls(), 0);
    }

    function test_missingOwnershipRejectsBeforeCallingMining() public {
        _activate();
        nft.forceTransfer(address(0xBAD), ID);
        vm.expectRevert(IPoolVault.NotOwnerAfterBuy.selector);
        _operatorMine(_arm(address(nft), ID));
        assertEq(mining.mineCalls(), 0);
    }

    function test_wrongMinerIdentityRejectsBeforeCallingMining() public {
        _activate();
        mining.setIdentity(key, Addresses.BEHEMOTH_CIRCUITS, uint64(ID));
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        _operatorMine(_arm(address(nft), ID));
        assertEq(mining.mineCalls(), 0);
    }

    function test_minerIdentityChangeDuringMiningCallRollsBack() public {
        _activate();
        mining.setMineFault(2);
        vm.expectRevert(IPoolVault.WrongCircuit.selector);
        _operatorMine(_arm(address(nft), ID));
        assertEq(mining.getMiner(key).circuits, address(nft));
        assertEq(mining.mineCalls(), 0);
    }
}
