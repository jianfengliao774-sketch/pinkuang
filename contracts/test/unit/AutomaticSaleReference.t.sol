// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareTransferTestBase} from "../utils/ShareTransferTestBase.sol";
import {PlatformAuthority} from "../../src/PlatformAuthority.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract AutomaticReferenceBudgetRegistry {
    address public immutable timelock;
    mapping(address => bool) public isPool;

    constructor(address timelock_) {
        timelock = timelock_;
    }

    function register(address pool) external {
        isPool[pool] = true;
    }
}

contract AutomaticReferenceWrongAuthority {
    address public immutable coreFactory;
    address public immutable gasWallet;

    constructor(address factory_, address gasWallet_) {
        coreFactory = factory_;
        gasWallet = gasWallet_;
    }
}

contract AutomaticSaleReferenceTest is ShareTransferTestBase {
    address private constant GAS_WALLET = address(0xFEE);
    address private constant FIRST_ADMIN = address(0xAD111);
    address private constant SECOND_ADMIN = address(0xAD222);
    bytes32 private constant DIGEST = keccak256("official-firsto-evidence");
    PlatformAuthority private authority;
    AutomaticReferenceBudgetRegistry private budgetRegistry;

    function setUp() public override {
        super.setUp();
        budgetRegistry = new AutomaticReferenceBudgetRegistry(address(timelock));
        authority = new PlatformAuthority(
            address(poolFactory), address(budgetRegistry), FIRST_ADMIN, SECOND_ADMIN, GAS_WALLET
        );
        vm.prank(OWNER);
        poolFactory.setOperator(address(authority));
    }

    function _publish(uint128 price, uint64 observedAt, bytes32 digest) private {
        vm.prank(GAS_WALLET);
        shareMarket.publishSaleReference(address(pool), price, observedAt, digest);
    }

    function test_gasWalletPublishesOnlyReferenceWithoutAdminNonceOrSignature() public {
        assertEq(shareMarket.automaticSaleReferenceVersion(), 1);
        assertEq(shareMarket.saleReferencePublisher(), GAS_WALLET);
        _publish(5 ether, uint64(block.timestamp), DIGEST);
        (uint128 price, uint64 observed, bytes32 digest) = shareMarket.saleReference(address(pool));
        assertEq(price, 5 ether);
        assertEq(observed, block.timestamp);
        assertEq(digest, DIGEST);
        assertEq(authority.nonces(FIRST_ADMIN), 0);
        assertEq(authority.nonces(SECOND_ADMIN), 0);
        assertEq(shareMarket.totalBnbOwed(), 0);
    }

    function test_unrelatedWalletsIncludingAdministratorsCannotUsePublisherEntry() public {
        address[5] memory outsiders = [ALICE, OWNER, FIRST_ADMIN, SECOND_ADMIN, OPERATOR];
        for (uint256 i; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(IShareMarket.Unauthorized.selector);
            shareMarket.publishSaleReference(address(pool), 5 ether, uint64(block.timestamp), DIGEST);
        }
    }

    function test_onlyCoreRegisteredPoolsAcceptAutomaticReference() public {
        address unrelated = address(budgetRegistry);
        budgetRegistry.register(unrelated);
        vm.prank(GAS_WALLET);
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        shareMarket.publishSaleReference(unrelated, 5 ether, uint64(block.timestamp), DIGEST);
        vm.prank(GAS_WALLET);
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        shareMarket.publishSaleReference(address(0xBAD), 5 ether, uint64(block.timestamp), DIGEST);
    }

    function test_priceDigestAndObservationTimeAreValidated() public {
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        _publish(0, uint64(block.timestamp), DIGEST);
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        _publish(5 ether, uint64(block.timestamp), bytes32(0));
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        _publish(5 ether, uint64(block.timestamp + 1), DIGEST);
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        _publish(5 ether, uint64(block.timestamp - 5 minutes - 1), DIGEST);
        _publish(5 ether, uint64(block.timestamp - 5 minutes), DIGEST);
    }

    function test_olderEvidenceCannotReplaceNewerAutomaticReference() public {
        uint64 observed = uint64(block.timestamp);
        _publish(5 ether, observed, DIGEST);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        _publish(4 ether, observed - 1, keccak256("older"));
        _publish(6 ether, uint64(block.timestamp), keccak256("newer"));
        (uint128 price,,) = shareMarket.saleReference(address(pool));
        assertEq(price, 6 ether);
    }

    function test_uint128MaximumIsAcceptedAndOversizedAbiValueCannotWrite() public {
        _publish(type(uint128).max, uint64(block.timestamp), DIGEST);
        vm.prank(GAS_WALLET);
        (bool ok,) = address(shareMarket).call(abi.encodeWithSignature(
            "publishSaleReference(address,uint128,uint64,bytes32)",
            address(pool), uint256(type(uint128).max) + 1, uint64(block.timestamp), DIGEST
        ));
        assertFalse(ok);
        (uint128 price,,) = shareMarket.saleReference(address(pool));
        assertEq(price, type(uint128).max);
    }

    function test_gasRotationRevokesOldPublisherImmediately() public {
        address replacement = address(0xFE2);
        vm.prank(address(timelock));
        authority.setGasWallet(replacement);
        assertEq(shareMarket.saleReferencePublisher(), replacement);
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        _publish(5 ether, uint64(block.timestamp), DIGEST);
        vm.prank(replacement);
        shareMarket.publishSaleReference(address(pool), 5 ether, uint64(block.timestamp), DIGEST);
    }

    function test_wrongFactoryAuthorityOrEoaOperatorDisablesPublisher() public {
        AutomaticReferenceWrongAuthority wrong = new AutomaticReferenceWrongAuthority(address(0xBAD), GAS_WALLET);
        vm.prank(OWNER);
        poolFactory.setOperator(address(wrong));
        assertEq(shareMarket.saleReferencePublisher(), address(0));
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        _publish(5 ether, uint64(block.timestamp), DIGEST);
        vm.prank(OWNER);
        poolFactory.setOperator(OPERATOR);
        assertEq(shareMarket.saleReferencePublisher(), address(0));
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        _publish(5 ether, uint64(block.timestamp), DIGEST);
    }

    function test_gasCannotApproveSaleCreatePoolRedirectTreasuryOrUpgrade() public {
        ShareMarket next = new ShareMarket();
        vm.startPrank(GAS_WALLET);
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        shareMarket.reviewSale(address(pool), 1, 5 ether, true);
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        shareMarket.setSaleReference(address(pool), 5 ether, uint64(block.timestamp), DIGEST);
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        shareMarket.upgradeToAndCall(address(next), "");
        vm.expectRevert();
        poolFactory.setOperator(GAS_WALLET);
        vm.expectRevert();
        poolFactory.setTreasury(GAS_WALLET);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        poolFactory.createPool(defaultParams);
        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignatureLength(uint256)", 0));
        authority.reviewSale(address(shareMarket), address(pool), 1, 5 ether, true, 0, block.timestamp + 1 hours, "");
        vm.stopPrank();
        assertEq(poolFactory.operator(), address(authority));
        assertEq(poolFactory.treasury(), TREASURY);
        assertEq(authority.nonces(FIRST_ADMIN), 0);
    }

    function test_gasCannotBuyProjectOrClaimFeesWithoutAdminSignature() public {
        budgetRegistry.register(address(pool));
        address[] memory markets = new address[](1);
        markets[0] = address(shareMarket);
        address[] memory pools = new address[](0);
        vm.startPrank(GAS_WALLET);
        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignatureLength(uint256)", 0));
        authority.buyBudgetOfficial(address(pool), address(pool), 1, 5 ether, 0, block.timestamp + 1 hours, "");
        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignatureLength(uint256)", 0));
        authority.claimFees(markets, pools, FIRST_ADMIN, 0, block.timestamp + 1 hours, "");
        vm.stopPrank();
        assertEq(authority.nonces(FIRST_ADMIN), 0);
    }
}
