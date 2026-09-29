// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Addresses} from "../../script/Addresses.sol";

/// @dev Narrow probe ABI from https://tapeout.net/assets/artifacts-BZhnQij0.js.
/// Its behavior is certified only by the fixed-block fork assertions below.
interface IProbeCircuitMarket {
    function list(address circuits, uint256 tokenId, uint96 price) external returns (uint256 id);
    function buy(uint256 id, uint96 expectedPrice) external payable;
    function listingFor(address circuits, uint256 tokenId)
        external
        view
        returns (uint256 id, address seller, uint96 price, bool valid);
    function listingView(uint256 id)
        external
        view
        returns (address seller, address circuits, uint256 tokenId, uint96 price, uint16 feeBps_, bool valid);
    function feeBps() external view returns (uint16);
    function protocolWallet() external view returns (address);
    function owed(address who) external view returns (uint256);
    function withdraw() external;
}

/// @dev Test-only receiver: transfers and calls remain within a local fork.
contract MarketSellerProbe is IERC721Receiver {
    address private immutable controller;
    bool public rejectBnb;
    uint256 public receiveCount;

    constructor() {
        controller = msg.sender;
    }

    modifier onlyController() {
        require(msg.sender == controller, "controller only");
        _;
    }

    function list(uint256 tokenId, uint96 price) external onlyController returns (uint256) {
        IERC721(Addresses.TAPEOUT_CIRCUITS).approve(Addresses.CIRCUIT_MARKET, tokenId);
        return IProbeCircuitMarket(Addresses.CIRCUIT_MARKET).list(Addresses.TAPEOUT_CIRCUITS, tokenId, price);
    }

    function setRejectBnb(bool value) external onlyController {
        rejectBnb = value;
    }

    function withdraw() external onlyController {
        IProbeCircuitMarket(Addresses.CIRCUIT_MARKET).withdraw();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        require(!rejectBnb, "test receiver rejects BNB");
        ++receiveCount;
    }
}

