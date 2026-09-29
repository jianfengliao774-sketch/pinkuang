// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Addresses} from "../../script/Addresses.sol";
import {ProbeHolder, IProbeMining, IProbeMarket} from "../utils/ProbeHolder.sol";

contract ProtocolProbe is Test {
    uint256 constant FORK_BLOCK = 123728000;
    uint256 constant TOKEN_ID = 16210;
    address constant ORIGINAL_OWNER = 0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744;
    IERC721 circuits;
    IERC20 bem;
    IProbeMining mining;
    IProbeMarket market;
    ProbeHolder holder;
    bytes32 key;

    function setUp() public {
        require(block.chainid == 56 && block.number == FORK_BLOCK, "requires pinned BSC fork");
        circuits = IERC721(Addresses.TAPEOUT_CIRCUITS);
        bem = IERC20(Addresses.BEM);
        mining = IProbeMining(Addresses.MINING);
        market = IProbeMarket(Addresses.CIRCUIT_MARKET);
        holder = new ProbeHolder(address(circuits), TOKEN_ID, address(mining), address(market), address(bem));
        key = mining.minerKey(address(circuits), TOKEN_ID);
        assertEq(circuits.ownerOf(TOKEN_ID), ORIGINAL_OWNER, "fixture owner changed");
        assertGt(mining.pending(key), 0, "fixture must already be mining");
        vm.deal(address(this), 10 ether);
    }

    function _transferToHolder() internal {
        vm.prank(ORIGINAL_OWNER);
        circuits.safeTransferFrom(ORIGINAL_OWNER, address(holder), TOKEN_ID);
        assertEq(circuits.ownerOf(TOKEN_ID), address(holder));
    }

    function _listFromOriginalOwner(uint96 price) internal returns (uint256 listingId) {
        vm.startPrank(ORIGINAL_OWNER);
        circuits.approve(address(market), TOKEN_ID);
        listingId = market.list(address(circuits), TOKEN_ID, price);
        vm.stopPrank();
    }

    function test_Q3_ActiveMinerContinuesAndClaimsToContractAfterTransfer() public {
        uint256 beforeTransfer = mining.pending(key);
        _transferToHolder();
        assertEq(mining.pending(key), beforeTransfer, "transfer altered accrued rewards");
        holder.forward(address(mining), abi.encodeCall(IProbeMining.claim, (key)));
        uint256 initialClaim = bem.balanceOf(address(holder));
        assertGe(initialClaim, beforeTransfer);
        assertEq(mining.pending(key), 0);
        vm.warp(block.timestamp + 1 hours);
        // pending() reads the stored global accumulator; a view does not accrue elapsed emissions.
        assertEq(mining.pending(key), 0, "observed pending view must remain stale until an update");
        // A real claim on a DIFFERENT miner updates the protocol's accumulator. No storage mocking.
        mining.claim(mining.minerKey(address(circuits), 400));
        uint256 afterWait = mining.pending(key);
        assertGt(afterWait, 0, "transferred miner earns NEW rewards after its old rewards were cleared");
        uint256 beforeBalance = bem.balanceOf(address(holder));
        uint256 sellerBalance = bem.balanceOf(ORIGINAL_OWNER);
        holder.forward(address(mining), abi.encodeCall(IProbeMining.claim, (key)));
        assertEq(bem.balanceOf(address(holder)) - beforeBalance, afterWait);
        assertEq(bem.balanceOf(ORIGINAL_OWNER), sellerBalance);
        assertEq(mining.pending(key), 0);
        emit log_named_uint("pending before transfer (BEM atoms)", beforeTransfer);
        emit log_named_uint("initial actual claim (BEM atoms)", initialClaim);
        emit log_named_uint("pending after 3600 seconds and global update (BEM atoms)", afterWait);
        emit log_named_uint("NEW rewards claimed to contract (BEM atoms)", afterWait);
    }

    function test_Q6_BuyerClaimsSellerThenBuysAtomically() public {
        uint96 price = 0.01 ether;
        uint256 id = _listFromOriginalOwner(price);
        uint256 accrued = mining.pending(key);
        uint256 sellerBem = bem.balanceOf(ORIGINAL_OWNER);
        uint256 supplyBefore = bem.totalSupply();
        holder.claimAndBuy{value: price}(id, price);
        uint256 minted = bem.totalSupply() - supplyBefore;
        assertEq(circuits.ownerOf(TOKEN_ID), address(holder));
        assertGe(minted, accrued, "claim also accrues emissions since last global update");
        assertEq(bem.balanceOf(ORIGINAL_OWNER) - sellerBem, minted);
        assertEq(bem.balanceOf(address(holder)), 0);
        assertEq(mining.pending(key), 0);
        emit log_named_uint("pre-purchase pending view", accrued);
        emit log_named_uint("actual BEM paid to seller before purchase", minted);
    }

    function test_Q6_FailedBuyRollsBackPriorClaim() public {
        uint96 price = 0.01 ether;
        uint256 id = _listFromOriginalOwner(price);
        uint256 pendingBefore = mining.pending(key);
        uint256 sellerBem = bem.balanceOf(ORIGINAL_OWNER);
        vm.expectRevert(bytes("price changed"));
        holder.claimAndBuy{value: price}(id, price + 1);
        assertEq(circuits.ownerOf(TOKEN_ID), ORIGINAL_OWNER);
        assertEq(bem.balanceOf(ORIGINAL_OWNER), sellerBem);
        assertEq(mining.pending(key), pendingBefore);
    }

    function test_Q6_ControlledSaleSettlesBeforeTransfer() public {
        _transferToHolder();
        vm.warp(block.timestamp + 1 hours);
        uint256 accrued = mining.pending(key);
        uint256 supplyBefore = bem.totalSupply();
        address buyer = makeAddr("direct buyer");
        holder.probeCompleteSale{value: 0.01 ether}(buyer, 0.01 ether);
        uint256 minted = bem.totalSupply() - supplyBefore;
        assertEq(circuits.ownerOf(TOKEN_ID), buyer);
        assertGt(minted, accrued, "elapsed emissions must be settled at handover");
        assertEq(bem.balanceOf(address(holder)), minted);
        assertEq(bem.balanceOf(buyer), 0);
        assertEq(mining.pending(key), 0);
        assertEq(address(holder).balance, 0.01 ether);
        mining.claim(key);
        assertEq(bem.balanceOf(buyer), 0, "same-instant buyer cannot claim any previous-owner rewards");
        vm.warp(block.timestamp + 1 hours);
        mining.claim(key);
        assertGt(bem.balanceOf(buyer), 0, "new emissions belong to the new owner");
        assertEq(bem.balanceOf(address(holder)), minted, "old-owner rewards stay with the seller");
        emit log_named_uint("final BEM retained for previous holder", minted);
    }

    function test_Q6_ClaimFailurePreventsControlledTransfer() public {
        _transferToHolder();
        vm.mockCallRevert(address(mining), abi.encodeCall(IProbeMining.claim, (key)), "probe injected claim failure");
        vm.expectRevert(bytes("probe injected claim failure"));
        holder.probeCompleteSale{value: 0.01 ether}(makeAddr("failure buyer"), 0.01 ether);
        assertEq(circuits.ownerOf(TOKEN_ID), address(holder));
        assertEq(address(holder).balance, 0);
    }

    function test_Q6_BareMarketSaleDoesNotForceFinalClaim() public {
        _transferToHolder();
        holder.forward(address(circuits), abi.encodeCall(IERC721.approve, (address(market), TOKEN_ID)));
        bytes memory result = holder.forward(
            address(market), abi.encodeCall(IProbeMarket.list, (address(circuits), TOKEN_ID, uint96(0.01 ether)))
        );
        uint256 listingId = abi.decode(result, (uint256));
        uint256 accrued = mining.pending(key);
        address buyer = makeAddr("bare market buyer");
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        market.buy{value: 0.01 ether}(listingId, 0.01 ether);
        assertEq(circuits.ownerOf(TOKEN_ID), buyer);
        assertEq(bem.balanceOf(address(holder)), 0);
        assertEq(mining.pending(key), accrued, "bare market unexpectedly settled rewards");
        uint256 supplyBefore = bem.totalSupply();
        vm.prank(buyer);
        mining.claim(key);
        uint256 minted = bem.totalSupply() - supplyBefore;
        assertGe(minted, accrued);
        assertEq(bem.balanceOf(buyer), minted);
        emit log_named_uint("unsettled BEM taken by new market owner", minted);
    }

    function test_Q7_ConsecutiveZeroPendingClaim() public {
        _transferToHolder();
        holder.forward(address(mining), abi.encodeCall(IProbeMining.claim, (key)));
        assertEq(mining.pending(key), 0);
        uint256 balance = bem.balanceOf(address(holder));
        holder.forward(address(mining), abi.encodeCall(IProbeMining.claim, (key)));
        assertEq(bem.balanceOf(address(holder)), balance);
        assertEq(mining.pending(key), 0);
    }

    function test_ProbeWhitelistRejectsUnknownSelectorAndStranger() public {
        vm.expectRevert("not allowlisted");
        holder.forward(address(bem), abi.encodeCall(IERC20.transfer, (address(this), 1)));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert("probe controller only");
        holder.forward(address(mining), abi.encodeCall(IProbeMining.claim, (key)));
    }
}
