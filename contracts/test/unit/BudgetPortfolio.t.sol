// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {FundingTestBase, IFundingVault} from "../utils/FundingTestBase.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {BudgetPortfolioFactory} from "../../src/BudgetPortfolioFactory.sol";
import {BudgetPortfolioVault} from "../../src/BudgetPortfolioVault.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {PlatformAuthority} from "../../src/PlatformAuthority.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IShareMarket} from "../../src/interfaces/IShareMarket.sol";
import {PurchaseMockBem, PurchaseMockNft, PurchaseMockMining, PurchaseMockMarket} from "../utils/PurchaseMocks.sol";
import {Addresses} from "../../script/Addresses.sol";
import {FirstoSignedAskMock} from "../utils/FirstoMocks.sol";
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";

contract BudgetRoundAttacker {
    function expireThenPropose(BudgetPortfolioVault project, address child) external {
        project.expireChildSale();
        project.proposeChildSale(child, 1, 0, 0);
    }
}

contract WrongLegacyBudgetFactory {
    function legacyFactory() external pure returns (address) {
        return address(0xBAD);
    }
}

contract BudgetPortfolioTest is FundingTestBase {
    address private constant SELLER = address(0x5E11E2);
    BudgetPortfolioFactory private portfolios;
    BudgetPortfolioVault private project;
    ShareMarket private shareMarket;
    ShareMarket private coreShareMarket;
    PurchaseMockNft private nft;
    PurchaseMockBem private bem;
    PurchaseMockMining private mining;
    PurchaseMockMarket private market;

    function setUp() public override {
        super.setUp();
        vm.chainId(56);
        address firsto = 0x33423244F9a5bF81b12B1a018aF6F4e079B97f29;
        vm.etch(firsto, address(new FirstoSignedAskMock()).code);
        FirstoSignedAskMock(firsto).configure(Addresses.PROTOCOL_FACTORY, 0, 1);
        vm.etch(Addresses.TAPEOUT_CIRCUITS, address(new PurchaseMockNft()).code);
        vm.etch(Addresses.BEM, address(new PurchaseMockBem()).code);
        vm.etch(Addresses.MINING, address(new PurchaseMockMining()).code);
        vm.etch(Addresses.CIRCUIT_MARKET, address(new PurchaseMockMarket()).code);
        nft = PurchaseMockNft(Addresses.TAPEOUT_CIRCUITS);
        bem = PurchaseMockBem(Addresses.BEM);
        mining = PurchaseMockMining(payable(Addresses.MINING));
        market = PurchaseMockMarket(Addresses.CIRCUIT_MARKET);

        ShareMarket coreImplementation = new ShareMarket();
        coreShareMarket = ShareMarket(
            payable(address(
                    new ERC1967Proxy(
                        address(coreImplementation),
                        abi.encodeCall(ShareMarket.initialize, (address(poolFactory), address(timelock)))
                    )
                ))
        );
        bytes memory registration = abi.encodeCall(poolFactory.registerShareMarket, (address(coreShareMarket)));
        bytes32 registrationSalt = keccak256("budget-core-market-registration");
        vm.prank(OWNER);
        timelock.schedule(address(poolFactory), 0, registration, bytes32(0), registrationSalt, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(poolFactory), 0, registration, bytes32(0), registrationSalt);

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

        vm.prank(address(timelock));
        coreShareMarket.setBudgetFactoryTrust(address(portfolios), true);

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
        defaultParams.circuitId += 1;
        pool = _createBudgetPool(defaultParams);
    }

    function _createBudgetPool(IPoolVault.PoolParams memory params) private returns (IFundingVault child) {
        vm.prank(OPERATOR);
        child = IFundingVault(poolFactory.createBudgetChildPool(params, address(project)));
    }

    function _subscribe(address member, uint8 shares) private {
        uint256 cost = uint256(shares) * 13 ether / 100;
        vm.deal(member, member.balance + cost);
        vm.prank(member);
        project.deposit{value: cost}(shares);
    }

    function test_onlyPortfolioCanSubscribeToReservedChildAcrossTransactions() public {
        assertEq(poolFactory.designatedSubscriber(address(pool)), address(project));
        vm.deal(ALICE, UNIT_PRICE);
        vm.prank(ALICE);
        vm.expectRevert(IPoolVault.Unauthorized.selector);
        pool.deposit{value: UNIT_PRICE}(1);
        assertEq(pool.totalSupply(), 0);
        _subscribe(ALICE, 100);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        assertEq(project.childCount(), 1);
        assertEq(pool.balanceOf(address(project)), 100);
    }

    function test_factoryTreasuryChangeDoesNotBlockFundedPortfolioPurchase() public {
        _subscribe(ALICE, 100);
        address updatedTreasury = address(0xBEEF);
        vm.prank(OWNER);
        poolFactory.setTreasury(updatedTreasury);
        IPoolVault.PoolParams memory params = defaultParams;
        params.circuitId += 20;
        IFundingVault child = _createBudgetPool(params);
        assertEq(child.treasury(), updatedTreasury);
        uint256 listing = _list(params.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(child), listing);
        assertEq(project.childCount(), 1);
    }

    function test_budgetFactoryTreasuryChangeAffectsFutureProjectsOnly() public {
        address updatedTreasury = address(0xBEEF);
        vm.prank(ALICE);
        vm.expectRevert();
        portfolios.setTreasury(updatedTreasury);
        vm.prank(OWNER);
        vm.expectRevert(BudgetPortfolioFactory.InvalidAddress.selector);
        portfolios.setTreasury(address(0));
        vm.prank(OWNER);
        portfolios.setTreasury(updatedTreasury);
        assertEq(project.treasury(), TREASURY);
        vm.prank(OPERATOR);
        BudgetPortfolioVault later = BudgetPortfolioVault(
            payable(portfolios.createPortfolio(
                    1 ether, 1 ether, 1 ether, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days)
                ))
        );
        assertEq(later.treasury(), updatedTreasury);
    }

    function _list(uint256 id, uint96 price) private returns (uint256 listingId) {
        nft.mint(SELLER, id);
        mining.configure(address(nft), id, 1_000, 100);
        vm.prank(SELLER);
        nft.approve(address(market), id);
        listingId = market.createListing(SELLER, address(nft), id, price);
    }

    function _saleReference(uint256 price) private {
        vm.prank(OPERATOR);
        coreShareMarket.setSaleReference(
            address(pool), uint128(price), uint64(block.timestamp), keccak256("test-firsto-reference")
        );
    }

    function _buyTwo() private returns (IFundingVault second) {
        IPoolVault.PoolParams memory secondParams = defaultParams;
        secondParams.circuitId += 1;
        second = _createBudgetPool(secondParams);
        uint256 firstListing = _list(defaultParams.circuitId, 5 ether);
        uint256 secondListing = _list(secondParams.circuitId, 5.5 ether);
        vm.startPrank(OPERATOR);
        project.buyOfficial(address(pool), firstListing);
        project.buyOfficial(address(second), secondListing);
        vm.stopPrank();
    }

    function _completeChildSale(IFundingVault child, uint256 price) private {
        vm.prank(ALICE);
        uint256 proposalId = project.proposeChildSale(address(child), price, price, uint64(block.timestamp));
        vm.prank(ALICE);
        project.voteChildSale(proposalId, true);
        vm.prank(BOB);
        project.voteChildSale(proposalId, true);
        vm.prank(OPERATOR);
        coreShareMarket.setSaleReference(
            address(child), uint128(price), uint64(block.timestamp), keccak256("child-sale-claim-retry")
        );
        project.executeChildSale(proposalId);
        uint256 childProposalId = PoolVault(payable(address(child))).listedProposalId();
        vm.deal(CAROL, price);
        vm.prank(CAROL);
        PoolVault(payable(address(child))).completeFirstoSale{value: price}(childProposalId, price, 0, 1);
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

    function test_exactCostOfficialChildPurchaseNeedsNoSurplusWithdrawal() public {
        _subscribe(ALICE, 100);
        IPoolVault.PoolParams memory params = defaultParams;
        params.circuitId += 10;
        params.targetRaise = 5 ether;
        params.priceCap = 5 ether;
        IFundingVault child = _createBudgetPool(params);
        uint256 listingId = _list(params.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(child), listingId);
        assertEq(project.childCount(), 1);
        assertEq(project.spentWei(), 5 ether);
        assertEq(address(project).balance, 8 ether);
        assertEq(child.bnbOwed(address(project)), 0);
        assertEq(nft.ownerOf(params.circuitId), address(child));
    }

    function test_oddOfficialPriceReturnsEveryWeiToSoleProjectHolder() public {
        _subscribe(ALICE, 100);
        IPoolVault.PoolParams memory params = defaultParams;
        params.circuitId += 11;
        params.targetRaise = 5 ether;
        params.priceCap = 5 ether;
        IFundingVault child = _createBudgetPool(params);
        uint96 price = uint96(5 ether - 1);
        uint256 listingId = _list(params.circuitId, price);

        vm.prank(OPERATOR);
        project.buyOfficial(address(child), listingId);

        assertEq(project.childCount(), 1);
        assertEq(project.spentWei(), price);
        assertEq(address(project).balance, 13 ether - price);
        assertEq(address(child).balance, 0);
        assertEq(child.bnbOwed(address(project)), 0);
        assertEq(nft.ownerOf(params.circuitId), address(child));
    }

    function test_exactCostFirstoChildIncludingBuyerFeeNeedsNoSurplusWithdrawal() public {
        _subscribe(ALICE, 100);
        IPoolVault.PoolParams memory params = defaultParams;
        params.circuitId += 10;
        params.targetRaise = 5.05 ether;
        params.priceCap = 5.05 ether;
        IFundingVault child = _createBudgetPool(params);
        address maker = vm.addr(0xBEEF);
        nft.mint(maker, params.circuitId);
        mining.configure(address(nft), params.circuitId, 1_000, 100);
        address firsto = 0x33423244F9a5bF81b12B1a018aF6F4e079B97f29;
        FirstoSignedAskMock(firsto).configure(Addresses.PROTOCOL_FACTORY, 100, 1);
        vm.prank(maker);
        nft.approve(firsto, params.circuitId);
        IFirstoSignedAskExchange.SignedAsk memory ask = IFirstoSignedAskExchange.SignedAsk({
            maker: maker,
            collection: address(nft),
            tokenId: params.circuitId,
            nonce: 7,
            price: 5 ether,
            expiry: uint64(block.timestamp + 1 days),
            payoutRecipient: maker,
            feeBps: 100,
            feeEpoch: 1,
            schemaVersion: 2
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBEEF, FirstoSignedAskMock(firsto).hash(ask));
        vm.prank(OPERATOR);
        project.buyFirsto(address(child), abi.encode(ask, abi.encodePacked(r, s, v)));
        assertEq(project.childCount(), 1);
        assertEq(project.spentWei(), 5.05 ether);
        assertEq(address(project).balance, 7.95 ether);
        assertEq(child.bnbOwed(address(project)), 0);
        assertEq(nft.ownerOf(params.circuitId), address(child));
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
        IFundingVault second = _createBudgetPool(secondParams);
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
        _saleReference(4 ether);
        project.executeChildSale(proposalId);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));

        vm.deal(CAROL, 4 ether);
        vm.prank(CAROL);
        pool.completeFirstoSale{value: 4 ether}(1, 4 ether, 0, 1);
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

    function test_closedChildClaimFailureDoesNotBlockSaleProceedsAndCanRetry() public {
        _subscribe(ALICE, 60);
        _subscribe(BOB, 40);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        mining.configure(address(nft), defaultParams.circuitId, 1_000_000, 0);
        _completeChildSale(pool, 4 ether);

        uint256 childBem = PoolVault(payable(address(pool))).claimable(address(project));
        assertGt(childBem, 0);
        vm.mockCallRevert(
            address(pool), abi.encodeWithSelector(IPoolVault.claim.selector), "child BEM claim unavailable"
        );
        vm.expectRevert();
        project.collectChildBem(address(pool));

        assertEq(project.settleChildSale(), 3.96 ether);
        assertEq(project.activeProposalId(), 0);
        assertEq(project.activeChildCount(), 0);
        assertEq(uint256(project.state()), uint256(IPoolVault.State.Closed));
        assertEq(project.claimableBem(ALICE), 0, "unreceived BEM cannot become a parent liability");
        vm.prank(ALICE);
        assertEq(project.withdrawBnb(), 7.146 ether);
        vm.prank(BOB);
        assertEq(project.withdrawBnb(), 4.764 ether);

        vm.clearMockedCalls();
        uint256 collected = project.collectChildBem(address(pool));
        assertEq(collected, childBem);
        assertEq(project.claimableBem(ALICE), collected * 60 / 100);
        assertEq(project.claimableBem(BOB), collected * 40 / 100);
        vm.prank(ALICE);
        assertEq(project.claimBem(), collected * 60 / 100);
        vm.prank(BOB);
        assertEq(project.claimBem(), collected * 40 / 100);
    }

    function test_soldChildDelayedBemFollowsTransferredSharesWithAnotherChildActive() public {
        _subscribe(ALICE, 60);
        _subscribe(BOB, 40);
        IFundingVault second = _buyTwo();
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        mining.configure(address(nft), defaultParams.circuitId, 1_000_000, 0);
        mining.configure(address(nft), defaultParams.circuitId + 1, 2_000_000, 0);
        _completeChildSale(pool, 4 ether);

        vm.mockCallRevert(
            address(pool), abi.encodeWithSelector(IPoolVault.claim.selector), "child BEM claim unavailable"
        );
        assertEq(project.settleChildSale(), 3.96 ether);
        assertEq(project.activeChildCount(), 1);
        assertEq(uint256(project.state()), uint256(IPoolVault.State.Active));
        assertTrue(project.shareTradingAllowed());
        vm.expectRevert();
        project.collectChildBem(address(pool));
        vm.prank(ALICE);
        assertEq(project.withdrawBnb(), 3.813 ether);
        vm.prank(BOB);
        assertEq(project.withdrawBnb(), 2.542 ether);

        vm.prank(ALICE);
        project.transfer(BOB, 10);
        assertEq(project.balanceOf(ALICE), 50);
        assertEq(project.balanceOf(BOB), 50);
        vm.clearMockedCalls();
        uint256 soldBem = project.collectChildBem(address(pool));
        assertEq(project.claimableBem(ALICE), soldBem / 2);
        assertEq(project.claimableBem(BOB), soldBem / 2);
        uint256 activeBem = project.collectChildBem(address(second));
        assertEq(project.claimableBem(ALICE), (soldBem + activeBem) / 2);
        assertEq(project.claimableBem(BOB), (soldBem + activeBem) / 2);
        vm.prank(ALICE);
        assertEq(project.claimBem(), (soldBem + activeBem) / 2);
        vm.prank(BOB);
        assertEq(project.claimBem(), (soldBem + activeBem) / 2);
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
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.RewardsLocked.selector);
        project.claimBem();
        vm.deal(BOB, 1.01 ether);
        vm.prank(BOB);
        shareMarket.fill{value: 1.01 ether}(orderId, 10);

        assertEq(project.balanceOf(ALICE), 90);
        assertEq(project.balanceOf(BOB), 10);
        assertEq(project.claimableBem(ALICE), beforeBem * 90 / 100);
        assertEq(project.claimableBem(BOB), beforeBem / 10);
        vm.prank(BOB);
        assertEq(project.claimBem(), beforeBem / 10);
        vm.prank(ALICE);
        assertEq(project.claimBem(), beforeBem * 90 / 100);
        assertEq(shareMarket.bnbOwed(ALICE), 0.99 ether);
        assertEq(shareMarket.bnbOwed(TREASURY), 0.02 ether);
    }

    function test_sellerCanClaimBemAfterCancellingShareOrder() public {
        _subscribe(ALICE, 100);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        mining.configure(address(nft), defaultParams.circuitId, 1_000_000, 0);
        project.collectChildBem(address(pool));
        uint256 pending = project.claimableBem(ALICE);

        vm.prank(ALICE);
        uint256 orderId = shareMarket.list(address(project), 10, 0.1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.RewardsLocked.selector);
        project.claimBem();

        vm.prank(ALICE);
        shareMarket.cancel(orderId);
        vm.prank(ALICE);
        assertEq(project.claimBem(), pending);
    }

    function test_belowEightyPercentSaleNeedsPlatformReviewAfterDoubleMajority() public {
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
        _saleReference(6 ether);
        vm.expectRevert(BudgetPortfolioVault.ProposalNotPassed.selector);
        project.executeChildSale(id);
        uint256 childProposalId = PoolVault(payable(address(pool))).nextProposalId();
        vm.startPrank(OPERATOR);
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        coreShareMarket.reviewSale(address(pool), childProposalId, 4 ether, false);
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        coreShareMarket.reviewSale(address(pool), childProposalId, 4 ether, true);
        vm.stopPrank();
        uint256 adminKey = 0xA11CE;
        address admin = vm.addr(adminKey);
        PlatformAuthority authority =
            new PlatformAuthority(address(poolFactory), address(portfolios), admin, vm.addr(0xB0B), address(0xFEE));
        vm.prank(OWNER);
        poolFactory.setOperator(address(authority));
        vm.prank(OWNER);
        portfolios.setOperator(address(authority));
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BEMine Platform Authority"),
                keccak256("1"),
                block.chainid,
                address(authority)
            )
        );
        bytes32 operation = keccak256(
            abi.encode(authority.REVIEW_CHILD_SALE_TYPEHASH(), address(project), id, true, uint256(0), deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(adminKey, keccak256(abi.encodePacked("\x19\x01", domain, operation)));
        vm.prank(admin);
        authority.reviewChildSale(address(project), id, true, 0, deadline, abi.encodePacked(r, s, v));
        (uint8 status, uint128 price) = coreShareMarket.saleReview(address(pool), childProposalId);
        assertEq(status, 0, "review is bound only to a real child proposal at execution");
        assertEq(price, 0);
        project.executeChildSale(id);
        (status, price) = coreShareMarket.saleReview(address(pool), childProposalId);
        assertEq(status, 1);
        assertEq(price, 4 ether);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
    }

    function test_discountedChildSaleUsesTimelockTrustedFactoryAfterCoreOperatorRotation() public {
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
        _saleReference(6 ether);
        vm.prank(OPERATOR);
        project.reviewChildSale(id, true);

        vm.prank(OPERATOR);
        vm.expectRevert(IShareMarket.Unauthorized.selector);
        coreShareMarket.setBudgetFactoryTrust(address(portfolios), false);
        vm.prank(address(timelock));
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        coreShareMarket.setBudgetFactoryTrust(address(0xBAD), true);
        WrongLegacyBudgetFactory wrongFactory = new WrongLegacyBudgetFactory();
        vm.prank(address(timelock));
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        coreShareMarket.setBudgetFactoryTrust(address(wrongFactory), true);
        vm.prank(address(timelock));
        coreShareMarket.setBudgetFactoryTrust(address(portfolios), false);
        assertFalse(coreShareMarket.budgetFactoryTrusted(address(portfolios)));
        vm.expectRevert(ShareMarket.InvalidSaleReference.selector);
        project.executeChildSale(id);

        vm.prank(address(timelock));
        coreShareMarket.setBudgetFactoryTrust(address(portfolios), true);
        vm.prank(OWNER);
        poolFactory.setOperator(address(0xBEEF));
        project.executeChildSale(id);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
    }

    function test_rejectedDiscountedSaleCanExecuteDirectlyAfterReferenceFalls() public {
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
        _saleReference(6 ether);
        vm.prank(OPERATOR);
        project.reviewChildSale(id, false);
        assertEq(project.childSaleReview(id), 2);
        vm.expectRevert(BudgetPortfolioVault.ProposalNotPassed.selector);
        project.executeChildSale(id);
        _saleReference(5 ether);
        project.executeChildSale(id);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
    }

    function _passedChildSaleAtPrice(uint256 price) private returns (uint256 id) {
        _subscribe(ALICE, 29);
        _subscribe(BOB, 30);
        _subscribe(CAROL, 41);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        vm.prank(ALICE);
        id = project.proposeChildSale(address(pool), price, 0, 0);
        vm.prank(ALICE);
        project.voteChildSale(id, true);
        vm.prank(BOB);
        project.voteChildSale(id, true);
    }

    function test_childAtEightyPercentListsWithoutAnyPlatformReview() public {
        uint256 id = _passedChildSaleAtPrice(4 ether);
        _saleReference(5 ether);
        assertEq(project.saleReviewThresholdBps(), 8000);
        assertEq(PoolVault(payable(address(pool))).saleReviewThresholdBps(), 8000);
        vm.prank(OPERATOR);
        vm.expectRevert(BudgetPortfolioVault.InvalidProposal.selector);
        project.reviewChildSale(id, true);
        project.executeChildSale(id);
        (uint8 review,) = coreShareMarket.saleReview(address(pool), PoolVault(payable(address(pool))).listedProposalId());
        assertEq(review, 0, "no child approval is recorded for an 80% sale");
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
    }

    function test_childOneWeiBelowEightyPercentRequiresAndPropagatesReview() public {
        uint256 price = 4 ether - 1;
        uint256 id = _passedChildSaleAtPrice(price);
        _saleReference(5 ether);
        vm.expectRevert(BudgetPortfolioVault.ProposalNotPassed.selector);
        project.executeChildSale(id);
        vm.prank(OPERATOR);
        project.reviewChildSale(id, true);
        project.executeChildSale(id);
        (uint8 review, uint128 reviewedPrice) =
            coreShareMarket.saleReview(address(pool), PoolVault(payable(address(pool))).listedProposalId());
        assertEq(review, 1);
        assertEq(reviewedPrice, price);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
    }

    function test_childFractionalWeiReferenceDoesNotTruncateReviewBoundary() public {
        uint256 id = _passedChildSaleAtPrice(80);
        _saleReference(101);
        vm.expectRevert(BudgetPortfolioVault.ProposalNotPassed.selector);
        project.executeChildSale(id);
        vm.prank(OPERATOR);
        project.reviewChildSale(id, true);
        project.executeChildSale(id);
        assertEq(PoolVault(payable(address(pool))).salePrice(), 80);
    }

    function test_atOrAboveReferenceCannotBeReviewedAndListsAfterDoubleMajority() public {
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
        _saleReference(3 ether);
        vm.prank(OPERATOR);
        vm.expectRevert(BudgetPortfolioVault.InvalidProposal.selector);
        project.reviewChildSale(id, false);
        project.executeChildSale(id);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
    }

    function test_twoApprovedCandidatesForSameChildDoNotOverwriteEachOther() public {
        _subscribe(ALICE, 29);
        _subscribe(BOB, 30);
        _subscribe(CAROL, 41);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        vm.prank(ALICE);
        uint256 first = project.proposeChildSale(address(pool), 4 ether, 5 ether, uint64(block.timestamp));
        vm.prank(BOB);
        uint256 second = project.proposeChildSale(address(pool), 3 ether, 5 ether, uint64(block.timestamp));
        for (uint256 id = first; id <= second; ++id) {
            vm.prank(ALICE);
            project.voteChildSale(id, true);
            vm.prank(BOB);
            project.voteChildSale(id, true);
        }
        _saleReference(6 ether);
        PlatformAuthority authority = new PlatformAuthority(
            address(poolFactory), address(portfolios), vm.addr(0xA11CE), vm.addr(0xB0B), address(0xFEE)
        );
        vm.prank(OWNER);
        poolFactory.setOperator(address(authority));
        vm.prank(OWNER);
        portfolios.setOperator(address(authority));
        vm.prank(address(authority));
        project.reviewChildSale(first, true);
        vm.prank(address(authority));
        project.reviewChildSale(second, true);
        uint256 childId = PoolVault(payable(address(pool))).nextProposalId();
        (uint8 status,) = coreShareMarket.saleReview(address(pool), childId);
        assertEq(status, 0);
        project.executeChildSale(first);
        uint128 price;
        (status, price) = coreShareMarket.saleReview(address(pool), childId);
        assertEq(status, 1);
        assertEq(price, 4 ether);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
    }

    function test_childSalePriceMustFitFirstoAskBeforeOpeningRound() public {
        _subscribe(ALICE, 60);
        _subscribe(BOB, 40);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();

        uint256 nextId = project.nextProposalId();
        uint64 nextRound = project.nextRoundAt();
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.InvalidProposal.selector);
        project.proposeChildSale(address(pool), uint256(type(uint128).max) + 1, 0, 0);
        assertEq(project.nextProposalId(), nextId);
        assertEq(project.nextRoundAt(), nextRound);

        vm.prank(ALICE);
        uint256 id = project.proposeChildSale(address(pool), type(uint128).max, 0, 0);
        vm.prank(ALICE);
        project.voteChildSale(id, true);
        vm.prank(BOB);
        project.voteChildSale(id, true);
        _saleReference(1);
        project.executeChildSale(id);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
        assertEq(PoolVault(payable(address(pool))).salePrice(), type(uint128).max);
    }

    function test_minorityOpenerCannotBlockCompetingCandidateInSameRound() public {
        _subscribe(ALICE, 10);
        _subscribe(BOB, 40);
        _subscribe(CAROL, 50);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        vm.prank(ALICE);
        uint256 spam = project.proposeChildSale(address(pool), 1, 0, 0);
        vm.prank(BOB);
        uint256 candidate = project.proposeChildSale(address(pool), 6 ether, 0, 0);
        assertEq(candidate, spam + 1);
        assertEq(project.activeProposalId(), spam);
        vm.prank(BOB);
        project.voteChildSale(candidate, true);
        vm.prank(CAROL);
        project.voteChildSale(candidate, true);
        _saleReference(5 ether);
        project.executeChildSale(candidate);
        assertEq(project.activeProposalId(), candidate);
        assertEq(uint256(pool.state()), uint256(IPoolVault.State.Listed));
        vm.expectRevert(BudgetPortfolioVault.InvalidProposal.selector);
        project.executeChildSale(spam);
    }

    function test_oneShareCannotProposeAndExpiredRoundsCannotFreezeAgain() public {
        BudgetRoundAttacker attacker = new BudgetRoundAttacker();
        _subscribe(address(attacker), 10);
        _subscribe(ALICE, 89);
        _subscribe(BOB, 1);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        vm.prank(BOB);
        vm.expectRevert(BudgetPortfolioVault.InvalidProposal.selector);
        project.proposeChildSale(address(pool), 1, 0, 0);
        uint256 openedAt = block.timestamp;
        vm.prank(address(attacker));
        uint256 first = project.proposeChildSale(address(pool), 1, 0, 0);
        assertFalse(project.shareTradingAllowed());
        assertEq(project.nextRoundAt(), openedAt + 3 days);
        vm.prank(address(attacker));
        project.voteChildSale(first, true);
        vm.warp(openedAt + 1 days);
        assertTrue(project.shareTradingAllowed(), "expired unexecuted round cannot keep shares frozen");
        vm.expectRevert(BudgetPortfolioVault.ProposeCooldown.selector);
        attacker.expireThenPropose(project, address(pool));
        assertEq(project.activeProposalId(), first, "failed atomic re-freeze rolls back expiry too");
        assertTrue(project.shareTradingAllowed());
        vm.prank(ALICE);
        project.transfer(BOB, 1);
        assertEq(project.balanceOf(BOB), 2);
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.InvalidProposal.selector);
        project.voteChildSale(first, true);
        vm.expectRevert(BudgetPortfolioVault.InvalidProposal.selector);
        project.executeChildSale(first);
        vm.warp(openedAt + 3 days - 1);
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.ProposeCooldown.selector);
        project.proposeChildSale(address(pool), 6 ether, 0, 0);
        vm.warp(openedAt + 3 days);
        vm.prank(ALICE);
        uint256 second = project.proposeChildSale(address(pool), 6 ether, 0, 0);
        assertEq(second, first + 1);
        assertEq(project.activeProposalId(), second);
        assertFalse(project.shareTradingAllowed());
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.InvalidProposal.selector);
        project.voteChildSale(first, true);
        vm.expectRevert(BudgetPortfolioVault.InvalidProposal.selector);
        project.executeChildSale(first);
    }

    function test_executedChildSaleStaysFrozenPastVotingDeadline() public {
        _subscribe(ALICE, 100);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        vm.prank(ALICE);
        uint256 proposal = project.proposeChildSale(address(pool), 6 ether, 0, 0);
        vm.prank(ALICE);
        project.voteChildSale(proposal, true);
        _saleReference(6 ether);
        project.executeChildSale(proposal);
        vm.warp(block.timestamp + 1 days);
        assertFalse(project.shareTradingAllowed());
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.WrongState.selector);
        project.transfer(BOB, 1);
    }

    function test_executedChildSaleCannotBeOverwrittenAfterRoundCooldown() public {
        _subscribe(ALICE, 100);
        IFundingVault second = _buyTwo();
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        vm.prank(ALICE);
        uint256 proposal = project.proposeChildSale(address(pool), 6 ether, 0, 0);
        vm.prank(ALICE);
        project.voteChildSale(proposal, true);
        _saleReference(6 ether);
        project.executeChildSale(proposal);

        vm.warp(block.timestamp + 7 days);
        vm.prank(ALICE);
        vm.expectRevert(BudgetPortfolioVault.ProposalActive.selector);
        project.proposeChildSale(address(second), 6 ether, 0, 0);
        assertEq(project.activeProposalId(), proposal);
        assertFalse(project.shareTradingAllowed());
    }

    function test_externalChildCancellationCannotFreezePortfolioForever() public {
        _subscribe(ALICE, 100);
        uint256 listing = _list(defaultParams.circuitId, 5 ether);
        vm.prank(OPERATOR);
        project.buyOfficial(address(pool), listing);
        vm.warp(block.timestamp + 10 days);
        project.finalizeAcquisition();
        vm.prank(ALICE);
        uint256 proposal = project.proposeChildSale(address(pool), 6 ether, 0, 0);
        vm.prank(ALICE);
        project.voteChildSale(proposal, true);
        _saleReference(6 ether);
        project.executeChildSale(proposal);
        vm.warp(PoolVault(payable(address(pool))).expiresAt());
        PoolVault(payable(address(pool))).cancelExpired();
        assertFalse(project.shareTradingAllowed());
        project.expireChildSale();
        assertEq(project.activeProposalId(), 0);
        assertTrue(project.shareTradingAllowed());
        vm.prank(ALICE);
        project.transfer(BOB, 1);
        assertEq(project.balanceOf(BOB), 1);
    }
}