contract MarketProbeTest is Test {
    IProbeCircuitMarket private constant market = IProbeCircuitMarket(Addresses.CIRCUIT_MARKET);
    IERC721 private constant circuits = IERC721(Addresses.TAPEOUT_CIRCUITS);
    uint256 private constant TOKEN_ID = 400;
    uint96 private constant PRICE = 1 ether;
    bytes32 private constant SOLD_TOPIC = keccak256("Sold(uint256,address,address,uint256,uint256,uint256)");

    address private buyer;
    address private realOwner;
    address private protocolWallet;

    function setUp() public {
        uint256 forkBlock = vm.envUint("FORK_BLOCK");
        require(forkBlock == 123728000, "fixture requires documented fixed block");
        vm.createSelectFork(vm.envString("BSC_RPC_URL"), forkBlock);
        assertEq(block.chainid, Addresses.CHAIN_ID);
        assertEq(block.number, forkBlock);
        buyer = makeAddr("market-probe-buyer");
        realOwner = circuits.ownerOf(TOKEN_ID);
        protocolWallet = market.protocolWallet();
        assertEq(market.feeBps(), 100);
        vm.deal(buyer, 10 ether);
    }

    function test_Q4_MarketBuyerPaysListedPriceAndSellerBearsOnePercent() public {
        vm.startPrank(realOwner);
        circuits.approve(Addresses.CIRCUIT_MARKET, TOKEN_ID);
        uint256 id = market.list(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID, PRICE);
        vm.stopPrank();
        _assertListing(id, realOwner);

        uint256 sellerBalanceBefore = realOwner.balance;
        uint256 sellerOwedBefore = market.owed(realOwner);
        uint256 protocolBalanceBefore = protocolWallet.balance;
        uint256 protocolOwedBefore = market.owed(protocolWallet);
        uint256 marketBalanceBefore = Addresses.CIRCUIT_MARKET.balance;
        uint256 buyerBalanceBefore = buyer.balance;

        vm.recordLogs();
        vm.prank(buyer);
        market.buy{value: PRICE}(id, PRICE);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        uint256 fee = uint256(PRICE) / 100;
        assertEq(buyerBalanceBefore - buyer.balance, PRICE, "buyer pays no additional fee");
        emit log_named_uint("seller BNB delta", realOwner.balance - sellerBalanceBefore);
        emit log_named_uint("seller owed delta", market.owed(realOwner) - sellerOwedBefore);
        emit log_named_uint("protocol BNB delta", protocolWallet.balance - protocolBalanceBefore);
        emit log_named_uint("protocol owed delta", market.owed(protocolWallet) - protocolOwedBefore);
        emit log_named_uint("market BNB delta", Addresses.CIRCUIT_MARKET.balance - marketBalanceBefore);
        assertEq(realOwner.balance - sellerBalanceBefore, PRICE - fee, "seller directly receives 99%");
        assertEq(market.owed(realOwner), sellerOwedBefore, "seller has no new withdrawable credit");
        assertEq(protocolWallet.balance, protocolBalanceBefore, "protocol is not paid directly");
        assertEq(market.owed(protocolWallet) - protocolOwedBefore, fee, "protocol fee credited once");
        assertEq(Addresses.CIRCUIT_MARKET.balance - marketBalanceBefore, fee, "market retains fee for withdrawal");
        _assertSold(entries, id, fee);
        _assertConsumed(id);
    }

    function test_Q4_MarketRejectsUnderpaymentAndFeeAddedOnTop() public {
        MarketSellerProbe seller = _contractSeller();
        uint256 id = seller.list(TOKEN_ID, PRICE);
        vm.startPrank(buyer);
        vm.expectRevert();
        market.buy{value: PRICE - 1}(id, PRICE);
        vm.expectRevert();
        market.buy{value: uint256(PRICE) + PRICE / 100}(id, PRICE);
        vm.stopPrank();
        assertEq(circuits.ownerOf(TOKEN_ID), address(seller));
        _assertListing(id, address(seller));
    }

    function test_Q5_ContractSellerReceivesBnbDirectlyAndHasNothingToWithdraw() public {
        MarketSellerProbe seller = _contractSeller();
        uint256 id = seller.list(TOKEN_ID, PRICE);
        uint256 marketBalanceBefore = Addresses.CIRCUIT_MARKET.balance;
        vm.prank(buyer);
        market.buy{value: PRICE}(id, PRICE);

        emit log_named_uint("contract seller BNB after buy", address(seller).balance);
        emit log_named_uint("contract seller owed after buy", market.owed(address(seller)));
        emit log_named_uint("contract seller receive callbacks", seller.receiveCount());
        emit log_named_uint("market BNB delta after buy", Addresses.CIRCUIT_MARKET.balance - marketBalanceBefore);
        assertEq(address(seller).balance, uint256(PRICE) * 99 / 100);
        assertEq(market.owed(address(seller)), 0);
        assertEq(seller.receiveCount(), 1);
        assertEq(Addresses.CIRCUIT_MARKET.balance - marketBalanceBefore, PRICE / 100);
        _assertConsumed(id);
        vm.expectRevert(bytes("nothing owed"));
        seller.withdraw();
    }

    function test_Q5_RejectingSellerRevertsTradeInsteadOfCreatingOwed() public {
        MarketSellerProbe seller = _contractSeller();
        uint256 id = seller.list(TOKEN_ID, PRICE);
        seller.setRejectBnb(true);
        uint256 buyerBalanceBefore = buyer.balance;
        uint256 marketBalanceBefore = Addresses.CIRCUIT_MARKET.balance;
        uint256 protocolOwedBefore = market.owed(protocolWallet);
        vm.prank(buyer);
        vm.expectRevert(bytes("pay seller failed"));
        market.buy{value: PRICE}(id, PRICE);

        assertEq(buyer.balance, buyerBalanceBefore);
        assertEq(address(seller).balance, 0);
        assertEq(market.owed(address(seller)), 0);
        assertEq(Addresses.CIRCUIT_MARKET.balance, marketBalanceBefore);
        assertEq(market.owed(protocolWallet), protocolOwedBefore);
        assertEq(circuits.ownerOf(TOKEN_ID), address(seller));
        _assertListing(id, address(seller));

        seller.setRejectBnb(false);
        vm.prank(buyer);
        market.buy{value: PRICE}(id, PRICE);
        assertEq(address(seller).balance, uint256(PRICE) * 99 / 100);
        _assertConsumed(id);
    }

    function test_Q5_ProtocolFeeUsesOwedAndWithdraw() public {
        MarketSellerProbe seller = _contractSeller();
        uint256 id = seller.list(TOKEN_ID, PRICE);
        uint256 owedBefore = market.owed(protocolWallet);
        vm.prank(buyer);
        market.buy{value: PRICE}(id, PRICE);
        uint256 owedAfter = market.owed(protocolWallet);
        assertEq(owedAfter - owedBefore, PRICE / 100);

        uint256 recipientBalanceBefore = protocolWallet.balance;
        uint256 marketBalanceBefore = Addresses.CIRCUIT_MARKET.balance;
        vm.prank(protocolWallet);
        market.withdraw();
        assertEq(protocolWallet.balance - recipientBalanceBefore, owedAfter);
        assertEq(marketBalanceBefore - Addresses.CIRCUIT_MARKET.balance, owedAfter);
        assertEq(market.owed(protocolWallet), 0);
        vm.prank(protocolWallet);
        vm.expectRevert(bytes("nothing owed"));
        market.withdraw();
    }

    function _contractSeller() private returns (MarketSellerProbe seller) {
        seller = new MarketSellerProbe();
        vm.prank(realOwner);
        circuits.safeTransferFrom(realOwner, address(seller), TOKEN_ID);
    }

    function _assertListing(uint256 id, address expectedSeller) private view {
        (address seller, address nft, uint256 tokenId, uint96 price, uint16 fee, bool valid) = market.listingView(id);
        assertEq(seller, expectedSeller);
        assertEq(nft, Addresses.TAPEOUT_CIRCUITS);
        assertEq(tokenId, TOKEN_ID);
        assertEq(price, PRICE);
        assertEq(fee, 100);
        assertTrue(valid);
    }

    function _assertConsumed(uint256 id) private view {
        assertEq(circuits.ownerOf(TOKEN_ID), buyer);
        (,,,,, bool valid) = market.listingView(id);
        assertFalse(valid);
        (uint256 currentId,,, bool currentValid) = market.listingFor(Addresses.TAPEOUT_CIRCUITS, TOKEN_ID);
        assertEq(currentId, 0);
        assertFalse(currentValid);
    }

    function _assertSold(Vm.Log[] memory entries, uint256 id, uint256 fee) private pure {
        bool found;
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].emitter != Addresses.CIRCUIT_MARKET || entries[i].topics[0] != SOLD_TOPIC) continue;
            assertEq(uint256(entries[i].topics[1]), id);
            (uint256 tokenId, uint256 paidToSeller, uint256 feePaid) =
                abi.decode(entries[i].data, (uint256, uint256, uint256));
            assertEq(tokenId, TOKEN_ID);
            assertEq(paidToSeller, PRICE - fee);
            assertEq(feePaid, fee);
            found = true;
        }
        assertTrue(found, "Sold event missing");
    }
}
