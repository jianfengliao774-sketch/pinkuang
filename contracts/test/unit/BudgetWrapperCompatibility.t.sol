// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {PurchaseMockBem, PurchaseMockNft, PurchaseMockMining, PurchaseMockMarket} from "../utils/PurchaseMocks.sol";
import {Addresses} from "../../script/Addresses.sol";

/// @dev A test-only holder: it proves that a future common-share project can
/// atomically fund/acquire each existing single-miner child and collect its income.
/// It is deliberately not a deployable portfolio contract or a governance bypass.
contract BudgetHolderProbe {
    function fundAndBuy(IFundingVault child, uint256 listingId) external payable {
        require(child.totalSupply() == 0, "child already funded");
        require(child.params().targetRaise == msg.value, "wrong funding");
        child.deposit{value: msg.value}(100);
        child.buyFromMarket(listingId);
        require(child.state() == IPoolVault.State.Active && child.balanceOf(address(this)) == 100, "not acquired");
        child.withdrawBnb();
    }

    function collect(IFundingVault child) external {
        child.harvest();
        child.claim();
    }

    receive() external payable {}
}

contract BudgetWrapperCompatibilityTest is FundingTestBase {
    address private constant SELLER = address(0x5E11E2);
    BudgetHolderProbe private holder;
    PurchaseMockNft private nft;
    PurchaseMockBem private bem;
    PurchaseMockMining private mining;
    PurchaseMockMarket private market;

    function setUp() public override {
        super.setUp();
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        bem = PurchaseMockBem(Addresses.BEM);
        mining = PurchaseMockMining(payable(Addresses.MINING));
        market = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);
        holder = new BudgetHolderProbe();
        vm.deal(address(this), 20 ether);
    }

    function _list(uint256 id, uint96 price) private returns (uint256 listingId) {
        nft.mint(SELLER, id);
        mining.configure(address(nft), id, 1_000, 100);
        vm.prank(SELLER);
        nft.approve(address(market), id);
        listingId = market.createListing(SELLER, address(nft), id, price);
    }

    function test_twoChildrenCanBeBoughtByOneContractAndSurplusCollected() public {
        uint256 firstListing = _list(defaultParams.circuitId, 5 ether);
        holder.fundAndBuy{value: defaultParams.targetRaise}(pool, firstListing);

        IPoolVault.PoolParams memory secondParams = defaultParams;
        secondParams.circuitId += 1;
        IFundingVault second = _createPool(secondParams);
        uint256 secondListing = _list(secondParams.circuitId, 5.5 ether);
        holder.fundAndBuy{value: secondParams.targetRaise}(second, secondListing);

        assertEq(pool.balanceOf(address(holder)), 100);
        assertEq(second.balanceOf(address(holder)), 100);
        assertEq(nft.ownerOf(defaultParams.circuitId), address(pool));
        assertEq(nft.ownerOf(secondParams.circuitId), address(second));
        assertEq(address(holder).balance, 2.5 ether, "both child purchase surpluses return to project");

        mining.configure(address(nft), defaultParams.circuitId, 1_000_000, 0);
        mining.configure(address(nft), secondParams.circuitId, 2_000_000, 0);
        holder.collect(pool);
        holder.collect(second);
        assertGt(bem.balanceOf(address(holder)), 0, "both child BEM claims reach project address");
    }

    function test_failedSecondPurchaseRollsBackItsFundingWithoutAffectingFirst() public {
        uint256 firstListing = _list(defaultParams.circuitId, 5 ether);
        holder.fundAndBuy{value: defaultParams.targetRaise}(pool, firstListing);
        IPoolVault.PoolParams memory secondParams = defaultParams;
        secondParams.circuitId += 1;
        IFundingVault second = _createPool(secondParams);
        uint256 secondListing = _list(secondParams.circuitId, 5.5 ether);
        market.setBuyFault(4);

        vm.expectRevert(bytes("injected market failure"));
        holder.fundAndBuy{value: secondParams.targetRaise}(second, secondListing);

        assertEq(second.totalSupply(), 0, "failed transaction cannot strand project funds in child");
        assertEq(address(second).balance, 0);
        assertEq(nft.ownerOf(secondParams.circuitId), SELLER);
        assertEq(pool.balanceOf(address(holder)), 100, "earlier acquired machine remains owned by project");
    }
}
