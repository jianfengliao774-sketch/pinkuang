// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {BudgetPortfolioFactory} from "../../src/BudgetPortfolioFactory.sol";
import {BudgetPortfolioVault} from "../../src/BudgetPortfolioVault.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {PurchaseMockBem, PurchaseMockNft, PurchaseMockMining, PurchaseMockMarket} from "../utils/PurchaseMocks.sol";
import {Addresses} from "../../script/Addresses.sol";

contract BudgetPortfolioTest is FundingTestBase {
    address private constant SELLER = address(0x5E11E2);
    BudgetPortfolioFactory private portfolios;
    BudgetPortfolioVault private project;
    ShareMarket private shareMarket;
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

        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        BudgetPortfolioVault implementation = new BudgetPortfolioVault(predictedFactory);
        PoolBeacon portfolioBeacon = new PoolBeacon(address(implementation), address(timelock));
        BudgetPortfolioFactory factoryImplementation = new BudgetPortfolioFactory();
        portfolios = BudgetPortfolioFactory(
            address(
                new ERC1967Proxy(
                    address(factoryImplementation),
                    abi.encodeCall(
                        BudgetPortfolioFactory.initialize,
                        (OWNER, OPERATOR, TREASURY, address(timelock), address(portfolioBeacon), address(poolFactory))
                    )
                )
            )
        );
        assertEq(address(portfolios), predictedFactory);

        ShareMarket marketImplementation = new ShareMarket();
        shareMarket = ShareMarket(
            payable(address(
                    new ERC1967Proxy(
                        address(marketImplementation),
                        abi.encodeCall(ShareMarket.initialize, (address(portfolios), address(timelock)))
                    )
                ))
        );
        vm.prank(address(timelock));
        portfolios.registerShareMarket(address(shareMarket));
        vm.prank(OPERATOR);
        project = BudgetPortfolioVault(
            payable(portfolios.createPortfolio(
                    13 ether, 6 ether, 3 ether, uint64(block.timestamp + 7 days), uint64(block.timestamp + 10 days)
                ))
        );
    }

    function _subscribe(address member, uint8 shares) private {
        uint256 cost = uint256(shares) * 13 ether / 100;
        vm.deal(member, member.balance + cost);
        vm.prank(member);
        project.deposit{value: cost}(shares);
    }

    function _list(uint256 id, uint96 price) private returns (uint256 listingId) {
        nft.mint(SELLER, id);
        mining.configure(address(nft), id, 1_000, 100);
        vm.prank(SELLER);
        nft.approve(address(market), id);
        listingId = market.createListing(SELLER, address(nft), id, price);
    }

    function _buyTwo() private returns (IFundingVault second) {
        IPoolVault.PoolParams memory secondParams = defaultParams;
        secondParams.circuitId += 1;
        second = _createPool(secondParams);
        uint256 firstListing = _list(defaultParams.circuitId, 5 ether);
        uint256 secondListing = _list(secondParams.circuitId, 5.5 ether);
        vm.startPrank(OPERATOR);
        project.buyOfficial(address(pool), firstListing);
        project.buyOfficial(address(second), secondListing);
        vm.stopPrank();
    }

    function test_twoMachinesOneHundredSharesAndExactRefunds() public {
        _subscribe(ALICE, 60);
        _subscribe(BOB, 40);
        IFundingVault second = _buyTwo();
        assertEq(project.childCount(), 2);
        assertEq(project.activeChildCount(), 2);
        assertEq(pool.balanceOf(address(project)), 100);
        assertEq(second.balanceOf(address(project)), 100);
        assertEq(nft.ownerOf(defaultParams.circuitId), address(pool));
        assertEq(nft.ownerOf(defaultParams.circuitId + 1), address(second));
        assertEq(project.spentWei(), 10.5 ether);
        assertEq(address(project).balance, 2.5 ether);

        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        assertEq(uint256(project.state()), uint256(IPoolVault.State.Active));
        assertEq(project.purchaseFeeWei(), 0.105 ether);
        assertEq(project.refundPerShareWei(), 0.02395 ether);
        vm.prank(ALICE);
        assertEq(project.withdrawBnb(), 1.437 ether);
        vm.prank(BOB);
        assertEq(project.withdrawBnb(), 0.958 ether);
        vm.prank(TREASURY);
        assertEq(project.withdrawBnb(), 0.105 ether);
        assertEq(address(project).balance, 0);
    }

    function test_zeroMachinesRefundsBudgetOnceAndCannotBurnForSecondRefund() public {
        _subscribe(ALICE, 100);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        assertEq(uint256(project.state()), uint256(IPoolVault.State.Refunding));
        vm.prank(ALICE);
        assertEq(project.withdrawBnb(), 13 ether);
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.WrongState.selector);
        project.claimFailedFunding();
        assertEq(address(project).balance, 0);
    }

    function test_competingWalletsForLastShareCannotOverfundProject() public {
        _subscribe(ALICE, 99);
        _subscribe(BOB, 1);
        vm.deal(CAROL, 0.13 ether);
        vm.prank(CAROL);
        vm.expectRevert(BudgetPortfolioVault.WrongState.selector);
        project.deposit{value: 0.13 ether}(1);
        assertEq(project.totalSupply(), 100);
        assertEq(project.balanceOf(ALICE), 99);
        assertEq(project.balanceOf(BOB), 1);
        assertEq(project.balanceOf(CAROL), 0);
        assertEq(address(project).balance, 13 ether);
    }

    function test_failedSecondPurchaseLeavesBudgetAndEarlierMachineUntouched() public {
        _subscribe(ALICE, 100);
        uint256 firstListing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), firstListing);
        IPoolVault.PoolParams memory secondParams = defaultParams;
        secondParams.circuitId += 1;
        IFundingVault second = _createPool(secondParams);
        uint256 secondListing = _list(secondParams.circuitId, 5.5 ether);
        market.setBuyFault(4);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("injected market failure"));
        project.buyOfficial(address(second), secondListing);
        assertEq(project.childCount(), 1);
        assertEq(project.spentWei(), 5 ether);
        assertEq(address(project).balance, 8 ether);
        assertEq(second.totalSupply(), 0);
        assertEq(address(second).balance, 0);
        assertEq(nft.ownerOf(secondParams.circuitId), SELLER);
    }

    function test_operatorOnlyAndPerWeightCapIsCheckedBeforeFundingChild() public {
        _subscribe(ALICE, 100);
        uint256 listing = _list(defaultParams.circuitId, 2 ether);
        vm.prank(BOB);
        vm.expectRevert(BudgetPortfolioVault.Unauthorized.selector);
        project.buyOfficial(address(pool), listing);
        bytes32 key = mining.minerKey(address(nft), defaultParams.circuitId);
        mining.setVerifiedWeight(key, 1);
        vm.prank(OPERATOR);
        vm.expectRevert(BudgetPortfolioVault.OverPriceCap.selector);
        project.buyOfficial(address(pool), listing);
        assertEq(pool.totalSupply(), 0);
        assertEq(address(project).balance, 13 ether);
        mining.setVerifiedWeight(key, 2);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        assertEq(project.spentWei(), 2 ether);
    }

    function test_oneClaimCombinesTwoMinerRewardsAndUnclaimedBemMovesWithShares() public {
        _subscribe(ALICE, 60);
        _subscribe(BOB, 40);
        IFundingVault second = _buyTwo();
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        mining.configure(address(nft), defaultParams.circuitId, 1_000_000, 0);
        mining.configure(address(nft), defaultParams.circuitId + 1, 2_000_000, 0);
        project.collectChildBem(address(pool));
        project.collectChildBem(address(second));
        uint256 aliceBefore = project.claimableBem(ALICE);
        uint256 bobBefore = project.claimableBem(BOB);
        assertEq(aliceBefore + bobBefore, bem.balanceOf(address(project)));
        vm.prank(ALICE);
        project.transfer(BOB, 10);
        assertEq(project.claimableBem(ALICE), aliceBefore * 50 / 60);
        assertEq(project.claimableBem(BOB), bobBefore + aliceBefore / 6);
        vm.prank(BOB);
        uint256 claimed = project.claimBem();
        assertEq(claimed, bem.balanceOf(BOB));
        assertEq(project.claimableBem(BOB), 0);
    }

    function test_manuallyClaimedBemStaysWithSellerAndOnlyLaterIncomeFollowsShares() public {
        _subscribe(ALICE, 100);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();

        mining.configure(address(nft), defaultParams.circuitId, 1_000_000, 0);
        project.collectChildBem(address(pool));
        vm.prank(ALICE);
        uint256 alreadyClaimed = project.claimBem();
        assertGt(alreadyClaimed, 0);

        vm.prank(ALICE);
        project.transfer(BOB, 40);
        assertEq(project.claimableBem(BOB), 0);
        assertEq(bem.balanceOf(ALICE), alreadyClaimed);

        mining.configure(address(nft), defaultParams.circuitId, 500_000, 0);
        project.collectChildBem(address(pool));
        assertEq(project.claimableBem(BOB) * 3, project.claimableBem(ALICE) * 2);
        vm.prank(BOB);
        uint256 buyerClaim = project.claimBem();
        assertEq(bem.balanceOf(BOB), buyerClaim);
        assertEq(bem.balanceOf(ALICE), alreadyClaimed);
    }

    function test_portfolioDeadlinesMustBeBounded() public {
        vm.prank(OPERATOR);
        vm.expectRevert(BudgetPortfolioVault.InvalidParameters.selector);
        portfolios.createPortfolio(
            13 ether, 6 ether, 3 ether, uint64(block.timestamp + 31 days), uint64(block.timestamp + 34 days)
        );
        vm.prank(OPERATOR);
        vm.expectRevert(BudgetPortfolioVault.InvalidParameters.selector);
        portfolios.createPortfolio(
            13 ether, 6 ether, 3 ether, uint64(block.timestamp + 1 days), uint64(block.timestamp + 9 days)
        );
    }

    function test_existingChildBemCanBeCollectedWhenNextHarvestFails() public {
        _subscribe(ALICE, 100);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        mining.configure(address(nft), defaultParams.circuitId, 1_000_000, 0);
        pool.harvest();
        mining.setClaimFault(1);
        uint256 collected = project.collectChildBem(address(pool));
        assertGt(collected, 0);
        vm.prank(ALICE);
        assertEq(project.claimBem(), collected);
    }

    function test_memberVoteControlsChildSaleAndProceedsAreBookedOnce() public {
        _subscribe(ALICE, 60);
        _subscribe(BOB, 40);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();

        vm.prank(ALICE);
        uint256 proposalId = project.proposeChildSale(address(pool), 4 ether, 5 ether, uint64(block.timestamp));
        assertFalse(project.shareTradingAllowed());
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.WrongState.selector);
        project.transfer(BOB, 1);
        vm.prank(ALICE);
        project.voteChildSale(proposalId, true);
        vm.expectRevert(BudgetPortfolioVault.ProposalNotPassed.selector);
        project.executeChildSale(proposalId);
        vm.prank(BOB);
        project.voteChildSale(proposalId, true);
        project.executeChildSale(proposalId);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));

        vm.deal(CAROL, 4 ether);
        vm.prank(CAROL);
        pool.completeSale{value: 4 ether}();
        assertEq(project.settleChildSale(), 3.96 ether);
        assertEq(uint256(project.state()), uint256(IPoolVault.State.Closed));
        assertEq(nft.ownerOf(defaultParams.circuitId), CAROL);
        vm.prank(ALICE);
        assertEq(project.withdrawBnb(), 7.146 ether, "60% of refund plus net sale price");
        vm.prank(BOB);
        assertEq(project.withdrawBnb(), 4.764 ether);
        vm.prank(TREASURY);
        assertEq(project.withdrawBnb(), 0.05 ether);
        assertEq(address(project).balance, 0);
    }

    function test_shareMarketChargesBothSidesAndMovesUnclaimedBemToBuyer() public {
        _subscribe(ALICE, 100);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        mining.configure(address(nft), defaultParams.circuitId, 1_000_000, 0);
        project.collectChildBem(address(pool));
        uint256 beforeBem = project.claimableBem(ALICE);

        vm.prank(ALICE);
        uint256 orderId = shareMarket.list(address(project), 10, 0.1 ether);
        vm.deal(BOB, 1.01 ether);
        vm.prank(BOB);
        shareMarket.fill{value: 1.01 ether}(orderId, 10);

        assertEq(project.balanceOf(ALICE), 90);
        assertEq(project.balanceOf(BOB), 10);
        assertEq(project.claimableBem(ALICE), beforeBem * 90 / 100);
        assertEq(project.claimableBem(BOB), beforeBem / 10);
        assertEq(shareMarket.bnbOwed(ALICE), 0.99 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.02 ether);
    }

    function test_belowCostSaleNeedsSixtySharesEvenWithAddressMajority() public {
        _subscribe(ALICE, 29);
        _subscribe(BOB, 30);
        _subscribe(CAROL, 41);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        vm.prank(ALICE);
        uint256 id = project.proposeChildSale(address(pool), 4 ether, 5 ether, uint64(block.timestamp));
        vm.prank(ALICE);
        project.voteChildSale(id, true);
        vm.prank(BOB);
        project.voteChildSale(id, true);
        vm.expectRevert(BudgetPortfolioVault.ProposalNotPassed.selector);
        project.executeChildSale(id);
        vm.prank(CAROL);
        project.voteChildSale(id, true);
        project.executeChildSale(id);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
    }
}
