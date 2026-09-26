// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {SaleTestBase} from "../utils/SaleTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {PoolVault} from "../../src/PoolVault.sol";

/// @dev Builds the pre-upgrade sale ledger without deploying or calling a swap router.
contract LegacySaleVaultFixture is PoolVault {
    constructor(address factory_) PoolVault(factory_) {}

    function fixtureLegacyListing(uint256 price, uint256 yesShares, uint256 yesCount) external {
        SaleStorage storage s = _saleStorage();
        require(_vaultStorage().state == State.Listed, "listed fixture");
        s.salePrice = price;
        s.proposals[s.listedProposalId].price = price;
        s.proposals[s.listedProposalId].yesShares = yesShares;
        s.proposals[s.listedProposalId].yesCount = yesCount;
    }

    function fixtureLegacyClosedSale(uint256 alreadySpent) external {
        SaleStorage storage s = _saleStorage();
        require(_vaultStorage().state == State.Closed, "closed fixture");
        uint256 fee = s.saleProceeds / 50;
        require(alreadySpent <= fee, "fixture budget");
        uint256 oldNet = s.saleProceeds - fee * 2;
        s.salePerShareWei = oldNet / 100;
        s.saleRemainder = oldNet % 100;
        s.saleOutstandingWei = s.salePerShareWei * 100;
        s.burnBudget = fee - alreadySpent;
        s.totalBurnBnbSpent = alreadySpent;
        s.saleRoundingRecipient = address(0);
        s.legacyBurnBudgetReleased = false;
    }

    function fixturePayOldSale(address member) external {
        SaleStorage storage s = _saleStorage();
        require(!s.saleSettled[member], "paid fixture");
        uint256 amount = balanceOf(member) * s.salePerShareWei;
        s.saleSettled[member] = true;
        s.saleOutstandingWei -= amount;
        (bool ok,) = member.call{value: amount}("");
        require(ok, "payment fixture");
    }
}

contract SaleBudgetMigrationTest is SaleTestBase {
    LegacySaleVaultFixture private legacy;

    function setUp() public override {
        super.setUp();
        LegacySaleVaultFixture implementation = new LegacySaleVaultFixture(address(poolFactory));
        bytes memory upgrade = abi.encodeWithSignature("upgradeTo(address)", address(implementation));
        bytes32 salt = keccak256("legacy-sale-fixture");
        vm.prank(OWNER);
        timelock.schedule(address(beacon), 0, upgrade, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(beacon), 0, upgrade, bytes32(0), salt);
        legacy = LegacySaleVaultFixture(payable(address(pool)));
        _listSale(10003);
        _complete(NFT_BUYER, 10003);
    }

    function test_oldPaidHolderReceivesOnlyIndependentBonusAndNoDoublePayment() public {
        legacy.fixtureLegacyClosedSale(0);
        legacy.fixturePayOldSale(ALICE);
        assertEq(sale.pendingSaleProceeds(ALICE), 98);
        assertEq(sale.pendingSaleProceeds(BOB), 4802);
        assertEq(sale.pendingSaleProceeds(CAROL), 199);
        assertEq(_withdraw(ALICE), 0.735 ether + 98);
        assertEq(sale.pendingSaleProceeds(ALICE), 0);
        assertEq(sale.burnBudget(), 0);
        assertEq(_withdraw(BOB), 0.735 ether + 4802);
        assertEq(_withdraw(CAROL), 0.03 ether + 199);
        assertEq(_withdraw(TREASURY), 200);
        assertEq(address(pool).balance, 0);
        assertEq(pool.totalBnbOwed(), 0);
    }

    function test_onlyRemainingBudgetReleasedAlreadySpentValueNeverRecreated() public {
        legacy.fixtureLegacyClosedSale(150);
        vm.deal(address(pool), address(pool).balance - 150);
        // 53 residual wei cannot make a per-share unit; fixed last holder receives them.
        assertEq(sale.pendingSaleProceeds(ALICE), 4704);
        assertEq(sale.pendingSaleProceeds(CAROL), 245);
        _withdraw(ALICE);
        _withdraw(BOB);
        _withdraw(CAROL);
        _withdraw(TREASURY);
        assertEq(saleVault.totalBurnBnbSpent(), 150);
        assertEq(address(pool).balance, 0);
        assertEq(pool.totalBnbOwed(), 0);
    }
}

contract LegacyListedSaleMigrationTest is SaleTestBase {
    LegacySaleVaultFixture private legacy;

    function setUp() public override {
        super.setUp();
        LegacySaleVaultFixture implementation = new LegacySaleVaultFixture(address(poolFactory));
        bytes memory upgrade = abi.encodeWithSignature("upgradeTo(address)", address(implementation));
        bytes32 salt = keccak256("legacy-listed-fixture");
        vm.prank(OWNER);
        timelock.schedule(address(beacon), 0, upgrade, bytes32(0), salt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(beacon), 0, upgrade, bytes32(0), salt);
        legacy = LegacySaleVaultFixture(payable(address(pool)));
        _listSale(SALE_PRICE);
    }

    function test_legacyZeroPriceListingCannotCompleteAndCanExpire() public {
        legacy.fixtureLegacyListing(0, 98, 2);
        vm.expectRevert(IPoolVault.InvalidSalePrice.selector);
        _complete(NFT_BUYER, 0);
        vm.warp(sale.expiresAt());
        sale.cancelExpired();
        _stateIs(IPoolVault.State.Active);
        assertEq(nft.ownerOf(rewardId), address(pool));
    }

    function test_legacyDiscountListingWithFiftyOneSharesCannotComplete() public {
        legacy.fixtureLegacyListing(1, 51, 2);
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        _complete(NFT_BUYER, 1);
        _stateIs(IPoolVault.State.Listed);
        assertEq(nft.ownerOf(rewardId), address(pool));
    }

    function test_discountRequiresBothSixtySharesAndAddressMajority() public {
        legacy.fixtureLegacyListing(1, 60, 1);
        vm.expectRevert(IPoolVault.ProposalNotPassed.selector);
        _complete(NFT_BUYER, 1);
        legacy.fixtureLegacyListing(1, 60, 2);
        _complete(NFT_BUYER, 1);
        _stateIs(IPoolVault.State.Closed);
        assertEq(sale.pendingSaleProceeds(CAROL), 1);
        assertEq(sale.saleOutstandingWei(), 1);
    }
}
