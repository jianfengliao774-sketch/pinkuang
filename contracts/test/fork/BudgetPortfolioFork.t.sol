// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {AtomicDeployment} from "../../src/AtomicDeployment.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {BudgetPortfolioFactory} from "../../src/BudgetPortfolioFactory.sol";
import {BudgetPortfolioVault} from "../../src/BudgetPortfolioVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {IFirstoSignedAskExchange} from "../../src/interfaces/IFirstoExchange.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IBudgetForkOfficialMarket {
    function list(address collection, uint256 tokenId, uint96 price) external returns (uint256);
}

/// @notice Actual integrated graph buys one official and one public Firsto order, then sells via Firsto.
/// @dev Fixed BSC 124308679. Only local project deployment, native test funding, time and
/// official seller impersonation are simulated. No protocol etch/store, BEM/NFT deal or broadcast.
contract BudgetPortfolioForkTest is Test {
    uint256 private constant OFFICIAL_ID = 16210;
    uint256 private constant FIRSTO_ID = 5788;
    uint256 private constant OFFICIAL_PRICE = 0.01 ether;
    uint256 private constant FIRSTO_COST = 0.0505 ether;
    uint256 private constant BUDGET = 0.07 ether;
    uint256 private constant SALE_PRICE = 0.02 ether;
    address private constant OFFICIAL_SELLER = 0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744;
    address private constant FIRSTO_SELLER = 0xB88F7608e5f325c0276324F2e35363934BcC91d6;
    address private constant ALICE = address(0xA11CE);
    address private constant BUYER = address(0xB01234);
    IERC721 private constant NFT = IERC721(Addresses.TAPEOUT_CIRCUITS);
    IERC20 private constant BEM = IERC20(Addresses.BEM);

    PoolFactory private factory;
    BudgetPortfolioVault private portfolio;
    PoolVault private officialChild;
    PoolVault private firstoChild;

    function setUp() public {
        if (block.number == 123728000) {
            emit log("Budget Firsto integration requires the separate BSC 124308679 fixture command");
            vm.skip(true);
            return;
        }
        require(block.chainid == 56 && block.number == 124308679, "requires Firsto fixed-block BSC fork");
        assertEq(NFT.ownerOf(OFFICIAL_ID), OFFICIAL_SELLER);
        assertEq(NFT.ownerOf(FIRSTO_ID), FIRSTO_SELLER);
        AtomicDeployment coordinator = new AtomicDeployment();
        AtomicDeployment.IntegratedConfig memory config;
        config.core = AtomicDeployment.Config({
            ownerMultisig: address(this),
            operator: address(this),
            treasury: address(this),
            vaultImplementation: address(new PoolVault(coordinator.predictedFactory())),
            factoryImplementation: address(new PoolFactory()),
            marketImplementation: address(new ShareMarket())
        });
        config.portfolioFactoryImplementation = address(new BudgetPortfolioFactory());
        config.portfolioVaultImplementation = address(new BudgetPortfolioVault(coordinator.predictedPortfolioFactory()));
        (AtomicDeployment.Deployment memory core, AtomicDeployment.PortfolioDeployment memory graph) =
            coordinator.deployIntegratedSingleOwner(config);
        factory = PoolFactory(core.factory);
        portfolio = BudgetPortfolioVault(
            payable(BudgetPortfolioFactory(graph.factory)
                    .createPortfolio(
                        BUDGET,
                        0.06 ether,
                        0.06 ether,
                        uint64(block.timestamp + 1 days),
                        uint64(block.timestamp + 2 days)
                    ))
        );
        vm.deal(ALICE, BUDGET);
        vm.prank(ALICE);
        portfolio.deposit{value: BUDGET}(100);
        officialChild = _child(OFFICIAL_ID, OFFICIAL_PRICE);
        firstoChild = _child(FIRSTO_ID, FIRSTO_COST);
    }

    function test_Fork_IntegratedBudgetBuysBothSourcesAtExactCostAndReceivesControlledSaleProceeds() public {
        uint256 officialSellerBem = BEM.balanceOf(OFFICIAL_SELLER);
        uint256 firstoSellerBem = BEM.balanceOf(FIRSTO_SELLER);
        vm.startPrank(OFFICIAL_SELLER);
        NFT.approve(Addresses.CIRCUIT_MARKET, OFFICIAL_ID);
        uint256 listingId = IBudgetForkOfficialMarket(Addresses.CIRCUIT_MARKET)
            .list(Addresses.TAPEOUT_CIRCUITS, OFFICIAL_ID, uint96(OFFICIAL_PRICE));
        vm.stopPrank();
        portfolio.buyOfficial(address(officialChild), listingId);
        portfolio.buyFirsto(address(firstoChild), abi.encode(_ask(), _signature()));
        assertEq(portfolio.childCount(), 2);
        assertEq(portfolio.activeChildCount(), 2);
        assertEq(portfolio.spentWei(), OFFICIAL_PRICE + FIRSTO_COST);
        assertEq(address(portfolio).balance, BUDGET - OFFICIAL_PRICE - FIRSTO_COST);
        assertEq(officialChild.bnbOwed(address(portfolio)), 0, "exact official cost must need no surplus withdrawal");
        assertEq(firstoChild.bnbOwed(address(portfolio)), 0, "exact Firsto cost includes the buyer fee");
        assertEq(NFT.ownerOf(OFFICIAL_ID), address(officialChild));
        assertEq(NFT.ownerOf(FIRSTO_ID), address(firstoChild));
        assertGt(BEM.balanceOf(OFFICIAL_SELLER), officialSellerBem);
        assertGt(BEM.balanceOf(FIRSTO_SELLER), firstoSellerBem);
        assertEq(BEM.balanceOf(address(portfolio)), 0, "seller historic income is never project income");
        assertEq(factory.machinePool(Addresses.TAPEOUT_CIRCUITS, OFFICIAL_ID), address(officialChild));
        assertEq(factory.machinePool(Addresses.TAPEOUT_CIRCUITS, FIRSTO_ID), address(firstoChild));

        vm.warp(block.timestamp + 7 days);
        portfolio.finalizeAcquisition();
        assertEq(portfolio.purchaseFeeWei(), OFFICIAL_PRICE / 100, "no added project Firsto purchase fee");
        vm.prank(ALICE);
        uint256 proposalId = portfolio.proposeChildSale(address(officialChild), SALE_PRICE, 0, 0);
        vm.prank(ALICE);
        portfolio.voteChildSale(proposalId, true);
        ShareMarket(payable(factory.shareMarket()))
            .setSaleReference(
                address(officialChild), uint128(SALE_PRICE), uint64(block.timestamp), keccak256("fixed-fork-reference")
            );
        portfolio.executeChildSale(proposalId);
        uint256 payment = SALE_PRICE + SALE_PRICE / 100;
        vm.deal(BUYER, payment);
        vm.prank(BUYER);
        officialChild.completeFirstoSale{value: payment}(1, SALE_PRICE, 100, 1);
        assertEq(NFT.ownerOf(OFFICIAL_ID), BUYER);
        assertGt(BEM.balanceOf(address(officialChild)), 0, "sale transaction settled actual old-owner BEM");
        uint256 beforeBalance = address(portfolio).balance;
        uint256 childBem = BEM.balanceOf(address(officialChild));
        uint256 net = portfolio.settleChildSale();
        assertEq(net, SALE_PRICE * 99 / 100, "child sale fee is not charged again by the portfolio");
        assertEq(address(portfolio).balance - beforeBalance, net);
        assertEq(
            BEM.balanceOf(address(portfolio)), 0, "BNB sale settlement leaves child BEM available for later collection"
        );
        assertEq(portfolio.collectChildBem(address(officialChild)), childBem);
        assertEq(BEM.balanceOf(address(portfolio)), childBem);
        uint256 distributedBem = childBem / 100 * 100;
        assertEq(portfolio.claimableBem(ALICE), distributedBem);
        assertEq(portfolio.activeChildCount(), 1);
        assertEq(uint256(portfolio.state()), uint256(IPoolVault.State.Active));
        vm.prank(ALICE);
        assertEq(portfolio.claimBem(), distributedBem);
        assertEq(BEM.balanceOf(ALICE), distributedBem);
        assertEq(
            BEM.balanceOf(address(portfolio)), childBem % 100, "existing bounded ledger dust stays for next receipt"
        );
        vm.prank(ALICE);
        assertEq(portfolio.withdrawBnb(), BUDGET - OFFICIAL_PRICE - FIRSTO_COST - OFFICIAL_PRICE / 100 + net);
        assertEq(NFT.ownerOf(FIRSTO_ID), address(firstoChild), "partial exit preserves the other miner");
    }

    function _child(uint256 tokenId, uint256 cost) private returns (PoolVault) {
        return PoolVault(
            payable(factory.createBudgetChildPool(
                    IPoolVault.PoolParams({
                        circuits: Addresses.TAPEOUT_CIRCUITS,
                        circuitId: tokenId,
                        targetRaise: cost,
                        priceCap: cost,
                        directSeller: address(0),
                        directPrice: 0,
                        fundingDeadline: uint64(block.timestamp + 1 days),
                        purchaseDeadline: uint64(block.timestamp + 2 days)
                    }),
                    address(portfolio)
                ))
        );
    }

    function _ask() private pure returns (IFirstoSignedAskExchange.SignedAsk memory) {
        return IFirstoSignedAskExchange.SignedAsk({
            maker: FIRSTO_SELLER,
            collection: Addresses.TAPEOUT_CIRCUITS,
            tokenId: FIRSTO_ID,
            nonce: 91194853857757076373198051252334927123677906225459773215660203836142063036762,
            price: 0.05 ether,
            expiry: 1792748154,
            payoutRecipient: FIRSTO_SELLER,
            feeBps: 100,
            feeEpoch: 1,
            schemaVersion: 2
        });
    }

    function _signature() private pure returns (bytes memory) {
        return hex"98fee6d550ac8353fb553985bb17917bc483dc48c15698f6ed45996fb0bfcd0552b599bce63618c1b1bd8f09d0579bbe29e9c88b8cde6f257800927c074d51571c";
    }
}
