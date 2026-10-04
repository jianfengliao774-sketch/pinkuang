// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {PurchaseMockNft, PurchaseMockBem, PurchaseMockMining, PurchaseMockMarket} from "../utils/PurchaseMocks.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";

contract TargetOwnerAuthorityMock {
    address public administratorOne;
    address public administratorTwo;

    constructor(address one, address two) {
        administratorOne = one;
        administratorTwo = two;
    }

    function setAdministrators(address one, address two) external {
        administratorOne = one;
        administratorTwo = two;
    }
}

contract TargetOwnerTest is FundingTestBase {
    address private constant SELLER = address(0x5E11E2);
    address private constant OUTSIDE_BUYER = address(0xBEEF);
    uint256 private constant ADMIN_ONE_KEY = 0xA11;
    uint256 private constant ADMIN_TWO_KEY = 0xA22;
    bytes32 private constant TARGET_STORAGE = 0x5e3815662d4c25a0aafa80ec36671d2b01c656be89eff3f6936c6387169fd700;
    bytes32 private constant VAULT_STORAGE = 0x91bfb6bda130bea719738fb057a72863be36ca25095a844c93b1e775e47e6d00;
    bytes32 private constant TYPEHASH = keccak256(
        "ConfigureTargetOwner(address pool,address factory,address circuits,uint256 circuitId,address originalOwner,address authority,address administratorOne,address administratorTwo,uint256 nonce,uint256 deadline)"
    );
    PurchaseMockNft private nft;
    TargetOwnerAuthorityMock private authority;

    function setUp() public override {
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        nft.mint(SELLER, 16210);
        super.setUp();
        authority = new TargetOwnerAuthorityMock(vm.addr(ADMIN_ONE_KEY), vm.addr(ADMIN_TWO_KEY));
    }

    function _legacy() private {
        // A delivered proxy has zero in the new independent namespace; preserve all existing slots and assets.
        vm.store(address(pool), TARGET_STORAGE, bytes32(0));
        vm.store(address(pool), bytes32(uint256(TARGET_STORAGE) + 1), bytes32(0));
        vm.prank(OWNER);
        poolFactory.setOperator(address(authority));
    }

    function _authorization(address originalOwner) private view returns (IPoolVault.TargetOwnerAuthorization memory a) {
        a = IPoolVault.TargetOwnerAuthorization(
            originalOwner,
            address(authority),
            authority.administratorOne(),
            authority.administratorTwo(),
            0,
            block.timestamp + 1 hours
        );
    }

    function _digest(IPoolVault.TargetOwnerAuthorization memory a, uint256 chain, address target)
        private
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BEMine Target Owner"),
                keccak256("1"),
                chain,
                target
            )
        );
        bytes32 payload = keccak256(
            abi.encode(TYPEHASH, target, address(poolFactory), defaultParams.circuits, defaultParams.circuitId, a)
        );
        return keccak256(abi.encodePacked(hex"1901", domain, payload));
    }

    function _signature(bytes32 digest, uint256 key) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _configure(IPoolVault.TargetOwnerAuthorization memory a) private {
        bytes32 digest = _digest(a, block.chainid, address(pool));
        pool.configureTargetOwner(abi.encode(a, _signature(digest, ADMIN_ONE_KEY), _signature(digest, ADMIN_TWO_KEY)));
    }

    function _assertRefund(uint256 amount) private view {
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Refunding));
        assertTrue(pool.refundsRecorded());
        assertEq(pool.totalBnbOwed(), amount);
    }

    function testInitializeLocksActualOwnerAndIndependentVersion() public view {
        (address owner, bool configured, uint256 nonce) = pool.targetOwner();
        assertEq(owner, SELLER);
        assertTrue(configured);
        assertEq(nonce, 0);
        assertEq(pool.targetOwnerVersion(), 1);
    }

    function testMissingTokenCannotCreatePool() public {
        _deployFactory();
        defaultParams.circuitId = 555;
        vm.prank(OPERATOR);
        vm.expectRevert();
        poolFactory.createPool(defaultParams);
        assertEq(poolFactory.poolCount(), 0);
    }

    function testFundingExternalBuyerBlocksDepositAndCreditsExistingMembers() public {
        _deposit(pool, ALICE, 20);
        _deposit(pool, BOB, 30);
        nft.forceTransfer(OUTSIDE_BUYER, defaultParams.circuitId);
        vm.deal(CAROL, UNIT_PRICE);
        vm.prank(CAROL);
        vm.expectRevert(IPoolVault.TargetOwnerChanged.selector);
        pool.deposit{value: UNIT_PRICE}(1);
        assertTrue(pool.syncTargetAvailability());
        _assertRefund(50 * UNIT_PRICE);
        assertEq(pool.bnbOwed(ALICE), 20 * UNIT_PRICE);
        assertEq(pool.bnbOwed(BOB), 30 * UNIT_PRICE);
        assertEq(pool.contributedWei(ALICE), 0);
        assertEq(pool.contributedWei(BOB), 0);
        assertEq(pool.totalSupply(), 50); // Refunding preserves the historical shares and checkpoint history.
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(ALICE.balance, before + 20 * UNIT_PRICE);
        assertEq(pool.bnbOwed(ALICE), 0);
    }

    function testFundedExternalBuyerCanRefundBeforeDeadline() public {
        _fundPool();
        nft.forceTransfer(OUTSIDE_BUYER, defaultParams.circuitId);
        assertLt(block.timestamp, defaultParams.purchaseDeadline);
        assertTrue(pool.syncTargetAvailability());
        _assertRefund(defaultParams.targetRaise);
        assertEq(pool.bnbOwed(ALICE), 49 * UNIT_PRICE);
        assertEq(pool.bnbOwed(BOB), 49 * UNIT_PRICE);
        assertEq(pool.bnbOwed(CAROL), 2 * UNIT_PRICE);
    }

    function testRepeatedSyncCannotDoubleCredit() public {
        _fundPool();
        nft.forceTransfer(OUTSIDE_BUYER, defaultParams.circuitId);
        pool.syncTargetAvailability();
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.syncTargetAvailability();
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.finalizeFailure();
        _assertRefund(defaultParams.targetRaise);
    }

    function testExternalBuyerRelistingCannotReviveFixedPurchase() public {
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        PurchaseMockMarket market = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);
        _fundPool();
        nft.forceTransfer(OUTSIDE_BUYER, defaultParams.circuitId);
        vm.prank(OUTSIDE_BUYER);
        nft.approve(address(market), defaultParams.circuitId);
        uint256 listingId = market.createListing(OUTSIDE_BUYER, address(nft), defaultParams.circuitId, 5 ether);
        vm.expectRevert(IPoolVault.TargetOwnerChanged.selector);
        pool.buyFromMarket(listingId);
        vm.expectRevert(IPoolVault.TargetOwnerChanged.selector);
        pool.buyFromFirsto(0, hex"00");
        vm.expectRevert(IPoolVault.TargetOwnerChanged.selector);
        pool.sellToPool();
        assertTrue(pool.syncTargetAvailability());
        _assertRefund(defaultParams.targetRaise);
        assertEq(nft.ownerOf(defaultParams.circuitId), OUTSIDE_BUYER);
    }

    function testLegacyUnconfiguredFundedCannotBuyBeforeMigration() public {
        _fundPool();
        _legacy();
        vm.expectRevert(IPoolVault.TargetOwnerNotConfigured.selector);
        pool.buyFromMarket(1);
        vm.expectRevert(IPoolVault.TargetOwnerNotConfigured.selector);
        pool.buyFromFirsto(0, hex"00");
        vm.expectRevert(IPoolVault.TargetOwnerNotConfigured.selector);
        pool.sellToPool();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funded));
        vm.warp(defaultParams.purchaseDeadline);
        pool.finalizeFailure();
        _assertRefund(defaultParams.targetRaise);
    }

    function testRefundPreservesExistingWithdrawalCreditAndDoesNotRecreditIt() public {
        _deposit(pool, ALICE, 20);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        _deposit(pool, BOB, 30);
        nft.forceTransfer(OUTSIDE_BUYER, defaultParams.circuitId);
        assertTrue(pool.syncTargetAvailability());
        _assertRefund(50 * UNIT_PRICE);
        assertEq(pool.bnbOwed(ALICE), 20 * UNIT_PRICE);
        assertEq(pool.bnbOwed(BOB), 30 * UNIT_PRICE);
        assertEq(pool.contributedWei(ALICE), 0);
        assertEq(pool.contributedWei(BOB), 0);
    }

    function testUnchangedOwnerAndCancelledListingDoNotRefund() public {
        _deposit(pool, ALICE, 1);
        assertFalse(pool.syncTargetAvailability());
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funding));
        assertEq(pool.totalBnbOwed(), 0);
    }

    function testUnknownRevertingOwnerReadNeverCreditsRefund() public {
        _deposit(pool, ALICE, 1);
        vm.mockCallRevert(
            address(nft), abi.encodeWithSelector(nft.ownerOf.selector, defaultParams.circuitId), hex"deadbeef"
        );
        vm.expectRevert();
        pool.syncTargetAvailability();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funding));
        assertEq(pool.totalBnbOwed(), 0);
        vm.deal(BOB, UNIT_PRICE);
        vm.prank(BOB);
        vm.expectRevert();
        pool.deposit{value: UNIT_PRICE}(1);
    }

    function testZeroOwnerResponseIsUnknownNotSale() public {
        _deposit(pool, ALICE, 1);
        vm.mockCall(
            address(nft), abi.encodeWithSelector(nft.ownerOf.selector, defaultParams.circuitId), abi.encode(address(0))
        );
        vm.expectRevert(IPoolVault.TargetOwnerUnavailable.selector);
        pool.syncTargetAvailability();
        assertEq(pool.totalBnbOwed(), 0);
    }

    function testMalformedOwnerResponseIsUnknownNotSale() public {
        _deposit(pool, ALICE, 1);
        vm.mockCall(address(nft), abi.encodeWithSelector(nft.ownerOf.selector, defaultParams.circuitId), hex"11");
        vm.expectRevert();
        pool.syncTargetAvailability();
        assertEq(pool.totalBnbOwed(), 0);
    }

    function testUnsolicitedPoolCustodyIsNotExternalSale() public {
        _fundPool();
        nft.forceTransfer(address(pool), defaultParams.circuitId);
        assertFalse(pool.syncTargetAvailability());
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funded));
        assertEq(pool.totalBnbOwed(), 0);
    }

    function testOwnSuccessfulPurchaseNeverRefundsAndCallbackCannotCancel() public {
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        PurchaseMockMining(payable(Addresses.MINING)).configure(address(nft), defaultParams.circuitId, 0, 0);
        PurchaseMockMarket market = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);
        vm.prank(SELLER);
        nft.approve(address(market), defaultParams.circuitId);
        uint256 listingId = market.createListing(SELLER, address(nft), defaultParams.circuitId, 5 ether);
        nft.setReentryData(abi.encodeCall(IPoolVault.syncTargetAvailability, ()));
        _fundPool();
        pool.buyFromMarket(listingId);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Active));
        assertEq(nft.ownerOf(defaultParams.circuitId), address(pool));
        assertTrue(nft.reentryAttempted());
        assertFalse(nft.reentrySucceeded());
        vm.expectRevert(IPoolVault.WrongState.selector);
        pool.syncTargetAvailability();
        assertFalse(pool.refundsRecorded());
    }

    function _flexiblePool() private {
        _deployFactory();
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        PurchaseMockMining(payable(Addresses.MINING)).configure(address(nft), defaultParams.circuitId, 0, 0);
        defaultParams.targetRaise = 6.6 ether;
        IPoolVault.FlexiblePurchaseConfig memory c = IPoolVault.FlexiblePurchaseConfig(
            1,
            6 ether,
            100,
            1000,
            uint64(block.timestamp),
            uint64(block.number),
            keccak256("reference, not seller order")
        );
        vm.prank(OPERATOR);
        pool = IFundingVault(poolFactory.createFlexiblePool(defaultParams, c));
    }

    function testFlexiblePoolReferenceOwnerChangeDoesNotBlockSubscriptionOrCancel() public {
        _flexiblePool();
        nft.forceTransfer(OUTSIDE_BUYER, defaultParams.circuitId);
        _deposit(pool, ALICE, 20);
        vm.expectRevert(IPoolVault.FlexiblePurchaseDisabled.selector);
        pool.syncTargetAvailability();
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Funding));
        assertEq(pool.totalBnbOwed(), 0);
    }

    function testLegacyMissingBaselineBlocksDepositButPreservesWithdrawalAndFailure() public {
        _deposit(pool, ALICE, 20);
        _legacy();
        vm.deal(BOB, UNIT_PRICE);
        vm.prank(BOB);
        vm.expectRevert(IPoolVault.TargetOwnerNotConfigured.selector);
        pool.deposit{value: UNIT_PRICE}(1);
        vm.expectRevert(IPoolVault.TargetOwnerNotConfigured.selector);
        pool.syncTargetAvailability();
        vm.prank(ALICE);
        pool.withdrawDeposit();
        assertEq(pool.bnbOwed(ALICE), 20 * UNIT_PRICE);
        vm.prank(ALICE);
        pool.withdrawBnb();
        assertEq(pool.bnbOwed(ALICE), 0);
        vm.warp(defaultParams.fundingDeadline);
        pool.finalizeFailure();
        _assertRefund(0);
    }

    function testLegacyFundedNoBaselineRetainsDeadlineRefund() public {
        _fundPool();
        _legacy();
        vm.warp(defaultParams.purchaseDeadline);
        pool.finalizeFailure();
        _assertRefund(defaultParams.targetRaise);
    }

    function testLegacyTwoAdminMigrationKeepsAllDeliveredStateAndRefundsHistoricalOwnerChange() public {
        _fundPool();
        uint256 beforeBalance = address(pool).balance;
        _legacy();
        nft.forceTransfer(OUTSIDE_BUYER, defaultParams.circuitId);
        _configure(_authorization(SELLER));
        (address owner, bool configured, uint256 nonce) = pool.targetOwner();
        assertEq(owner, SELLER);
        assertTrue(configured);
        assertEq(nonce, 1);
        assertEq(address(pool).balance, beforeBalance);
        assertEq(pool.totalSupply(), 100);
        assertEq(pool.contributedWei(ALICE), 49 * UNIT_PRICE);
        assertEq(pool.balanceOf(ALICE), 49);
        assertEq(pool.params().priceCap, defaultParams.priceCap);
        assertEq(pool.factory(), address(poolFactory));
        assertTrue(pool.syncTargetAvailability());
        _assertRefund(defaultParams.targetRaise);
    }

    function testLegacyMigrationNeverLazilyUsesCurrentOwner() public {
        _legacy();
        nft.forceTransfer(OUTSIDE_BUYER, defaultParams.circuitId);
        (address owner, bool configured,) = pool.targetOwner();
        assertEq(owner, address(0));
        assertFalse(configured);
        _configure(_authorization(SELLER));
        (owner,,) = pool.targetOwner();
        assertEq(owner, SELLER);
    }

    function testCannotOverwriteNewPoolBaseline() public {
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(OUTSIDE_BUYER);
        vm.expectRevert(IPoolVault.TargetOwnerAlreadyConfigured.selector);
        _configure(a);
    }

    function testMigrationReplayAndSecondConfigurationRejected() public {
        _legacy();
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        _configure(a);
        vm.expectRevert(IPoolVault.TargetOwnerAlreadyConfigured.selector);
        _configure(a);
    }

    function testMigrationRequiresCanonicalEnvelopeAndFullSignatures() public {
        _legacy();
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        bytes32 digest = _digest(a, block.chainid, address(pool));
        bytes memory one = _signature(digest, ADMIN_ONE_KEY);
        bytes memory two = _signature(digest, ADMIN_TWO_KEY);
        bytes memory encoded = abi.encode(a, one, two);
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(bytes.concat(encoded, hex"00"));
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(abi.encode(a, hex"11", two));
        // Identical decoded signatures with nonzero trailing padding are not the canonical signed envelope.
        encoded[encoded.length - 1] = bytes1(uint8(1));
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(encoded);
        (address owner, bool configured, uint256 nonce) = pool.targetOwner();
        assertEq(owner, address(0));
        assertFalse(configured);
        assertEq(nonce, 0);
    }

    function testWrongChainAndPoolSignaturesRejected() public {
        _legacy();
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        bytes32 digest = _digest(a, block.chainid + 1, address(pool));
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(abi.encode(a, _signature(digest, ADMIN_ONE_KEY), _signature(digest, ADMIN_TWO_KEY)));
        digest = _digest(a, block.chainid, address(0xBAD));
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(abi.encode(a, _signature(digest, ADMIN_ONE_KEY), _signature(digest, ADMIN_TWO_KEY)));
    }

    function testNonceExpiredAndTamperedOwnerRejected() public {
        _legacy();
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        a.nonce = 1;
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        _configure(a);
        a.nonce = 0;
        a.deadline = block.timestamp - 1;
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        _configure(a);
        a.deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(a, block.chainid, address(pool));
        a.originalOwner = OUTSIDE_BUYER;
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(abi.encode(a, _signature(digest, ADMIN_ONE_KEY), _signature(digest, ADMIN_TWO_KEY)));
    }

    function testBothDistinctCurrentAdminsRequired() public {
        _legacy();
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        bytes32 digest = _digest(a, block.chainid, address(pool));
        bytes memory one = _signature(digest, ADMIN_ONE_KEY);
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(abi.encode(a, one, one));
        authority.setAdministrators(vm.addr(ADMIN_ONE_KEY), vm.addr(ADMIN_ONE_KEY));
        a.administratorTwo = a.administratorOne;
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        _configure(a);
        authority.setAdministrators(address(0), vm.addr(ADMIN_TWO_KEY));
        a.administratorOne = address(0);
        a.administratorTwo = vm.addr(ADMIN_TWO_KEY);
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        _configure(a);
    }

    function testRotatingCurrentAdminsInvalidatesPreviousAuthorization() public {
        _legacy();
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        bytes32 digest = _digest(a, block.chainid, address(pool));
        authority.setAdministrators(vm.addr(ADMIN_ONE_KEY), address(0x777));
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(abi.encode(a, _signature(digest, ADMIN_ONE_KEY), _signature(digest, ADMIN_TWO_KEY)));
    }

    function testAuthorityChangeInvalidatesPreviousAuthorization() public {
        _legacy();
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        bytes32 digest = _digest(a, block.chainid, address(pool));
        TargetOwnerAuthorityMock next = new TargetOwnerAuthorityMock(a.administratorOne, a.administratorTwo);
        vm.prank(OWNER);
        poolFactory.setOperator(address(next));
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(abi.encode(a, _signature(digest, ADMIN_ONE_KEY), _signature(digest, ADMIN_TWO_KEY)));
    }

    function testDepositPauseSignaturesCannotInitializeOwner() public {
        _legacy();
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        bytes32 pause = keccak256(
            abi.encode(
                keccak256("DepositPause(address pool,bool paused,uint256 nonce,uint256 deadline)"),
                address(pool),
                true,
                uint256(0),
                a.deadline
            )
        );
        vm.expectRevert(IPoolVault.InvalidTargetOwnerAuthorization.selector);
        pool.configureTargetOwner(abi.encode(a, _signature(pause, ADMIN_ONE_KEY), _signature(pause, ADMIN_TWO_KEY)));
    }

    function testFlexibleAndPostPurchaseStatesCannotMigrate() public {
        _flexiblePool();
        _legacy();
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        vm.expectRevert(IPoolVault.FlexiblePurchaseDisabled.selector);
        _configure(a);
    }

    function testAllPostFundingStatesCannotBeCancelledOrConfigured() public {
        _legacy();
        bytes32 stateSlot = bytes32(uint256(VAULT_STORAGE) + 9);
        IPoolVault.TargetOwnerAuthorization memory a = _authorization(SELLER);
        for (uint256 i = 2; i <= 5; ++i) {
            bytes32 raw = vm.load(address(pool), stateSlot);
            vm.store(address(pool), stateSlot, bytes32((uint256(raw) & ~uint256(255)) | i));
            vm.expectRevert(IPoolVault.WrongState.selector);
            pool.syncTargetAvailability();
            vm.expectRevert(IPoolVault.WrongState.selector);
            _configure(a);
            assertEq(pool.totalBnbOwed(), 0);
        }
    }
}
